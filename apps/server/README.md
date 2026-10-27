# ASTRA 观测台 · 数据服务（apps/server）

本机**所有 AI agent** 的实时数据采集 + 本地 HTTP/SSE 服务：DSH（DeepSeek Harness）、Hermes、OpenCode、
Claude Code、Codex（预留），外加**整机遥测**（CPU / 内存 / 磁盘 / 网络 / 进程 / uptime / 电池）。

零依赖：只用 Node 内置模块（`node:http` / `node:fs` / `node:zlib` / `node:path` / `node:crypto` /
`node:sqlite` / `node:child_process`）——`node:sqlite` 是 Node 24 的实验特性，启动时会有一行
`ExperimentalWarning`，无害。
Node **>= 24.12**（依赖 `zlib.zstdDecompressSync` 解 zstd 事件流、`node:sqlite` 只读读 SQLite）。

前端（`apps/web`）只通过本服务读数据；**字段契约见 [`docs/DATA-CONTRACT.md`](../../docs/DATA-CONTRACT.md)**，
那里有可直接复制的 TypeScript 类型与实测 JSON 样例 —— 改服务端字段前先改契约。

```
浏览器 (apps/web, Vite :5173)
   │  GET /api/fleet               ← 首屏全量快照（多源会话 + 分野 + 来源注册表 + 事件）
   │  GET /api/system              ← 整机遥测最新一帧
   │  GET /api/stream (SSE)        ← fleet 全量帧(1/s) + tick 增量帧 + system 帧(2s)
   ▼
apps/server/src/server.mjs  ── FleetHub（REST/SSE/静态托管/模式选择）
   │
   ▼
apps/server/src/multi.mjs   ── MultiSource（多源合并：会话/分野/事件/来源注册表 + 全局事件排序）
   ├── collector.mjs（DSH，原 v1 采集器不动）
   │   ├── projcache.mjs   ~/.dsh/storages/session_projcache/sessions/*.json  （会话主快照，实时重写）
   │   ├── eventlog.mjs    ~/.dsh/sessions/**/session.v4.jsonl.zstd           （zstd 多帧事件流，增量 tail）
   │   ├── workspace.mjs   ~/.dsh/storages/workspace.json                     （workspace / 归档 / 置顶）
   │   ├── fleet.mjs       原始数据 ⇒ 契约对象（状态机、速率、工具计数、父子层级）
   │   └── metrics.mjs     60s 滚动窗口（token/s、tool/s）
   ├── sources/hermes.mjs    ~/.hermes/state.db（SQLite 只读，水位增量）
   ├── sources/opencode.mjs  ~/.local/share/opencode/opencode.db（SQLite 只读）
   ├── sources/claude.mjs    ~/.claude/projects/**/*.jsonl（字节 offset 增量 tail）
   ├── sources/codex.mjs     ~/.codex/sessions/**/rollout-*.jsonl（本机 absent）
   ├── sources/shared.mjs    多源公共投影（makeSession/makeEvent/buildSectors/状态机…）
   ├── system.mjs            整机遥测：spawn system-sample.ps1 逐行解析 + 历史环形缓冲
   └── tools.mjs             工具名 ⇒ 五类光束（read/write/exec/net/agent）唯一真源
```

## 启动

```bash
# 仓库根目录
node apps/server/src/server.mjs          # 或 pnpm start / pnpm dev:server(--watch)
# → [astra] listening on http://127.0.0.1:8787 · mode live
```

常用参数 / 环境变量：

