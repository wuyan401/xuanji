# ASTRA 观测台 · 数据契约（DATA CONTRACT）

> **本文件是前端唯一契约。** 前端（`apps/web`）只允许依赖这里定义的字段；服务端（`apps/server`）改动任何
> 字段名、单位、可空性之前，必须先改本文件并与前端同步。
> 对应前端镜像：`apps/web/src/state/types.ts`（字段一一对应）。
>
> - 契约版本：**`v2`**（2026-10-27）—— 多源 agent 采集 + 整机遥测
> - 服务端：`apps/server/src/server.mjs`（零依赖 Node ≥ 24.12）
> - 默认地址：`http://127.0.0.1:8787`
> - 传输：JSON（UTF-8）+ SSE；所有响应 `Cache-Control: no-store`
>
> **v2 变更摘要（相对 v1）**
> 1. `AgentSession` 新增 `source` / `sourceLabel`，会话 id 全局唯一（非 DSH 来源带 `"<source>:"` 前缀）。
> 2. `FleetSnapshot` 新增 `sources: AgentSourceInfo[]`（来源注册表：detected / absent）。
> 3. `Sector` 新增 `source`；分野划分键由「workspace」升级为「source + workspace」。
> 4. `AstroEvent` 新增 `source`（**每个事件都必须带**），并支持 Hermes / OpenCode / Claude Code / Codex 的事件。
> 5. 新增整机遥测：`GET /api/system`、`GET /api/system/history`、SSE `event: system`。
> 6. 工具名 → 五类光束映射扩展到全部来源（含 Hermes / opencode / Claude Code 工具名与关键字兜底）。
> 7. 新增契约不变式：**`session.workspace === 该会话所在 sector.name`**。

---

## 1. 端点一览

| 方法 | 路径 | 返回 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | `Health` | 服务/采集健康、模式、耗时、各来源统计、整机遥测状态（调试用） |
| GET | `/api/fleet` | `FleetSnapshot` | **首屏全量快照**：全部来源的 sessions/sectors/sources/aggregates + 最近 ≤300 条事件 |
| GET | `/api/sessions` | `{ generatedAt, source, sessions: AgentSession[] }` | 只要 sessions 时用 |
| GET | `/api/sessions/:id` | `AgentSession` | id 用 **session.id 原样**（DSH 是原始 sessionId，其它来源带前缀）；不存在 → `404 {"error":"session not found","id":"…"}` |
| GET | `/api/events?limit=100` | `{ generatedAt, source, events: AstroEvent[] }` | `limit` 夹在 `1..2000`，默认 100，非法值回退 100 |
| GET | `/api/system` | `SystemSample` | **整机遥测最新一帧**（CPU/内存/磁盘/网络/进程/uptime/电池） |
| GET | `/api/system/history?limit=120` | `{ generatedAt, history: SystemSample[] }` | 历史采样环形缓冲；`limit` 夹在 `1..120`，默认 120（**返回对象，不是裸数组**） |
| GET | `/api/stream` | `text/event-stream` | **SSE**：`fleet` / `tick` / `system` / `: ping`，见 §8 |
| GET | `/api` | 路由表 | 调试用 |
| GET | `/*` | 静态文件 | 托管 `apps/web/dist`；未构建时返回占位 HTML（200） |

### 查询参数

| 参数 | 适用端点 | 行为 |
| --- | --- | --- |
| `?demo=1` | `/api/fleet`、`/api/stream`、`/api/sessions*`、`/api/events` | 返回/推送**模拟数据源**（`source:"demo"`）；live 模式下也会懒启动 demo 源，不影响真实采集 |
| `--demo` / `DEMO=1` | 启动参数 | 服务主数据源直接是 demo（`source:"demo"`） |
| `--replay <file>` | 启动参数 | 主数据源是回放（`source:"replay"`），`--replay` 优先于 `--demo` |

> demo 模式的 `sessions` 覆盖 4 个来源（dsh/hermes/claude/opencode）、`sources` 仍返回完整的 5 个来源
> （codex 故意为 `absent`），用于前端在无真实数据时演示多源与整机遥测界面。

### 错误码

| 状态 | 场景 | body |
| --- | --- | --- |
| 200 | 正常 | 见各端点 |
| 400 | 静态路径非法 URI 编码 | `Bad Request`（纯文本） |
| 403 | 静态路径逃逸 `webDist` | `Forbidden`（纯文本） |
| 404 | 未知 API 路径 / 会话不存在 / 缺失的静态资源 | `{"error":…}` 或纯文本 |
| 405 | 非 `GET`/`HEAD`（SSE 只允许 GET） | `{"error":"method not allowed"}` |
| 500 | 服务端未捕获异常 | `{"error":"internal error","message":…}` |
| 503 | 数据源尚未就绪（极少见） | `{"error":"source not ready yet","retry":true}` |

支持 `HEAD`（无 body）。`OPTIONS` 返回 204；只有带 `--cors` 启动且 `Origin` 是
`localhost/127.0.0.1/[::1]` 时才回显 CORS 头。

---

## 2. TypeScript 类型（可直接复制）

