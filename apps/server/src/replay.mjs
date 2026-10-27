// Replay source: serves a previously captured fleet from disk as a time series.
// Accepted file shapes (all lenient):
//   - one JSON object with `sessions`            -> a single frozen frame
//   - one JSON object with `frames: [...]`       -> a series of frames
//   - one JSON array of objects with `sessions`  -> a series of frames
//   - JSONL: one frame (object with `sessions`) or one AstroEvent per line
// Each frame may carry `generatedAt`, `sessions`, `sectors`, `aggregates` and
// `events` (AstroEvent[]). Frames loop forever unless `replayLoop` is false.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { nowMs, tail } from './util.mjs';
import { projectSectors, projectAggregates } from './fleet.mjs';
import { RateTracker } from './metrics.mjs';
import { WorkspaceIndex } from './workspace.mjs';
import { SOURCE_LABELS } from './sources/shared.mjs';

const RING = 2000;
const FLEET_EVENTS = 300;
const SOURCE_ORDER = ['dsh', 'hermes', 'opencode', 'claude', 'codex'];

/** Source id encoded in a global session id (`hermes:xxx`), else 'dsh'. */
function sourceOfSessionId(sessionId) {
  if (typeof sessionId === 'string') {
    const colon = sessionId.indexOf(':');
    if (colon > 0) {
      const candidate = sessionId.slice(0, colon);
      if (SOURCE_LABELS[candidate]) return candidate;
    }
  }
  return 'dsh';
}

/** Backfill `source`/`sourceLabel` on replayed sessions so old dumps still work. */
function normalizeSessions(sessions) {
  return sessions.map((session) => {
    if (session.source) return session;
    const source = sourceOfSessionId(session.id);
    return { ...session, source, sourceLabel: SOURCE_LABELS[source] ?? source };
  });
}

function normalizeEvents(events) {
  return events.map((event) => {
    if (event.source) return event;
    const source = sourceOfSessionId(event.sessionId);
    return { ...event, source };
  });
}

/** AgentSourceInfo[] computed from whatever a replay frame happens to carry. */
function buildSourceInfos(sessions) {
  const stats = new Map();
  for (const session of sessions) {
    let entry = stats.get(session.source);
    if (!entry) {
      entry = { sessions: 0, live: 0, lastActivityAt: 0 };
      stats.set(session.source, entry);
    }
    entry.sessions += 1;
    if (session.state === 'live') entry.live += 1;
    if ((session.lastActivityAt ?? 0) > entry.lastActivityAt) entry.lastActivityAt = session.lastActivityAt;
  }
  return SOURCE_ORDER.map((id) => {
    const entry = stats.get(id) ?? { sessions: 0, live: 0, lastActivityAt: 0 };
    return {
      id,
      label: SOURCE_LABELS[id] ?? id,
      state: entry.sessions > 0 ? 'detected' : 'absent',
      sessions: entry.sessions,
      live: entry.live,
      lastActivityAt: entry.lastActivityAt,
      detail: entry.sessions > 0 ? `replay 回放 · ${entry.sessions} 会话` : `回放数据中没有 ${id} 会话`,
    };
  });
}

function normalizeFrame(raw, index, fallbackAt) {
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  const events = Array.isArray(raw.events) ? raw.events.filter((e) => e && e.id && e.at) : [];
  const generatedAt = Number(raw.generatedAt) || fallbackAt || index * 1000;
  return {
    generatedAt,
    sessions,
    sectors: Array.isArray(raw.sectors) ? raw.sectors : null,
    aggregates: raw.aggregates && typeof raw.aggregates === 'object' ? raw.aggregates : null,
    events,
  };
}

function parseReplayFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSONL
  }

  let frames = [];
  let looseEvents = [];
  if (parsed && !Array.isArray(parsed)) {
    if (Array.isArray(parsed.frames)) frames = parsed.frames;
    else if (Array.isArray(parsed.sessions)) frames = [parsed];
  } else if (Array.isArray(parsed)) {
    frames = parsed;
  } else {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (Array.isArray(row.sessions)) frames.push(row);
      else if (row.kind && row.sessionId) looseEvents.push(row);
    }
    if (looseEvents.length && !frames.length) {
      // event-only log: one frame, undated sessions are not replayable
      frames = [{ sessions: [], events: looseEvents }];
    } else if (looseEvents.length) {
      frames[frames.length - 1].events = frames[frames.length - 1].events.concat(looseEvents);
    }
  }

  frames = frames.filter((f) => f && typeof f === 'object');
  if (!frames.length) {
    throw new Error(`replay file has no sessions or frames: ${file}`);
  }
  return frames.map((f, i) => normalizeFrame(f, i));
}

export class ReplaySource extends EventEmitter {
  constructor(config = {}, { log = () => {} } = {}) {
    super();
    this.config = config;
    this.log = log;
    this.source = 'replay';
    this.file = config.replayFile;
    this.frames = [];
    this.cursor = 0;
    this.ring = [];
    this.seenEvents = new Set();
    this.rate = new RateTracker({ startAt: nowMs() });
    this.counter = 0;
    this.counters = { errors: 0, approvals: 0, toolCalls: 0, events: 0, polls: 0 };
    this.aggregates = {
      liveCount: 0, idleCount: 0, endedCount: 0,
      tokenRate: 0, toolRate: 0, errorCount: 0, maxContextPressure: 0, stamp: 0,
    };
    this.timer = null;
    this.running = false;
    this.bootAt = 0;
    this.workspaceIndex = new WorkspaceIndex();
  }

