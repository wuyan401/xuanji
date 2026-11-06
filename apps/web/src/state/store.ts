// 单一数据源：SSE 快照 + 增量事件环形缓冲。
// 视图层只通过 store 读数据；store 不做任何汇总计算（汇总在后端 aggregates 里）。

import type {
  Aggregates,
  AgentSession,
  AstroEvent,
  ClientFleetSnapshot,
  ConnectionState,
  FleetFrame,
  FleetTickFrame,
  FleetDeltaFrame,
  Sector,
  SystemFrame,
  SystemSnapshot,
} from './types';
import { EMPTY_AGGREGATES, EMPTY_SNAPSHOT, EMPTY_SYSTEM } from './types';
import { retainJson, retainSessions, sameJson } from './reconcile';

const EVENT_RING_MAX = 400;
const RECONNECT_MIN_MS = 1200;
const RECONNECT_MAX_MS = 15000;
const STALE_MS = 32000;
const POLL_INTERVAL_MS = 2500;
/** 整机遥测历史（2s 一条 → 约 4 分钟） */
const SYSTEM_HISTORY_MAX = 120;

type FleetListener = (snapshot: ClientFleetSnapshot) => void;
type EventsListener = (events: AstroEvent[]) => void;
type ConnectionListener = (state: ConnectionState) => void;
type SystemListener = (snapshot: SystemSnapshot) => void;

export class FleetStore {
  private snapshot: ClientFleetSnapshot = {
    ...EMPTY_SNAPSHOT,
    sessions: [],
    sectors: [],
    events: [],
  };
  private eventsRing: AstroEvent[] = [];
  private eventIds = new Set<string>();
  private sessionById = new Map<string, AgentSession>();
  private sectorList: Sector[] = [];
  private aggregates: Aggregates = { ...EMPTY_AGGREGATES };

  private system: SystemSnapshot = { ...EMPTY_SYSTEM };
  private systemHistory: SystemSnapshot[] = [];

  private fleetListeners = new Set<FleetListener>();
  private eventsListeners = new Set<EventsListener>();
  private connectionListeners = new Set<ConnectionListener>();
  private systemListeners = new Set<SystemListener>();

  private selectedId: string | null = null;

  private source: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private disposed = false;
  private everConnected = false;
  private polling = false;
  private pollGeneration = 0;
  private pollInFlight = false;
  private pollController: AbortController | null = null;
  private lastMessageAt = 0;
  /** ?demo=1 时透传给服务端 */
  private demo = false;

  constructor(private readonly streamUrl = '/api/stream', options?: { demo?: boolean }) {
    this.demo = options?.demo ?? false;
  }

  // ---- 读 ----
  getSnapshot(): ClientFleetSnapshot {
    return this.snapshot;
  }
  getSessions(): AgentSession[] {
    return this.snapshot.sessions;
  }
  getSession(id: string | null): AgentSession | null {
    return id ? this.sessionById.get(id) ?? null : null;
  }
  getEvents(): AstroEvent[] {
    return this.eventsRing;
  }
  getAggregates(): Aggregates {
    return this.aggregates;
  }
  getSectors(): Sector[] {
    return this.sectorList;
  }
  getSelectedId(): string | null {
    return this.selectedId;
  }
  getConnection(): ConnectionState {
    return this.snapshot.connection;
  }
  /** 最近一条整机遥测（可能 available:false） */
  getSystem(): SystemSnapshot {
    return this.system;
  }
  /** 整机遥测历史（旧→新，最多 SYSTEM_HISTORY_MAX 条） */
  getSystemHistory(): SystemSnapshot[] {
    return this.systemHistory;
  }
  isLive(): boolean {
    return this.snapshot.connection === 'live';
  }

  // ---- 写 ----
  setSelectedId(id: string | null): void {
    this.selectedId = id;
  }

  // ---- 订阅 ----
  onFleet(fn: FleetListener): () => void {
    this.fleetListeners.add(fn);
    return () => this.fleetListeners.delete(fn);
  }
  onEvents(fn: EventsListener): () => void {
    this.eventsListeners.add(fn);
    return () => this.eventsListeners.delete(fn);
  }
  onConnection(fn: ConnectionListener): () => void {
    this.connectionListeners.add(fn);
    return () => this.connectionListeners.delete(fn);
  }
  onSystem(fn: SystemListener): () => void {
    this.systemListeners.add(fn);
    return () => this.systemListeners.delete(fn);
  }

  // ---- 连接 ----
  connect(): void {
    if (this.disposed) return;
    this.openStream();
  }

  disconnect(): void {
    this.disposed = true;
    this.closeStream();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.reconnectTimer = null;
    this.staleTimer = null;
    this.stopPollingFallback();
    this.setConnection('offline');
  }