| 变量 / 参数 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 监听地址（默认只给本机） |
| `DSH_HOME` / `DSH_ROOT` | `~/.dsh` | DSH 数据根目录（测试时可指向夹具） |
| `HERMES_DB` | `~/.hermes/state.db` | Hermes SQLite（只读） |
| `OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | OpenCode SQLite（只读） |
| `CLAUDE_DIR` | `~/.claude/projects` | Claude Code JSONL 根目录 |
| `CODEX_DIR` | `~/.codex` | Codex 数据根目录（当前 absent） |
| `POLL_MS` | `500` | DSH 采集轮询间隔 |
| `SOURCE_POLL_MS` | `1000` | 非 DSH 来源轮询间隔 |
| `LIVE_MS` | `60000` | 最近活动 ≤ 该值 → `live` |
| `IDLE_MS` | `1800000` | ≤ 30min → `idle`，更久 → `ended` |
| `EVENT_RING` | `2000` | 内存事件环形缓冲容量 |
| `EVENT_TAIL_BYTES` | `262144` | 启动时最近活跃 DSH 会话的 zstd 尾部预读字节数 |
| `EVENT_READ_BUDGET` | `4194304` | 每轮每文件最多消费的新增字节（防止大文件回放卡死） |
| `FLEET_EVENT_LIMIT` | `300` | `/api/fleet` 携带的最近事件数 |
| `FLEET_FRAME_MS` | `1000` | SSE fleet 快照帧间隔（契约 ≤1fps） |
| `HEARTBEAT_MS` | `15000` | SSE `: ping` 心跳间隔 |
| `WORKSPACE_REFRESH_MS` | `15000` | workspace.json 重载间隔 |
| `CLAUDE_RECENT_MS` | `604800000` | Claude Code 种子事件只看最近 N ms（默认 7 天） |
| `SYSTEM_TELEMETRY` | `1` | `0` 关闭整机遥测采样器 |
| `SYSTEM_SAMPLE_MS` | `2000` | 整机采样间隔 |
| `SYSTEM_HISTORY` | `120` | 整机历史环形缓冲长度（`/api/system/history` 上限） |
| `SYSTEM_SCRIPT` | `src/system-sample.ps1` | 覆盖采样脚本路径（调试用） |
| `WEB_DIST` | `apps/web/dist` | 静态托管目录 |
| `LOG_POLL=0` | - | 关闭每轮采集日志 |
| `VERBOSE=1` | - | 打印每个 HTTP 请求耗时 |
| `--cors` / `CORS=1` | off | 只对 `localhost/127.0.0.1/[::1]` 回显 CORS 头 |
| `--demo` / `DEMO=1` | off | 内置模拟数据源（无真实数据也能演示/截图） |
| `--replay <file>` | - | 回放录制的帧文件（见下） |

```bash
# 演示模式：8 个 agent、多来源（dsh/hermes/claude/opencode）、子 agent 树、审批、错误、压力逼近
node apps/server/src/server.mjs --demo          # http://127.0.0.1:8787

# 回放模式：文件可以是 fleet 快照 JSON、{frames:[...]}、数组或 JSONL
node apps/server/src/server.mjs --replay apps/server/.probe/samples/fleet.json
```

`?demo=1` 查询参数在 **live 模式下也会懒启动模拟数据源**（`/api/fleet?demo=1`、`/api/stream?demo=1`），
前端 demo 开关即用它；不影响 live 数据本身。

## API 一览

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/api/health` | 采集健康 + 模式 + 各来源 init/poll 耗时 + 来源注册表 + 整机遥测状态（见契约 §9） |
| GET | `/api/fleet` | **全量快照**：`{generatedAt, source, sessions, sectors, sources, aggregates, events}` |
| GET | `/api/sessions` | `{generatedAt, source, sessions}` |
| GET | `/api/sessions/:id` | 单个 `AgentSession`；不存在 → `404 {error:"session not found"}` |
| GET | `/api/events?limit=100` | `{generatedAt, source, events}`，`limit` 夹在 `1..2000`（默认 100） |
| GET | `/api/system` | 整机遥测最新一帧（`available:false` 时字段为零值） |
| GET | `/api/system/history?limit=120` | `{generatedAt, history:[…]}`；`limit` 夹在 `1..120`（默认 120） |
| GET | `/api/stream` | **SSE**：`event: fleet`（首帧立即 + 1/s）、`event: tick` 增量、`event: system`（2s）、`: ping`（15s） |
| GET | `/api` | 路由表 JSON（调试用） |
| GET | `/*` | 静态托管 `apps/web/dist`（不存在时返回深色占位 HTML，含 API 链接） |

