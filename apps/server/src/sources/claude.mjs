// Claude Code source: tails `~/.claude/projects/**/*.jsonl` (one JSON object per
// line). Each *.jsonl file is one session (sessionId = file basename).
//
// Record shapes we care about:
//   {type:'assistant', message:{model, content:[{type:'text'|'tool_use',…}], usage, stop_reason}, timestamp, cwd}
//   {type:'user',      message:{content:'…'|[ {type:'tool_result', tool_use_id, content, is_error?} ]}, timestamp, cwd}
//   {type:'ai-title',  aiTitle}      {type:'last-prompt', lastPrompt}
//   {type:'system',    subtype:'api_error', …}
//
// Mapping: id=`claude:<uuid>`, turns = real user prompts, steps = assistant
// messages, tokens = summed message.usage. Incremental strategy: per-file byte
// offset + partial-line buffer; a file that shrinks is re-read from 0.

import fs from 'node:fs';
import path from 'node:path';
import { categorizeTool, emptyToolCounts } from '../tools.mjs';
import { cleanText, walkFiles } from '../util.mjs';
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

const SEED_FILES = 6;
const SEED_EVENTS = 150;
const MAX_READ_BYTES = 2 * 1024 * 1024;

function toMs(iso) {
  const ms = Date.parse(iso ?? '');
  return Number.isFinite(ms) ? ms : 0;
}

function toolInputHint(input) {
  if (!input || typeof input !== 'object') return null;
  for (const key of [
    'command',
    'file_path',
    'path',
    'pattern',
    'description',
    'query',
    'url',
    'prompt',
    'notebook_path',
  ]) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim());
  return typeof first === 'string' ? first : null;
}

export class ClaudeSource {
  constructor(config = {}, { log = () => {} } = {}) {
    this.id = 'claude';
    this.label = SOURCE_LABELS.claude;
    this.config = config;
    this.log = log;
    this.root = config.claudeDir;
    this.liveMs = config.liveMs ?? 60_000;
    this.idleMs = config.idleMs ?? 1_800_000;
    this.recentMs = config.claudeRecentMs ?? 7 * 24 * 3_600_000;
    this.detected = false;
    this.files = new Map(); // file path -> {size,mtimeMs,offset,tail,sessionId}
    this.slots = new Map(); // sessionId -> slot
    this.seedEvents = [];
    this.projected = [];
    this.counters = makeCounters();
    this.error = null;
    this.lastPollMs = 0;
  }

  describe() {
    return {
      id: this.id,
      label: this.label,
      state: this.detected ? 'detected' : 'absent',
      detail: this.detected
        ? `JSONL · ${this.root}`
        : `未发现 ${this.root}`,
    };
  }

  /* ---------------------------------------------------------------- init */

  async init(now = Date.now()) {
    const t0 = performance.now();
    this.detected = Boolean(this.root) && fs.existsSync(this.root);
    if (!this.detected) {
      this.error = 'claude projects dir not found';
      return { sessions: 0, events: 0, ms: 0, error: this.error };
    }
    try {
      const files = (await walkFiles(this.root, 4)).filter((file) => file.endsWith('.jsonl'));
      files.sort((a, b) => statMtime(b) - statMtime(a));
      for (const file of files) {
        const sessionId = path.basename(file, '.jsonl');
        const fstate = { size: 0, mtimeMs: 0, offset: 0, tail: '', sessionId };
        this.files.set(file, fstate);
        this.readFile(file, fstate, true);
      }
      this.seedEvents = this.buildSeedEvents(files);
      this.project(now);
    } catch (err) {
      this.error = String(err?.message ?? err);
      this.log(`[claude] init failed: ${this.error}`);
    }
    const ms = Math.round(performance.now() - t0);
    return { sessions: this.projected.length, events: this.seedEvents.length, ms, error: this.error };
  }

  ensureSlot(sessionId, file) {
    let slot = this.slots.get(sessionId);
    if (!slot) {
      slot = {
        id: sessionId,
        file,
        title: '',
        firstUserText: null,
        cwd: '',
        model: null,
        createdAt: 0,
        lastActivityAt: 0,
        turns: 0,
        steps: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        toolCounts: emptyToolCounts(),
        lastPrompt: null,
        lastResponse: null,
        pending: new Map(), // toolUseId -> {tool,at}
        turn: 0,
        step: 0,
      };
      this.slots.set(sessionId, slot);
    }
    return slot;
  }