```ts
/* ------------------------------------------------------------------ 基础枚举 */

export type AgentState = 'live' | 'idle' | 'ended';
export type ToolCategory = 'read' | 'write' | 'exec' | 'net' | 'agent';
export type SourceKind = 'live' | 'demo' | 'replay';

/** 已知的 agent 来源 id。服务端可能追加新来源，前端请按 string 处理并容忍未知值。 */
export type AgentSourceId = 'dsh' | 'hermes' | 'opencode' | 'claude' | 'codex';

/* ------------------------------------------------------------------ 会话 */

export interface Tokens {
  input: number;       // 未命中缓存的输入 token（DSH: uncachedInputTokens；其它来源同义字段）
  output: number;      // 输出 token
  cacheRead: number;   // 命中缓存读的 token
  cacheWrite: number;  // 写缓存的 token
}

export interface OpenStep {
  turn: number;
  step: number;
  startedAt: number;            // epoch ms
  firstTokenAt: number | null;  // epoch ms；当前 step 尚未吐首 token / 来源无此信息时为 null
}

export interface TodoItem {
  text: string;   // ≤160 字，已清洗换行
  done: boolean;  // 仅 in_progress/pending → false
}

export interface AgentTeamInfo {
  memberIds: string[];  // 子 agent 的 sessionId（≤32 个）
  tasks: number;        // Team 任务数
}

export interface AgentSession {
  id: string;                    // 全局唯一。DSH: 原始 sessionId；其它: "<source>:<nativeId>"
  title: string;                 // 会话标题（≤80 字，无标题时由首条用户消息截断）
  workspace: string;             // 工作区显示名；**必须等于该会话所在 sector.name**
  cwd: string;                   // 工作目录；非 DSH 来源可能为空字符串，Hermes 用安装目录兜底
  source: string;                // 来源 id，见 AgentSourceId
  sourceLabel: string;           // 来源显示名：DSH / Hermes / OpenCode / Claude Code / Codex
  state: AgentState;
  parentId: string | null;       // 父会话 id（子 agent / 子会话），同源内唯一
  depth: number;                 // 父子层级，0 起，最大 8
  model: string | null;          // 例：deepseek-flash / deepseek-v4-flash / gpt-6-astra
  reasoningEffort: string | null;// DSH 专有（low/medium/high/max），其它来源 null
  preset: string | null;         // DSH agentPreset / Hermes source / opencode agent
  createdAt: number;             // epoch ms（整数）
  lastActivityAt: number;        // epoch ms（整数）；状态机按它计算
  turns: number;                 // 用户轮次数
  steps: number;                 // 步数（DSH step / Hermes assistant 消息 / opencode assistant 消息 / Claude assistant 记录）
  tokens: Tokens;
  recentTokenRate: number;       // tokens/s（近 60s 输出 token 增长）；仅 DSH 实时数据源有非 0 值
  contextPressure: number;       // 0..1（已 clamp）；来源无上下文信息时为 0
  contextWindow: number;         // 上下文窗口大小（token）；未知/无数据为 0
  openStep: OpenStep | null;     // 当前进行中的 step；无则 null
  pendingCalls: string[];        // 正在执行的工具名（≤8，去重）；无则 []
  toolCounts: Record<ToolCategory, number>; // 五类工具累计计数，键恒为 read/write/exec/net/agent
  todos: TodoItem[] | null;      // 当前 todo 列表；来源无 todo 信息时为 null
  planActive: boolean;           // 是否处于 plan 模式（DSH 专有，其它 false）
  team: AgentTeamInfo;           // 团队信息（恒有对象，无则 {memberIds:[],tasks:0}）
  lastPrompt: string | null;     // 最近一轮用户消息前 400 字（已清洗 system-reminder）
  lastResponse: string | null;   // 最近一轮助手回复前 400 字；进行中的会话可能为 null
}

/* ------------------------------------------------------------------ 分野 / 来源 / 聚合 */

export interface Sector {
  id: string;          // 全局唯一。DSH: workspace id；其它: "<source>::<规范化 cwd>"
  name: string;        // 分野显示名；**等于其中所有 session.workspace**
  path: string;        // 工作区路径（可能为空字符串）
  source: string;      // 所属来源 id
  sessionIds: string[];// 该分野内会话 id，按 lastActivityAt 降序
  liveCount: number;   // 该分野内 state==='live' 的数量
}

export interface AgentSourceInfo {
  id: string;                       // 'dsh' | 'hermes' | 'opencode' | 'claude' | 'codex' | …
  label: string;                    // 显示名
  state: 'detected' | 'absent';     // 本机是否检测到数据
  sessions: number;                 // 该来源当前投影出的会话数
  live: number;                     // 其中 live 数
  lastActivityAt: number;           // 该来源最近活动 ms；无数据为 0
  detail: string;                   // 人话说明（数据位置 / 未检测到原因）
}

export interface Aggregates {
  liveCount: number;
  idleCount: number;
  endedCount: number;          // ended 数量（含所有历史会话）
  tokenRate: number;           // tokens/s（仅 DSH 实时速率；无实时采集时为 0）
  toolRate: number;            // tools/s（仅 DSH 实时速率）
  errorCount: number;          // 最近 60s 事件中 kind==='error' 的数量
  maxContextPressure: number;  // live/idle 会话中最大的 contextPressure（0..1）
  stamp: number;               // epoch ms（该聚合的计算时刻）
}

/* ------------------------------------------------------------------ 事件 */

export type EventKind =
  | 'turn/start' | 'turn/end'
  | 'step/start' | 'step/end'
  | 'tool/call' | 'tool/result'
  | 'approval' | 'error'
  | 'session/live' | 'session/ended';

export interface AstroEvent {
  id: string;                 // 全局唯一且稳定（去重键）
  at: number;                 // epoch ms（整数），同一次 fleet 内按 at 升序
  kind: EventKind;
  source: string;             // **必填**：事件产生者所属来源 id，与该事件 session 的 source 一致
  sessionId: string;
  sessionTitle: string;       // ≤80 字
  tool: string | null;        // 工具原始名（tool/call、tool/result 才有）
  toolCategory: ToolCategory | null;
  detail: string | null;      // ≤120 字、无换行（参数首行 / 错误摘要 / 审批内容）
  isError: boolean | null;    // 仅 tool/result / error 有意义，其它为 null
  turn: number | null;
  step: number | null;
  durationMs: number | null;  // tool/result、step/end 的耗时；其它为 null
}

/* ------------------------------------------------------------------ 快照 / SSE 帧 */

export interface FleetSnapshot {
  generatedAt: number;       // epoch ms
  source: SourceKind;        // 'live' | 'demo' | 'replay'
  sessions: AgentSession[];
  sectors: Sector[];
  sources: AgentSourceInfo[];
  aggregates: Aggregates;
  events: AstroEvent[];      // 最近 ≤300 条，按 at 升序
}

/** SSE `event: fleet` 的 data */
export interface FleetFrame extends FleetSnapshot {
  type: 'fleet';
}

/** SSE `event: tick` 的 data（增量帧；字段可省略） */
export interface FleetTickFrame {
  type: 'tick';
  at: number;                          // epoch ms
  events: AstroEvent[];                // 自上次 tick 以来的新事件（可能为 []）
  sessions?: AgentSession[];           // 仅“有变化”的会话（可省略）
  aggregates?: Aggregates;             // 最新聚合（可省略）
}

/* ------------------------------------------------------------------ 整机遥测 */

export interface SystemCpu {
  usage: number;        // 0..1 全 CPU 使用率
  perCore: number[];    // 每逻辑核 0..1；核数 = perCore.length
}

export interface SystemMem {
  usedPct: number;      // 0..1
  usedBytes: number;
  totalBytes: number;
}

export interface SystemDisk {
  name: string;         // 例如 "C:\\"
  totalBytes: number;
  freeBytes: number;
  usedPct: number;      // 0..1
}

export interface SystemNet {
  rxBps: number;        // 最近一个采样区间的接收速率（bytes/s）
  txBps: number;        // 发送速率（bytes/s）
  totalRxBytes: number; // 自采样进程启动以来的累计接收字节
  totalTxBytes: number;
}

export interface SystemProc {
  pid: number;
  name: string;
  cpuPct: number;       // 百分比数值（10 = 10%，即 0..100，不是 0..1）
  memBytes: number;     // WorkingSet64 字节
  threads: number;      // 线程数（v2.5 起）
  startedAt: number;    // 进程启动时间 epoch ms（v2.6 起；受保护进程可能为 0）
}

export interface SystemBattery {
  percent: number;      // 0..100
  charging: boolean;
}

/** `/api/system`、`/api/system/history[]`、SSE `event: system` 的 data 形状 */
export interface SystemSample {
  type?: 'system';      // 仅 SSE system 帧带该字段；REST 的 SystemSample 不带
  at: number;           // epoch ms
  available: boolean;   // 采样器是否可用；false 时其余字段为 0 / [] / null
  cpu: SystemCpu;
  mem: SystemMem;
  disks: SystemDisk[];
  net: SystemNet;
  procs: SystemProc[];  // 最多 220 条（v2.5 起；早期版本为 top 12）
  uptimeSec: number;    // 系统运行时间（秒）
  battery: SystemBattery | null; // 无电池（台式机）→ null
}

export interface SystemHistory {
  generatedAt: number;  // epoch ms
  history: SystemSample[]; // 按 at 升序，≤120
}

/** `/api/stream` 的帧类型 */
export type SseFrame = FleetFrame | FleetTickFrame | SystemSample;
```

