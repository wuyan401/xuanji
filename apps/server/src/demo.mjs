// Demo source: a self-contained fleet simulator so the UI can be shown (and
// smoke-tested) without depending on real DSH data. It implements the exact
// same read surface as Collector, emits the same `tick` shape, and produces the
// same wire contract. Sessions simulate thinking / tool / step / turn / approval
// cycles with token growth and context pressure creeping toward the window.

import { EventEmitter } from 'node:events';
import { nowMs, nextId, ms } from './util.mjs';
import { emptyToolCounts } from './tools.mjs';
import { SOURCE_LABELS, buildSectors } from './sources/shared.mjs';

const SOURCE_ORDER = ['dsh', 'hermes', 'opencode', 'claude', 'codex'];

const SIM_TICK_MS = 250;
const RING = 2000;
const FLEET_EVENTS = 300;

const TOOL_POOL = [
  ['read', 'apps/web/src/state/store.ts'],
  ['grep', 'EventSource|applyFleet'],
  ['write', 'apps/server/src/collector.mjs'],
  ['edit', 'apps/web/src/scene/AgentScene.tsx'],
  ['bash', 'node --test apps/server/tests/'],
  ['pwsh', 'Get-Content apps/server/README.md'],
  ['web_search', 'framer motion scroll trigger'],
  ['glob', 'apps/web/src/**/*.ts'],
  ['subagent', 'review token accounting'],
  ['send_message', 'lead: server ready'],
  ['todo_write', '5 items'],
  ['read', 'docs/ARCHITECTURE.md'],
];
const CATEGORY_OF = {
  read: 'read', grep: 'read', glob: 'read', ls: 'read',
  write: 'write', edit: 'write', todo_write: 'write',
  bash: 'exec', pwsh: 'exec',
  web_search: 'net',
  subagent: 'agent', send_message: 'agent',
};

