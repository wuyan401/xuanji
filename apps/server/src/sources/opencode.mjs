// opencode source: reads the local opencode SQLite database read-only and maps
// its session / message / part tables into the unified fleet.
//
// opencode stores nested data as JSON TEXT columns:
//   session.model  -> {"id":"deepseek-v4-flash","providerID":…,"variant":…}
//   message.data   -> {role, tokens:{input,output,reasoning,cache:{read,write}}, path:{cwd}, modelID, finish}
//   part.data      -> {type:'tool'|'text'|'step-start'|'step-finish'|'reasoning', …}
//
// Mapping decisions (docs/DATA-CONTRACT.md v2):
//   id           opencode:<session.id>
//   title        session.title
//   workspace    basename(session.directory)
//   turns        count(message.data.role='user')
//   steps        count(message.data.role='assistant')
//   tokens       session.tokens_input / tokens_output / tokens_cache_read / tokens_cache_write
//   toolCounts   part.data.type='tool' -> part.data.tool
//   lastPrompt   newest user text part
//   lastResponse newest assistant text part
// Incremental strategy: part.time_updated watermark; file stat is checked first
// so a quiet DB costs ~0ms per poll.

import fs from 'node:fs';
import { loadSqlite } from './sqlite.mjs';
import { categorizeTool, emptyToolCounts } from '../tools.mjs';
import { cleanText } from '../util.mjs';
import {
  SOURCE_LABELS,
  addToolCount,
  deriveState,
  makeCounters,
  makeEvent,
  makeSession,
  resolveDepth,
  sortSessions,
  workspaceNameFor,
} from './shared.mjs';

const BUSY_TIMEOUT_MS = 1500;
const SEED_PARTS = 100;
const MAX_PARTS_PER_POLL = 4000;

function parseJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class OpencodeSource {
  constructor(config = {}, { log = () => {} } = {}) {
    this.id = 'opencode';
    this.label = SOURCE_LABELS.opencode;
    this.config = config;
    this.log = log;
    this.dbPath = config.opencodeDb;
    this.liveMs = config.liveMs ?? 60_000;
    this.idleMs = config.idleMs ?? 1_800_000;
    this.detected = false;
    this.db = null;
    this.error = null;
    this.dbStatKey = '';
    this.partWatermark = 0;
    this.msgWatermark = 0;
    this.sessions = new Map(); // native id -> slot
    this.messageRoles = new Map(); // message id -> role
    this.emittedParts = new Set();
    this.projected = [];
    this.seedEvents = [];
    this.counters = makeCounters();
    this.turnBySession = new Map();
    this.stepBySession = new Map();
    this.lastPollMs = 0;
  }

  describe() {
    return {
      id: this.id,
      label: this.label,
      state: this.detected ? 'detected' : 'absent',
      detail: this.detected ? `SQLite · ${this.dbPath}` : `未发现 ${this.dbPath}`,
    };
  }

  statKey() {
    try {
      const s = fs.statSync(this.dbPath);
      let walKey = '';
      try {
        const wal = fs.statSync(`${this.dbPath}-wal`);
        walKey = `:${wal.size}:${Math.round(wal.mtimeMs)}`;
      } catch {
        walKey = '';
      }
      return `${s.size}:${Math.round(s.mtimeMs)}${walKey}`;
    } catch {
      return '';
    }
  }

  /* ---------------------------------------------------------------- init */

  async init(now = Date.now()) {
    this.detected = Boolean(this.dbPath) && fs.existsSync(this.dbPath);
    if (!this.detected) {
      this.error = 'opencode db not found';
      this.projected = [];
      return { sessions: 0, events: 0, ms: 0 };
    }
    const t0 = performance.now();
    try {
      this.sqlite = await loadSqlite();
      this.open();
      this.loadAll();
      this.project(now);
      this.seedEvents = this.buildSeedEvents();
    } catch (err) {
      this.error = String(err?.message ?? err);
      this.log(`[opencode] init failed: ${this.error}`);
    }
    const ms = Math.round(performance.now() - t0);
    return { sessions: this.projected.length, events: this.seedEvents.length, ms, error: this.error };
  }

  open() {
    if (this.db) return;
    this.db = new this.sqlite.DatabaseSync(this.dbPath, { readOnly: true });
    try {
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    } catch {
      /* best effort */
    }
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }

  emptySlot(row) {
    return {
      row,
      users: 0,
      assistant: 0,
      lastTs: 0,
      toolCounts: emptyToolCounts(),
      lastUser: null,
      lastAssistant: null,
      pending: [],
      lastPartAt: 0,
    };
  }

  loadAll() {
    const db = this.db;
    const sessions = db
      .prepare(
        `SELECT id, parent_id, directory, title, agent, model, time_created, time_updated,
                time_archived, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost
           FROM session ORDER BY time_updated DESC`,
      )
      .all();
    for (const row of sessions) this.sessions.set(row.id, this.emptySlot(row));

    const messages = db
      .prepare('SELECT id, session_id, time_created, data FROM message ORDER BY time_created ASC')
      .all();
    for (const msg of messages) {
      const data = parseJson(msg.data);
      const role = data?.role ?? null;
      this.messageRoles.set(msg.id, role);
      const slot = this.sessions.get(msg.session_id);
      if (slot) this.applyMessage(slot, msg, data, role);
    }

    const parts = db
      .prepare(
        'SELECT id, message_id, session_id, time_created, time_updated, data FROM part ORDER BY time_created ASC',
      )
      .all();
    for (const part of parts) {
      const data = parseJson(part.data);
      this.applyPart(part, data);
    }

    const partMax = db.prepare('SELECT COALESCE(MAX(time_updated), 0) AS m FROM part').get();
    const msgMax = db.prepare('SELECT COALESCE(MAX(time_created), 0) AS m FROM message').get();
    this.partWatermark = Number(partMax?.m ?? 0);
    this.msgWatermark = Number(msgMax?.m ?? 0);
  }

  applyMessage(slot, msg, data, role) {
    slot.lastTs = Math.max(slot.lastTs, Number(msg.time_created) || 0);
    if (role === 'user') slot.users += 1;
    else if (role === 'assistant') slot.assistant += 1;
    const cwd = data?.path?.cwd;
    if (cwd && !slot.row.directory) slot.row.directory = cwd;
  }

  applyPart(part, data) {
    const slot = this.sessions.get(part.session_id);
    if (!slot) return;
    const at = Number(part.time_created) || 0;
    slot.lastTs = Math.max(slot.lastTs, at);
    slot.lastPartAt = Math.max(slot.lastPartAt, Number(part.time_updated) || at);
    const type = data?.type;
    if (type === 'tool') {
      const toolName = data.tool || null;
      addToolCount(slot.toolCounts, toolName);
      const status = data.state?.status;
      if (status && status !== 'completed' && status !== 'error') {
        slot.pending.push(toolName || 'unknown');
        if (slot.pending.length > 8) slot.pending.shift();
      }
    } else if (type === 'text') {
      const role = this.messageRoles.get(part.message_id) ?? null;
      const text = cleanText(data.text, 400);
      if (text) {
        if (role === 'user') slot.lastUser = text;
        else if (role === 'assistant') slot.lastAssistant = text;
      }
    }
  }

  /* ------------------------------------------------------------- project */

  project(now = Date.now()) {
    const sessions = [];
    for (const slot of this.sessions.values()) {
      const row = slot.row;
      const modelJson = parseJson(row.model);
      const lastActivityAt = Math.max(
        Number(row.time_updated) || 0,
        Number(row.time_created) || 0,
        slot.lastTs,
        slot.lastPartAt,
      );
      const ended = Boolean(row.time_archived);
      const state = deriveState({ lastActivityAt, now, liveMs: this.liveMs, idleMs: this.idleMs, ended });
      sessions.push(
        makeSession({
          id: `opencode:${row.id}`,
          title: row.title || `opencode ${String(row.id).slice(4, 12)}`,
          workspace: workspaceNameFor(row.directory, 'opencode'),
          cwd: row.directory || '',
          source: 'opencode',
          state,
          parentId: row.parent_id ? `opencode:${row.parent_id}` : null,
          model: modelJson?.id ?? null,
          preset: row.agent || null,
          createdAt: Number(row.time_created) || lastActivityAt,
          lastActivityAt,
          turns: slot.users,
          steps: slot.assistant,
          tokens: {
            input: row.tokens_input,
            output: row.tokens_output,
            cacheRead: row.tokens_cache_read,
            cacheWrite: row.tokens_cache_write,
          },
          recentTokenRate: 0,
          contextPressure: 0,
          contextWindow: 0,
          openStep: null,
          pendingCalls: slot.pending,
          toolCounts: slot.toolCounts,
          todos: null,
          planActive: false,
          team: { memberIds: [], tasks: 0 },
          lastPrompt: slot.lastUser,
          lastResponse: slot.lastAssistant,
        }),
      );
    }
    resolveDepth(sessions);
    this.projected = sortSessions(sessions);
    return this.projected;
  }

  titleOf(sessionId) {
    const slot = this.sessions.get(sessionId);
    return slot?.row?.title || `opencode ${String(sessionId).slice(4, 12)}`;
  }

  /* -------------------------------------------------------------- events */

  eventsForPart(part, data) {
    const events = [];
    const slot = this.sessions.get(part.session_id);
    if (!slot) return events;
    const type = data?.type;
    const title = this.titleOf(part.session_id);
    const sid = `opencode:${part.session_id}`;
    const at = Number(part.time_created) || 0;
    if (type === 'step-start') {
      this.stepBySession.set(part.session_id, (this.stepBySession.get(part.session_id) ?? 0) + 1);
      events.push(
        makeEvent('opencode', {
          id: `evt-opencode-${part.id}`,
          kind: 'step/start',
          at,
          sessionId: sid,
          sessionTitle: title,
          turn: this.turnBySession.get(part.session_id) ?? 0,
          step: this.stepBySession.get(part.session_id) ?? 0,
        }),
      );
    } else if (type === 'step-finish') {
      events.push(
        makeEvent('opencode', {
          id: `evt-opencode-${part.id}-end`,
          kind: 'step/end',
          at,
          sessionId: sid,
          sessionTitle: title,
          turn: this.turnBySession.get(part.session_id) ?? 0,
          step: this.stepBySession.get(part.session_id) ?? 0,
        }),
      );
    } else if (type === 'tool') {
      const toolName = data.tool || null;
      const state = data.state ?? {};
      const status = state.status;
      const startedAt = Number(state.time?.start) || at;
      const endedAt = Number(state.time?.end) || 0;
      if (status === 'completed' || status === 'error') {
        if (this.emittedParts.has(part.id)) return events;
        this.emittedParts.add(part.id);
        events.push(
          makeEvent('opencode', {
            id: `evt-opencode-${part.id}-call`,
            kind: 'tool/call',
            at: startedAt,
            sessionId: sid,
            sessionTitle: title,
            tool: toolName,
            detail: state.title || hintFromInput(state.input),
          }),
        );
        const isError = status === 'error' || state.error != null;
        const detail = state.error || state.output || state.metadata?.output || state.title;
        events.push(
          makeEvent('opencode', {
            id: `evt-opencode-${part.id}-res`,
            kind: 'tool/result',
            at: endedAt || startedAt,
            sessionId: sid,
            sessionTitle: title,
            tool: toolName,
            detail,
            isError,
            durationMs: endedAt && startedAt ? endedAt - startedAt : null,
          }),
        );
        if (isError) {
          events.push(
            makeEvent('opencode', {
              id: `evt-opencode-${part.id}-err`,
              kind: 'error',
              at: endedAt || startedAt,
              sessionId: sid,
              sessionTitle: title,
              tool: toolName,
              detail: state.error || detail,
              isError: true,
            }),
          );
        }
      }
    } else if (type === 'text') {
      const role = this.messageRoles.get(part.message_id) ?? null;
      const text = cleanText(data.text, 400);
      if (role === 'user' && text) {
        const turn = (this.turnBySession.get(part.session_id) ?? 0) + 1;
        this.turnBySession.set(part.session_id, turn);
        events.push(
          makeEvent('opencode', {
            id: `evt-opencode-${part.id}-turn`,
            kind: 'turn/start',
            at,
            sessionId: sid,
            sessionTitle: title,
            turn,
          }),
        );
      }
    }
    return events;
  }

  buildSeedEvents() {
    if (!this.db) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT id, message_id, session_id, time_created, time_updated, data
             FROM part ORDER BY time_created DESC LIMIT ${SEED_PARTS}`,
        )
        .all();
      rows.reverse();
      const events = [];
      for (const part of rows) {
        const data = parseJson(part.data);
        events.push(...this.eventsForPart(part, data));
      }
      this.counters.events += events.length;
      return events;
    } catch {
      return [];
    }
  }

  /* ---------------------------------------------------------------- poll */

  async poll(now = Date.now()) {
    if (!this.detected) return { changed: false, events: [] };
    const t0 = performance.now();
    const key = this.statKey();
    if (key === this.dbStatKey) {
      this.counters.polls += 1;
      return { changed: false, events: [] };
    }
    this.dbStatKey = key;
    const events = [];
    try {
      this.open();
      this.refreshSessions();
      const messages = this.db
        .prepare('SELECT id, session_id, time_created, data FROM message WHERE time_created > ? ORDER BY time_created ASC LIMIT 500')
        .all(this.msgWatermark);
      for (const msg of messages) {
        const data = parseJson(msg.data);
        const role = data?.role ?? null;
        this.messageRoles.set(msg.id, role);
        const slot = this.sessions.get(msg.session_id);
        if (slot) this.applyMessage(slot, msg, data, role);
        this.msgWatermark = Math.max(this.msgWatermark, Number(msg.time_created) || 0);
      }

      let guard = 0;
      while (guard < MAX_PARTS_PER_POLL) {
        guard += 1;
        const parts = this.db
          .prepare(
            `SELECT id, message_id, session_id, time_created, time_updated, data
               FROM part WHERE time_updated > ? ORDER BY time_updated ASC LIMIT 500`,
          )
          .all(this.partWatermark);
        if (!parts.length) break;
        for (const part of parts) {
          const data = parseJson(part.data);
          this.applyPart(part, data);
          events.push(...this.eventsForPart(part, data));
          this.partWatermark = Math.max(this.partWatermark, Number(part.time_updated) || 0);
        }
        if (parts.length < 500) break;
      }

      const before = new Map(this.projected.map((s) => [s.id, s.state]));
      this.project(now);
      this.emitStateEvents(before, events, now);
      this.counters.polls += 1;
      this.counters.events += events.length;
      this.counters.errors += events.filter((e) => e.kind === 'error').length;
      this.lastPollMs = Math.round((performance.now() - t0) * 10) / 10;
      this.counters.lastPollMs = this.lastPollMs;
      this.counters.maxPollMs = Math.max(this.counters.maxPollMs, this.lastPollMs);
      return { changed: true, events };
    } catch (err) {
      this.error = String(err?.message ?? err);
      this.counters.polls += 1;
      return { changed: false, events: [] };
    }
  }

  refreshSessions() {
    const rows = this.db
      .prepare(
        `SELECT id, parent_id, directory, title, agent, model, time_created, time_updated,
                time_archived, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost
           FROM session ORDER BY time_updated DESC`,
      )
      .all();
    for (const row of rows) {
      const slot = this.sessions.get(row.id);
      if (slot) slot.row = row;
      else this.sessions.set(row.id, this.emptySlot(row));
    }
  }

  emitStateEvents(before, events, now) {
    for (const session of this.projected) {
      const prev = before.get(session.id);
      if (prev === session.state) continue;
      if (session.state === 'live') {
        events.push(
          makeEvent('opencode', {
            kind: 'session/live',
            at: now,
            sessionId: session.id,
            sessionTitle: session.title,
          }),
        );
      } else if (session.state === 'ended') {
        events.push(
          makeEvent('opencode', {
            kind: 'session/ended',
            at: now,
            sessionId: session.id,
            sessionTitle: session.title,
          }),
        );
      }
    }
  }

  /* ------------------------------------------------------------ read API */

  getSessions() {
    return this.projected;
  }

  getEvents() {
    return this.seedEvents;
  }

  getHealth() {
    return {
      id: this.id,
      label: this.label,
      state: this.detected ? 'detected' : 'absent',
      dbPath: this.dbPath,
      error: this.error,
      sessions: this.projected.length,
      live: this.projected.filter((s) => s.state === 'live').length,
      watermark: this.partWatermark,
      counters: { ...this.counters },
      pollMs: this.config.sourcePollMs ?? 1000,
    };
  }

  stop() {
    this.close();
  }
}

function hintFromInput(input) {
  if (!input || typeof input !== 'object') return null;
  for (const key of ['command', 'filePath', 'file_path', 'path', 'pattern', 'description', 'query', 'url']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

export function createOpencodeSource(config, opts) {
  return new OpencodeSource(config, opts);
}
