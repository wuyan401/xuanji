// The live collector: polls DSH's projection cache + event logs, merges them
// into one in-memory fleet state, and emits tick batches for the SSE layer.
//
// Data flow:
//   projcache/*.json  -> ProjCache.poll()  -> deriveSnapshot()   \
//   sessions/*.zstd   -> EventLogTailer    -> event-derived state > projectSession() -> AgentSession
//   token deltas      -> RateTracker                              /        -> Aggregates / AstroEvents
//
// Failure policy: a broken file is logged (rate-limited) and never aborts the
// poll. Memory is bounded: event ring (default 2000), per-session tool maps are
// trimmed, rate samples live inside a 60 s window.

import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadConfig } from './config.mjs';
import {
  cleanText, ms, nowMs, summarizeArgs, toolArgHint, userMessageText,
  assistantText, toolResultText, tail, nextId,
} from './util.mjs';
import { categorizeTool, emptyToolCounts } from './tools.mjs';
import { ProjCache } from './projcache.mjs';
import { EventLogTailer } from './eventlog.mjs';
import { RateTracker } from './metrics.mjs';
import {
  deriveSnapshot, emptyEventState, projectSession, projectSectors, projectAggregates,
} from './fleet.mjs';
import { WorkspaceIndex } from './workspace.mjs';

const STATE_RANK = { live: 0, idle: 1, ended: 2 };
/** preload events older than this are not put on the first-screen ledger */
const PRELOAD_EVENT_TTL = 10 * 60_000;

export class Collector extends EventEmitter {
  /** @param {ReturnType<typeof loadConfig>} [config] */
  constructor(config = loadConfig(), { log = console.log } = {}) {
    super();
    this.config = config;
    this.log = log;

    this.projcache = new ProjCache({ dir: config.projcacheDir, log });
    this.eventlog = new EventLogTailer({
      root: config.eventsRoot,
      log,
      recentMs: config.idleMs,
      tailBytes: config.tailBytes,
      readBudgetPerPoll: config.readBudgetPerPoll,
    });
    this.eventlog.onEvents = (sessionId, events, meta) => this.handleEvents(sessionId, events, meta);

    this.workspaceIndex = new WorkspaceIndex();
    /** @type {Map<string, any>} sessionId -> collector state */
    this.states = new Map();
    /** @type {Map<string, any>} sessionId -> last projected AgentSession */
    this.projected = new Map();
    /** @type {any[]} AstroEvent ring */
    this.events = [];
    /** @type {any[]} events accumulated since the last emitted tick */
    this.batch = [];

    this.liveRate = new RateTracker({ startAt: nowMs() });
    this.counters = {
      errors: 0, approvals: 0, toolCalls: 0, events: 0,
      polls: 0, lastPollMs: 0, maxPollMs: 0, lastPollAt: 0,
      eventLoopLagMs: 0,
    };
    this.parentById = new Map();
    this.depthById = new Map();
    this.aggregates = {
      liveCount: 0, idleCount: 0, endedCount: 0,
      tokenRate: 0, toolRate: 0, errorCount: 0, maxContextPressure: 0, stamp: 0,
    };

    this.running = false;
    this.inited = false;
    this.booting = null;
    this.timer = null;
    this.inFlight = null;
    this.bootAt = 0;
    this.initAt = 0;
    this.initStats = null;
    this.lastWorkspaceLoad = 0;
    this.localEventSeq = 0;
  }

  // -------------------------------------------------------------------------
  // boot / lifecycle
  // -------------------------------------------------------------------------

  /** Initial full scan. Safe to call twice (returns the same promise). */
  init() {
    if (this.booting) return this.booting;
    this.booting = this.doInit();
    return this.booting;
  }

