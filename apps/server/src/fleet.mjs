// Projection layer: DSH raw material -> the frozen front-end contract.
//
// `deriveSnapshot()` turns one projcache record into a flat, cheap-to-use
// snapshot. `projectSession()` merges that snapshot with the event-derived live
// state (`ev`) and the collector's token-rate samples into exactly the
// `AgentSession` shape from docs/DATA-CONTRACT.md. Nothing here does I/O, so it
// is safe to call for every session on every tick.

import { cleanText } from './util.mjs';

export const DEFAULT_LIVE_MS = 60_000;
export const DEFAULT_IDLE_MS = 30 * 60_000;

const ZERO_TOKENS = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const ZERO_TOOL_COUNTS = () => ({ read: 0, write: 0, exec: 0, net: 0, agent: 0 });

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round = (v, digits) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Sort key for a {turn, step} pair. */
function stepKey(step) {
  return step ? (Number(step.turn) || 0) * 1e6 + (Number(step.step) || 0) : -1;
}

function pickModel(record) {
  const rows = record?.rows ?? {};
  const lastUsed = rows.modelSelection?.val?.lastUsed;
  if (!lastUsed || typeof lastUsed !== 'object') return { model: null, reasoningEffort: null };
  return {
    model: typeof lastUsed.model === 'string' ? lastUsed.model : null,
    reasoningEffort: typeof lastUsed.reasoningEffort === 'string' ? lastUsed.reasoningEffort : null,
  };
}

/**
 * Normalise one projcache record (cheap, no I/O).
 * @param {string} id session id (file name)
 * @param {any} record `record` object of the projcache document
 */
export function deriveSnapshot(id, record) {
  const rows = record?.rows && typeof record.rows === 'object' ? record.rows : {};
  const val = (key) => rows[key]?.val;
  const identity = record?.identity ?? {};
  const stats = val('sessionStats') || {};
  const totals = val('tokenUsage')?.totals || {};
  const pressure = val('contextPressure') || {};
  const permissions = val('permissions') || {};
  const plan = val('plan') || null;
  const team = val('agentTeam') || null;
  const subagent = val('subagent') || null;
  const todosRaw = rows.todos?.val;
  const outline = val('turnOutline') || {};
  const titleInput = val('titleInput') || {};
  const sessionMeta = val('sessionListMetadata') || {};
  const { model, reasoningEffort } = pickModel(record);

  const preset = typeof val('agentPreset') === 'string'
    ? val('agentPreset')
    : (typeof permissions.preset === 'string' ? permissions.preset : null);

  const isSubagent = !String(id).startsWith('session-') || Boolean(subagent);
  const subagentLabel = cleanText(subagent?.identity?.label ?? '', 80);
  const rawTitle = cleanText(val('title') ?? '', 200);
  const firstInput = cleanText(titleInput?.first?.text ?? titleInput?.text ?? '', 500);

  // Title resolution: real titles first, then the task label for subagents,
  // then the first user message. Never expose the system-reminder boilerplate.
  let title = '';
  if (isSubagent && subagentLabel) title = subagentLabel;
  else if (rawTitle) title = rawTitle;
  else if (firstInput) title = firstInput;
  else if (subagentLabel) title = subagentLabel;
  if (title.length > 80) title = `${title.slice(0, 79).trimEnd()}…`;
  if (!title) title = `会话 ${String(id).slice(0, 8)}`;

  const pressureTokens = Number(pressure.pressureTokens) || 0;
  const contextWindow = Number(pressure.contextWindow) || 0;
  const ratio = contextWindow > 0 ? pressureTokens / contextWindow : 0;

  let openStep = null;
  if (stats.openStep && typeof stats.openStep === 'object') {
    const turn = Number(stats.openStep.turn);
    const step = Number(stats.openStep.step);
    if (Number.isFinite(turn) && Number.isFinite(step)) {
      openStep = {
        turn,
        step,
        startedAt: Number(stats.openStep.startTime) || 0,
        firstTokenAt: Number(stats.openStep.firstTokenTime) || null,
      };
    }
  }

  let todos = null;
  if (Array.isArray(todosRaw) && todosRaw.length) {
    todos = todosRaw
      .filter((t) => t && typeof t === 'object' && typeof t.content === 'string')
      .slice(0, 60)
      .map((t) => ({ text: cleanText(t.content, 160), done: t.status === 'completed' || t.done === true }));
    if (!todos.length) todos = null;
  }

  let lastPrompt = null;
  let lastResponse = null;
  const turns = Array.isArray(outline.turns) ? outline.turns : [];
  for (const turn of turns) {
    if (typeof turn?.prompt === 'string' && turn.prompt.trim()) lastPrompt = cleanText(turn.prompt, 400);
    if (typeof turn?.response === 'string' && turn.response.trim()) lastResponse = cleanText(turn.response, 400);
  }
  if (!lastPrompt && firstInput) lastPrompt = cleanText(firstInput, 400);

  return {
    id,
    isSubagent,
    createdAt: Number(identity.createdAt) || 0,
    cwd: typeof identity.cwd === 'string' ? identity.cwd : '',
    title,
    model,
    reasoningEffort,
    preset,
    turns: Number(stats.turns) || 0,
    steps: Number(stats.steps) || 0,
    tokens: {
      input: Number(totals.uncachedInputTokens) || 0,
      output: Number(totals.outputTokens) || 0,
      cacheRead: Number(totals.cacheReadTokens) || 0,
      cacheWrite: Number(totals.cacheWriteTokens) || 0,
    },
    contextPressureRaw: ratio,
    contextPressure: round(clamp(ratio, 0, 1), 4),
    contextWindow,
    openStep,
    pendingSnap: Object.keys(stats.pendingCalls ?? {}),
    todos,
    planActive: Boolean(plan?.active),
    team: {
      memberIds: Array.isArray(team?.members) ? team.members.map((m) => m?.id).filter(Boolean) : [],
      tasks: Array.isArray(team?.tasks) ? team.tasks.length : 0,
    },
    lastPrompt,
    lastResponse,
    lastPromptAt: Number(sessionMeta.lastPromptAt) || 0,
    subagentLabel,
  };
}