- 除 `/api/stream` 外都支持 `HEAD`（无 body）；非 `GET/HEAD` → `405`。
- 所有响应 `Cache-Control: no-store`；JSON 为 UTF-8。
- 多客户端 SSE 互不影响；断线由浏览器 `EventSource` 自动重连（服务端发 `retry: 3000`）。
- 静态托管：`/` → `index.html`；无扩展名的路径 → SPA fallback；缺失的静态资源 → 404；`..` 逃逸 → 403。

SSE 帧格式（详细字段见契约 §8）：

```
retry: 3000

: connected

event: fleet
data: {"type":"fleet","generatedAt":...,"source":"live","sessions":[...],"sectors":[...],"sources":[...],"aggregates":{...},"events":[...]}

event: tick
data: {"type":"tick","at":...,"events":[...],"sessions":[仅变更],"aggregates":{...}}

event: system
data: {"type":"system","at":...,"available":true,"cpu":{...},"mem":{...},"disks":[...],"net":{...},"procs":[top12],"uptimeSec":...,"battery":{...}}

: ping
```

## 数据来源与采集策略

### 1. DSH（全量实时）
1. **会话主快照**（权威全量状态）`~/.dsh/storages/session_projcache/sessions/<sessionId>.json`
   - 每步/每条消息后由 DSH 重写；`rows.{title,tokenUsage,contextPressure,sessionStats,todos,plan,agentTeam,turnOutline,...}`。
   - 采集器按 `(mtimeMs,size)` 判断变化，**只重读变化的文件**（125 文件冷启动 ~26–190ms，稳态每轮 1–3ms）。
   - 单文件 `JSON.parse` 失败只记日志（10s 节流）并保留上一版数据，不会拖垮整轮采集。
2. **事件流**（细粒度活动）`~/.dsh/sessions/<workspace 编码目录>/<sessionId>/session.v4.jsonl.zstd`
   - zstd **多帧追加**文件：每帧独立压缩，帧间无长度前缀（descriptor 0x04），因此按魔数 `28 b5 2f fd` 切帧 + 试解压验证；
     假阳性魔数（压缩数据内部）会自动扩窗重试，尾部写了一半的帧保留偏移等下次增长。
   - 增量策略：记录每个文件已消费字节偏移，`size` 增长时只读新增区间；`size` 变小（重写/截断）→ 偏移归零重扫；
     单轮每文件最多消费 `EVENT_READ_BUDGET`，避免大文件堆积。
   - 启动时只对 **最近 10 分钟内活跃**（按 mtime）的文件预读尾部 `EVENT_TAIL_BYTES`，全量 145 个文件 54MB **不读历史**。
3. **workspace 分组** `~/.dsh/storages/workspace.json`：`tables.workspaces`（id/title/path/sessionIds）、
   `global.archivedSessionIds`、`pinnedSessionIds`。projcache 中没有映射的会话按 `cwd` 生成兜底 sector。

### 2. 其它 agent 来源（历史归档为主）
| 来源 | 物理来源 | 读取方式 | 增量策略 |
| --- | --- | --- | --- |
| Hermes | `~/.hermes/state.db`（SQLite，578MB / 118 会话 / 43k 消息） | `node:sqlite` `readOnly:true` + `PRAGMA busy_timeout=1500` | `messages.id` 水位；db/wal 的 `size:mtime` 变化才刷新 |
| OpenCode | `~/.local/share/opencode/opencode.db`（SQLite，50MB / 87 会话 / 13k part） | 同上 | `message.time_created` / `part.time_updated` 水位 |
| Claude Code | `~/.claude/projects/**/*.jsonl`（59 文件，每文件一个会话） | `node:fs` 读文件 | 每文件字节 offset + 行 tail；size 变小则重扫 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | 预留解析器 | 本机无 sessions → `absent` |

- **绝不写原始数据**：SQLite 一律只读打开；文件只读不写。
- **Hermes 时间戳是秒级 REAL**（`started_at`/`messages.timestamp`），投影时 ×1000 并取整为 ms。
- **Hermes 历史会话缺 cwd**（117 条里 77 条）时，回退为安装目录 `C:/work/hermes`，
  保证 `session.workspace === sector.name` 不变式。
- 各来源会话 id 带前缀：`hermes:20261027_171424_fe81aa`、`opencode:ses_…`、`claude:7a4f…`、`codex:…`；
  DSH 保持原始 sessionId（契约用 `source` 字段区分）。

