#!/usr/bin/env node
// XUANJI · 璇玑 — 本地假数据源（Lead 维护，仅用于前端开发与 QA；不是产品的一部分）
// 目的：在后端采集器（apps/server）就绪前，让 scene/hud 可以独立开发、截图、自审。
// 契约与 apps/web/src/state/types.ts 完全一致（v3：多来源 + 整机遥测）。
// 用法：node tools/mock-server.mjs [--port 8788] [--quiet]
// 前端：ASTRA_SERVER=http://127.0.0.1:8788 pnpm -C apps/web dev
// 浏览器：http://127.0.0.1:5173/?boot=0   整机视图：?boot=0&view=system

import http from 'node:http';

const args = new Set(process.argv.slice(2));
const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = portArg ? Number(portArg.split('=')[1]) : 8788;
const quiet = args.has('--quiet');

const now = () => Date.now();
const rr = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.floor(rr(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ── 来源注册表（含 absent 的 Codex，验证 UI 对「未发现」的表达） ────────────────
const SOURCES = [
  { id: 'dsh', label: 'DSH', state: 'detected', detail: '~/.dsh/storages/session_projcache' },
  { id: 'hermes', label: 'Hermes', state: 'detected', detail: '~/.hermes/state.db' },
  { id: 'opencode', label: 'opencode', state: 'detected', detail: '~/.local/share/opencode/opencode.db' },
  { id: 'claude', label: 'Claude Code', state: 'detected', detail: '~/.claude/projects/**/*.jsonl' },
  { id: 'codex', label: 'Codex', state: 'absent', detail: '~/.codex（未发现会话记录）' },
];

// ── 静态骨架：多来源的 workspace 分野与其中的 agent 星 ──────────────────────────
const SECTORS = [
  { id: 'dsh::work-agent', source: 'dsh', name: 'work agent', path: '~/work' },
  { id: 'dsh::deepseek-harness', source: 'dsh', name: 'deepseek harness', path: '~/work/deepseek-harness' },
  { id: 'dsh::stellaris', source: 'dsh', name: 'stellaris', path: '~/work/stellaris' },
  { id: 'hermes::home', source: 'hermes', name: 'hermes', path: 'C:/work/hermes' },
  { id: 'hermes::research', source: 'hermes', name: 'hermes · research', path: 'C:/work/hermes/research' },
  { id: 'opencode::playground', source: 'opencode', name: 'opencode playground', path: 'C:/Users/dev/playground' },
  { id: 'claude::astra', source: 'claude', name: 'astra', path: '~/xuanji' },
  { id: 'claude::notes', source: 'claude', name: 'claude notes', path: 'C:/Users/dev/notes' },
];

const TITLES = [
  '搭建本地观察台前端',
  'haloflux 架构拆解',
  '视觉研究：群星与赛博朋克',
  '数据采集器重构',
  '起居注文案校对',
  '事件流解码性能分析',
  '移动端布局适配',
  '截图画廊与视觉回归',
  '把 SSE 重连写成状态机',
  '字体子集化试验',
  '调色板提取脚本',
  '浑仪几何参数试错',
  'reviewer: 前端设计审查',
  'subagent: 研究资料整理',
  'subagent: 契约对齐',
  '旧会话：multi-agent 看板',
  'hermes 桌面端调试',
  'opencode 会话：rust 实验',
  'claude: 论文笔记整理',
];

const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'claude-sonnet-4.5', 'gpt-5-codex', 'qwen3-coder'];
const EFFORTS = ['low', 'medium', 'high'];
const TOOL_POOL = {
  read: ['read', 'glob', 'grep'],
  write: ['write', 'edit', 'apply_patch'],
  exec: ['pwsh', 'bash', 'node'],
  net: ['web_search', 'web_fetch'],
  agent: ['spawn_teammate', 'send_message', 'subagent', 'team_task_create'],
};
const TOOL_CAT = Object.fromEntries(Object.entries(TOOL_POOL).flatMap(([k, v]) => v.map((t) => [t, k])));

const DETAILS = {
  read: ['astra/apps/web/src/main.ts', 'docs/DESIGN-BIBLE.md', 'apps/server/src/fleet.mjs', '~/.hermes/state.db', '~/.claude/projects/*.jsonl'],
  write: ['astra/apps/web/src/scene/micro.ts', 'docs/qa/review.md', 'apps/web/src/hud/dossier.ts'],
  exec: ['pnpm -C apps/web build', 'node tools/screenshot.mjs', 'git status --short'],
  net: ['搜索 haloflux 架构分析', '抓取 PolyForm 许可证原文'],
  agent: ['派研究子 agent：翁法罗斯视觉', '向 data-pipeline 发送契约'],
};

let seq = 100;

function makeSession(i, sectorIdx, depth = 0, parentId = null) {
  const sector = SECTORS[sectorIdx];
  const state = i % 7 === 0 ? 'ended' : i % 3 === 0 ? 'idle' : 'live';
  const id = (depth > 0 ? 'sub-' : 'sess-') + String(1000 + i);
  const turns = ri(1, 38);
  const steps = turns * ri(2, 6);
  const output = ri(800, 260000);
  const title = TITLES[i % TITLES.length];
  const toolCounts = {
    read: ri(0, 60),
    write: ri(0, 30),
    exec: ri(0, 25),
    net: ri(0, 20),
    agent: ri(0, 12),
  };
  return {
    id,
    source: sector.source,
    sourceLabel: SOURCES.find((s) => s.id === sector.source)?.label ?? sector.source,
    title,
    workspace: sector.name,
    cwd: sector.path,
    state,
    parentId,
    depth,
    model: MODELS[i % MODELS.length],
    reasoningEffort: EFFORTS[i % EFFORTS.length],
    preset: pick(['default', 'frontend', 'research']),
    createdAt: now() - ri(1, 96) * 3600_000,
    lastActivityAt: now() - ri(0, 40) * 60_000,
    turns,
    steps,
    tokens: {
      input: ri(20000, 1800000),
      output,
      cacheRead: ri(10000, 3000000),
      cacheWrite: ri(0, 400000),
    },
    recentTokenRate: state === 'live' ? rr(4, 46) : 0,
    contextPressure: rr(0.06, 0.96),
    contextWindow: 200000,
    openStep: state === 'live' ? { turn: turns, step: steps, startedAt: now() - ri(2000, 90000), firstTokenAt: now() - ri(500, 1200) } : null,
    pendingCalls: state === 'live' ? [pick(TOOL_POOL.read), pick(TOOL_POOL.write)].slice(0, ri(0, 2)) : [],
    toolCounts,
    todos: i % 4 === 0 ? [{ text: '接通 /api/fleet 契约', done: true }, { text: '浑仪星轨缓动', done: false }, { text: '三视口截图复核', done: false }] : null,
    planActive: i % 5 === 1,
    team: { memberIds: i % 3 === 0 ? ['haloflux-arch', 'style-galactic'] : [], tasks: i % 3 === 0 ? ri(1, 6) : 0 },
    lastPrompt: state === 'ended' ? null : pick(['继续推进前端实现', '这个视觉方向再收一收', '把报告写完整', '检查构建错误']),
    lastResponse: state === 'live' ? pick(['正在实现浑仪的节拍时钟与星轨。', '先读一遍契约再动手。', '这一版色板偏冷，需要再加一点铜锈。']) : null,
  };
}

const sessions = [];
let n = 0;
const COUNTS = [7, 4, 3, 4, 2, 3, 3, 2];
for (let s = 0; s < SECTORS.length; s++) {
  for (let i = 0; i < COUNTS[s]; i++) sessions.push(makeSession(n++, s));
}
// 子 agent（有 parentId，depth 1/2）
sessions.push(makeSession(n++, 0, 1, sessions[0].id));
sessions.push(makeSession(n++, 0, 1, sessions[0].id));
sessions.push(makeSession(n++, 3, 1, sessions[7].id));
sessions.push(makeSession(n++, 6, 2, sessions[sessions.length - 1].id));

function sourcesInfo() {
  return SOURCES.map((src) => {
    const mine = sessions.filter((s) => s.source === src.id);
    return {
      id: src.id,
      label: src.label,
      state: src.state,
      sessions: mine.length,
      live: mine.filter((s) => s.state === 'live').length,
      lastActivityAt: mine.length ? Math.max(...mine.map((s) => s.lastActivityAt)) : null,
      detail: src.detail,
    };
  });
}

function aggregates() {
  const live = sessions.filter((s) => s.state === 'live');
  const idle = sessions.filter((s) => s.state === 'idle');
  const ended = sessions.filter((s) => s.state === 'ended');
  return {
    liveCount: live.length,
    idleCount: idle.length,
    endedCount: ended.length,
    tokenRate: Math.round(live.reduce((a, s) => a + s.recentTokenRate, 0)),
    toolRate: Number(live.reduce((a, s) => a + s.recentTokenRate / 12, 0).toFixed(2)),
    errorCount: events.filter((e) => e.isError).length,
    maxContextPressure: Math.max(0, ...sessions.map((s) => s.contextPressure)),
    stamp: now(),
  };
}

function sectorList() {
  return SECTORS.map((sec) => {
    const mine = sessions.filter((s) => s.workspace === sec.name && s.source === sec.source);
    return {
      id: sec.id,
      source: sec.source,
      name: sec.name,
      path: sec.path,
      sessionIds: mine.map((s) => s.id),
      liveCount: mine.filter((s) => s.state === 'live').length,
    };
  });
}

const events = [];
function makeEvent(recent = false) {
  const live = sessions.filter((s) => s.state === 'live');
  const s = pick(live.length ? live : sessions);
  const kindPool = ['tool/call', 'tool/call', 'tool/call', 'tool/result', 'step/start', 'step/end', 'turn/start', 'turn/end', 'approval'];
  let kind = pick(kindPool);
  const cat = pick(Object.keys(TOOL_POOL));
  const tool = cat === 'agent' || kind === 'tool/call' ? pick(TOOL_POOL[cat]) : null;
  const isError = kind === 'tool/result' && process.env.MOCK_ERRORS !== '0' && Math.random() < 0.14;
  if (isError) kind = 'error';
  const ev = {
    id: `ev-${seq++}`,
    at: now() - (recent ? ri(0, 4000) : 0),
    kind,
    source: s.source,
    sessionId: s.id,
    sessionTitle: s.title,
    tool,
    toolCategory: tool ? TOOL_CAT[tool] ?? cat : null,
    detail: isError
      ? pick(['ENOENT: no such file or directory, open astra/apps/web/src/hud/index.ts', '命令以退出码 1 结束', 'TypeError: Cannot read properties of undefined (reading "frame")'])
      : tool
        ? pick(DETAILS[TOOL_CAT[tool] ?? cat])
        : kind === 'approval'
          ? '请求提升沙箱权限：workspace-write'
          : null,
    isError: isError ? true : null,
    turn: s.turns,
    step: s.steps,
    durationMs: kind === 'tool/result' || kind === 'error' ? ri(40, 9800) : null,
  };
  events.push(ev);
  if (events.length > 400) events.shift();

  // 让假数据真的在“动”
  if (s.state === 'live') {
    s.steps += Math.random() < 0.35 ? 1 : 0;
    s.tokens.output += ri(20, 900);
    s.recentTokenRate = Math.max(1, s.recentTokenRate + rr(-4, 4));
    s.lastActivityAt = now();
    s.contextPressure = Math.min(0.99, s.contextPressure + rr(-0.004, 0.006));
    s.toolCounts[TOOL_CAT[tool] ?? cat] += tool ? 1 : 0;
    if (s.openStep) s.openStep.startedAt = Math.min(s.openStep.startedAt, now() - 800);
    if (Math.random() < 0.06) {
      s.state = pick(['idle', 'ended']);
      s.openStep = null;
      s.recentTokenRate = 0;
    }
  } else if (Math.random() < 0.05) {
    s.state = 'live';
    s.lastActivityAt = now();
    s.recentTokenRate = rr(4, 30);
    s.openStep = { turn: s.turns, step: s.steps, startedAt: now() - 3000, firstTokenAt: null };
  }
  return ev;
}

// 预填一些历史事件，首屏就有账本可读
for (let i = 0; i < 30; i++) makeEvent(true);

function fleetFrame() {
  return {
    type: 'fleet',
    generatedAt: now(),
    source: 'demo',
    sessions,
    sectors: sectorList(),
    sources: sourcesInfo(),
    aggregates: aggregates(),
    events: events.slice(-400),
  };
}

/* ------------------------------- 整机遥测 ------------------------------- */
const CORES = 16;
const PROC_NAMES = ['node.exe', 'chrome.exe', 'Hermes.exe', 'Code.exe', 'msedge.exe', 'RPGMV.exe', 'explorer.exe', 'SearchIndexer.exe', 'python.exe', 'Codex.exe'];
const systemState = {
  cpu: 0.23,
  perCore: Array.from({ length: CORES }, () => rr(0.08, 0.42)),
  memPct: 0.61,
  rx: 180_000,
  tx: 42_000,
  totalRx: 9_800_000_000,
  totalTx: 2_100_000_000,
  uptime: 268_400,
  startedAt: now() - 268_400_000,
};
const systemHistory = [];

function systemSnapshot() {
  // 随机游走 + 均值回归，肉眼像真的
  const t = now() / 1000;
  systemState.cpu = Math.max(0.04, Math.min(0.97, systemState.cpu + rr(-0.05, 0.05) + 0.02 * Math.sin(t / 7)));
  systemState.perCore = systemState.perCore.map((v) => Math.max(0.02, Math.min(0.99, v + rr(-0.08, 0.08))));
  systemState.memPct = Math.max(0.32, Math.min(0.93, systemState.memPct + rr(-0.012, 0.012)));
  systemState.rx = Math.max(4_000, systemState.rx + rr(-40_000, 44_000));
  systemState.tx = Math.max(1_000, systemState.tx + rr(-12_000, 13_000));
  systemState.totalRx += systemState.rx * 2;
  systemState.totalTx += systemState.tx * 2;
  systemState.uptime += 2;
  const totalBytes = 68_719_476_736;
  const usedBytes = Math.round(totalBytes * systemState.memPct);
  const procs = PROC_NAMES.map((name, idx) => ({
    pid: 1200 + idx * 733,
    name,
    cpuPct: Number(Math.min(99, Math.max(0, systemState.perCore[idx % CORES] * 100 + rr(-6, 6))).toFixed(1)),
    memBytes: Math.round(usedBytes * rr(0.01, 0.16)),
  })).sort((a, b) => b.cpuPct - a.cpuPct);
  const snap = {
    type: 'system',
    at: now(),
    available: true,
    cpu: { usage: Number(systemState.cpu.toFixed(4)), perCore: systemState.perCore.map((v) => Number(v.toFixed(4))) },
    mem: { usedPct: Number(systemState.memPct.toFixed(4)), usedBytes, totalBytes },
    disks: [
      { name: 'C:', totalBytes: 1_000_204_886_016, freeBytes: 402_653_184_000, usedPct: 0.597 },
      { name: 'D:', totalBytes: 2_000_398_934_016, freeBytes: 1_269_124_792_320, usedPct: 0.3655 },
    ],
    net: {
      rxBps: Math.round(systemState.rx),
      txBps: Math.round(systemState.tx),
      totalRxBytes: Math.round(systemState.totalRx),
      totalTxBytes: Math.round(systemState.totalTx),
    },
    procs,
    uptimeSec: systemState.uptime,
    battery: { percent: 87, charging: true },
  };
  systemHistory.push(snap);
  while (systemHistory.length > 120) systemHistory.shift();
  return snap;
}
systemSnapshot();

/* --------------------------------- HTTP --------------------------------- */
function writeSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const clients = new Set();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const json = (body, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  if (url.pathname === '/api/fleet') {
    json(fleetFrame());
    return;
  }

  if (url.pathname === '/api/system') {
    json(systemSnapshot());
    return;
  }

  if (url.pathname === '/api/system/history') {
    const limit = Math.max(1, Math.min(120, Number(url.searchParams.get('limit')) || 120));
    json(systemHistory.slice(-limit));
    return;
  }

  if (url.pathname === '/api/health') {
    json({
      ok: true,
      mock: true,
      sessions: sessions.length,
      sources: sourcesInfo().map((s) => `${s.id}:${s.sessions}${s.state === 'absent' ? '(absent)' : ''}`),
      system: { available: true, at: systemHistory[systemHistory.length - 1]?.at },
    });
    return;
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': mock stream\n\n');
    clients.add(res);
    writeSse(res, 'fleet', fleetFrame());
    writeSse(res, 'system', systemSnapshot());
    const timer = setInterval(() => {
      writeSse(res, 'tick', {
        type: 'tick',
        at: now(),
        events: [makeEvent()],
        sessions: sessions.filter(() => Math.random() < 0.12),
        aggregates: aggregates(),
        sources: sourcesInfo(),
      });
    }, ri(900, 1500));
    const sysTimer = setInterval(() => writeSse(res, 'system', systemSnapshot()), 2000);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(timer);
      clearInterval(sysTimer);
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('mock-server: 只有 /api/fleet、/api/system、/api/system/history、/api/stream、/api/health');
});

server.listen(PORT, '127.0.0.1', () => {
  if (!quiet) {
    console.log(`[xuanji mock] http://127.0.0.1:${PORT}  sessions=${sessions.length}  sources=${SOURCES.length}`);
    console.log(`[xuanji mock] 前端：ASTRA_SERVER=http://127.0.0.1:${PORT} pnpm -C astra/apps/web dev`);
    console.log(`[xuanji mock] 整机视图：http://127.0.0.1:5173/?boot=0&view=system`);
  }
});