  async init() {
    this.bootAt = nowMs();
    if (!this.file) throw new Error('replay mode requires --replay <file>');
    this.frames = parseReplayFile(this.file);
    this.frameMs = Number(this.config.replayFrameMs) || Math.max(400, Math.floor(Number(this.config.fleetFrameMs) || 1000));
    this.loop = this.config.replayLoop !== false;
    this.cursor = 0;
    this.applyFrame(0, true);
    this.log(`[replay] loaded ${this.frames.length} frame(s) from ${this.file} · ${this.frameMs}ms/frame`);
    return { frames: this.frames.length, frameMs: this.frameMs };
  }

  applyFrame(index, initial = false) {
    const frame = this.frames[index];
    this.cursor = index;
    const now = nowMs();
    // merge events into the ring (stable id de-dup)
    const fresh = [];
    for (const event of normalizeEvents(frame.events)) {
      if (this.seenEvents.has(event.id)) continue;
      this.seenEvents.add(event.id);
      this.ring.push(event);
      fresh.push(event);
      if (event.kind === 'error') this.counters.errors += 1;
      if (event.kind === 'approval') this.counters.approvals += 1;
      if (event.kind === 'tool/call') this.counters.toolCalls += 1;
    }
    this.counters.events += fresh.length;
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    if (fresh.length > 1) fresh.sort((a, b) => a.at - b.at);

    const sessions = normalizeSessions(frame.sessions);
    if (frame.aggregates) {
      this.aggregates = { ...frame.aggregates, stamp: now };
    } else {
      const wsIndex = this.workspaceIndex;
      for (const session of sessions) {
        try {
          wsIndex.assign(session.id, session.cwd);
        } catch {
          /* ignore */
        }
      }
      const winSec = 60;
      this.aggregates = projectAggregates(
        sessions,
        { tokensPerSec: () => 0, toolsPerSec: () => 0 },
        { errors: this.counters.errors },
        now,
      );
      void winSec;
    }
    this.sessions = sessions;
    this.currentSectors = frame.sectors
      ? frame.sectors.map((sector) => (sector.source ? sector : { ...sector, source: 'dsh' }))
      : null;
    this.counters.polls += 1;
    if (!initial && (fresh.length || sessions.length)) {
      const tick = { at: now, events: fresh, sessions, aggregates: this.aggregates };
      for (const fn of this.listeners('tick')) {
        try {
          fn(tick);
        } catch (err) {
          this.log(`[replay] tick listener failed: ${err.message}`);
        }
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      if (!this.frames.length) return;
      let next = this.cursor + 1;
      if (next >= this.frames.length) {
        if (!this.loop) {
          this.stop();
          return;
        }
        next = 0;
        this.seenEvents.clear();
        this.ring = [];
      }
      this.applyFrame(next);
    }, this.frameMs);
    if (this.timer.unref) this.timer.unref();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getFleet() {
    const now = nowMs();
    const sessions = this.sessions ?? [];
    let sectors = this.currentSectors;
    if (!sectors) {
      try {
        sectors = projectSectors(this.workspaceIndex, sessions);
      } catch {
        sectors = [];
      }
    }
    return {
      generatedAt: now,
      source: 'replay',
      sessions,
      sectors,
      sources: buildSourceInfos(sessions),
      aggregates: { ...this.aggregates, stamp: now },
      events: tail(this.ring, FLEET_EVENTS),
    };
  }

  getSessions() {
    return this.sessions ?? [];
  }

  getSession(id) {
    return (this.sessions ?? []).find((s) => s.id === id) ?? null;
  }

  getEvents(limit = 100) {
    return tail(this.ring, Math.max(1, limit));
  }

  getHealth() {
    const now = nowMs();
    return {
      ok: true,
      source: 'replay',
      generatedAt: now,
      uptimeMs: this.bootAt ? now - this.bootAt : 0,
      booted: this.frames.length > 0,
      polling: this.running,
      pollMs: this.frameMs ?? 1000,
      poll: { count: this.counters.polls, lastMs: 1, maxMs: 3 },
      sessions: {
        total: this.frames[this.cursor]?.sessions.length ?? 0,
        projected: this.sessions?.length ?? 0,
        ...this.aggregates,
      },
      rates: {
        tokenPerSec: this.aggregates.tokenRate,
        toolPerSec: this.aggregates.toolRate,
        tokenPerMin: Math.round(this.aggregates.tokenRate * 60 * 10) / 10,
        toolPerMin: Math.round(this.aggregates.toolRate * 60 * 10) / 10,
        windowSec: 60,
      },
      events: { ring: this.ring.length, ringMax: RING, frames: this.counters.events, bytes: 0, backlog: 0 },
      sources: { mode: 'replay', file: this.file, frames: this.frames.length, cursor: this.cursor },
      counters: { ...this.counters },
      init: { frames: this.frames.length, frameMs: this.frameMs },
    };
  }
}

export async function createReplaySource(config = {}, opts = {}) {
  const replay = new ReplaySource(config, opts);
  await replay.init();
  replay.start();
  return replay;
}