### 3. 整机遥测
- 采样脚本 `src/system-sample.ps1`：PowerShell **单进程循环**，每 2s 输出一行 JSON（CPU/内存/磁盘/网络/进程 top12/uptime/电池）。
- `src/system.mjs` spawn 一次（本机 `pwsh` 不存在时自动回退 `powershell.exe`），逐行解析；
  子进程退出自动重启（退避 ≤10s）；非 Windows / 无 PowerShell → `available:false`，不报错。
- 电池查询每 8 轮一次（CIM 查询较慢）；内存用 `GlobalMemoryStatusEx` P/Invoke、uptime 用 `GetTickCount64` P/Invoke。
- 历史环形缓冲默认 120 帧（≈4 分钟），`/api/system/history?limit=` 读取；SSE 每采样周期推 `event: system`。

### 状态机（契约 §4）

```
archived / 来源显式结束 → ended
lastActivityAt 距今 ≤ LIVE_MS(60s)              → live
有 openStep 且距今 ≤ IDLE_MS(30min)             → live
距今 ≤ IDLE_MS                                 → idle
否则                                           → ended
```

> DSH 的 `sessionStats.openStep` 在**步骤开始时**写入，step 内没有更细的时间戳，且 `firstTokenTime` 常为 null；
> 所以 `lastActivityAt` / `openStep.firstTokenAt` / pending 工具名会用 zstd 事件流（`step/*`、`tool/*`、
> `assistant/message.stream[0].time`）补齐，projcache 与事件流取二者更新者。
> 历史会话（>10min 未活跃）没有 tail 事件，`toolCounts` 可能为全 0 —— 这是已知取舍（见下）。

工具名 → 五类光束的映射集中在 `src/tools.mjs`（解析顺序：精确 → 小写 → `mcp__` 内层 → 前缀 → 关键字兜底 → null），
覆盖 DSH / Hermes / opencode / Claude Code 工具名，映射表也写在契约 §6。

## 性能实测（本机，389 会话 / 36 分野 / 5 来源 / 300 事件）

| 指标 | 实测 |
| --- | --- |
| 冷启动 `init`（一次性，异步不阻塞 listen） | DSH 190ms + Hermes ~1.3s + OpenCode ~2.7s + Claude ~3.0s（**并行下发但同步 CPU 活，wall ≈ 3.2s**；磁盘空闲时 ~1.2–2.2s） |
| 采集轮询 `poll`（稳态全源） | `lastPollMs` 0.8–1ms，`maxPollMs` **77ms**（首轮含全源刷新） |
| `/api/fleet` | 15–30ms（冷 67ms），**568KB**（389 会话 + 300 事件） |
| `/api/sessions` | ~10ms / ~136KB |
| `/api/health`（热） | 1–3ms |
| `/api/system` | <1ms（内存中的最新帧） |
| SSE | fleet 1/s（~568KB/帧）、tick 随采集（仅增量）、system 2s（~2KB）、ping 15s |

## 测试

```bash
node --test apps/server/tests/smoke.mjs     # 冒烟：真实 server + REST/SSE 契约（~6s，8 tests）
node --test apps/server/tests/*.mjs         # 全量：16 tests / ~10.6s
```

- `smoke.mjs`：拉起真实 server（随机端口），覆盖 health（来源注册表 + poll 预算）、
  `/api/fleet` 契约（28 字段 / 来源前缀 / 不变式 / 事件 source 与排序）、`/api/sessions*` 与 404、
  `/api/system` 与 `history` 形状与 limit、SSE 的 fleet/tick/system 帧、`?demo=1` 多源演示、工具映射。
- `v2.test.mjs`：工具映射（四来源工具名 + 关键字兜底）、Hermes tool_calls/tool_result 解析、
  公共投影契约不变式、整机 sample 假 JSON 行解析、真实 SQLite/JSONL **只读抽样**
  （断言 `size:mtime` 未变）、Codex absent。

