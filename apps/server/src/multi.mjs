// MultiSource: the live fleet for API v2. It keeps the existing DSH collector
// untouched and merges it with the other local agent tools (Hermes, opencode,
// Claude Code, Codex) into one AgentSession/AstroEvent stream, plus the machine
// telemetry monitor.
//
// Responsibilities:
//  - own the source registry (dsh, hermes, opencode, claude, codex) and its
//    AgentSourceInfo[] projection for /api/fleet;
//  - poll the non-DSH sources on a slow cadence (cheap stat/watermark checks);
//  - merge/denoise events into one globally time-sorted ring (<=2000);
//  - rebuild the whole snapshot on demand (TTL cached) and emit `tick` frames
//    whenever any source produced new events.
//
// The DSH collector keeps its own faster poll loop; we just relay its tick.

import { EventEmitter } from 'node:events';
import { Collector } from './collector.mjs';
import { createClaudeSource } from './sources/claude.mjs';
import { createCodexSource } from './sources/codex.mjs';
import { createHermesSource } from './sources/hermes.mjs';
import { createOpencodeSource } from './sources/opencode.mjs';
import {
  SOURCE_LABELS,
  buildSectors,
  sortSessions,
  sectorIdFor,
  workspaceNameFor,
} from './sources/shared.mjs';
import { SystemMonitor } from './system.mjs';

const SOURCE_ORDER = ['dsh', 'hermes', 'opencode', 'claude', 'codex'];

export class MultiSource extends EventEmitter {
  constructor(config, { log = () => {} } = {}) {
    super();
    this.config = config;
    this.log = log;
    this.kind = 'live';
    this.startedAt = Date.now();
    this.collector = new Collector(config, { log });
    this.secondary = [
      createHermesSource(config, { log }),
      createOpencodeSource(config, { log }),
      createClaudeSource(config, { log }),
      createCodexSource(config, { log }),
    ];
    this.sources = new Map([['dsh', this.collector]]);
    for (const source of this.secondary) this.sources.set(source.id, source);
    this.system = new SystemMonitor(config, { log });
    this.eventRing = [];
    this.seenEvents = new Map();
    this.ringLimit = Math.max(200, config.eventRing ?? 2000);
    this.fleetEventLimit = Math.max(1, config.fleetEventLimit ?? 300);
    this.initInfo = null;
    this.polling = false;
    this.pollTimer = null;
    this.stopped = false;
    this.counters = {
      polls: 0,
      lastPollMs: 0,
      maxPollMs: 0,
      events: 0,
      sourceEvents: 0,
      lastPollAt: 0,
    };
    this.sourceInit = new Map();
    this.collector.on('tick', (tick) => this.onDshTick(tick));
  }

  /* ---------------------------------------------------------------- start */

  async start() {
    const t0 = performance.now();
    const dshStarted = performance.now();
    await this.collector.start();
    const dshMs = Math.round(performance.now() - dshStarted);

    const secondaryStart = performance.now();
    const now = Date.now();
    const results = await Promise.all(
      this.secondary.map(async (source) => {
        try {
          const result = await source.init(now);
          this.sourceInit.set(source.id, result);
          return { id: source.id, ...result };
        } catch (err) {
          const message = String(err?.message ?? err);
          this.log(`[multi] ${source.id} init failed: ${message}`);
          this.sourceInit.set(source.id, { sessions: 0, events: 0, ms: 0, error: message });
          return { id: source.id, sessions: 0, events: 0, ms: 0, error: message };
        }
      }),
    );
    const secondaryMs = Math.round(performance.now() - secondaryStart);

    // Seed the merged event ring: DSH's recent ring plus each source's recent
    // history. These go to the first `fleet` frame only — never to a tick.
    const seeded = [];
    try {
      seeded.push(...this.collector.getEvents());
    } catch {
      /* ignore */
    }
    for (const source of this.secondary) seeded.push(...(source.getEvents?.() ?? []));
    for (const event of seeded) this.mergeEvent(event, seeded);
    this.eventRing.sort((a, b) => a.at - b.at);
    if (this.eventRing.length > this.ringLimit) {
      this.eventRing.splice(0, this.eventRing.length - this.ringLimit);
    }

    this.system.on('sample', (sample) => this.emit('system', sample));
    this.system.start();

    this.startPollLoop();
    this.initInfo = {
      ms: Math.round(performance.now() - t0),
      dshMs,
      secondaryMs,
      sources: results,
      seededEvents: this.eventRing.length,
    };
    const parts = results.map((r) => `${r.id} ${r.sessions}${r.error ? ` E(${r.error})` : ''}`).join(' · ');
    this.log(`[multi] ready in ${this.initInfo.ms}ms · dsh ${dshStarted === 0 ? 0 : dshMs}ms · ${parts} · system ${this.system.available ? 'on' : 'pending'}`);
    return this;
  }