  private openStream(): void {
    this.closeStream();
    this.setConnection(this.everConnected || this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    const search = new URLSearchParams({ delta: '1' });
    if (this.demo) search.set('demo', '1');
    // 老服务忽略 delta 参数仍会返回 full fleet，兼容本地开发/mock/回放。
    const url = `${this.streamUrl}${this.streamUrl.includes('?') ? '&' : '?'}${search}`;
    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.source = es;

    const isCurrentStream = () => this.source === es && !this.disposed;
    es.addEventListener('fleet', (ev) => {
      if (!isCurrentStream()) return;
      const frame = this.parse<FleetFrame>(ev.data);
      if (frame) this.applyFleet(frame);
      this.noteMessage(es);
    });
    es.addEventListener('delta', (ev) => {
      if (!isCurrentStream()) return;
      const frame = this.parse<FleetDeltaFrame>(ev.data);
      if (frame) this.applyDelta(frame);
      this.noteMessage(es);
    });
    es.addEventListener('tick', (ev) => {
      if (!isCurrentStream()) return;
      const frame = this.parse<FleetTickFrame>(ev.data);
      if (frame) this.applyTick(frame);
      this.noteMessage(es);
    });
    es.addEventListener('system', (ev) => {
      if (!isCurrentStream()) return;
      const frame = this.parse<SystemFrame>(ev.data);
      if (frame) this.applySystem(frame);
      this.noteMessage(es);
    });
    es.onopen = () => {
      if (!isCurrentStream()) return;
      this.everConnected = true;
      this.reconnectAttempt = 0;
      this.noteMessage(es);
    };
    es.onerror = () => {
      if (!isCurrentStream()) return;
      // 手动接管重连：关闭后自己按退避重来，并临时用轮询兜底。
      this.closeStream();
      this.startPollingFallback();
      this.scheduleReconnect();
    };
  }

  private closeStream(): void {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * Math.pow(1.7, this.reconnectAttempt),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) this.openStream();
    }, delay);
  }

  private startPollingFallback(): void {
    if (this.polling || this.disposed) return;
    this.polling = true;
    const generation = ++this.pollGeneration;
    const poll = async () => {
      if (!this.polling || generation !== this.pollGeneration || this.disposed || this.pollInFlight) return;
      this.pollInFlight = true;
      const controller = new AbortController();
      this.pollController = controller;
      const isCurrent = () => this.polling && generation === this.pollGeneration && !this.disposed;
      try {
        try {
          const res = await fetch(this.demo ? '/api/fleet?demo=1' : '/api/fleet', {
            cache: 'no-store',
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = (await res.json()) as FleetFrame;
          if (!isCurrent()) return;
          this.applyFleet({ ...data, type: 'fleet' });
          this.setConnection('reconnecting');
        } catch {
          if (!isCurrent()) return;
          if (this.reconnectAttempt > 3) this.setConnection('offline');
        }
        if (!isCurrent()) return;
        // 整机遥测：旧版后端没有 /api/system，404 时静默忽略
        try {
          const res = await fetch(this.demo ? '/api/system?demo=1' : '/api/system', {
            cache: 'no-store',
            signal: controller.signal,
          });
          if (res.ok) {
            const sys = (await res.json()) as SystemFrame | SystemSnapshot;
            if (isCurrent()) this.applySystem(sys as SystemFrame);
          }
        } catch {
          /* 无整机通道时忽略 */
        }
      } finally {
        if (generation === this.pollGeneration) {
          this.pollInFlight = false;
          if (this.pollController === controller) this.pollController = null;
        }
      }
    };
    void poll();
    this.pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  private stopPollingFallback(): void {
    this.polling = false;
    this.pollGeneration += 1;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollInFlight = false;
    this.pollController?.abort();
    this.pollController = null;
  }

  private noteMessage(source: EventSource): void {
    if (this.source !== source || this.disposed) return;
    this.lastMessageAt = Date.now();
    this.stopPollingFallback();
    this.setConnection('live');
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      if (this.disposed || this.source !== source) return;
      if (Date.now() - this.lastMessageAt > STALE_MS) {
        this.closeStream();
        this.startPollingFallback();
        this.scheduleReconnect();
      }
    }, STALE_MS + 500);
  }

  private setConnection(state: ConnectionState): void {
    if (state === this.snapshot.connection) return;
    this.snapshot = { ...this.snapshot, connection: state };
    for (const fn of this.connectionListeners) fn(state);
    if (state === 'offline') this.startPollingFallback();
  }

  // ---- 帧处理 ----
  private applyFleet(frame: FleetFrame): void {
    const sessions = retainSessions(
      this.snapshot.sessions,
      Array.isArray(frame.sessions) ? frame.sessions : [],
      this.sessionById,
    );
    if (sessions !== this.snapshot.sessions) {
      this.sessionById = new Map(sessions.map((s) => [s.id, s]));
    }
    this.sectorList = retainJson(this.sectorList, Array.isArray(frame.sectors) ? frame.sectors : []);
    this.aggregates = retainJson(this.aggregates, frame.aggregates ?? this.aggregates);
    const sources = retainJson(this.snapshot.sources, Array.isArray(frame.sources) ? frame.sources : this.snapshot.sources);
    if (Array.isArray(frame.events) && frame.events.length) {
      this.appendEvents(frame.events, true);
    }
    this.snapshot = {
      generatedAt: Number(frame.generatedAt) || Date.now(),
      source: frame.source ?? 'live',
      sessions,
      sectors: this.sectorList,
      sources,
      aggregates: this.aggregates,
      events: this.eventsRing,
      connection: this.snapshot.connection,
      receivedAt: Date.now(),
    };
    for (const fn of this.fleetListeners) fn(this.snapshot);
  }

  private mergeSessions(incoming: AgentSession[] | undefined, removed: string[] = []): AgentSession[] {
    let changed = false;
    for (const id of removed) changed = this.sessionById.delete(id) || changed;
    if (Array.isArray(incoming)) {
      for (const session of incoming) {
        const old = this.sessionById.get(session.id);
        if (!old || !sameJson(old, session)) {
          this.sessionById.set(session.id, session);
          changed = true;
        }
      }
    }
    if (!changed) return this.snapshot.sessions;
    // Preserve ordering until a structural full snapshot supplies the new backend order.
    const sessions: AgentSession[] = [];
    const seen = new Set<string>();
    for (const previous of this.snapshot.sessions) {
      const next = this.sessionById.get(previous.id);
      if (next) { sessions.push(next); seen.add(next.id); }
    }
    for (const [id, next] of this.sessionById) if (!seen.has(id)) sessions.push(next);
    return sessions;
  }

  private applyDelta(frame: FleetDeltaFrame): void {
    // A reconnect always starts with a full snapshot. Never apply an orphan delta.
    if (!this.everConnected && !this.snapshot.generatedAt) return;
    const sessions = this.mergeSessions(frame.sessions, frame.removed);
    this.aggregates = retainJson(this.aggregates, frame.aggregates ?? this.aggregates);
    if (Array.isArray(frame.sectors)) this.sectorList = retainJson(this.sectorList, frame.sectors);
    const sources = Array.isArray(frame.sources) ? retainJson(this.snapshot.sources, frame.sources) : this.snapshot.sources;
    this.snapshot = {
      ...this.snapshot,
      generatedAt: Number(frame.at) || Date.now(),
      sessions,
      sectors: this.sectorList,
      sources,
      aggregates: this.aggregates,
      events: this.eventsRing,
      receivedAt: Date.now(),
    };
    for (const fn of this.fleetListeners) fn(this.snapshot);
  }

  private applyTick(frame: FleetTickFrame): void {
    const sessions = this.mergeSessions(frame.sessions);
    const aggregates = retainJson(this.aggregates, frame.aggregates ?? this.aggregates);
    const sources = retainJson(this.snapshot.sources, Array.isArray(frame.sources) ? frame.sources : this.snapshot.sources);
    const fresh = Array.isArray(frame.events) ? frame.events : [];
    const hasChanges = sessions !== this.snapshot.sessions || aggregates !== this.aggregates || sources !== this.snapshot.sources;
    this.aggregates = aggregates;
    if (fresh.length) this.appendEvents(fresh, false);
    if (!fresh.length && !hasChanges) return;
    this.snapshot = {
      ...this.snapshot,
      sessions,
      sources,
      aggregates: this.aggregates,
      events: this.eventsRing,
      receivedAt: Date.now(),
    };
    for (const fn of this.fleetListeners) fn(this.snapshot);
  }

  /** 整机遥测帧：更新当前值 + 历史环，并通知订阅者 */
  private applySystem(frame: SystemFrame): void {
    const snap = frame as SystemSnapshot;
    if (!snap || typeof snap.at !== 'number') return;
    // 重连首帧/REST 兜底可能重发同一采样，不重复入历史或重绘 sparkline。
    if (snap.at === this.system.at && sameJson(this.system, snap)) return;
    this.system = snap;
    if (snap.available) {
      const list = this.systemHistory;
      if (!list.length || list[list.length - 1].at < snap.at) {
        list.push(snap);
      } else {
        // 乱序帧：按 at 有序插入（二分）
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid].at < snap.at) lo = mid + 1;
          else hi = mid;
        }
        if (list[lo]?.at === snap.at) list[lo] = snap;
        else list.splice(lo, 0, snap);
      }
      while (list.length > SYSTEM_HISTORY_MAX) list.shift();
    }
    for (const fn of this.systemListeners) fn(this.system);
  }

  private appendEvents(incoming: AstroEvent[], fromSnapshot: boolean): void {
    const fresh: AstroEvent[] = [];
    const sorted = fromSnapshot
      ? [...incoming].sort((a, b) => a.at - b.at)
      : incoming;
    for (const ev of sorted) {
      if (!ev || !ev.id) continue;
      if (this.eventIds.has(ev.id)) continue;
      this.eventIds.add(ev.id);
      this.eventsRing.push(ev);
      fresh.push(ev);
    }
    if (!fresh.length) return;
    while (this.eventsRing.length > EVENT_RING_MAX) {
      const dropped = this.eventsRing.shift();
      if (dropped) this.eventIds.delete(dropped.id);
    }
    for (const fn of this.eventsListeners) fn(fresh);
  }

  private parse<T>(raw: string): T | null {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.disconnect();
    this.fleetListeners.clear();
    this.eventsListeners.clear();
    this.connectionListeners.clear();
    this.systemListeners.clear();
  }
}
