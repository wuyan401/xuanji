// Hermes source: reads the local Hermes agent SQLite state (~578MB) strictly
// read-only and projects its sessions/messages into the unified fleet.
//
// Mapping decisions (see docs/DATA-CONTRACT.md v2):
//   id           hermes:<sessions.id>
//   title        sessions.title || display_name
//   workspace    basename(cwd); when Hermes recorded no cwd the install root is
//                used as both cwd and workspace (so workspace === sector.name)
//   cwd          sessions.cwd, falling back to the Hermes install root
//   preset       sessions.source (desktop / qqbot / …) — Hermes' own platform id
//   turns        count(messages WHERE role='user')
//   steps        count(messages WHERE role='assistant')
//   tokens       sessions.input_tokens / output_tokens / cache_read_tokens / cache_write_tokens
//   toolCounts   categorized from messages.tool_name (role='tool')
//   lastPrompt   newest user message text (400 chars)
//   lastResponse newest assistant message text (400 chars)
//
// Times in Hermes are epoch SECONDS as REAL -> multiplied by 1000 and rounded.
// Incremental strategy: messages.id watermark; the DB is only re-queried when
// the file (or its -wal) stat changes, so the steady-state poll is ~0ms.

import fs from 'node:fs';
import { loadSqlite } from './sqlite.mjs';
import { categorizeTool, emptyToolCounts } from '../tools.mjs';
import { cleanText, toolArgHint } from '../util.mjs';
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

const SEED_MESSAGES = 120;
const MAX_MESSAGES_PER_POLL = 4000;
const BUSY_TIMEOUT_MS = 1500;

const MSG_COLUMNS = `id, session_id, role, content, tool_calls, tool_name, timestamp, finish_reason`;

function toMs(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
}

