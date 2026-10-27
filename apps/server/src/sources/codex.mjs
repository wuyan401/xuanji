// Codex source: registry entry for the Codex CLI.
//
// On this machine `~/.codex` only holds config.toml (no session rollouts), so the
// source reports `absent` and contributes zero sessions. The parser for
// `~/.codex/sessions/**/rollout-*.jsonl` is implemented so it lights up
// automatically once rollouts appear:
//   {type:'session_meta', payload:{id, cwd, timestamp, …}}
//   {type:'response_item', payload:{type:'message'|'function_call'|'function_call_output', …}}
//   {type:'event_msg', payload:{type:'token_count'|…}}

import fs from 'node:fs';
import path from 'node:path';
import { emptyToolCounts } from '../tools.mjs';
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

const MAX_FILES = 200;

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export class CodexSource {
  constructor(config = {}, { log = () => {} } = {}) {
    this.id = 'codex';
    this.label = SOURCE_LABELS.codex;
    this.config = config;
    this.log = log;
    this.root = config.codexDir;
    this.sessionsDir = this.root ? path.join(this.root, 'sessions') : null;
    this.liveMs = config.liveMs ?? 60_000;
    this.idleMs = config.idleMs ?? 1_800_000;
    this.detected = false;
    this.files = new Map();
    this.slots = new Map();
    this.seedEvents = [];
    this.projected = [];
    this.counters = makeCounters();
    this.error = null;
  }

  describe() {
    return {
      id: this.id,
      label: this.label,
      state: this.detected ? 'detected' : 'absent',
      detail: this.detected
        ? `rollout JSONL · ${this.sessionsDir}`
        : this.root
          ? `未发现 rollout 记录（${this.root} 仅配置）`
          : '未发现 ~/.codex',
    };
  }

  discover() {
    if (!this.sessionsDir || !fs.existsSync(this.sessionsDir)) return [];
    return walkFiles(this.sessionsDir, 6).filter((file) => file.endsWith('.jsonl')).slice(0, MAX_FILES);
  }

  async init(now = Date.now()) {
    const files = this.discover();
    this.detected = files.length > 0;
    if (!this.detected) {
      this.projected = [];
      return { sessions: 0, events: 0, ms: 0 };
    }
    const t0 = performance.now();
    for (const file of files) {
      const state = { size: 0, mtimeMs: 0, offset: 0, tail: '', sessionId: path.basename(file, '.jsonl') };
      this.files.set(file, state);
      this.readFile(file, state, false);
    }
    this.project(now);
    const ms = Math.round(performance.now() - t0);
    return { sessions: this.projected.length, events: 0, ms };
  }

  ensureSlot(sessionId) {
    let slot = this.slots.get(sessionId);
    if (!slot) {
      slot = {
        id: sessionId,
        title: null,
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
        pending: new Map(),
      };
      this.slots.set(sessionId, slot);
    }
    return slot;
  }

  readFile(file, state, emit) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    if (stat.size <= state.offset) {
      state.size = stat.size;
      state.mtimeMs = stat.mtimeMs;
      return;
    }
    const fd = fs.openSync(file, 'r');
    let text = '';
    try {
      const length = stat.size - state.offset;
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, state.offset);
      text = state.tail + buf.toString('utf8', 0, read);
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split('\n');
    state.tail = lines.pop() ?? '';
    const slot = this.ensureSlot(state.sessionId);
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      this.ingestRecord(slot, record, emit ? [] : null);
    }
    state.offset = stat.size;
    state.size = stat.size;
    state.mtimeMs = stat.mtimeMs;
  }

  ingestRecord(slot, record, events) {
    const at = toMs(record.timestamp) || toMs(record.payload?.timestamp);
    if (at) slot.lastActivityAt = Math.max(slot.lastActivityAt, at);
    const payload = record.payload ?? {};
    if (record.type === 'session_meta') {
      if (payload.cwd) slot.cwd = payload.cwd;
      if (payload.model) slot.model = payload.model;
      if (payload.id && !slot.id) slot.id = payload.id;
      return;
    }
    if (record.type === 'response_item') {
      if (payload.type === 'message') {
        const text = cleanText(extractText(payload.content), 400);
        if (payload.role === 'user') {
          slot.turns += 1;
          slot.lastPrompt = text || slot.lastPrompt;
          if (events) {
            events.push(
              makeEvent('codex', {
                kind: 'turn/start',
                at,
                sessionId: `codex:${slot.id}`,
                sessionTitle: slot.title || `codex ${slot.id.slice(0, 8)}`,
                turn: slot.turns,
              }),
            );
          }
        } else {
          slot.steps += 1;
          slot.lastResponse = text || slot.lastResponse;
          if (events) {
            events.push(
              makeEvent('codex', {
                kind: 'turn/end',
                at,
                sessionId: `codex:${slot.id}`,
                sessionTitle: slot.title || `codex ${slot.id.slice(0, 8)}`,
                turn: slot.turns,
              }),
            );
          }
        }
      } else if (payload.type === 'function_call') {
        const tool = payload.name || 'unknown';
        addToolCount(slot.toolCounts, tool);
        slot.pending.set(payload.call_id || payload.id, { tool, at });
        if (events) {
          events.push(
            makeEvent('codex', {
              kind: 'tool/call',
              at,
              sessionId: `codex:${slot.id}`,
              sessionTitle: slot.title || `codex ${slot.id.slice(0, 8)}`,
              tool,
              detail: cleanText(payload.arguments, 120),
            }),
          );
        }
      } else if (payload.type === 'function_call_output') {
        const pending = slot.pending.get(payload.call_id);
        slot.pending.delete(payload.call_id);
        if (events) {
          events.push(
            makeEvent('codex', {
              kind: 'tool/result',
              at,
              sessionId: `codex:${slot.id}`,
              sessionTitle: slot.title || `codex ${slot.id.slice(0, 8)}`,
              tool: pending?.tool ?? null,
              detail: cleanText(extractText(payload.output), 120),
              isError: false,
            }),
          );
        }
      }
      return;
    }
    if (record.type === 'event_msg' && payload.type === 'token_count') {
      const usage = payload.info?.total_token_usage;
      if (usage) {
        slot.tokens.input = Number(usage.input_tokens) || slot.tokens.input;
        slot.tokens.output = Number(usage.output_tokens) || slot.tokens.output;
      }
    }
  }

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
          id: `codex:${slot.id}`,
          title: slot.title || `codex ${String(slot.id).slice(0, 8)}`,
          workspace: workspaceNameFor(slot.cwd, 'codex'),
          cwd: slot.cwd || '',
          source: 'codex',
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

  async poll(now = Date.now()) {
    if (!this.detected) return { changed: false, events: [] };
    const t0 = performance.now();
    const events = [];
    let changed = false;
    for (const [file, state] of this.files) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.size === state.size && Math.round(stat.mtimeMs) === Math.round(state.mtimeMs)) continue;
      changed = true;
      this.readFile(file, state, false);
    }
    if (changed) this.project(now);
    this.counters.polls += 1;
    this.counters.events += events.length;
    this.lastPollMs = Math.round((performance.now() - t0) * 10) / 10;
    return { changed, events };
  }

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
    };
  }

  stop() {
    this.files.clear();
  }
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') parts.push(item);
      else if (item?.type === 'input_text' || item?.type === 'output_text' || item?.type === 'text') {
        parts.push(item.text ?? '');
      }
    }
    return parts.join(' ');
  }
  if (content && typeof content === 'object') return content.content ?? content.text ?? '';
  return '';
}

export function createCodexSource(config, opts) {
  return new CodexSource(config, opts);
}