> ⚠ Node 24.12 的 `node --test <目录>` **不能**展开目录（会把目录当模块加载并报
> `Cannot find module .../apps/server/tests`）。请用显式文件路径或 glob。
> 根 `package.json` 的 `test` 脚本已固定为 `node --test apps/server/tests/smoke.mjs`。

## 已知限制

- **冷启动异步**：服务先 `listen`，再异步初始化多源数据源（本机 1.2–3.2s）；期间 `/api/fleet` 可能
  `sessions:[]`，前端应容忍首屏空态。
- **历史事件不回溯**：DSH tail 最近 10 分钟、Claude Code 最近 7 天、Hermes 最近 120 条、OpenCode 最近 100 part；
  所以老会话的 `toolCounts` 可能为 0、`lastResponse` 可能来自快照字段。
- **非 DSH 来源无实时速率/上下文**：`tokenRate`/`toolRate`/`recentTokenRate` 仅 DSH 有实时值；
  `contextPressure=0`/`contextWindow=0` 对非 DSH 表示「无数据」。
- **非 DSH 来源基本是历史归档**：Hermes/OpenCode/Claude 最新数据都 >24h（本机），因此几乎全为 `ended`，
  Codex 为 `absent`（只有配置没有 sessions）。
- **`cwd` 可为空串**：非 DSH 来源不保证有 cwd（Hermes 已用安装目录兜底）；`workspace` 与 `sector.name`
  永远非空且相等。
- **zstd 尾部写一半**：最后一帧可能不完整，采集器保留偏移等文件增长后再解；单帧损坏只跳过该帧。
- **状态是时间推断**：DSH 无显式结束标志；Hermes 用 `ended_at/archived`，其它来源纯时间推断。
- **`contextPressure` clamp**：DSH 的 `pressureTokens` 可超过 `contextWindow`，采集器会 clamp 到 `0..1`。
- **事件 ring 不持久化**：内存 2000 条，重启后由种子事件重建。
- **`node:sqlite` 实验特性**：启动有一行 ExperimentalWarning（无害，可 `node --no-warnings`）。
- **静态托管占位页**：`apps/web/dist` 未构建时任意路径都返回占位 HTML 200，方便先验证 API。
- **无认证**：默认只监听 `127.0.0.1`，不要直接暴露到公网。

## 目录结构

```
apps/server/
├── README.md
├── src/
│   ├── server.mjs        # 入口：FleetHub（HTTP/SSE/静态托管/模式选择）+ CLI
│   ├── config.mjs        # env/CLI 配置
│   ├── multi.mjs         # 多源合并：会话/分野/来源注册表/事件排序/整机帧
│   ├── collector.mjs     # DSH 采集器：轮询、状态机、聚合、tick 批量
│   ├── projcache.mjs     # DSH projcache 快照增量读取
│   ├── eventlog.mjs      # DSH zstd 多帧事件流增量 tail
│   ├── fleet.mjs         # DSH 原始数据 → 契约投影
│   ├── workspace.mjs     # DSH workspace 索引与兜底 sector
│   ├── metrics.mjs       # 60s 滚动速率
│   ├── tools.mjs         # 工具名 → 类别映射（唯一真源）
│   ├── demo.mjs          # 模拟数据源（多来源演示）
│   ├── replay.mjs        # 帧回放数据源
│   ├── system.mjs        # 整机遥测：spawn 采样脚本 + 历史环形缓冲
│   ├── system-sample.ps1 # PowerShell 单进程采样脚本（每 2s 一行 JSON）
│   ├── sources/
│   │   ├── shared.mjs    # 多源公共投影（makeSession/makeEvent/buildSectors/状态机）
│   │   ├── sqlite.mjs    # node:sqlite 懒加载
│   │   ├── hermes.mjs    # Hermes SQLite 适配器
│   │   ├── opencode.mjs  # OpenCode SQLite 适配器
│   │   ├── claude.mjs    # Claude Code JSONL 适配器
│   │   └── codex.mjs     # Codex rollout 预留适配器
│   └── util.mjs          # 文本清洗/参数摘要/JSON 响应等小工具
└── tests/
    ├── smoke.mjs         # 冒烟：真实 server + REST/SSE
    └── v2.test.mjs       # 多源 / 整机遥测 / 契约不变式单测
```