  async doInit() {
    const t0 = performance.now();
    this.bootAt = nowMs();
    this.initAt = this.bootAt;

    try {
      this.workspaceIndex = await WorkspaceIndex.load(this.config.workspaceFile);
    } catch (err) {
      this.log(`[collector] workspace index failed: ${err?.message ?? err}`);
    }
    this.lastWorkspaceLoad = nowMs();

    const projStats = await this.projcache.init();
    for (const [sessionId] of this.projcache.sessions) {
      const item = this.projcache.sessions.get(sessionId);
      this.ensureState(sessionId);
      this.refreshSnapshot(sessionId, item.record, item.mtimeMs);
    }

    const evStats = await this.eventlog.init(this.bootAt);

    this.recomputeHierarchy();
    this.reprojectAll(nowMs());
    this.recomputeAggregates(nowMs());
    this.initStats = {
      ms: performance.now() - t0,
      projcache: { files: projStats.files, sessions: projStats.sessions, ms: projStats.ms },
      events: { files: evStats.files, preloaded: evStats.preloaded, frames: evStats.frames, events: evStats.events, ms: evStats.ms },
    };
    this.inited = true;
    this.log(
      `[collector] ready in ${ms(this.initStats.ms)} · ${projStats.sessions} sessions ` +
      `(projcache ${ms(projStats.ms)}) · events ${evStats.preloaded}/${evStats.files} files tailed ` +
      `(${evStats.frames} frames / ${evStats.events} events in ${ms(evStats.ms)})`,
    );
    return this.initStats;
  }