/** Empty event-derived state for a newly discovered session. */
export function emptyEventState() {
  return {
    lastAt: 0,
    openStep: null,
    pending: new Map(),
    toolNames: new Map(),
    toolCounts: ZERO_TOOL_COUNTS(),
    lastUserText: null,
    lastAssistantText: null,
    errors: 0,
    approvals: 0,
    stepStarts: new Map(),
    turnStarts: new Map(),
    callAt: new Map(),
  };
}

/**
 * Project one collector session state into the contract AgentSession.
 *
 * @param {{snap:any, ev:any, rate:any, mtimeMs:number, wsId:string|null,
 *          archived:boolean, lastKnownAt:number}} state
 * @param {number} now
 * @param {{liveMs:number, idleMs:number, windowSec:number, parentById:Map<string,string>, depthById:Map<string,number>}} ctx
 */
export function projectSession(state, now, ctx) {
  const snap = state.snap;
  const ev = state.ev;
  const mtime = state.mtimeMs || 0;
  // 统一为整数毫秒:fs 的 mtimeMs 带小数,契约里所有时间戳都是整数。
  const lastActivityAt = Math.round(
    Math.max(
      mtime,
      ev?.lastAt || 0,
      snap?.lastPromptAt || 0,
      snap?.openStep?.startedAt || 0,
      snap?.createdAt || 0,
    ),
  );
  const age = Math.max(0, now - lastActivityAt);
  const liveMs = ctx.liveMs ?? DEFAULT_LIVE_MS;
  const idleMs = ctx.idleMs ?? DEFAULT_IDLE_MS;

  // --- state machine -------------------------------------------------------
  // live : open step (possibly a long tool call) or activity within liveMs
  // idle : quiet for <= idleMs
  // ended: archived, or quiet for longer than idleMs
  const hasOpenStep = Boolean(ev?.openStep || snap?.openStep);
  let agentState;
  if (state.archived) agentState = 'ended';
  else if (age <= liveMs) agentState = 'live';
  else if (hasOpenStep && age <= idleMs) agentState = 'live';
  else if (age <= idleMs) agentState = 'idle';
  else agentState = 'ended';
  const ended = agentState === 'ended';

  // --- open step (event stream is finer-grained than the snapshot) ---------
  let openStep = null;
  if (!ended) {
    const snapStep = snap?.openStep ?? null;
    const evStep = ev?.openStep ?? null;
    let pick = snapStep;
    let alt = evStep;
    if (evStep && (!snapStep || stepKey(evStep) >= stepKey(snapStep))) {
      pick = evStep;
      alt = snapStep;
    }
    if (pick) {
      const sameStep = alt && alt.turn === pick.turn && alt.step === pick.step;
      const firstTokenAt = (sameStep ? (alt.firstTokenAt ?? pick.firstTokenAt) : pick.firstTokenAt) ?? null;
      openStep = {
        turn: Number(pick.turn) || 0,
        step: Number(pick.step) || 0,
        startedAt: Math.round(Number(pick.startedAt) || Number(alt?.startedAt) || lastActivityAt),
        firstTokenAt: firstTokenAt == null ? null : Math.round(Number(firstTokenAt) || 0),
      };
    }
  }

  // --- currently running tools --------------------------------------------
  const pendingCalls = [];
  if (!ended) {
    const seenPending = new Set();
    for (const [callId, info] of ev?.pending ?? []) {
      const name = info?.name || ev.toolNames.get(callId) || 'unknown';
      if (seenPending.has(name)) continue;
      seenPending.add(name);
      pendingCalls.push(name);
      if (pendingCalls.length >= 8) break;
    }
    if (!pendingCalls.length && snap?.pendingSnap?.length) {
      for (const callId of snap.pendingSnap.slice(0, 8)) {
        const name = ev?.toolNames.get(callId) || 'unknown';
        if (seenPending.has(name)) continue;
        seenPending.add(name);
        pendingCalls.push(name);
      }
    }
  }

  const tokens = snap?.tokens ?? ZERO_TOKENS();
  const windowSec = ctx.windowSec > 0 ? ctx.windowSec : 60;
  const recentTokenRate = state.rate ? round((state.rate.sumTokens(now) || 0) / windowSec, 2) : 0;

  const parentId = ctx.parentById.get(snap.id) ?? null;
  const depth = ctx.depthById.get(snap.id) ?? (parentId ? 1 : 0);

  return {
    id: snap.id,
    title: snap.title,
    workspace: state.workspaceName || '未知星域',
    cwd: snap.cwd,
    source: 'dsh',
    sourceLabel: 'DSH',
    state: agentState,
    parentId,
    depth,
    model: snap.model,
    reasoningEffort: snap.reasoningEffort,
    preset: snap.preset,
    createdAt: Math.round(snap.createdAt || lastActivityAt),
    lastActivityAt,
    turns: snap.turns,
    steps: snap.steps,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
    },
    recentTokenRate,
    contextPressure: round(clamp(snap.contextPressure || 0, 0, 1), 4),
    contextWindow: snap.contextWindow || 0,
    openStep,
    pendingCalls,
    toolCounts: { ...ZERO_TOOL_COUNTS(), ...(ev?.toolCounts ?? {}) },
    todos: snap.todos,
    planActive: Boolean(snap.planActive),
    team: {
      memberIds: snap.team.memberIds.slice(0, 32),
      tasks: snap.team.tasks,
    },
    lastPrompt: snap.lastPrompt || ev?.lastUserText || null,
    lastResponse: snap.lastResponse || ev?.lastAssistantText || null,
  };
}

