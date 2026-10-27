// Shared helpers for the non-DSH agent sources (Hermes / opencode / Claude Code
// / Codex). Every source projects its native rows into the same contract
// `AgentSession` / `AstroEvent` shapes, so the fleet merger can treat them
// uniformly.
//
// Contract notes (docs/DATA-CONTRACT.md v2):
//  - session ids are globally unique: `${source}:${nativeId}`;
//  - sectors are keyed `source::workspaceKey` (workspaceKey = normalized cwd);
//  - events carry `source` and are globally sorted by `at`;
//  - fields a source cannot observe are null / 0 / [] (never omitted).

import path from 'node:path';
import { categorizeTool, emptyToolCounts } from '../tools.mjs';
import { cleanText, nowMs } from '../util.mjs';

/** Human-readable labels for the source registry. */
export const SOURCE_LABELS = {
  dsh: 'DSH',
  hermes: 'Hermes',
  opencode: 'OpenCode',
  claude: 'Claude Code',
  codex: 'Codex',
};

export const UNKNOWN_WORKSPACE = '未知星域';

/** Clamp a tool name to the five beam categories; unknown tools are not counted. */
export function categoryOf(tool) {
  return categorizeTool(tool);
}

export function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

export function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round((Number(n) || 0) * f) / f;
}

export function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** One-line, length-capped text (events demand no newlines). */
export function clip(text, max = 120) {
  if (text == null) return null;
  const s = cleanText(String(text), max);
  return s || null;
}

/**
 * Wire-format cwd normalizer used for sector keys/dedup:
 * lowercase, forward slashes, no trailing slash.
 */
export function normalizeCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  return cwd.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Display name for a cwd: last path segment, or a fallback. */
export function workspaceNameFor(cwd, fallback = UNKNOWN_WORKSPACE) {
  const norm = normalizeCwd(cwd);
  if (!norm) return fallback;
  const parts = norm.split('/').filter(Boolean);
  return parts[parts.length - 1] || fallback;
}

/** `source::workspaceKey` — the global sector partitioning key from the contract. */
export function sectorIdFor(source, cwd) {
  const key = normalizeCwd(cwd);
  return key ? `${source}::${key}` : `${source}::unknown`;
}

/**
 * Derive live/idle/ended from the last observed activity.
 * Mirrors the DSH state machine: recent activity => live, quiet <= idleMs =>
 * idle, anything older (or an explicit end marker) => ended.
 */
export function deriveState({ lastActivityAt, now, liveMs = 60_000, idleMs = 1_800_000, ended = false }) {
  if (ended) return 'ended';
  const age = Math.max(0, now - (lastActivityAt || 0));
  if (age <= liveMs) return 'live';
  if (age <= idleMs) return 'idle';
  return 'ended';
}

/**
 * Build a contract AgentSession. Raw values are normalized + clamped here so
 * every source produces exactly the same shape.
 */
export function makeSession(raw) {
  const source = raw.source;
  const label = SOURCE_LABELS[source] ?? source;
  const lastActivityAt = int(raw.lastActivityAt || raw.createdAt || nowMs());
  const createdAt = int(raw.createdAt || lastActivityAt);
  const toolCounts = { ...emptyToolCounts(), ...(raw.toolCounts ?? {}) };
  return {
    id: raw.id,
    title: clip(raw.title || `${label} 会话`, 80) || `${label} 会话`,
    workspace: clip(raw.workspace || workspaceNameFor(raw.cwd), 40) || UNKNOWN_WORKSPACE,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    source,
    sourceLabel: label,
    state: raw.state ?? 'ended',
    parentId: raw.parentId ?? null,
    depth: int(raw.depth, raw.parentId ? 1 : 0),
    model: raw.model ?? null,
    reasoningEffort: raw.reasoningEffort ?? null,
    preset: raw.preset ?? null,
    createdAt,
    lastActivityAt,
    turns: int(raw.turns),
    steps: int(raw.steps),
    tokens: {
      input: int(raw.tokens?.input),
      output: int(raw.tokens?.output),
      cacheRead: int(raw.tokens?.cacheRead),
      cacheWrite: int(raw.tokens?.cacheWrite),
    },
    recentTokenRate: round(raw.recentTokenRate ?? 0, 2),
    contextPressure: round(clamp01(raw.contextPressure), 4),
    contextWindow: int(raw.contextWindow),
    openStep: raw.openStep ?? null,
    pendingCalls: Array.isArray(raw.pendingCalls) ? raw.pendingCalls.slice(0, 8) : [],
    toolCounts,
    todos: Array.isArray(raw.todos) ? raw.todos : null,
    planActive: Boolean(raw.planActive),
    team: {
      memberIds: (raw.team?.memberIds ?? []).slice(0, 32),
      tasks: int(raw.team?.tasks),
    },
    lastPrompt: raw.lastPrompt ? clip(raw.lastPrompt, 400) : null,
    lastResponse: raw.lastResponse ? clip(raw.lastResponse, 400) : null,
  };
}