  startPollLoop() {
    const interval = Math.max(200, this.config.sourcePollMs ?? 1000);
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.pollOnce();
      } finally {
        if (!this.stopped) {
          this.pollTimer = setTimeout(tick, interval);
          this.pollTimer.unref?.();
        }
      }
    };
    this.pollTimer = setTimeout(tick, interval);
    this.pollTimer.unref?.();
  }

  async pollOnce(now = Date.now()) {
    if (this.polling || this.stopped) return;
    this.polling = true;
    const t0 = performance.now();
    const fresh = [];
    try {
      const results = await Promise.all(
        this.secondary.map(async (source) => {
          try {
            return await source.poll(now);
          } catch (err) {
            this.log(`[multi] ${source.id} poll failed: ${String(err?.message ?? err)}`);
            return { changed: false, events: [] };
          }
        }),
      );
      for (const result of results) {
        if (result?.events?.length) fresh.push(...result.events);
      }
      this.counters.polls += 1;
      this.counters.sourceEvents += fresh.length;
      this.counters.lastPollAt = now;
      if (fresh.length) this.emitMerged(fresh, now);
    } catch (err) {
      this.log(`[multi] poll crashed: ${String(err?.message ?? err)}`);
    } finally {
      this.counters.lastPollMs = Math.round((performance.now() - t0) * 10) / 10;
      this.counters.maxPollMs = Math.max(this.counters.maxPollMs, this.counters.lastPollMs);
      this.polling = false;
    }
  }

  /** Relay DSH collector ticks through the merged event pipeline. */
  onDshTick(tick) {
    if (this.stopped) return;
    const fresh = (tick?.events ?? []).filter(Boolean);
    if (fresh.length) this.emitMerged(fresh, tick.at ?? Date.now());
  }

  emitMerged(fresh, now) {
    const merged = [];
    for (const event of fresh) {
      const isNew = this.mergeEvent(event, merged);
      if (isNew) merged.push(event);
    }
    if (!merged.length) return;
    let snapshot = null;
    try {
      snapshot = this.buildSnapshot(now);
    } catch (err) {
      this.log(`[multi] snapshot failed: ${String(err?.message ?? err)}`);
    }
    const changedIds = new Set(merged.map((event) => event.sessionId));
    const sessions = snapshot ? snapshot.sessions.filter((s) => changedIds.has(s.id)) : [];
    this.emit('tick', {
      at: now,
      events: merged.sort((a, b) => a.at - b.at),
      sessions,
      aggregates: snapshot?.aggregates ?? null,
    });
  }

  /** Insert one event into the deduped, time-sorted ring. */
  mergeEvent(event, batch = null) {
    if (!event || !event.id) return false;
    if (this.seenEvents.has(event.id)) return false;
    this.seenEvents.set(event.id, event.at);
    if (this.seenEvents.size > 5000) this.pruneSeen();
    const ring = this.eventRing;
    let index = ring.length;
    while (index > 0 && ring[index - 1].at > event.at) index -= 1;
    ring.splice(index, 0, event);
    if (ring.length > this.ringLimit) {
      const dropped = ring.splice(0, ring.length - this.ringLimit);
      for (const item of dropped) this.seenEvents.delete(item.id);
    }
    this.counters.events += 1;
    if (batch) this.counters.sourceEvents += 1;
    return true;
  }

  pruneSeen() {
    const keep = new Set(this.eventRing.map((event) => event.id));
    for (const id of this.seenEvents.keys()) {
      if (!keep.has(id) && this.seenEvents.size > 4000) this.seenEvents.delete(id);
    }
  }

  /* ------------------------------------------------------------- snapshot */

  /** Rebuild the merged fleet snapshot (sessions/sectors/sources/aggregates). */
  buildSnapshot(now = Date.now()) {
    let dshFleet;
    try {
      dshFleet = this.collector.getFleet();
    } catch {
      dshFleet = { sessions: [], sectors: [], aggregates: null };
    }
    const dshSessions = dshFleet.sessions.map((session) => ({
      ...session,
      source: 'dsh',
      sourceLabel: SOURCE_LABELS.dsh,
    }));
    const secondarySessions = [];
    for (const source of this.secondary) {
      for (const session of source.getSessions()) secondarySessions.push(session);
    }
    const sessions = sortSessions([...dshSessions, ...secondarySessions]);
    const dshSectors = (dshFleet.sectors ?? []).map((sector) => ({
      ...sector,
      source: 'dsh',
    }));
    const sectors = [...dshSectors, ...buildSectors(secondarySessions)].sort(
      (a, b) =>
        b.liveCount - a.liveCount ||
        String(a.source).localeCompare(String(b.source)) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
    const aggregates = this.buildAggregates(sessions, dshFleet.aggregates, now);
    return {
      generatedAt: now,
      source: 'live',
      sessions,
      sectors,
      sources: this.buildSourceInfos(sessions),
      aggregates,
      events: this.eventRing.slice(-this.fleetEventLimit),
    };
  }

  buildAggregates(sessions, dshAggregates, now) {
    let liveCount = 0;
    let idleCount = 0;
    let endedCount = 0;
    let maxContextPressure = 0;
    for (const session of sessions) {
      if (session.state === 'live') liveCount += 1;
      else if (session.state === 'idle') idleCount += 1;
      else endedCount += 1;
      if (session.state !== 'ended' && session.contextPressure > maxContextPressure) {
        maxContextPressure = session.contextPressure;
      }
    }
    const errorCount = this.countRecentErrors(now);
    return {
      liveCount,
      idleCount,
      endedCount,
      tokenRate: dshAggregates?.tokenRate ?? 0,
      toolRate: dshAggregates?.toolRate ?? 0,
      errorCount,
      maxContextPressure: Math.round(maxContextPressure * 10_000) / 10_000,
      stamp: now,
    };
  }

  countRecentErrors(now) {
    let count = 0;
    const cutoff = now - 60_000;
    for (let i = this.eventRing.length - 1; i >= 0; i -= 1) {
      const event = this.eventRing[i];
      if (event.at < cutoff) break;
      if (event.kind === 'error') count += 1;
    }
    return count;
  }

  buildSourceInfos(sessions) {
    const stats = new Map();
    for (const session of sessions) {
      let entry = stats.get(session.source);
      if (!entry) {
        entry = { sessions: 0, live: 0, lastActivityAt: 0 };
        stats.set(session.source, entry);
      }
      entry.sessions += 1;
      if (session.state === 'live') entry.live += 1;
      if (session.lastActivityAt > entry.lastActivityAt) entry.lastActivityAt = session.lastActivityAt;
    }
    const infos = [];
    for (const id of SOURCE_ORDER) {
      const source = this.sources.get(id);
      if (!source) continue;
      // The DSH collector has no describe(); the projcache is the source of truth
      // and it is always present when the collector booted, so report it detected.
      const described = source.describe?.() ?? (id === 'dsh'
        ? { state: 'detected', detail: `projcache · ${this.config.dshRoot}` }
        : { state: 'absent', detail: '' });
      const statsForSource = stats.get(id) ?? { sessions: 0, live: 0, lastActivityAt: 0 };
      infos.push({
        id,
        label: SOURCE_LABELS[id] ?? id,
        state: described.state,
        sessions: statsForSource.sessions,
        live: statsForSource.live,
        lastActivityAt: statsForSource.lastActivityAt,
        detail: described.detail ?? '',
      });
    }
    return infos;
  }

  /* ------------------------------------------------------------- read API */

  getFleet() {
    return this.buildSnapshot(Date.now());
  }

  getSessions() {
    return this.buildSnapshot(Date.now()).sessions;
  }

  getSession(id) {
    return this.buildSnapshot(Date.now()).sessions.find((session) => session.id === id) ?? null;
  }

  getEvents(limit = this.fleetEventLimit) {
    const count = Math.min(Math.max(1, limit), this.ringLimit);
    return this.eventRing.slice(-count);
  }

  getSystem() {
    return this.system.getSystem();
  }

  getSystemHistory(limit) {
    return this.system.getHistory(limit);
  }

  getHealth() {
    const snapshot = this.buildSnapshot(Date.now());
    const sources = {};
    try {
      sources.dsh = { id: 'dsh', label: SOURCE_LABELS.dsh, ...(this.collector.getHealth?.() ?? {}) };
    } catch (err) {
      sources.dsh = { id: 'dsh', label: SOURCE_LABELS.dsh, error: String(err?.message ?? err) };
    }
    for (const source of this.secondary) {
      sources[source.id] = source.getHealth?.() ?? { id: source.id };
    }
    return {
      ok: true,
      source: 'live',
      generatedAt: Date.now(),
      uptimeMs: Date.now() - this.startedAt,
      booted: true,
      polling: !this.polling,
      dshRoot: this.config.dshRoot,
      pollMs: this.config.pollMs,
      sourcePollMs: this.config.sourcePollMs,
      poll: { ...this.counters },
      sessions: {
        total: snapshot.sessions.length,
        ...snapshot.aggregates,
      },
      sources,
      sourceInfo: snapshot.sources,
      system: this.system.getHealth(),
      events: {
        ring: this.eventRing.length,
        ringMax: this.ringLimit,
      },
      init: this.initInfo,
    };
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    try {
      this.collector.stop();
    } catch {
      /* ignore */
    }
    for (const source of this.secondary) {
      try {
        source.stop?.();
      } catch {
        /* ignore */
      }
    }
    this.system.removeAllListeners('sample');
    this.system.stop();
    this.removeAllListeners('tick');
  }
}