> 前端本地扩展（`ClientFleetSnapshot` 的 `connection` / `receivedAt`）由客户端自行维护，服务端**不下发**。

---

## 3. AgentSession 字段明细

| 字段 | 类型 | 单位/取值 | 可空 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | string | — | 否 | 全局唯一。DSH 为原始 sessionId（uuid 或 `session-uuid`）；其它来源 `<source>:<nativeId>` |
| `title` | string | ≤80 字 | 否 | 见 §3.1 标题规则 |
| `workspace` | string | — | 否 | 工作区别名；**不变式：等于所属 `sector.name`** |
| `cwd` | string | 绝对路径或 `''` | 否（可为空串） | 见 §3.2 cwd 规则 |
| `source` | string | 来源 id | 否 | `dsh` / `hermes` / `opencode` / `claude` / `codex` |
| `sourceLabel` | string | 显示名 | 否 | `DSH` / `Hermes` / `OpenCode` / `Claude Code` / `Codex` |
| `state` | AgentState | — | 否 | 见 §4 状态机 |
| `parentId` | string \| null | session.id | 可空 | 子 agent / 子会话的父会话（同来源） |
| `depth` | number | 0..8 | 否 | 由 parentId 链计算 |
| `model` | string \| null | — | 可空 | 模型名；来源未记录时为 null |
| `reasoningEffort` | string \| null | — | 可空 | DSH 专有 |
| `preset` | string \| null | — | 可空 | DSH=agentPreset；Hermes=sessions.source（desktop/qqbot…）；opencode=agent |
| `createdAt` | number | epoch ms 整数 | 否 | 会话创建时间 |
| `lastActivityAt` | number | epoch ms 整数 | 否 | 最近活动时间；状态机唯一依据 |
| `turns` | number | 次 | 否 | 用户轮次 |
| `steps` | number | 步 | 否 | 见 §3.3 |
| `tokens` | Tokens | token | 否 | 四键恒存在，未知为 0 |
| `recentTokenRate` | number | tokens/s | 否 | 近 60s 速率；只有 DSH 实时数据非 0 |
| `contextPressure` | number | 0..1 | 否 | 已 clamp；无上下文信息（非 DSH）=0 |
| `contextWindow` | number | token | 否 | 未知 =0 |
| `openStep` | OpenStep \| null | — | 可空 | 无进行中 step 时 null |
| `pendingCalls` | string[] | 工具名 | 否 | 无则 `[]` |
| `toolCounts` | Record<ToolCategory, number> | 次 | 否 | 五键恒存在 |
| `todos` | TodoItem[] \| null | — | 可空 | 无 todo 信息 = null |
| `planActive` | boolean | — | 否 | 非 DSH 恒 false |
| `team` | AgentTeamInfo | — | 否 | 恒有对象 |
| `lastPrompt` | string \| null | ≤400 字 | 可空 | 已清洗 system-reminder 噪声 |
| `lastResponse` | string \| null | ≤400 字 | 可空 | 进行中的 DSH 会话可能为 null |

### 3.1 标题规则
1. Hermes：`sessions.display_name` → `sessions.title` → 首条 user 消息前 60 字。
2. OpenCode：`session.title` → 首条 user 文本前 60 字。
3. Claude Code：`ai-title.aiTitle` → `last-prompt.lastPrompt` 前 60 字 → 首条 user 文本前 40 字。
4. Codex（预留）：`session_meta` 的标题 → 首条 user 消息。
5. DSH：子 agent 用 `subagent.identity.label`（即任务描述）→ 用户会话用 `rows.title` → `titleInput.first.text` → `"会话 <id 前 8 位>"`。
6. 全部清洗：剥离 `<system-reminder>…</system-reminder>`（含被截断的未闭合块）、压缩空白、换行 → 空格、≤80 字。

### 3.2 cwd 规则
- DSH：`record.identity.cwd`。
- Hermes：`sessions.cwd`；为空的历史会话（本机 117 条里 77 条）回退为 **Hermes 安装目录**
  （`C:/work/hermes`，即 `state.db` 所在目录），因此 `cwd` 非空、`workspace='hermes'` 与分野名一致。
- OpenCode：`session.directory`。
- Claude Code：会话记录里的 `cwd` 字段；缺失时为空串 `""`。
- **契约允许非 DSH 来源的 `cwd` 为空字符串**；前端不要假设 `cwd` 一定非空，`workspace` 永远非空。

### 3.3 steps 语义差异
| 来源 | `turns` | `steps` |
| --- | --- | --- |
| DSH | 轮次数 | `sessionStats.steps` |
| Hermes | `role='user'` 消息数 | `role='assistant'` 消息数 |
| OpenCode | user 消息数 | assistant 消息数 |
| Claude Code | 用户 prompt 记录数 | assistant 记录数 |
| Codex | 预留同义 | 预留同义 |