/** Parse Hermes assistant `tool_calls` JSON (array of function calls). */
export function parseHermesToolCalls(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((call) => {
        const fn = call?.function ?? call;
        const name = fn?.name ?? call?.name ?? null;
        if (!name) return null;
        return { name, arguments: fn?.arguments ?? call?.arguments ?? null, callId: call?.call_id ?? call?.id ?? null };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Parse a Hermes tool-result content JSON blob into {text, isError}. */
export function parseHermesToolResult(raw) {
  const rawText = typeof raw === 'string' ? raw : '';
  let parsed = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }
  if (parsed && typeof parsed === 'object') {
    const error = parsed.error ?? null;
    const exit = parsed.exit_code;
    const text = error || parsed.output || parsed.content || parsed.result || '';
    const isError = Boolean(error) || (typeof exit === 'number' && exit !== 0);
    return { text: typeof text === 'string' ? text : JSON.stringify(text), isError };
  }
  const looksError = /^\s*(error|fatal|exception|traceback|typeerror|valueerror)/i.test(rawText);
  return { text: rawText, isError: looksError };
}

export class HermesSource {
  constructor(config = {}, { log = () => {} } = {}) {
    this.id = 'hermes';
    this.label = SOURCE_LABELS.hermes;
    this.config = config;
    this.log = log;
    this.dbPath = config.hermesDb;
    // Fallback cwd for the 77+ historical sessions that never recorded one:
    // the Hermes install directory. Keeps the front-end "path" column readable
    // and keeps `session.workspace === sector.name` (contract invariant).
    this.fallbackCwd = this.dbPath
      ? this.dbPath.replace(/[\\/][^\\/]*$/, '').replace(/\\/g, '/')
      : '';
    this.liveMs = config.liveMs ?? 60_000;
    this.idleMs = config.idleMs ?? 1_800_000;
    this.detected = false;
    this.db = null;
    this.error = null;
    this.dbStatKey = '';
    this.msgWatermark = 0;
    this.msgRows = new Map(); // rawId -> aggregation
    this.projected = [];
    this.seedEvents = [];
    this.counters = makeCounters();
    this.turnBySession = new Map();
    this.stepBySession = new Map();
    this.lastPollMs = 0;
    this.busy = false;
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
      this.error = 'hermes state.db not found';
      this.projected = [];
      return { sessions: 0, events: 0, ms: 0 };
    }
    const t0 = performance.now();
    try {
      this.sqlite = await loadSqlite();
      this.open();
      this.loadFull();
      this.project(now);
      this.seedEvents = this.buildSeedEvents();
    } catch (err) {
      this.error = String(err?.message ?? err);
      this.log(`[hermes] init failed: ${this.error}`);
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
      /* pragma is best-effort */
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

  loadFull() {
    const db = this.db;
    const sessions = db
      .prepare(
        `SELECT id, source, model, parent_session_id, started_at, ended_at, end_reason,
                message_count, tool_call_count, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, reasoning_tokens, cwd, title,
                display_name, archived, pinned
           FROM sessions ORDER BY started_at DESC`,
      )
      .all();
    const agg = db
      .prepare(
        `SELECT session_id,
                COUNT(*) AS msgs,
                SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) AS users,
                SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) AS assistant,
                MAX(timestamp) AS lastTs
           FROM messages GROUP BY session_id`,
      )
      .all();
    const tools = db
      .prepare(
        `SELECT session_id, tool_name, COUNT(*) AS c
           FROM messages WHERE role='tool' AND tool_name IS NOT NULL
          GROUP BY session_id, tool_name`,
      )
      .all();
    const lastText = db
      .prepare(
        `SELECT session_id, role, content FROM (
           SELECT session_id, role, content,
                  ROW_NUMBER() OVER (PARTITION BY session_id, role ORDER BY id DESC) AS rn
             FROM messages
            WHERE role IN ('user','assistant') AND content IS NOT NULL AND content <> ''
         ) WHERE rn <= 1`,
      )
      .all();
    const maxId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get();

    this.msgRows = new Map();
    for (const row of sessions) {
      this.msgRows.set(row.id, {
        row,
        msgs: 0,
        users: 0,
        assistant: 0,
        lastTs: 0,
        toolCounts: emptyToolCounts(),
        lastUser: null,
        lastAssistant: null,
      });
    }
    for (const a of agg) {
      const slot = this.msgRows.get(a.session_id);
      if (!slot) continue;
      slot.msgs = a.msgs ?? 0;
      slot.users = a.users ?? 0;
      slot.assistant = a.assistant ?? 0;
      slot.lastTs = a.lastTs ?? 0;
    }
    for (const t of tools) {
      const slot = this.msgRows.get(t.session_id);
      if (!slot) continue;
      const cat = categorizeTool(t.tool_name);
      if (cat) slot.toolCounts[cat] += t.c ?? 0;
    }
    for (const t of lastText) {
      const slot = this.msgRows.get(t.session_id);
      if (!slot) continue;
      if (t.role === 'user') slot.lastUser = cleanText(t.content, 400);
      else slot.lastAssistant = cleanText(t.content, 400);
    }
    this.msgWatermark = Number(maxId?.m ?? 0);
  }

  /* ------------------------------------------------------------- project */

  project(now = Date.now()) {
    const sessions = [];
    for (const slot of this.msgRows.values()) {
      const row = slot.row;
      const startedAt = toMs(row.started_at);
      const endedAt = toMs(row.ended_at);
      const lastMessageAt = toMs(slot.lastTs);
      const lastActivityAt = Math.max(startedAt, endedAt, lastMessageAt);
      const ended = Boolean(row.archived) || Boolean(row.ended_at);
      const state = deriveState({ lastActivityAt, now, liveMs: this.liveMs, idleMs: this.idleMs, ended });
      // Hermes does not always persist a cwd; fall back to the install root so
      // the session still groups into a readable sector (workspace === sector.name).
      const cwd = typeof row.cwd === 'string' && row.cwd.trim() ? row.cwd.trim() : this.fallbackCwd;
      sessions.push(
        makeSession({
          id: `hermes:${row.id}`,
          title: row.title || row.display_name || `Hermes ${String(row.id).slice(-6)}`,
          workspace: workspaceNameFor(cwd, this.label),
          cwd,
          source: 'hermes',
          state,
          parentId: row.parent_session_id ? `hermes:${row.parent_session_id}` : null,
          model: row.model || null,
          preset: row.source || null,
          createdAt: startedAt || lastActivityAt,
          lastActivityAt,
          turns: slot.users,
          steps: slot.assistant,
          tokens: {
            input: row.input_tokens,
            output: row.output_tokens,
            cacheRead: row.cache_read_tokens,
            cacheWrite: row.cache_write_tokens,
          },
          recentTokenRate: 0,
          contextPressure: 0,
          contextWindow: 0,
          openStep: null,
          pendingCalls: [],
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

  titleOf(rawId) {
    const slot = this.msgRows.get(rawId);
    if (!slot) return rawId;
    return slot.row.title || slot.row.display_name || `Hermes ${String(rawId).slice(-6)}`;
  }

  turnOf(rawId) {
    return this.turnBySession.get(rawId) ?? 0;
  }

  /* -------------------------------------------------------------- events */

  eventsForMessage(msg) {
    const events = [];
    const rawId = msg.session_id;
    if (!this.msgRows.has(rawId)) return events;
    const title = this.titleOf(rawId);
    const at = toMs(msg.timestamp);
    const turn = this.turnOf(rawId);
    const step = this.stepBySession.get(rawId) ?? 0;
    const role = msg.role;

    if (role === 'user') {
      const nextTurn = turn + 1;
      this.turnBySession.set(rawId, nextTurn);
      events.push(
        makeEvent('hermes', {
          id: `evt-hermes-${msg.id}`,
          kind: 'turn/start',
          at,
          sessionId: `hermes:${rawId}`,
          sessionTitle: title,
          turn: nextTurn,
        }),
      );
      return events;
    }
    if (role === 'assistant') {
      const nextStep = step + 1;
      this.stepBySession.set(rawId, nextStep);
      const calls = parseHermesToolCalls(msg.tool_calls);
      for (const call of calls) {
        events.push(
          makeEvent('hermes', {
            id: `evt-hermes-${msg.id}-${call.callId ?? call.name}`,
            kind: 'tool/call',
            at,
            sessionId: `hermes:${rawId}`,
            sessionTitle: title,
            tool: call.name,
            detail: toolArgHint(call.name, call.arguments),
            turn,
            step: nextStep,
          }),
        );
      }
      if (!calls.length && msg.content && String(msg.content).trim()) {
        events.push(
          makeEvent('hermes', {
            id: `evt-hermes-${msg.id}-end`,
            kind: 'turn/end',
            at,
            sessionId: `hermes:${rawId}`,
            sessionTitle: title,
            turn,
          }),
        );
      }
      if (msg.finish_reason === 'error') {
        events.push(
          makeEvent('hermes', {
            id: `evt-hermes-${msg.id}-err`,
            kind: 'error',
            at,
            sessionId: `hermes:${rawId}`,
            sessionTitle: title,
            isError: true,
            detail: 'assistant finish_reason=error',
            turn,
            step: nextStep,
          }),
        );
      }
      return events;
    }
    if (role === 'tool') {
      const result = parseHermesToolResult(msg.content);
      events.push(
        makeEvent('hermes', {
          id: `evt-hermes-${msg.id}-res`,
          kind: 'tool/result',
          at,
          sessionId: `hermes:${rawId}`,
          sessionTitle: title,
          tool: msg.tool_name || null,
          detail: result.text,
          isError: result.isError,
          turn,
          step,
        }),
      );
      if (result.isError) {
        events.push(
          makeEvent('hermes', {
            id: `evt-hermes-${msg.id}-err`,
            kind: 'error',
            at,
            sessionId: `hermes:${rawId}`,
            sessionTitle: title,
            tool: msg.tool_name || null,
            detail: result.text,
            isError: true,
            turn,
            step,
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
        .prepare(`SELECT ${MSG_COLUMNS} FROM messages ORDER BY id DESC LIMIT ${SEED_MESSAGES}`)
        .all();
      rows.reverse();
      const events = [];
      for (const row of rows) events.push(...this.eventsForMessage(row));
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
      this.refreshSessionRows();
      const fresh = this.readNewMessages();
      for (const msg of fresh) events.push(...this.eventsForMessage(msg));
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

  refreshSessionRows() {
    const rows = this.db
      .prepare(
        `SELECT id, source, model, parent_session_id, started_at, ended_at, end_reason,
                message_count, tool_call_count, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, reasoning_tokens, cwd, title,
                display_name, archived, pinned
           FROM sessions ORDER BY started_at DESC`,
      )
      .all();
    for (const row of rows) {
      const slot = this.msgRows.get(row.id);
      if (slot) slot.row = row;
      else {
        this.msgRows.set(row.id, {
          row,
          msgs: 0,
          users: 0,
          assistant: 0,
          lastTs: 0,
          toolCounts: emptyToolCounts(),
          lastUser: null,
          lastAssistant: null,
        });
      }
    }
  }

  readNewMessages() {
    const out = [];
    let guard = 0;
    while (guard < MAX_MESSAGES_PER_POLL) {
      guard += 1;
      const rows = this.db
        .prepare(`SELECT ${MSG_COLUMNS} FROM messages WHERE id > ? ORDER BY id ASC LIMIT 500`)
        .all(this.msgWatermark);
      if (!rows.length) break;
      for (const row of rows) {
        this.applyMessageToAggregate(row);
        this.msgWatermark = Math.max(this.msgWatermark, Number(row.id));
        out.push(row);
      }
      if (rows.length < 500) break;
    }
    return out;
  }

  applyMessageToAggregate(row) {
    const slot = this.msgRows.get(row.session_id);
    if (!slot) return;
    slot.msgs += 1;
    const ts = Number(row.timestamp) || 0;
    if (ts > slot.lastTs) slot.lastTs = ts;
    if (row.role === 'user') {
      slot.users += 1;
      const text = cleanText(row.content, 400);
      if (text) slot.lastUser = text;
    } else if (row.role === 'assistant') {
      slot.assistant += 1;
      const text = cleanText(row.content, 400);
      if (text) slot.lastAssistant = text;
    } else if (row.role === 'tool') {
      addToolCount(slot.toolCounts, row.tool_name);
    }
  }

  emitStateEvents(before, events, now) {
    for (const session of this.projected) {
      const prev = before.get(session.id);
      if (prev === session.state) continue;
      if (session.state === 'live') {
        events.push(
          makeEvent('hermes', {
            kind: 'session/live',
            at: now,
            sessionId: session.id,
            sessionTitle: session.title,
          }),
        );
      } else if (session.state === 'ended') {
        events.push(
          makeEvent('hermes', {
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
      watermark: this.msgWatermark,
      counters: { ...this.counters },
      pollMs: this.config.sourcePollMs ?? 1000,
    };
  }

  stop() {
    this.close();
  }
}

export function createHermesSource(config, opts) {
  return new HermesSource(config, opts);
}