  readFile(file, fstate, seed) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    if (stat.size < fstate.offset) {
      fstate.offset = 0;
      fstate.tail = '';
    }
    if (stat.size === fstate.offset && fstate.tail === '') {
      fstate.size = stat.size;
      fstate.mtimeMs = stat.mtimeMs;
      return;
    }
    const start = Math.max(fstate.offset, stat.size - MAX_READ_BYTES);
    const fd = fs.openSync(file, 'r');
    let chunk = '';
    try {
      const length = stat.size - start;
      if (length > 0) {
        const buf = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, buf, 0, length, start);
        chunk = fstate.offset === start && fstate.tail ? fstate.tail + buf.toString('utf8', 0, read) : buf.toString('utf8', 0, read);
      } else {
        chunk = fstate.tail;
      }
    } finally {
      fs.closeSync(fd);
    }
    const lines = chunk.split('\n');
    fstate.tail = lines.pop() ?? '';
    const slot = this.ensureSlot(fstate.sessionId, file);
    const events = seed ? null : [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      this.ingestRecord(slot, record, events);
    }
    fstate.offset = stat.size;
    fstate.size = stat.size;
    fstate.mtimeMs = stat.mtimeMs;
    return events;
  }

  ingestRecord(slot, record, events) {
    const at = toMs(record.timestamp);
    if (at) slot.lastActivityAt = Math.max(slot.lastActivityAt, at);
    if (record.cwd && !slot.cwd) slot.cwd = record.cwd;

    if (record.type === 'ai-title' && record.aiTitle) {
      slot.title = cleanText(record.aiTitle, 80) || slot.title;
      return;
    }
    if (record.type === 'last-prompt' && record.lastPrompt) {
      slot.lastPrompt = cleanText(record.lastPrompt, 400) || slot.lastPrompt;
      return;
    }
    if (record.type === 'system') {
      if (record.subtype === 'api_error' && events) {
        const detail =
          cleanText(record.error?.message ?? record.error?.formatted ?? 'Claude API error', 120) || null;
        events.push(
          makeEvent('claude', {
            id: `evt-claude-${slot.id}-${at}`,
            kind: 'error',
            at,
            sessionId: `claude:${slot.id}`,
            sessionTitle: this.titleOf(slot),
            detail,
            isError: true,
          }),
        );
      }
      return;
    }

    const message = record.message;
    if (!message) return;
    if (record.type === 'user') {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === 'tool_result') {
            const pending = slot.pending.get(block.tool_use_id);
            slot.pending.delete(block.tool_use_id);
            if (events && pending) {
              const isError = Boolean(block.is_error) || Boolean(record.toolUseResult?.isError);
              const text = toolResultText(block.content);
              events.push(
                makeEvent('claude', {
                  id: `evt-claude-${slot.id}-${block.tool_use_id}`,
                  kind: 'tool/result',
                  at,
                  sessionId: `claude:${slot.id}`,
                  sessionTitle: this.titleOf(slot),
                  tool: pending.tool,
                  detail: text,
                  isError,
                  durationMs: pending.at && at ? at - pending.at : null,
                }),
              );
            }
          }
        }
        return;
      }
      const text = cleanText(message.content, 400);
      if (!text) return;
      slot.turns += 1;
      slot.turn += 1;
      slot.lastPrompt = text;
      if (!slot.firstUserText) slot.firstUserText = text;
      if (events) {
        events.push(
          makeEvent('claude', {
            id: `evt-claude-${slot.id}-turn-${slot.turns}`,
            kind: 'turn/start',
            at,
            sessionId: `claude:${slot.id}`,
            sessionTitle: this.titleOf(slot),
            turn: slot.turn,
            detail: text,
          }),
        );
        if (this.isLiveAt(slot)) this.counters.events += 1;
      }
      return;
    }

    if (record.type === 'assistant') {
      slot.model = message.model || slot.model;
      if (!slot.createdAt && at) slot.createdAt = at;
      slot.steps += 1;
      slot.step += 1;
      const usage = message.usage;
      if (usage) {
        slot.tokens.input += Number(usage.input_tokens) || 0;
        slot.tokens.output += Number(usage.output_tokens) || 0;
        slot.tokens.cacheRead += Number(usage.cache_read_input_tokens) || 0;
        slot.tokens.cacheWrite += Number(usage.cache_creation_input_tokens) || 0;
      }
      let hasTool = false;
      let textOut = null;
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (block?.type === 'text' && block.text) textOut = cleanText(block.text, 400) || textOut;
        if (block?.type !== 'tool_use') continue;
        hasTool = true;
        const tool = block.name || 'unknown';
        addToolCount(slot.toolCounts, tool);
        slot.pending.set(block.id, { tool, at });
        if (events) {
          events.push(
            makeEvent('claude', {
              id: `evt-claude-${slot.id}-${block.id}`,
              kind: 'tool/call',
              at,
              sessionId: `claude:${slot.id}`,
              sessionTitle: this.titleOf(slot),
              tool,
              turn: slot.turn,
              step: slot.step,
              detail: toolInputHint(block.input),
            }),
          );
        }
      }
      if (textOut) slot.lastResponse = textOut;
      if (!hasTool && events) {
        events.push(
          makeEvent('claude', {
            id: `evt-claude-${slot.id}-turn-${slot.turn}-end`,
            kind: 'turn/end',
            at,
            sessionId: `claude:${slot.id}`,
            sessionTitle: this.titleOf(slot),
            turn: slot.turn,
            detail: textOut,
          }),
        );
      }
    }
  }

  isLiveAt(slot) {
    return Date.now() - slot.lastActivityAt < this.liveMs;
  }

  titleOf(slot) {
    return slot.title || slot.firstUserText || `claude ${slot.id.slice(0, 8)}`;
  }

  buildSeedEvents(files) {
    const recent = files.filter((file) => {
      const fstate = this.files.get(file);
      return fstate && Date.now() - fstate.mtimeMs < this.recentMs;
    });
    const events = [];
    for (const file of recent.slice(0, SEED_FILES)) {
      const fstate = this.files.get(file);
      const slot = this.slots.get(fstate.sessionId);
      if (!slot) continue;
      const replay = [];
      // Re-parse the last chunk of this file purely to synthesise seed events.
      try {
        const stat = fs.statSync(file);
        const start = Math.max(0, stat.size - 128 * 1024);
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.allocUnsafe(stat.size - start);
        const read = fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        const text = buf.toString('utf8', 0, read);
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          this.ingestRecord(slot, record, replay);
        }
      } catch {
        continue;
      }
      events.push(...replay);
    }
    events.sort((a, b) => a.at - b.at);
    const trimmed = events.slice(-SEED_EVENTS);
    this.counters.events = trimmed.length;
    this.counters.toolCalls = trimmed.filter((e) => e.kind === 'tool/call').length;
    this.counters.errors = trimmed.filter((e) => e.kind === 'error').length;
    return trimmed;
  }

  /* ------------------------------------------------------------- project */

  project(now = Date.now()) {
    const sessions = [];
    for (const slot of this.slots.values()) {
      const lastActivityAt = slot.lastActivityAt || slot.createdAt;
      const state = deriveState({
        lastActivityAt,
        now,
        liveMs: this.liveMs,
        idleMs: this.idleMs,
        ended: false,
      });
      sessions.push(
        makeSession({
          id: `claude:${slot.id}`,
          title: this.titleOf(slot),
          workspace: workspaceNameFor(slot.cwd, 'claude'),
          cwd: slot.cwd || '',
          source: 'claude',
          state,
          parentId: null,
          model: slot.model,
          preset: null,
          createdAt: slot.createdAt || lastActivityAt,
          lastActivityAt,
          turns: slot.turns,
          steps: slot.steps,
          tokens: slot.tokens,
          recentTokenRate: 0,
          contextPressure: 0,
          contextWindow: 0,
          openStep: null,
          pendingCalls: [...slot.pending.values()].map((p) => p.tool),
          toolCounts: slot.toolCounts,
          todos: null,
          planActive: false,
          team: { memberIds: [], tasks: 0 },
          lastPrompt: slot.lastPrompt,
          lastResponse: slot.lastResponse,
        }),
      );
    }
    resolveDepth(sessions);
    this.projected = sortSessions(sessions);
    return this.projected;
  }

  /* ---------------------------------------------------------------- poll */

  async poll(now = Date.now()) {
    if (!this.detected) return { changed: false, events: [] };
    const t0 = performance.now();
    const events = [];
    let changed = false;
    const before = new Map(this.projected.map((s) => [s.id, s.state]));
    try {
      for (const [file, fstate] of this.files) {
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (stat.size === fstate.size && Math.round(stat.mtimeMs) === Math.round(fstate.mtimeMs)) continue;
        changed = true;
        const found = this.readFile(file, fstate, false);
        if (found?.length) events.push(...found);
      }
      if (changed) {
        this.project(now);
        this.emitStateEvents(before, events, now);
      }
      this.counters.polls += 1;
      this.counters.events += events.length;
      this.counters.errors += events.filter((e) => e.kind === 'error').length;
      this.lastPollMs = Math.round((performance.now() - t0) * 10) / 10;
      this.counters.lastPollMs = this.lastPollMs;
      this.counters.maxPollMs = Math.max(this.counters.maxPollMs, this.lastPollMs);
      return { changed, events };
    } catch (err) {
      this.error = String(err?.message ?? err);
      this.counters.polls += 1;
      return { changed: false, events: [] };
    }
  }

  emitStateEvents(before, events, now) {
    for (const session of this.projected) {
      const prev = before.get(session.id);
      if (prev === session.state) continue;
      if (session.state === 'live') {
        events.push(
          makeEvent('claude', {
            kind: 'session/live',
            at: now,
            sessionId: session.id,
            sessionTitle: session.title,
          }),
        );
      } else if (session.state === 'ended') {
        events.push(
          makeEvent('claude', {
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
      root: this.root,
      error: this.error,
      files: this.files.size,
      sessions: this.projected.length,
      live: this.projected.filter((s) => s.state === 'live').length,
      counters: { ...this.counters },
      pollMs: this.config.sourcePollMs ?? 1000,
    };
  }

  stop() {
    this.files.clear();
  }
}

function statMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function toolResultText(content) {
  if (typeof content === 'string') return cleanText(content, 120);
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item?.type === 'text' && item.text) return cleanText(item.text, 120);
    }
  }
  return null;
}

export function createClaudeSource(config, opts) {
  return new ClaudeSource(config, opts);
}