### 3.4 排序
`/api/fleet` 的 `sessions` 排序：`live` → `idle` → `ended`；同状态内按 `lastActivityAt` 降序。
`sectors` 排序：`liveCount` 降序 → `name` 升序。
`events` 按 `at` 升序（时间相同按 id 稳定排序）。

---

## 4. 状态机

```
archived / 来源显式结束 (Hermes ended_at 非空、archived=1；DSH workspace.json 归档)
                        → ended
lastActivityAt 距今 ≤ LIVE_MS (默认 60s)              → live
有 openStep 且距今 ≤ IDLE_MS (默认 30min)              → live
距今 ≤ IDLE_MS                                         → idle
否则                                                   → ended
```

- 时间基准：`now - lastActivityAt`，单位 ms；`lastActivityAt` 由多信号取最大值
  （projcache mtime / 事件时间 / 最新消息时间 / openStep.startedAt / createdAt）。
- **非 DSH 来源没有「openStep」概念**：Hermes 用 `ended_at`/`archived` 判 ended，
  其余按时间推断（本机 Hermes/OpenCode/Claude 的历史数据都 >24h，因此基本都是 `ended` 或短暂 `idle`）。
- `ended` 会话仍会出现在 fleet 中（保证画面有足够历史内容），但 `openStep=null`、`pendingCalls=[]`。
- 事件 `session/live` / `session/ended` 在一次会话状态变化时产生一次。

---

## 5. Sector / Aggregates 口径

### 5.1 Sector 划分
- 划分键：`source + workspaceKey`（DSH 的 workspaceKey 是 workspace.json 里的 workspace id；
  其它来源是规范化 cwd：小写、`/` 分隔、去尾斜杠）。
- `Sector.id` 全局唯一：DSH 保持原 workspace id（如 `2d45ce27-…`），其它来源为 `"<source>::<规范化 cwd>"`，
  无 cwd 时为 `"<source>::unknown"`。
- `Sector.name` 取该分野内会话的 `workspace`（同一分野所有会话的 workspace 相同）；
  **不变式**：任意 `session.workspace === 其所属 sector.name`。
- `Sector.path`：DSH 为 workspace 路径；其它来源为该分野的 cwd（原样）。
- 只有至少包含一个会话的分野才会出现在 `sectors` 中。

### 5.2 Aggregates 口径
- `liveCount/idleCount/endedCount`：全部来源全部会话的计数（包含历史 ended）。
- `tokenRate` / `toolRate`：**只有 DSH 实时采集器提供**（60s 滚动窗口）；多源合并时沿用 DSH 的速率，
  不会因为 Hermes/OpenCode 的历史 token 而虚高。
- `errorCount`：最近 60s 内 `kind==='error'` 的事件数（所有来源）。
- `maxContextPressure`：live/idle 会话中最大 `contextPressure`（0..1）。
- `stamp`：该聚合的计算时刻。

---

## 6. 工具名 → 类别映射（五层光束）

类别恒为 `read | write | exec | net | agent`（顺序即光束层顺序）。映射集中在
`apps/server/src/tools.mjs`，**服务端是唯一真源**。解析顺序：

1. 精确匹配表；
2. 对比小写（Claude Code 的 `Read`/`Glob`/`Bash`/`WebFetch`…）；
3. `mcp__<server>__<tool>` 取内层工具名重新解析；
4. 前缀规则；
5. 关键字兜底（未知来源的新工具名）；
6. 都不中 → `null`（保留在事件上 `tool: 原值`，但不计入 `toolCounts`）。

### 6.1 各来源工具名对照表（节选）

| 来源 | read | write | exec | net | agent |
| --- | --- | --- | --- | --- | --- |
| DSH | read/glob/grep/ls/list/tree/read_image/analyze_*/query_*/get_*/team_task_get/list_agents/job_*/… | write/edit/multi_edit/apply_patch/todo_write/compress/create|update|delete_database_entry/manage_*/edit_map/generate_map/present | bash/pwsh/shell/exec/run/command/job_kill | web_search/web_fetch/fetch/curl/http | subagent/spawn_teammate/send_message/wait_agent/team_*/workflow/magi_review/skill |
| Hermes | read_file/search_files/skill_view/skills_list/vision_analyze/session_search | patch/write_file/memory/todo/image_generate/open_preview/text_to_speech | terminal/execute_code/process/close_terminal | browser_navigate/browser_console/browser_vision | skill_manage/delegate_task/clarify/cronjob |
| OpenCode | todoread/read/glob/grep/ls | todowrite/multiedit/write/edit/patch | bash | webfetch/websearch | task |
| Claude Code | Read/Glob/Grep/LS/NotebookRead/LSP-Diagnostics | Write/Edit/TodoWrite/NotebookEdit | Bash | WebFetch/WebSearch | Task/Skill |
| Codex（预留） | 同义小写映射 | 同义小写映射 | shell/exec | fetch | agent |

> 设计决定：Claude Code 的 `Task` 与 `Skill` 归为 **`agent`**（它们会派生/调度子 agent 或加载技能流程），
> 与 DSH 的 `subagent`/`skill` 一致。

### 6.2 关键字兜底规则（顺序即优先级）

```
net    /web|browser|fetch|http|url|curl|network/
exec   /bash|shell|exec|command|terminal|process|spawn|run/
agent  /subagent|agent|team|delegate|teammate|skill|task/
write  /write|edit|patch|apply|create|update|delete|save|generate|todo|memory|notebook/
read   /read|view|search|grep|glob|ls|list|find|query|get|inspect|show|status|diagnostic/
```

`toolCounts` 只累计能映射到五类的工具；未知工具不上报 `toolCounts`，事件里 `toolCategory: null`。

---

## 7. AstroEvent 生成规则

### 7.1 通用约束
- `id` 全局唯一且稳定（前端按 id 去重）；同一事件在首帧 fleet 与 tick 中的 id 相同。
- `at` 为整数 ms；一次 fleet 内事件按 `at` 升序；ring 容量 2000，fleet 只带最近 ≤300 条。
- `detail`：≤120 字、单行，优先取参数首行 / 错误摘要 / 审批内容。
- `sessionTitle`：≤80 字。
- **`source` 必须存在**且等于该事件 `sessionId` 所属会话的 `source`（DSH 事件 `source:'dsh'`）。
- `kind` 只能取 §2 的 10 种。