/** Build the contract Sector list from the workspace index + projections. */
export function projectSectors(workspaceIndex, projectedSessions) {
  const byId = new Map(projectedSessions.map((s) => [s.id, s]));
  const sectors = [];
  for (const ws of workspaceIndex.list()) {
    const sessionIds = [];
    let liveCount = 0;
    for (const id of ws.sessionIds) {
      const session = byId.get(id);
      if (!session) continue;
      sessionIds.push(id);
      if (session.state === 'live') liveCount += 1;
    }
    if (!sessionIds.length) continue;
    sessionIds.sort((a, b) => (byId.get(b)?.lastActivityAt ?? 0) - (byId.get(a)?.lastActivityAt ?? 0));
    sectors.push({ id: ws.id, name: ws.name, path: ws.path, source: 'dsh', sessionIds, liveCount });
  }
  sectors.sort((a, b) => b.liveCount - a.liveCount || a.name.localeCompare(b.name));
  return sectors;
}

/** Build Aggregates from projections + the global rate tracker. */
export function projectAggregates(projectedSessions, rate, counters, now) {
  let liveCount = 0;
  let idleCount = 0;
  let endedCount = 0;
  let maxContextPressure = 0;
  for (const s of projectedSessions) {
    if (s.state === 'live') {
      liveCount += 1;
      if (s.contextPressure > maxContextPressure) maxContextPressure = s.contextPressure;
    } else if (s.state === 'idle') {
      idleCount += 1;
      if (s.contextPressure > maxContextPressure) maxContextPressure = s.contextPressure;
    } else {
      endedCount += 1;
    }
  }
  return {
    liveCount,
    idleCount,
    endedCount,
    tokenRate: rate ? round(rate.tokensPerSec(now), 2) : 0,
    toolRate: rate ? round(rate.toolsPerSec(now), 3) : 0,
    errorCount: counters?.errors ?? 0,
    maxContextPressure: round(maxContextPressure, 4),
    stamp: now,
  };
}