const PROMPTS = [
  '构建本机所有 Agent 运行的实时数据可视化：前端做出科幻观测台质感，后端把 DSH 的会话数据采集成实时 fleet。',
  '这一轮的视觉要有星图、轨道、光束和观测舱的感觉，动效跟手，别像 AI 做的。',
  '把 SSE 断线重连和恢复态补上，演示模式要能循环出多 agent 协作的场面。',
  '帮我核对一下 contextPressure 的计算口径，pressureTokens / contextWindow。',
  '再加一层父子 agent 的从属关系，子 agent 应该从父会话里长出来。',
];
const RESPONSES = [
  '好哒，我先拆成数据层和视觉层两条线：数据层负责采集 /api/fleet，视觉层负责把会话画成轨道上的光点。',
  '已经把采集器接上了：每 500ms 轮询一次 projcache，事件流用 zstd 多帧增量 tail，首屏回填最近 300 条事件。',
  'SSE 首帧立即推完整 fleet，之后 1fps 快照 + tick 增量，15s 一次心跳，断线由前端指数退避重连。',
  'contextPressure 用 pressureTokens / contextWindow 算，clamp 到 0..1，超过 1 的窗口也不让它画出环外。',
  '子 agent 的 parentId 来自父会话的 agentTeam.members，depth 已经算好，前端可以直接画父子连线。',
];
const TODO_SEEDS = [
  '实现采集层增量解析',
  '写 SSE 流与静态托管',
  '补齐前端契约类型声明',
  '接上 demo 模拟数据',
  '跑通 smoke 测试并回报',
  '核对 contextPressure 口径',
];
const TOOL_RESULTS = [
  'ok，文件已写入',
  '读取 214 行，未发现错误',
  '找到 3 处引用',
  '测试通过：12 pass / 0 fail',
  '命令输出 48 行',
  '已通知 lead',
];
const ERRORS = [
  'Error: ENOENT no such file or directory',
  'TypeError: Cannot read properties of null (reading "sessions")',
  'zstd frame decode failed: unexpected end of file',
];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}
function rand(rng, min, max) {
  return min + rng() * (max - min);
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class DemoAgent {
  constructor(spec, now) {
    Object.assign(this, {
      id: spec.id,
      title: spec.title,
      workspace: spec.workspace,
      cwd: spec.cwd,
      source: spec.source ?? 'dsh',
      sourceLabel: SOURCE_LABELS[spec.source ?? 'dsh'] ?? 'DSH',
      parentId: spec.parentId ?? null,
      depth: spec.parentId ? 1 : 0,
      model: spec.model ?? 'deepseek-flash',
      reasoningEffort: spec.reasoningEffort ?? 'max',
      preset: spec.preset ?? 'standard',
      createdAt: now - (spec.ageMs ?? 1_200_000),
      tokens: { input: spec.input ?? 0, output: spec.output ?? 0, cacheRead: spec.cacheRead ?? 0, cacheWrite: 0 },
      contextWindow: spec.contextWindow ?? 1_000_000,
      pressure: spec.pressure ?? 0.08,
      // 上下文压力每秒自增一点的"逼近"速率(0.004~0.016/s):让演示在几十秒内
      // 就能看到压力爬升 → 触发一次 compaction 审批。
      pressureRate: spec.pressureRate ?? rand(Math.random, 0.003, 0.008),
      toolCounts: Object.assign(emptyToolCounts(), spec.toolCounts ?? {}),
      todos: spec.todos ?? null,
      planActive: Boolean(spec.planActive),
      team: spec.team ?? { memberIds: [], tasks: 0 },
      lastPrompt: spec.lastPrompt ?? null,
      lastResponse: spec.lastResponse ?? null,
      turn: spec.turn ?? 1,
      step: spec.step ?? 0,
      openStep: null,
      pendingCalls: [],
      pending: [],
      lastActivityAt: now,
      live: spec.state === 'live',
      endedState: spec.state === 'idle' ? 'idle' : spec.state === 'ended' ? 'ended' : 'live',
      rate: spec.rate ?? 0,
      targetRate: spec.targetRate ?? rand(Math.random, 8, 26),
      mode: spec.mode ?? 'thinking',
      modeLeft: 0,
      stepsInTurn: 0,
      tool: null,
    });
    if (!this.live) {
      this.lastActivityAt = now - (spec.state === 'idle' ? rand(Math.random, 4, 22) * 60_000 : 3 * 3600_000);
    }
  }

  setOpenStep(now) {
    this.openStep = { turn: this.turn, step: this.step, startedAt: now, firstTokenAt: now + 60 };
  }

  /** Advance the simulation by dt ms; returns events + whether the session changed. */
  update(now, dt, rng) {
    if (!this.live) return { events: [], changed: false };
    void rng;
    const events = [];
    const sec = dt / 1000;
    let changed = false;
    this.lastActivityAt = now;
    this.modeLeft -= dt;

    if (this.mode === 'thinking') {
      const tokenPerSec = this.targetRate;
      this.rate += (tokenPerSec - this.rate) * 0.25;
      const produced = Math.max(0, this.rate * sec); // tokens/s 直接对应"正在生成"的手感
      if (produced > 0) {
        this.tokens.output += produced;
        this.pressure = Math.min(
          1.2,
          this.pressure + this.pressureRate * sec + produced / 4_000_000,
        );
        this.tokens.cacheRead += produced * 6;
        changed = true;
      }
      if (!this.openStep) this.setOpenStep(now);
      if (this.modeLeft <= 0) {
        const [name, hint] = pick(rng, TOOL_POOL);
        this.pending = [{ callId: nextId('demo-call'), name, at: now }];
        this.pendingCalls = [name];
        this.tool = { name, at: now, category: CATEGORY_OF[name] ?? 'read' };
        this.mode = 'tool';
        this.modeLeft = rand(rng, 400, 1600);
        this.targetRate = rand(rng, 6, 24);
        this.rate = Math.min(this.rate, this.targetRate);
        events.push(this.event(now, 'step/start', { turn: this.turn, step: this.step }));
        events.push(this.event(now, 'tool/call', {
          tool: name, toolCategory: CATEGORY_OF[name] ?? 'read', detail: hint,
        }));
        changed = true;
      }
    } else if (this.mode === 'tool') {
      if (this.modeLeft <= 0) {
        const failed = rng() < 0.05;
        const tool = this.tool ?? { name: 'read', category: 'read' };
        const durationMs = tool.at ? now - tool.at : null;
        this.pending = [];
        this.pendingCalls = [];
        this.toolCounts[tool.category] = (this.toolCounts[tool.category] ?? 0) + 1;
        if (failed) {
          events.push(this.event(now, 'error', {
            tool: tool.name, toolCategory: tool.category, isError: true,
            detail: pick(rng, ERRORS), durationMs,
          }));
        } else {
          events.push(this.event(now, 'tool/result', {
            tool: tool.name, toolCategory: tool.category,
            detail: pick(rng, TOOL_RESULTS), durationMs,
          }));
        }
        this.step += 1;
        this.stepsInTurn += 1;
        this.tokens.input += Math.round(rand(rng, 400, 2400));
        if (this.toolCounts.write > 0) this.pressure = Math.min(1.2, this.pressure + 0.006);
        this.mode = 'thinking';
        this.modeLeft = rand(rng, 900, 2600);
        this.openStep = { turn: this.turn, step: this.step, startedAt: now, firstTokenAt: null };
        this.rate = rand(rng, 4, 14);

        // compaction: pressure creeps up until an approval / context reset
        if (this.pressure > 0.86) {
          events.push(this.event(now, 'approval', {
            detail: `上下文压力 ${(this.pressure * 100).toFixed(0)}% · 请求压缩上下文`,
          }));
          this.approvals = (this.approvals ?? 0) + 1;
          this.pressure *= rand(rng, 0.35, 0.55);
          this.targetRate = rand(rng, 10, 30);
        }
        if (this.stepsInTurn >= 5 + Math.floor(rng() * 6)) {
          events.push(...this.finishTurn(now));
          this.stepsInTurn = 0;
        }
        changed = true;
      }
    }
    return { events, changed };
  }

  finishTurn(now) {
    const events = [
      this.event(now, 'step/end', { turn: this.turn, step: this.step, durationMs: 800 + Math.floor(Math.random() * 4000) }),
      this.event(now, 'turn/end', { turn: this.turn, durationMs: 20_000 }),
    ];
    this.lastResponse = pick(Math.random, RESPONSES);
    this.turn += 1;
    this.step = 0;
    this.stepsInTurn = 0;
    this.lastPrompt = pick(Math.random, PROMPTS);
    this.openStep = null;
    this.pendingCalls = [];
    events.push(this.event(now, 'turn/start', { turn: this.turn }));
    this.mode = 'thinking';
    this.modeLeft = rand(Math.random, 1200, 3000);
    this.pressure = Math.min(1.15, this.pressure + 0.01);
    return events;
  }

  event(now, kind, extra = {}) {
    return {
      id: nextId(`evt-demo-${this.id}`),
      at: now,
      kind,
      source: this.source,
      sessionId: this.id,
      sessionTitle: this.title,
      tool: extra.tool ?? null,
      toolCategory: extra.toolCategory ?? null,
      detail: extra.detail ?? null,
      isError: extra.isError ?? null,
      turn: extra.turn ?? this.turn ?? null,
      step: extra.step ?? this.step ?? null,
      durationMs: extra.durationMs ?? null,
    };
  }

  project(now) {
    const state = this.live ? 'live' : this.endedState;
    return {
      id: this.id,
      title: this.title,
      workspace: this.workspace,
      cwd: this.cwd,
      source: this.source,
      sourceLabel: this.sourceLabel,
      state,
      parentId: this.parentId,
      depth: this.depth,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      preset: this.preset,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      turns: this.turn,
      steps: this.step,
      tokens: {
        input: Math.round(this.tokens.input),
        output: Math.round(this.tokens.output),
        cacheRead: Math.round(this.tokens.cacheRead),
        cacheWrite: Math.round(this.tokens.cacheWrite),
      },
      recentTokenRate: Math.round(this.rate * 100) / 100,
      contextPressure: Math.round(Math.min(1, this.pressure) * 10_000) / 10_000,
      contextWindow: this.contextWindow,
      openStep: this.openStep,
      pendingCalls: this.pendingCalls.slice(0, 8),
      toolCounts: { ...this.toolCounts },
      todos: this.todos,
      planActive: this.planActive,
      team: this.team,
      lastPrompt: this.lastPrompt,
      lastResponse: this.lastResponse,
    };
  }
}

export class DemoSource extends EventEmitter {
  constructor(config = {}, { log = () => {} } = {}) {
    super();
    this.config = config;
    this.log = log;
    this.source = 'demo';
    this.rng = mulberry32(20261027);
    this.agents = [];
    this.events = [];
    this.counters = { errors: 0, approvals: 0, toolCalls: 0, events: 0, polls: 0 };
    this.timer = null;
    this.running = false;
    this.bootAt = 0;
    this.aggregates = {
      liveCount: 0, idleCount: 0, endedCount: 0,
      tokenRate: 0, toolRate: 0, errorCount: 0, maxContextPressure: 0, stamp: 0,
    };
    this.lastTickAt = 0;
    this.sectors = [];
  }

  async init() {
    this.bootAt = nowMs();
    const now = this.bootAt;
    const rng = this.rng;

    // Only the workspace paths are needed; sectors are derived from the
    // projected sessions at the end of init (they are keyed by source + cwd).
    const byName = {
      'work agent': { path: 'C:\\work\\alpha' },
      game: { path: 'C:\\work\\game' },
      'deepseek harness': { path: 'C:\\work\\deepseek-harness' },
    };

    const team = { memberIds: ['demo-arch', 'demo-style', 'demo-mythic', 'demo-data'], tasks: 4 };
    const specs = [
      {
        id: 'demo-main', title: '构建本地 Agent 实时数据可视化', workspace: 'work agent',
        cwd: byName['work agent'].path, state: 'live', ageMs: 2_340_000,
        input: 0, output: 17_175, cacheRead: 955_392, pressure: 0.09, pressureRate: 0.0045,
        turn: 1, step: 18, targetRate: 14, rate: 12.5,
        todos: TODO_SEEDS.map((text, i) => ({ text, done: i < 2 })),
        planActive: true, team,
        lastPrompt: PROMPTS[0], lastResponse: RESPONSES[1],
        toolCounts: { read: 61, write: 22, exec: 31, net: 4, agent: 18 },
      },
      {
        id: 'demo-arch', title: '观测台视觉架构与场景分镜', workspace: 'work agent',
        cwd: byName['work agent'].path, state: 'live', parentId: 'demo-main', ageMs: 1_180_000,
        input: 2_140, output: 9_820, cacheRead: 320_000, pressure: 0.22, pressureRate: 0.0075,
        turn: 2, step: 9, targetRate: 9, rate: 7.2,
        todos: [{ text: '拆解视觉层级', done: true }, { text: '画分镜草图', done: false }],
        toolCounts: { read: 14, write: 6, exec: 2, net: 1, agent: 0 },
      },
      {
        id: 'demo-style', title: '深空配色与观感调优', workspace: 'work agent',
        cwd: byName['work agent'].path, state: 'live', parentId: 'demo-main', ageMs: 900_000,
        input: 1_100, output: 7_400, cacheRead: 210_000, pressure: 0.54, pressureRate: 0.013,
        turn: 2, step: 14, targetRate: 16, rate: 19.8,
        toolCounts: { read: 18, write: 12, exec: 4, net: 2, agent: 1 },
      },
      {
        id: 'demo-mythic', title: '命名与神话叙事线', workspace: 'work agent',
        cwd: byName['work agent'].path, state: 'live', parentId: 'demo-main', ageMs: 700_000,
        input: 640, output: 4_100, cacheRead: 120_000, pressure: 0.31, pressureRate: 0.006,
        turn: 1, step: 6, targetRate: 8, rate: 6.1,
        toolCounts: { read: 9, write: 3, exec: 1, net: 1, agent: 0 },
      },
      {
        id: 'demo-data', title: '采集层与 SSE 服务', workspace: 'work agent',
        cwd: byName['work agent'].path, state: 'live', parentId: 'demo-main', ageMs: 600_000,
        input: 320, output: 3_800, cacheRead: 90_000, pressure: 0.17, pressureRate: 0.011,
        turn: 1, step: 4, targetRate: 21, rate: 23.4,
        toolCounts: { read: 7, write: 5, exec: 3, net: 0, agent: 0 },
      },
      {
        id: 'demo-hermes', title: 'Hermes：修复事件循环里的状态泄漏', workspace: 'game',
        cwd: byName.game.path, state: 'live', source: 'hermes', ageMs: 5_400_000,
        input: 12_000, output: 24_500, cacheRead: 1_620_000, pressure: 0.63, pressureRate: 0.016,
        turn: 3, step: 12, targetRate: 6, rate: 2.1,
        toolCounts: { read: 41, write: 14, exec: 26, net: 0, agent: 2 },
        todos: [{ text: '复现泄漏', done: true }, { text: '定位到 turn/end 分支', done: true }, { text: '补回归测试', done: false }],
      },
      {
        id: 'demo-forge', title: '深海出图：星光少女立绘批次', workspace: 'deepseek harness',
        cwd: byName['deepseek harness'].path, state: 'idle', source: 'claude', ageMs: 4_100_000,
        input: 3_200, output: 6_880, cacheRead: 480_000, pressure: 0.42,
        turn: 1, step: 7,
        toolCounts: { read: 11, write: 4, exec: 9, net: 0, agent: 0 },
        lastPrompt: PROMPTS[3], lastResponse: RESPONSES[3],
      },
      {
        id: 'demo-ended', title: '重构 MCP 桥接握手校验', workspace: 'deepseek harness',
        cwd: byName['deepseek harness'].path, state: 'ended', source: 'opencode', ageMs: 9 * 3600_000,
        input: 4_500, output: 11_200, cacheRead: 700_000, pressure: 0.71,
        turn: 1, step: 23,
        toolCounts: { read: 24, write: 8, exec: 17, net: 1, agent: 3 },
        lastPrompt: PROMPTS[4], lastResponse: RESPONSES[4],
      },
    ];

    this.agents = specs.map((spec) => new DemoAgent(spec, now));
    this.sectors = buildSectors(this.agents.map((agent) => agent.project(now)));
    this.counter = 0;
    this.seedHistory(now);
    this.log(`[demo] simulated fleet ready · ${this.agents.length} agents`);
    return { agents: this.agents.length };
  }

  /** Backfill the ledger so the first screen already looks alive. */
  seedHistory(now) {
    const kinds = ['step/start', 'tool/call', 'tool/result', 'step/end', 'turn/start'];
    let n = 0;
    for (const agent of this.agents) {
      if (!agent.live && agent.endedState === 'ended') continue;
      const count = agent.id === 'demo-main' ? 6 : 3;
      for (let i = count; i > 0; i -= 1) {
        const at = now - i * 9000 - Math.floor(Math.random() * 2500);
        const kind = kinds[n % kinds.length];
        n += 1;
        const extra = kind === 'tool/call'
          ? { tool: 'read', toolCategory: 'read', detail: '读取 projcache 快照' }
          : kind === 'tool/result'
            ? { detail: '读取 214 行，未发现错误' }
            : {};
        this.push(agent.event(at, kind, extra), []);
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), SIM_TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = nowMs();
    const dt = this.lastTickAt ? Math.min(now - this.lastTickAt, 1000) : SIM_TICK_MS;
    this.lastTickAt = now;
    this.counters.polls += 1;

    const batch = [];
    const changed = [];
    for (const agent of this.agents) {
      const { events, changed: agentChanged } = agent.update(now, dt, this.rng);
      for (const event of events) this.push(event, batch);
      if (agentChanged || agent.live) changed.push(agent.project(now));
    }

    // aggregates: also refresh every second even without events
    if (this.running) {
      this.aggregates = this.computeAggregates(now);
      if (batch.length || changed.length) {
        for (const fn of this.listeners('tick')) {
          try {
            fn({ at: now, events: batch, sessions: changed, aggregates: this.aggregates });
          } catch (err) {
            this.log(`[demo] tick listener failed: ${err.message}`);
          }
        }
      }
    }
  }

  push(event, batch) {
    this.events.push(event);
    if (this.events.length > RING) this.events.splice(0, this.events.length - RING);
    batch.push(event);
    this.counters.events += 1;
    if (event.kind === 'error') this.counters.errors += 1;
    if (event.kind === 'approval') this.counters.approvals += 1;
    if (event.kind === 'tool/call') this.counters.toolCalls += 1;
  }

  computeAggregates(now) {
    const sessions = this.agents.map((a) => a.project(now));
    let liveCount = 0;
    let idleCount = 0;
    let endedCount = 0;
    let tokenRate = 0;
    let toolRate = 0;
    let maxPressure = 0;
    for (const s of sessions) {
      if (s.state === 'live') {
        liveCount += 1;
        tokenRate += s.recentTokenRate;
        toolRate += s.pendingCalls.length > 0 ? 0.4 : 0.15;
        maxPressure = Math.max(maxPressure, s.contextPressure);
      } else if (s.state === 'idle') {
        idleCount += 1;
        maxPressure = Math.max(maxPressure, s.contextPressure);
      } else endedCount += 1;
    }
    return {
      liveCount,
      idleCount,
      endedCount,
      tokenRate: Math.round(tokenRate * 100) / 100,
      toolRate: Math.round(toolRate * 1000) / 1000,
      errorCount: this.counters.errors,
      maxContextPressure: Math.round(maxPressure * 10_000) / 10_000,
      stamp: now,
    };
  }

  /** AgentSourceInfo[] for the demo fleet (codex stays absent on purpose). */
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
    return SOURCE_ORDER.map((id) => {
      const entry = stats.get(id) ?? { sessions: 0, live: 0, lastActivityAt: 0 };
      const detected = entry.sessions > 0;
      return {
        id,
        label: SOURCE_LABELS[id] ?? id,
        state: detected ? 'detected' : 'absent',
        sessions: entry.sessions,
        live: entry.live,
        lastActivityAt: entry.lastActivityAt,
        detail: detected ? `demo 模拟数据 · ${entry.sessions} 会话` : `未发现 ${id} 数据源`,
      };
    });
  }

  getFleet() {
    const now = nowMs();
    const sessions = this.agents.map((a) => a.project(now));
    this.aggregates = this.computeAggregates(now);
    return {
      generatedAt: now,
      source: 'demo',
      sessions,
      sectors: buildSectors(sessions),
      sources: this.buildSourceInfos(sessions),
      aggregates: this.aggregates,
      events: this.events.slice(-FLEET_EVENTS),
    };
  }

  getSessions() {
    const now = nowMs();
    return this.agents.map((a) => a.project(now));
  }

  getSession(id) {
    const agent = this.agents.find((a) => a.id === id);
    return agent ? agent.project(nowMs()) : null;
  }

  getEvents(limit = 100) {
    return this.events.slice(-Math.max(1, limit));
  }

  getHealth() {
    const now = nowMs();
    return {
      ok: true,
      source: 'demo',
      generatedAt: now,
      uptimeMs: this.bootAt ? now - this.bootAt : 0,
      booted: true,
      polling: this.running,
      pollMs: SIM_TICK_MS,
      poll: { count: this.counters.polls, lastMs: 1, maxMs: 3 },
      sessions: {
        total: this.agents.length,
        projected: this.agents.length,
        ...this.aggregates,
      },
      rates: {
        tokenPerSec: this.aggregates.tokenRate,
        toolPerSec: this.aggregates.toolRate,
        tokenPerMin: Math.round(this.aggregates.tokenRate * 60 * 10) / 10,
        toolPerMin: Math.round(this.aggregates.toolRate * 60 * 10) / 10,
        windowSec: 60,
      },
      events: { ring: this.events.length, ringMax: RING, frames: 0, bytes: 0, backlog: 0 },
      sources: { mode: 'demo' },
      counters: { ...this.counters },
    };
  }
}

/** start a demo source, fully initialised */
export async function createDemoSource(config = {}, opts = {}) {
  const demo = new DemoSource(config, opts);
  await demo.init();
  demo.start();
  return demo;
}

export { ms };