### 7.2 各来源事件映射

| 来源 | 事件来源 → kind | 说明 |
| --- | --- | --- |
| DSH | `step/start`→`step/start`；`step/end`→`step/end`；`turn/start`、`turn/end`；`tool/call`、`tool/result`；`tool/result.isError`→`tool/result` + `error`；`approval/asked`→`approval`；状态变化→`session/live`/`session/ended` | 原有规则不变 |
| Hermes | 新 user 消息→`turn/start`（turn 序号按会话内自增）；assistant 的 `tool_calls[]`→每个 call 一条 `tool/call`；assistant 无 tool_calls 且有正文→`turn/end`；`role='tool'`→`tool/result`（解析 content JSON 的 `output`/`error`/`exit_code` 判 `isError`，错误时额外一条 `error`）；`finish_reason='error'`→`error`；状态变化→`session/live`/`session/ended` | `tool/call.detail` 取 function.arguments 的关键参数；`tool/result.durationMs` 由 call/result 时间差 |
| OpenCode | `part.type='step-start'`→`step/start`；`step-finish`→`step/end`；`tool` part（status completed/error）→`tool/call` + `tool/result`（`state.output`/`metadata.output`/`error`，`durationMs`=end-start）；user 文本 part→`turn/start`；状态变化→`session/live`/`session/ended` | 同一 part 只上报一次（去重集合） |
| Claude Code | user prompt 记录→`turn/start`；assistant 的 `tool_use`→`tool/call`；随后的 `tool_result`→`tool/result`（配对 `tool_use_id`，`is_error`）；assistant 无 tool_use 的文本→`turn/end`；`system.subtype='api_error'`→`error`；状态变化→`session/live`/`session/ended` | 历史会话的种子事件只取最近 7 天内文件的尾部 |
| Codex（预留） | `response_item.message`→`turn/start`/`turn/end`；`function_call`→`tool/call`；`function_call_output`→`tool/result` | 本机无 rollout 记录，暂不产生事件 |

### 7.3 事件 id 形态（示例）
```
evt-7b69868d-99db-4b35-bbd6-d2cb5eddaa08-2512          # DSH: evt-<sessionId>-<seq>
evt-hermes-44434-call_00_m9YJMz8qDLs0hgQ8dVfr3356      # Hermes: evt-hermes-<messageId>-<callId>
evt-opencode-prt_ab12…-3                                # OpenCode
evt-claude-7a4fc49e-…-12                                # Claude Code
```

---

## 8. SSE 协议

`GET /api/stream`（可带 `?demo=1`）。响应头 `Content-Type: text/event-stream`，开场：

```
retry: 3000

: connected
```

之后出现三类消息：

```
event: fleet
data: {"type":"fleet","generatedAt":1793092743020,"source":"live","sessions":[...],"sectors":[...],"sources":[...],"aggregates":{...},"events":[...]}

event: tick
data: {"type":"tick","at":1793092743020,"events":[{"id":"evt-…",…}],"sessions":[仅变更的会话],"aggregates":{...}}

event: system
data: {"type":"system","at":1793092740956,"available":true,"cpu":{...},"mem":{...},"disks":[...],"net":{...},"procs":[top12],"uptimeSec":188770,"battery":{"percent":100,"charging":true}}

: ping
```

| 帧 | 频率 | 说明 |
| --- | --- | --- |
| `fleet` | 首帧**立即**发送，之后每 `FLEET_FRAME_MS`（默认 1000ms，≤1fps） | 完整 `FleetSnapshot` + `type:'fleet'`；前端可直接整体替换状态 |
| `tick` | 每次采集轮询（DSH 500ms / 多源 1000ms 中有新事件时） | 增量：`events`、仅变更的 `sessions`、最新 `aggregates`；无变化时可能不发 |
| `system` | 每个采样周期（默认 2000ms） | 整机遥测紧凑帧（`procs` top 12）；采样器不可用时不会发送 |
| `: ping` | 每 `HEARTBEAT_MS`（默认 15000ms） | SSE 注释行，用于保活（前端 EventSource 不会触发事件） |

- 多客户端互不影响；每个连接独立计时。
- 帧的 `data:` 一律单行 JSON。
- 前端 `EventSource` 断线重连由浏览器负责（`retry: 3000`）。
- 客户端 32s 未收到任何消息可视为 stale（服务端心跳 + fleet 帧保证不会发生）。

---

## 9. `/api/health`（调试用，前端可不依赖）

顶层字段（v2）：

```
ok, source, generatedAt, uptimeMs, booted, polling,
dshRoot, pollMs, sourcePollMs,
poll:        { polls, lastPollMs, maxPollMs, events, sourceEvents, lastPollAt },
sessions:    { total, liveCount, idleCount, endedCount, tokenRate, toolRate, errorCount, maxContextPressure, stamp },
sources:     { dsh: {...}, hermes: {...}, opencode: {...}, claude: {...}, codex: {...} },
sourceInfo:  [ AgentSourceInfo × 5 ],
system:      SystemSample,
events:      { ring, ringMax, frames, bytes, backlog, cursors },
init:        { ms, dshMs, secondaryMs, sources: [{id, sessions, events, ms, error}], seededEvents },
hub:         { mode, clients, uptimeMs, port, webDist, webBuilt, demoAvailable, systemTelemetry }
```

实测（本机，2026-10-27，389 会话）：

```json
{
  "ok": true, "source": "live",
  "poll": { "polls": 171, "lastPollMs": 0.9, "maxPollMs": 77, "events": 576, "sourceEvents": 577 },
  "sessions": { "total": 389, "liveCount": 3, "idleCount": 2, "endedCount": 384,
                "tokenRate": 189.9, "toolRate": 0.327, "errorCount": 0, "maxContextPressure": 0.2498 },
  "init": {
    "ms": 3223, "dshMs": 190, "secondaryMs": 3025, "seededEvents": 347,
    "sources": [
      { "id": "hermes",   "sessions": 118, "events": 130, "ms": 1347, "error": null },
      { "id": "opencode", "sessions": 87,  "events": 117, "ms": 2750, "error": null },
      { "id": "claude",   "sessions": 59,  "events": 0,   "ms": 3024, "error": null },
      { "id": "codex",    "sessions": 0,   "events": 0,   "ms": 0,    "error": null }
    ]
  },
  "hub": { "mode": "live", "clients": 0, "systemTelemetry": true }
}
```