  /** Boot (if needed) then start polling. */
  async start() {
    if (!this.inited) await this.init();
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  loop() {
    if (!this.running) return;
    this.inFlight = this.tickOnce()
      .catch((err) => {
        this.log(`[collector] poll failed: ${err?.stack ?? err}`);
      })
      .finally(() => {
        this.inFlight = null;
        if (this.running) {
          this.timer = setTimeout(() => this.loop(), this.config.pollMs);
          if (this.timer.unref) this.timer.unref();
        }
      });
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight.catch(() => {});
  }

  // -------------------------------------------------------------------------
  // one poll
  // -------------------------------------------------------------------------

  async tickOnce() {
    const t0 = performance.now();
    const now = nowMs();
    this.counters.polls += 1;

    // 1) projection cache (the authoritative "full state" per session)
    let projPoll = { changed: [], added: [], removed: [], stats: { parsed: 0, ms: 0 } };
    try {
      projPoll = await this.projcache.poll();
    } catch (err) {
      this.log(`[collector] projcache poll failed: ${err?.message ?? err}`);
    }
    for (const sessionId of [...projPoll.added, ...projPoll.changed]) {
      const item = this.projcache.sessions.get(sessionId);
      if (!item) continue;
      this.ensureState(sessionId);
      this.refreshSnapshot(sessionId, item.record, item.mtimeMs);
    }
    for (const sessionId of projPoll.removed) {
      const state = this.states.get(sessionId);
      if (state) {
        state.missing = true;
        state.markedDirty = true;
      }
    }

    // 2) workspace index refresh (cheap file, changes when sessions are listed)
    if (now - this.lastWorkspaceLoad > this.config.workspaceRefreshMs) {
      this.lastWorkspaceLoad = now;
      try {
        const next = await WorkspaceIndex.load(this.config.workspaceFile);
        this.workspaceIndex = next;
        // 只有归属真的变了才把会话标记为 dirty:否则每 15s 全量重推 123 条
        // session 到 tick 帧里,白白撑大 SSE。
        let anyChanged = false;
        for (const state of this.states.values()) {
          if (this.assignWorkspace(state)) {
            state.markedDirty = true;
            anyChanged = true;
          }
        }
        if (anyChanged) this.recomputeHierarchy();
      } catch (err) {
        this.log(`[collector] workspace refresh failed: ${err?.message ?? err}`);
      }
    }

    // 3) event log (incremental zstd frame tailing)
    let evPoll = { frames: 0, events: 0, bytes: 0, backlog: 0 };
    try {
      evPoll = await this.eventlog.poll(now);
    } catch (err) {
      this.log(`[collector] event poll failed: ${err?.message ?? err}`);
    }

    // 4) hierarchy + projections + state transitions
    this.recomputeHierarchy();
    const changedSessions = this.reprojectAll(now);
    const aggregates = this.recomputeAggregates(now);
    this.aggregates = aggregates;

    // 5) emit one tick per poll (events may be empty; aggregates keep rates live)
    const batchEvents = this.batch;
    this.batch = [];
    if (batchEvents.length > 1) batchEvents.sort((a, b) => a.at - b.at);
    const tick = {
      at: now,
      events: batchEvents,
      sessions: changedSessions,
      aggregates,
    };
    if (batchEvents.length || changedSessions.length) {
      for (const fn of this.listeners('tick')) {
        try {
          fn(tick);
        } catch (err) {
          this.log(`[collector] tick listener failed: ${err?.message ?? err}`);
        }
      }
    }

    // 6) timing + counters
    const elapsed = performance.now() - t0;
    this.counters.lastPollMs = elapsed;
    this.counters.lastPollAt = now;
    if (elapsed > this.counters.maxPollMs) this.counters.maxPollMs = elapsed;
    if (this.config.logPoll) {
      this.log(
        `[collector] poll ${ms(elapsed)} · read ${projPoll.stats.parsed} · ` +
        `ev ${evPoll.events}/${evPoll.frames}f · tick ev ${batchEvents.length} sess ${changedSessions.length} · ` +
        `fleet ${this.projected.size} live ${aggregates.liveCount} rate ${aggregates.tokenRate} t/s`,
      );
    }
    return { elapsed, projPoll, evPoll };
  }

  // -------------------------------------------------------------------------
  // state maintenance
  // -------------------------------------------------------------------------

  ensureState(sessionId) {
    let state = this.states.get(sessionId);
    if (state) return state;
    state = {
      id: sessionId,
      snap: null,
      ev: emptyEventState(),
      rate: new RateTracker({ startAt: nowMs(), windowMs: 60_000 }),
      mtimeMs: 0,
      tokenSeen: null,
      archived: false,
      missing: false,
      wsId: null,
      workspaceName: '未知星域',
      prevState: null,
      markedDirty: true,
      projected: null,
    };
    this.states.set(sessionId, state);
    return state;
  }

  /** Re-resolve a session's workspace; returns true when it actually changed. */
  assignWorkspace(state) {
    if (!state.snap) return false;
    try {
      const ws = this.workspaceIndex.assign(state.id, state.snap.cwd);
      const changed = state.wsId !== ws.id || state.workspaceName !== ws.name;
      state.wsId = ws.id;
      state.workspaceName = ws.name;
      return changed;
    } catch (err) {
      this.log(`[collector] workspace assign failed: ${err?.message ?? err}`);
      return false;
    }
  }

  refreshSnapshot(sessionId, record, mtimeMs) {
    const state = this.ensureState(sessionId);
    try {
      const snap = deriveSnapshot(sessionId, record);
      state.snap = snap;
      state.mtimeMs = mtimeMs || 0;
      state.missing = false;
      state.archived = this.workspaceIndex.archived.has(sessionId);
      this.assignWorkspace(state);

      // token delta -> rolling window (timestamps come from the snapshot write)
      const output = snap.tokens.output;
      if (state.tokenSeen != null && output > state.tokenSeen) {
        const delta = output - state.tokenSeen;
        const at = mtimeMs || nowMs();
        state.rate.add(at, { tokens: delta });
        this.liveRate.add(at, { tokens: delta });
      }
      state.tokenSeen = output;
      state.markedDirty = true;
    } catch (err) {
      this.log(`[collector] snapshot derive failed for ${sessionId}: ${err?.message ?? err}`);
    }
  }

  /** Compute parent/depth maps from every known team roster. */
  recomputeHierarchy() {
    const parentById = new Map();
    for (const state of this.states.values()) {
      const members = state.snap?.team?.memberIds;
      if (!members) continue;
      for (const memberId of members) {
        if (memberId && memberId !== state.id) parentById.set(memberId, state.id);
      }
    }
    const depthById = new Map();
    const depthOf = (id, guard = 0) => {
      if (depthById.has(id)) return depthById.get(id);
      const parent = parentById.get(id);
      const depth = parent && guard < 8 ? depthOf(parent, guard + 1) + 1 : 0;
      depthById.set(id, depth);
      return depth;
    };
    for (const state of this.states.values()) depthOf(state.id);

    const changed =
      parentById.size !== this.parentById.size ||
      [...parentById].some(([k, v]) => this.parentById.get(k) !== v);
    this.parentById = parentById;
    this.depthById = depthById;
    if (changed) {
      for (const state of this.states.values()) state.markedDirty = true;
    }
  }

  /** Re-project every session; returns sessions with meaningful changes. */
  reprojectAll(now) {
    const ctx = {
      liveMs: this.config.liveMs,
      idleMs: this.config.idleMs,
      windowSec: this.liveRate.spanSec(now),
      parentById: this.parentById,
      depthById: this.depthById,
    };
    const changed = [];
    for (const state of this.states.values()) {
      if (!state.snap) continue;
      let projected;
      try {
        projected = projectSession(state, now, ctx);
      } catch (err) {
        this.log(`[collector] project failed for ${state.id}: ${err?.message ?? err}`);
        continue;
      }
      const prev = this.projected.get(state.id);
      const prevState = prev?.state ?? null;
      this.projected.set(state.id, projected);
      state.projected = projected;

      const transition = prevState && prevState !== projected.state;
      if (transition) {
        this.pushSyntheticEvent(state, projected, now);
      }
      // Sessions that flip state, changed content, or are currently live need
      // to reach the client every tick; live ones because rates/openStep move.
      const dirty = state.markedDirty || !prev;
      state.markedDirty = false;
      if (dirty || transition || projected.state === 'live') changed.push(projected);
      state.prevState = projected.state;
    }
    return changed;
  }

  pushSyntheticEvent(state, projected, now) {
    const kind = projected.state === 'live' ? 'session/live' : projected.state === 'ended' ? 'session/ended' : null;
    if (!kind) return;
    this.pushAstroEvent({
      id: `evt-sess-${state.id}-${now.toString(36)}`,
      at: now,
      kind,
      source: 'dsh',
      sessionId: state.id,
      sessionTitle: projected.title,
      tool: null,
      toolCategory: null,
      detail: projected.state === 'live' ? '开始活动' : projected.state === 'ended' ? '会话结束' : null,
      isError: null,
      turn: projected.openStep?.turn ?? null,
      step: projected.openStep?.step ?? null,
      durationMs: null,
    });
  }

  recomputeAggregates(now) {
    const all = [...this.projected.values()];
    return projectAggregates(all, this.liveRate, this.counters, now);
  }

  // -------------------------------------------------------------------------
  // event ingestion
  // -------------------------------------------------------------------------

  handleEvents(sessionId, rawEvents, meta = {}) {
    const state = this.states.get(sessionId);
    if (!state) return;
    const preload = Boolean(meta.preload);
    const cutoff = preload ? this.initAt - PRELOAD_EVENT_TTL : 0;
    for (const raw of rawEvents) {
      const at = Math.round(Number(raw.time) || 0);
      if (!at) continue;
      if (preload && at < cutoff) continue;
      try {
        this.ingestEvent(state, raw, at, preload);
      } catch (err) {
        this.log(`[collector] bad event ${raw?.type} in ${sessionId}: ${err?.message ?? err}`);
      }
    }
  }

  ingestEvent(state, raw, at, preload) {
    const type = raw.type;
    const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
    const ev = state.ev;
    if (at > ev.lastAt) ev.lastAt = at;
    const seq = Number(raw.seq) || this.localEventSeq++;
    let astro = null;

    switch (type) {
      case 'step/start': {
        const turn = Number(data.turn) || 0;
        const step = Number(data.step) || 0;
        ev.openStep = { turn, step, startedAt: at, firstTokenAt: null };
        ev.stepStarts.set(`${turn}:${step}`, at);
        if (ev.stepStarts.size > 400) ev.stepStarts.delete(ev.stepStarts.keys().next().value);
        astro = this.astro(state, { at, kind: 'step/start', turn, step, seq });
        break;
      }
      case 'step/end': {
        const turn = Number(data.turn) || 0;
        const step = Number(data.step) || 0;
        const startedAt = ev.stepStarts.get(`${turn}:${step}`) || ev.openStep?.startedAt;
        if (ev.openStep && ev.openStep.turn === turn && ev.openStep.step === step) ev.openStep = null;
        astro = this.astro(state, {
          at, kind: 'step/end', turn, step, seq,
          durationMs: startedAt ? at - startedAt : null,
        });
        break;
      }
      case 'turn/start': {
        const turn = Number(data.turn) || 0;
        ev.turnStarts.set(turn, at);
        if (ev.turnStarts.size > 100) ev.turnStarts.delete(ev.turnStarts.keys().next().value);
        astro = this.astro(state, { at, kind: 'turn/start', turn, seq });
        break;
      }
      case 'turn/end': {
        const turn = Number(data.turn) || 0;
        const startedAt = ev.turnStarts.get(turn);
        ev.openStep = null;
        ev.turnStarts.delete(turn);
        astro = this.astro(state, {
          at, kind: 'turn/end', turn, seq,
          durationMs: startedAt ? at - startedAt : null,
        });
        break;
      }
      case 'tool/call': {
        const callId = String(data.callId ?? '');
        const name = typeof data.name === 'string' ? data.name : 'unknown';
        if (callId) {
          ev.pending.set(callId, { name, at });
          ev.toolNames.set(callId, name);
          ev.callAt.set(callId, at);
          if (ev.toolNames.size > 600) ev.toolNames.delete(ev.toolNames.keys().next().value);
          if (ev.callAt.size > 600) ev.callAt.delete(ev.callAt.keys().next().value);
          if (ev.pending.size > 40) ev.pending.delete(ev.pending.keys().next().value);
        }
        const category = categorizeTool(name);
        if (category) ev.toolCounts[category] += 1;
        this.counters.toolCalls += 1;
        this.liveRate.add(at, { tools: 1 });
        const hint = toolArgHint(name, data.arguments);
        astro = this.astro(state, {
          at, kind: 'tool/call', turn: Number(data.turn) || null, step: Number(data.step) || null,
          tool: name, toolCategory: category, detail: hint, seq,
        });
        break;
      }
      case 'tool/result': {
        const callId = String(data.toolCallId ?? data.message?.source?.callId ?? '');
        const info = ev.pending.get(callId);
        const name = info?.name || ev.toolNames.get(callId) || null;
        const category = categorizeTool(name);
        const startedAt = ev.callAt.get(callId) || info?.at;
        ev.pending.delete(callId);
        ev.callAt.delete(callId);
        const isError = Boolean(data.isError);
        const text = toolResultText(data.message);
        if (isError) {
          this.counters.errors += 1;
          if (ev) ev.errors += 1;
        }
        astro = this.astro(state, {
          at,
          kind: isError ? 'error' : 'tool/result',
          turn: Number(data.turn) || null,
          step: Number(data.step) || null,
          tool: name,
          toolCategory: category,
          detail: summarizeArgs(text, 120),
          isError,
          durationMs: startedAt ? at - startedAt : null,
          seq,
        });
        break;
      }
      case 'approval/asked': {
        this.counters.approvals += 1;
        const toolName = typeof data.toolName === 'string' ? data.toolName : null;
        const reason = cleanText(typeof data.reason === 'string' ? data.reason : '', 100);
        astro = this.astro(state, {
          at, kind: 'approval', tool: toolName, toolCategory: categorizeTool(toolName),
          detail: reason || '等待审批', isError: null, seq,
        });
        break;
      }
      case 'assistant/message': {
        const text = assistantText(data.message);
        if (text) ev.lastAssistantText = cleanText(text, 400);
        const stream = Array.isArray(data.stream) ? data.stream : [];
        const firstChunkTime = Number(stream[0]?.time) || null;
        const turn = Number(data.turn);
        const step = Number(data.step);
        if (ev.openStep && ev.openStep.turn === turn && ev.openStep.step === step && !ev.openStep.firstTokenAt && firstChunkTime) {
          ev.openStep.firstTokenAt = firstChunkTime;
        }
        break;
      }
      case 'user/message': {
        const text = userMessageText(data);
        if (text) ev.lastUserText = cleanText(text, 400);
        break;
      }
      default:
        break;
    }

    if (astro) this.pushAstroEvent(astro, !preload);
  }

  /** Assemble one contract AstroEvent. */
  astro(state, parts) {
    const title = state.snap?.title ?? state.id;
    return {
      id: `evt-${state.id}-${parts.seq ?? this.localEventSeq++}`,
      at: Math.round(parts.at) || 0,
      kind: parts.kind,
      // Every event declares which agent source produced it (contract v2).
      source: 'dsh',
      sessionId: state.id,
      sessionTitle: title,
      tool: parts.tool ?? null,
      toolCategory: parts.toolCategory ?? null,
      detail: parts.detail ? cleanText(parts.detail, 120) : null,
      isError: parts.isError ?? null,
      turn: parts.turn ?? null,
      step: parts.step ?? null,
      durationMs: parts.durationMs == null ? null : Math.round(parts.durationMs),
    };
  }

  pushAstroEvent(astro, emit = true) {
    // Keep the ring chronologically ordered by `at`. Almost all events arrive in
    // order (append at the tail, O(1)); late events recovered from the zstd tailer
    // (older sessions scanned later) are inserted in place so snapshots stay sorted.
    const ev = this.events;
    const n = ev.length;
    if (n === 0 || ev[n - 1].at <= astro.at) {
      ev.push(astro);
    } else {
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ev[mid].at <= astro.at) lo = mid + 1;
        else hi = mid;
      }
      ev.splice(lo, 0, astro);
    }
    this.counters.events += 1;
    if (ev.length > this.config.eventRing) {
      ev.splice(0, ev.length - this.config.eventRing);
    }
    // Preloaded history only backfills the ring; it must not be re-sent as a
    // live tick (the first `fleet` frame already carries those events).
    if (emit) this.batch.push(astro);
  }

  // -------------------------------------------------------------------------
  // public read API (same surface as DemoSource / ReplaySource)
  // -------------------------------------------------------------------------

  getFleet() {
    const now = nowMs();
    const sessions = [...this.projected.values()].sort(
      (a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || b.lastActivityAt - a.lastActivityAt,
    );
    const aggregates = this.recomputeAggregates(now);
    this.aggregates = aggregates;
    return {
      generatedAt: now,
      source: 'live',
      sessions,
      sectors: projectSectors(this.workspaceIndex, sessions),
      aggregates,
      events: tail(this.events, this.config.fleetEventLimit),
    };
  }

  getSessions() {
    return [...this.projected.values()];
  }

  getSession(id) {
    return this.projected.get(id) ?? null;
  }

  getEvents(limit = 100) {
    return tail(this.events, Math.max(1, Math.min(limit, this.config.eventRing)));
  }

  getHealth() {
    const now = nowMs();
    const proj = this.projcache.summary?.() ?? { files: 0, sessions: 0, errors: 0 };
    const evStats = this.eventlog.stats ?? {};
    return {
      ok: true,
      source: 'live',
      generatedAt: now,
      uptimeMs: this.bootAt ? now - this.bootAt : 0,
      booted: this.inited,
      polling: this.running,
      dshRoot: this.config.dshRoot,
      pollMs: this.config.pollMs,
      poll: {
        count: this.counters.polls,
        lastMs: Math.round(this.counters.lastPollMs * 10) / 10,
        maxMs: Math.round(this.counters.maxPollMs * 10) / 10,
      },
      sessions: {
        total: this.states.size,
        projected: this.projected.size,
        ...this.aggregates,
      },
      rates: {
        tokenPerSec: this.aggregates.tokenRate,
        toolPerSec: this.aggregates.toolRate,
        tokenPerMin: Math.round(this.liveRate.tokensPerMin(now) * 10) / 10,
        toolPerMin: Math.round(this.liveRate.toolsPerMin(now) * 10) / 10,
        windowSec: Math.round(this.liveRate.spanSec(now) * 10) / 10,
      },
      events: {
        ring: this.events.length,
        ringMax: this.config.eventRing,
        frames: evStats.frames ?? 0,
        bytes: evStats.bytes ?? 0,
        backlog: evStats.backlog ?? 0,
        cursors: this.eventlog.cursorSummary(),
      },
      sources: {
        projcache: { ...proj, dir: this.config.projcacheDir },
        events: { ...this.eventlog.cursorSummary(), dir: this.config.eventsRoot },
        workspaces: this.workspaceIndex.list().length,
      },
      counters: { ...this.counters },
      init: this.initStats,
    };
  }
}

/** Convenience: build a collector from env/argv and boot it in the background. */
export function createCollector(config = loadConfig(), opts = {}) {
  const collector = new Collector(config, opts);
  const ready = collector.init();
  return { collector, ready };
}

export { path, nextId, emptyToolCounts };