let localEventSeq = 0;

/**
 * Build a contract AstroEvent. `source` is mandatory; `toolCategory` is derived
 * from the tool name when the caller doesn't know it.
 */
export function makeEvent(source, parts) {
  const tool = parts.tool ?? null;
  localEventSeq += 1;
  return {
    id: parts.id ?? `evt-${source}-${Date.now().toString(36)}-${localEventSeq}`,
    at: int(parts.at),
    kind: parts.kind,
    source,
    sessionId: parts.sessionId ?? '',
    sessionTitle: clip(parts.sessionTitle || parts.sessionId || '', 80) || '',
    tool,
    toolCategory: parts.toolCategory ?? (tool ? categoryOf(tool) : null),
    detail: parts.detail ? clip(parts.detail, 120) : null,
    isError: parts.isError === true ? true : parts.isError === false ? false : null,
    turn: parts.turn == null ? null : int(parts.turn),
    step: parts.step == null ? null : int(parts.step),
    durationMs: parts.durationMs == null ? null : Math.max(0, int(parts.durationMs)),
  };
}

/** Group non-DSH sessions into sectors (`source::workspaceKey`). */
export function buildSectors(sessions) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const sectors = new Map();
  for (const s of sessions) {
    const id = sectorIdFor(s.source, s.cwd);
    let sector = sectors.get(id);
    if (!sector) {
      // Contract invariant: `session.workspace` must equal the name of the
      // sector the session belongs to. The session's own workspace string is
      // therefore the single source of truth for the sector name.
      sector = {
        id,
        name: s.workspace || workspaceNameFor(s.cwd),
        path: s.cwd || '',
        source: s.source,
        sessionIds: [],
        liveCount: 0,
      };
      sectors.set(id, sector);
    }
    sector.sessionIds.push(s.id);
    if (s.state === 'live') sector.liveCount += 1;
  }
  for (const sector of sectors.values()) {
    sector.sessionIds.sort(
      (a, b) => (byId.get(b)?.lastActivityAt ?? 0) - (byId.get(a)?.lastActivityAt ?? 0),
    );
  }
  return [...sectors.values()].sort(
    (a, b) => b.liveCount - a.liveCount || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

/** Sort projected sessions the same way the DSH collector does. */
const STATE_RANK = { live: 0, idle: 1, ended: 2 };
export function sortSessions(sessions) {
  return sessions.sort(
    (a, b) =>
      (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) ||
      b.lastActivityAt - a.lastActivityAt,
  );
}

/** A tiny per-source counter block for `/api/health`. */
export function makeCounters() {
  return { events: 0, errors: 0, approvals: 0, toolCalls: 0, polls: 0, lastPollMs: 0, maxPollMs: 0 };
}

export function addToolCount(toolCounts, tool) {
  const cat = categoryOf(tool);
  if (cat) toolCounts[cat] += 1;
  return cat;
}

/** Resolve parent id / depth for prefixed sessions using an id map. */
export function resolveDepth(sessions) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const s of sessions) {
    let depth = 0;
    let cur = s.parentId ? byId.get(s.parentId) : null;
    const seen = new Set([s.id]);
    while (cur && !seen.has(cur.id) && depth < 8) {
      seen.add(cur.id);
      depth += 1;
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    s.depth = depth;
  }
}

export function fileBasename(p) {
  return path.basename(p || '');
}