> `init` 是**一次性**冷启动耗时（服务先 `listen`，再异步初始化数据源，不阻塞 HTTP）。
> `poll.maxPollMs` 是采集轮询的最坏单轮耗时（稳态目标 ≤80ms）。

---

## 10. 数据来源注册表

| id | label | 物理来源（本机默认路径） | 读取方式 | 说明 |
| --- | --- | --- | --- | --- |
| `dsh` | DSH | `~/.dsh/storages/session_projcache/sessions/*.json`（会话主快照）+ `~/.dsh/sessions/**/session.v4.jsonl.zstd`（事件流）+ `~/.dsh/storages/workspace.json` | 文件 stat + 增量解析；zstd 多帧增量 tail | 实时（本机唯一有 live 会话的来源） |
| `hermes` | Hermes | `~/.hermes/state.db`（SQLite，578MB，117+ 会话 / 43k 消息） | `node:sqlite` `readOnly:true` + `busy_timeout=1500`；`messages.id` 水位增量 | 历史数据为主；`sessions.started_at/ended_at` 是**秒级 REAL**，已转 ms |
| `opencode` | OpenCode | `~/.local/share/opencode/opencode.db`（SQLite，50MB，87 会话 / 3k 消息 / 13k part） | 同上；`session.time_updated`/`part.time_updated` 水位增量 | 历史数据（本机最新 2026-09-30） |
| `claude` | Claude Code | `~/.claude/projects/**/*.jsonl`（59 文件，每文件一个会话） | 文件字节 offset 增量 tail | 历史数据（本机最新 2026-07-31）；标题取 `ai-title` |
| `codex` | Codex | `~/.codex/sessions/**/rollout-*.jsonl` | 文件增量（解析器预留） | **本机 absent**：`~/.codex` 仅配置、无 sessions |

- 每个来源在 `sources: AgentSourceInfo[]` 中一项；`state='absent'` 表示本机未检测到数据（不是报错）。
- 未注册的其它 agent 可后续新增（注册表顺序：`dsh, hermes, opencode, claude, codex`）。
- SQLite 一律**只读打开**，绝不写原始数据；采集侧只读文件，不做任何修改。
- 可配置项（env）：`DSH_ROOT`、`HERMES_DB`、`OPENCODE_DB`、`CLAUDE_DIR`、`CODEX_DIR`。

---

## 11. 整机遥测（`/api/system`）

### 11.1 采样
- 单进程 PowerShell 循环脚本 `apps/server/src/system-sample.ps1`，每 `SYSTEM_SAMPLE_MS`（默认 2000ms）
  向 stdout 输出一行 JSON；Node 侧 `system.mjs` spawn 一次、逐行解析。
- 采样内容：CPU（总 + 每逻辑核）、内存（GlobalMemoryStatusEx）、固定磁盘、网络（网卡累计字节差分算 bps）、
  进程 CPU/内存 top 12、系统 uptime、电池（每 8 轮查询一次）。
- 退出/崩溃自动重启（退避 500ms×2ⁿ，封顶 10s，unref）；非 Windows / 无 PowerShell → `available:false`，不报错。
- `SYSTEM_TELEMETRY=0` 可整体关闭遥测。

### 11.2 数值单位（容易踩坑）
- `cpu.usage`、`cpu.perCore[]`、`mem.usedPct`、`disks[].usedPct`：**0..1 的比例**。
- `procs[].cpuPct`：**百分比数值 0..100**（`10` 表示 10%）。
- `battery.percent`：0..100。
- `net.rxBps/txBps`：bytes/s（不是 bits/s）；`totalRxBytes/totalTxBytes`：自采样进程启动的累计值。
- 所有字节字段单位为 `byte`，时间单位 `ms`（`uptimeSec` 为秒）。

### 11.3 `/api/system/history`
- 返回 `{ generatedAt, history: SystemSample[] }`（**对象**，不是裸数组）。
- 环形缓冲容量 = `SYSTEM_HISTORY`（默认 120）；`limit` 上限 120，非法值回退 120。

### 11.4 实测样例（本机，24 核 / 16.9GB / C D E 三盘）

```json
{
  "at": 1793092740956,
  "available": true,
  "cpu": { "usage": 0.1845, "perCore": [0.4049, 0.0375, 0.3311, 0.015, 0.434, 0.0082, 0.3608, 0.0223,
            0.1913, 0.0958, 0.0149, 0.0517, 0.0958, 0.0811, 0.0296, 0.3086, 0.0143, 0.6324,
            0.0221, 0.103, 0.0732, 0.3527, 0.6837, 0.0663] },
  "mem": { "usedPct": 0.7911, "usedBytes": 13367328768, "totalBytes": 16898142208 },
  "disks": [
    { "name": "C:\\", "totalBytes": 321106472960, "freeBytes": 59431759872, "usedPct": 0.8149 },
    { "name": "D:\\", "totalBytes": 701008703488, "freeBytes": 60638269440, "usedPct": 0.9135 },
    { "name": "E:\\", "totalBytes": 512092008448, "freeBytes": 8549765120,  "usedPct": 0.9833 }
  ],
  "net": { "rxBps": 40894, "txBps": 496705, "totalRxBytes": 2583570869, "totalTxBytes": 2363631685 },
  "procs": [
    { "pid": 52912,  "name": "msedge",  "cpuPct": 4.7, "memBytes": 552099840 },
    { "pid": 99544,  "name": "msedge",  "cpuPct": 2.8, "memBytes": 358006784 },
    { "pid": 38544,  "name": "msedge",  "cpuPct": 2.5, "memBytes": 487714816 },
    { "pid": 95080,  "name": "node",    "cpuPct": 1,   "memBytes": 578990080 },
    { "pid": 123376, "name": "node",    "cpuPct": 0.3, "memBytes": 619945984 }
  ],
  "uptimeSec": 188770,
  "battery": { "percent": 100, "charging": true }
}
```

（`procs` 实际返回 top 12，上面截断为 5 条示意。）

---

## 12. 实测样例（v2，真实数据）

### 12.1 FleetSnapshot 顶层

```json
{
  "generatedAt": 1793092743020,
  "source": "live",
  "sessions": [ /* 389 条：dsh 125 + hermes 118 + opencode 87 + claude 59 */ ],
  "sectors": [ /* 36 个 */ ],
  "sources": [
    { "id": "dsh",      "label": "DSH",         "state": "detected", "sessions": 125, "live": 3, "lastActivityAt": 1793092742218, "detail": "projcache · C:\\Users\\gray\\.dsh" },
    { "id": "hermes",   "label": "Hermes",      "state": "detected", "sessions": 118, "live": 0, "lastActivityAt": 1793092571800, "detail": "SQLite · ~/.hermes/state.db" },
    { "id": "opencode", "label": "OpenCode",    "state": "detected", "sessions": 87,  "live": 0, "lastActivityAt": 1790778300727, "detail": "SQLite · C:\\Users\\gray\\.local\\share\\opencode\\opencode.db" },
    { "id": "claude",   "label": "Claude Code", "state": "detected", "sessions": 59,  "live": 0, "lastActivityAt": 1785500101527, "detail": "JSONL · C:\\Users\\gray\\.claude\\projects" },
    { "id": "codex",    "label": "Codex",       "state": "absent",   "sessions": 0,   "live": 0, "lastActivityAt": 0,             "detail": "未发现 rollout 记录（C:\\Users\\gray\\.codex 仅配置）" }
  ],
  "aggregates": {
    "liveCount": 3, "idleCount": 2, "endedCount": 384,
    "tokenRate": 189.9, "toolRate": 0.327, "errorCount": 0,
    "maxContextPressure": 0.2498, "stamp": 1793092743020
  },
  "events": [ /* 最近 300 条，按 at 升序；实测 kind 分布 step/end 59、step/start 59、tool/result 90、tool/call 91、turn/end 1；source 分布 dsh 295、hermes 5 */ ]
}
```

### 12.2 DSH live 会话（本团队子 agent，真实值）

```json
{
  "id": "7b69868d-99db-4b35-bbd6-d2cb5eddaa08",
  "title": "实现 DSH 数据采集器与本地 HTTP/SSE 服务",
  "workspace": "work agent",
  "cwd": "C:\\work\\work agent",
  "source": "dsh",
  "sourceLabel": "DSH",
  "state": "live",
  "parentId": "session-1a4ca1b8-a3bd-46f0-99ec-d994f198c2af",
  "depth": 1,
  "model": "deepseek-flash",
  "reasoningEffort": "max",
  "preset": "standard",
  "createdAt": 1793081510111,
  "lastActivityAt": 1793092742218,
  "turns": 2,
  "steps": 428,
  "tokens": { "input": 905203, "output": 389804, "cacheRead": 49246976, "cacheWrite": 0 },
  "recentTokenRate": 123.17,
  "contextPressure": 0.135,
  "contextWindow": 1000000,
  "openStep": { "turn": 2, "step": 212, "startedAt": 1793092738828, "firstTokenAt": 1793092740002 },
  "pendingCalls": ["pwsh"],
  "toolCounts": { "read": 27, "write": 27, "exec": 22, "net": 0, "agent": 0 },
  "todos": [
    { "text": "Write tests for sources/system/API; node --test apps/server/tests/*.mjs all green", "done": false }
  ],
  "planActive": false,
  "team": { "memberIds": [], "tasks": 0 },
  "lastPrompt": "你是「ASTRA 观测台」项目的数据工程师。…",
  "lastResponse": "数据层交付完成，task-4 已标记 complete（revision 3），后端进入冻结状态。以下是最终交付摘要：…"
}
```

### 12.3 Hermes 会话（无 cwd 历史会话的兜底示例）

```json
{
  "id": "hermes:20261027_171424_fe81aa",
  "title": "浏览器自动下载PDF原因排查",
  "workspace": "hermes",
  "cwd": "C:/work/hermes",
  "source": "hermes",
  "sourceLabel": "Hermes",
  "state": "idle",
  "parentId": null,
  "depth": 0,
  "model": "deepseek-v4-flash",
  "reasoningEffort": null,
  "preset": "desktop",
  "createdAt": 1793092465977,
  "lastActivityAt": 1793092571800,
  "turns": 1,
  "steps": 8,
  "tokens": { "input": 32604, "output": 12337, "cacheRead": 292480, "cacheWrite": 0 },
  "recentTokenRate": 0,
  "contextPressure": 0,
  "contextWindow": 0,
  "openStep": null,
  "pendingCalls": [],
  "toolCounts": { "read": 1, "write": 0, "exec": 10, "net": 0, "agent": 0 },
  "todos": null,
  "planActive": false,
  "team": { "memberIds": [], "tasks": 0 },
  "lastPrompt": "@file:.hermes/desktop-attachments/IB_LLC_2021_UnAud_Finls.pdf 浏览器怎么自动下载了这个文件 …",
  "lastResponse": "查清楚啦～这个文件本身是干净的，也不是网站偷偷下的…"
}
```

### 12.4 OpenCode 会话

```json
{
  "id": "opencode:ses_f0d66c226ffeVGRXLB1l7eKgzJ",
  "title": "《群星》主题前卫沉浸式网页设计",
  "workspace": "opencode",
  "cwd": "~/work/opencode",
  "source": "opencode",
  "sourceLabel": "OpenCode",
  "state": "ended",
  "parentId": null, "depth": 0,
  "model": "gpt-6-astra", "reasoningEffort": null, "preset": "build",
  "createdAt": 1790776524250, "lastActivityAt": 1790778300727,
  "turns": 4, "steps": 32,
  "tokens": { "input": 180943, "output": 16729, "cacheRead": 1044992, "cacheWrite": 0 },
  "recentTokenRate": 0, "contextPressure": 0, "contextWindow": 0,
  "openStep": null, "pendingCalls": [],
  "toolCounts": { "read": 7, "write": 8, "exec": 9, "net": 0, "agent": 7 },
  "todos": null, "planActive": false, "team": { "memberIds": [], "tasks": 0 },
  "lastPrompt": "继续",
  "lastResponse": "已经找到原因并修复了。…"
}
```

### 12.5 Claude Code 会话

```json
{
  "id": "claude:7a4fc49e-eb47-411c-9f20-84681d5cd583",
  "title": "현재 사용 중인 모델 확인",
  "workspace": "hermes",
  "cwd": "d:\\app\\hermes",
  "source": "claude",
  "sourceLabel": "Claude Code",
  "state": "ended",
  "parentId": null, "depth": 0,
  "model": "deepseek-v4-flash", "reasoningEffort": null, "preset": null,
  "createdAt": 1785497771078, "lastActivityAt": 1785500101527,
  "turns": 5, "steps": 421,
  "tokens": { "input": 425777, "output": 160347, "cacheRead": 34205440, "cacheWrite": 0 },
  "recentTokenRate": 0, "contextPressure": 0, "contextWindow": 0,
  "openStep": null, "pendingCalls": [],
  "toolCounts": { "read": 0, "write": 7, "exec": 146, "net": 0, "agent": 5 },
  "todos": null, "planActive": false, "team": { "memberIds": [], "tasks": 0 },
  "lastPrompt": "启动不了",
  "lastResponse": "请双击桌面的 **Hermes.exe 快捷方式** 试试…"
}
```

### 12.6 Sector（各来源各取一个）

```json
[
  { "id": "2d45ce27-c237-4e9a-bfde-5d099acb6ee0", "name": "work agent", "path": "C:\\work\\work agent",
    "source": "dsh", "sessionIds": ["7b69868d-…", "e3506f75-…", "session-1a4ca1b8-…"], "liveCount": 3 },
  { "id": "hermes::c:/work/hermes/career-ops", "name": "career-ops", "path": "C:\\work\\hermes\\career-ops",
    "source": "hermes", "sessionIds": ["hermes:20260702_095756_de384f"], "liveCount": 0 },
  { "id": "opencode::e:/1.mini ros小车附送资料_2022.07.13", "name": "1.mini ros小车附送资料_2022.07.13",
    "path": "E:/1.Mini ROS小车附送资料_2022.07.13", "source": "opencode",
    "sessionIds": ["opencode:ses_1e52087d6ffeSK6u2PJX7fXojQ", "opencode:ses_1e4f50c22ffeHb7KGFTVh73Ebk"], "liveCount": 0 },
  { "id": "claude::c:/work/claude", "name": "claude", "path": "c:\\work\\claude",
    "source": "claude", "sessionIds": ["claude:578fea41-…", "claude:d046bdd3-…"], "liveCount": 0 }
]
```

### 12.7 事件样例（每个事件都有 `source`）

```json
[
  { "id": "evt-hermes-44434-call_00_m9YJMz8qDLs0hgQ8dVfr3356", "at": 1793092550239, "kind": "tool/call",
    "source": "hermes", "sessionId": "hermes:20261027_171424_fe81aa", "sessionTitle": "Hermes fe81aa",
    "tool": "session_search", "toolCategory": "read",
    "detail": "interactivebrokers OR 盈透 OR \"IB_LLC\" OR \"财务报表下载\"",
    "isError": null, "turn": 1, "step": 6, "durationMs": null },
  { "id": "evt-e3506f75-40ed-452b-aa26-fd84d6bcfb7b-2515", "at": 1793092542433, "kind": "step/end",
    "source": "dsh", "sessionId": "e3506f75-40ed-452b-aa26-fd84d6bcfb7b",
    "sessionTitle": "璇玑 HUD 实现：顶栏/起居注/星牒/开机/调参",
    "tool": null, "toolCategory": null, "detail": null,
    "isError": null, "turn": 5, "step": 31, "durationMs": 8042 }
]
```

---

## 13. 已知限制（v2）

1. **冷启动异步**：服务先 `listen` 再异步初始化数据源（本机 389 会话全源 init ≈ 1.2–3.2s，随磁盘负载波动）。
   期间 `/api/fleet` 可能返回空 `sessions`；前端应容忍首帧空态（本服务 health `booted` 会先为 false，`/api/fleet` 始终 200）。
2. **采集速率语义**：`aggregates.tokenRate/toolRate`、`session.recentTokenRate` 仅来自 DSH 实时采集器；
   Hermes/OpenCode/Claude 的历史 token 不会贡献速率（否则启动瞬间会虚高）。
3. **非 DSH 来源无上下文信息**：`contextPressure=0`、`contextWindow=0` 表示「无数据」，不是「压力 0」；
   前端在 `source !== 'dsh'` 时应避免用压力主编码。
4. **历史事件不回溯**：只 tail 最近活跃文件的尾部——DSH 最近 10 分钟、Claude Code 最近 7 天、Hermes 最近 120 条、
   OpenCode 最近 100 个 part 作为种子事件。老会话的 `toolCounts` 可能为 0（尤其 DSH ended 会话）。
5. **`lastResponse` 可能为 null**：进行中的会话在 DSH 里 response 尚未落盘；历史非 DSH 来源一般有值。
6. **event ring 不持久化**：内存 2000 条，重启后由种子事件重建；`/api/events` 与 fleet 的 events 都来自该 ring。
7. **状态是时间推断**：DSH 无显式结束标志；Hermes 用 `ended_at/archived`，其它来源纯时间推断，
   所以本机历史来源几乎全为 `ended`。
8. **Codex absent**：`~/.codex` 只有配置，解析器已预留；`sources` 中会显示 `state:'absent'`。
9. **`cwd` 可为空串**：非 DSH 来源不保证有 cwd（Hermes 已用安装目录兜底；Claude Code 缺失时为空）。
   `workspace` 与 `sector.name` 永远非空且相等。
10. **`detail` 已截断**：≤120 字、单行；不要依赖其完整语义做精确匹配。
11. **demo 数据与真实数据混用**：`?demo=1` 的响应 `source:'demo'`，与 live 完全隔离，不要缓存串用。
12. **`node:sqlite` 实验特性**：启动会打印 `ExperimentalWarning`（无害；可用 `node --no-warnings` 抑制）。
13. **无认证**：默认只监听 `127.0.0.1`，不要直接暴露到公网。
14. **测试命令**：Node 24.12 的 `node --test <目录>` 不会展开目录；请用
    `node --test apps/server/tests/smoke.mjs`（根 `package.json` 的 `test` 脚本已固定为该命令），
    或 `node --test apps/server/tests/*.mjs`。

---

## 14. 变更流程

1. 服务端字段/单位/可空性变化 → **先改本文件**，再改 `apps/server/src/**`，再与前端同步 `apps/web/src/state/types.ts`。
2. 字段只增不减；删除/重命名必须升级契约版本并在本文件顶部写变更摘要。
3. 新增 agent 来源：在 `sources/` 增加适配器 + 注册表追加 id/label + 本文件 §10 补一行；
   会话 id 必须以 `"<source>:"` 前缀保证全局唯一。
4. 事件新增 kind 需前后端同时发布；现有 10 种之外的 kind 前端应容忍但不要渲染主编码。
5. 每次契约变更后跑：`node --test apps/server/tests/*.mjs` + `node tools/verify-data.mjs --url http://127.0.0.1:8791`。
