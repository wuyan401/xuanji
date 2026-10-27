# XUANJI · 璇玑 — 系统架构与实现契约

> 本机全部 agent 运行状态的实时观测所。
> 一句话：**把 DeepSeek Harness 里正在运行的每一个 agent，变成一台古典星象仪上的星，并用一册会自己书写的《起居注》记录它们。**

本文件是工程与设计的**唯一真理源**（single source of truth）。视觉风格细节见 `docs/DESIGN-BIBLE.md`，后端字段定义见 `apps/server/README.md` 与 `docs/DATA-CONTRACT.md`，两者冲突时以本文件 + DATA-CONTRACT 为准，并由 Lead 仲裁。

---

## 0. 产品定义与成功标准

**产品**：一个本地运行的可视化观测台（网页）。后端读取本机 DeepSeek Harness 的真实会话数据（见 §3），通过 REST + SSE 推给前端；前端用 Canvas 绘制一台实时运转的「璇玑」天文仪器，用 DOM 绘制配套的仪表、档案与《起居注》账本。

**它不是**：仪表盘拼贴、假数据演示、另一个 DSH 管理面板、haloflux 的换皮。

**成功标准（验收口径）**
1. 打开即见「活的」画面：真实数据驱动，指标与 DSH 会话可对账；无真实活动时可切 demo/replay 仍自洽。
2. 有**一个别人抄不走的核心体验装置**：《起居注》的实时「落墨成书」+ 星象仪的「授时/推近」运镜，二者由真实事件触发。
3. 三层信息各有归宿：**星图（态势）→ 勘验（详情）→ 起居注（时间线）**，任何时候都能回答「现在有哪些 agent、在干什么、代价多少、有没有风险」。
4. 60fps（1440p，M 系核显上限放宽到 45fps）；生产构建通过；零 console 错误。
5. 桌面优先，手机可用；键盘全流程可用；`prefers-reduced-motion` 有真正替代方案。
6. 全部素材自制或开源授权，不直接使用游戏截图/字体以外未授权资产。

---

## 1. 术语表（全项目统一用词）

| 术语 | 含义 | 数据来源 |
|---|---|---|
| **Agent / 星** | 一个 DSH 会话（session），可能为用户会话，也可能是某会话派出的子 agent | projcache `sessions/<id>.json` |
| **Sector / 星域** | 一个 workspace（按 `identity.cwd` 与 workspace.json 归类） | workspace.json + cwd |
| **Turn / 轮** | 用户一条消息触发的一轮 | `turnOutline.turns[]` |
| **Step / 步** | 轮内一次「一次模型调用 + 若干工具」的循环 | `sessionStats.steps` / 事件 `step/*` |
| **Tool call / 器用** | 一次工具调用（read/edit/bash/web_search…） | 事件 `tool/call` |
| **Live / 在案** | 正在运行（`openStep` 存在或 60s 内有事件） | collector 推导 |
| **Idle / 歇息** | 30min 内有活动但当前未运行 | collector 推导 |
| **Ended / 入档** | 更早的历史会话（24h 内仍显示于星图尘埃带） | collector 推导 |
| **Ledger / 起居注** | 底部实时事件账本（本项目签名装置） | 事件流 + 会话摘要 |
| **Beat / 节拍** | 由真实事件能量驱动的非均匀脉冲时钟 | 前端 scene |

---

## 2. 仓库结构与归属

```
astra/
├─ apps/server/                 # 数据采集 + HTTP/SSE 服务（零依赖 Node ESM）
│   ├─ src/collector.mjs        #   projcache 轮询 + zstd 事件增量解码 + 聚合
│   ├─ src/server.mjs           #   REST + SSE + 静态托管 + demo/replay
│   └─ tests/smoke.mjs
├─ apps/web/                    # 前端 (Vite + TypeScript, 无框架)
│   ├─ index.html               # [HUD builder]
│   ├─ vite.config.ts / tsconfig.json
│   ├─ public/fonts/            # [HUD builder] 自托管字体
│   └─ src/
│       ├─ main.ts              # [Lead] 引导、装配、全局快捷键路由
│       ├─ state/store.ts       # [Lead] SSE/REST → 内存态 → 派生指标 → 订阅
│       ├─ state/types.ts       # [Lead] 前端类型（镜像 DATA-CONTRACT）
│       ├─ design/tokens.css    # [Lead] 设计令牌（颜色/字号/节奏/层级）
│       ├─ scene/index.ts       # [SCENE builder] 场景门面 createScene()
│       ├─ scene/*.ts           # [SCENE builder] 星场/浑仪环/星/光束/后期/运镜
│       ├─ hud/index.ts         # [HUD builder] 仪表门面 createHud()
│       ├─ hud/*.ts             # [HUD builder] 顶栏/名册/档案/起居注/调参台/开机
│       └─ styles/*.css         # [HUD builder]
├─ docs/
│   ├─ ARCHITECTURE.md          # 本文件
│   ├─ DESIGN-BIBLE.md          # 视觉与动效的最终裁定
│   ├─ DATA-CONTRACT.md         # 后端契约（后端 owner 写）
│   └─ research/                # 资料与实测（只读参考）
└─ tools/                       # 研究/构建脚本
```

**写入范围纪律**：每个 builder 只写自己目录；跨目录需求改由 Lead 在 `main.ts`/`tokens.css` 中统一提供，不得互相改文件。

---

## 3. 数据流水线

```
DSH 本机存储                                      
┌──────────────────────────────┐                  
│ session_projcache/sessions/*.json   (~119 文件, 每步重写)
│ sessions/<ws>/<id>/session.v4.jsonl.zstd  (zstd 多帧追加)
│ storages/workspace.json
└──────────────┬───────────────┘                  
               │ 轮询 500ms + 增量解码 (零依赖)
        ┌──────▼───────┐        ┌─────────────────────────────┐
        │  collector   │───────▶│ 内存态: sessions/events/聚合 │
        └──────┬───────┘        └────────┬────────────────────┘
               │                         │
        GET /api/fleet               GET /api/stream (SSE)
               │      event:fleet(快照, ~1s 节流) / event:tick(增量事件)
        ┌──────▼─────────────────────────▼──────┐
        │           web store (state/store.ts)   │
        │  snapshot 合并 + 事件环形缓冲 + 派生指标  │
        └──────────┬──────────────────┬──────────┘
                   │                  │
            scene.update()      hud.update()
         （Canvas: 星图/浑仪）   （DOM: 仪表/档案/账本）
```

**节流/背压**：SSE 快照帧 ≤1fps；事件帧可合并（100ms 内的多条打包成 `events[]`）；前端 store 对同一 session 只保留最新快照，事件仅保留 400 条内存环（视觉层不需要更多）。

**空数据/离线**：`/api/health` 心跳；SSE 断开 → store 触发 `connection` 状态（`live|reconnecting|offline|demo`），HUD 显示「观测端口失联 · 重连中」，scene 进入低功耗漂移态；`?demo=1` 使用后端 demo 数据流。

---

## 4. 前端总体架构

```
                      ┌──────────────────────────┐
                      │   main.ts (Lead)         │
                      │   boot → store → 装配     │
                      └───────┬──────────┬───────┘
              store.subscribe │          │ store.subscribe
                     ┌────────▼───┐  ┌───▼─────────┐
                     │  scene/    │  │   hud/      │
                     │  Canvas    │  │   DOM       │
                     │  ├ starfield│  │  ├ topbar   │
                     │  ├ orrery   │  │  ├ roster   │
                     │  ├ agents   │  │  ├ dossier  │
                     │  ├ beams    │  │  ├ ledger   │
                     │  ├ postfx   │  │  ├ narration│
                     │  └ camera/  │  │  ├ boot     │
                     │    director │  │  └ console  │
                     └─────────────┘  └─────────────┘
```

**渲染分工（硬边界）**
- Canvas 只画「空间性」的东西：星场、浑仪环、星、光束、连线、光晕、后期。
- DOM 只画「文本性/交互性」的东西：所有数字、标题、列表、账本、按钮、滑杆、开机序列。
- 同一信息不得两边重复绘制（除了选中星与档案的对应高亮，用统一的 `selection` 状态）。
- 所有全屏转场（开机、模式切换遮罩、扫描扫过）由 DOM 覆盖层 + CSS 完成；Canvas 不画全屏 HTML 文本。

**主循环**：`requestAnimationFrame` 单循环在 `main.ts` 中（scene 提供 `frame(nowMs)`；store 数据变化通过回调入队，不直接触发渲染）。`document.hidden` 时降频到 4fps 并暂停运镜；重新可见时平滑恢复。

---

## 5. 核心体验装置（不可删减）

### 5.1 浑仪 / The Armillary（场景主装置）
一台双层同心仪的抽象：**外环**按 Sector 分段（每段一个 workspace），**内环**是时间刻度与事件涟漪；中央是「枢」——授时与能量交换的枢纽。星的角位置由 Sector 环与自身活跃度决定，所有环**不同速、带擒纵顿挫**（模拟机械天文钟），任何时刻都不匀速。

- 环上刻有真实的**刻度**：外环每段注明 Sector 名与负载；内环按分钟刻度；角度上带有历史事件灰痕（「星过留痕」）。
- 星的光晕大小 ∝ 近 30s token 速率；衰减用指数平滑。
- 器用（工具调用）→ 五类光束从星射向枢/向外出射，见 §7.4。

### 5.2 《起居注》/ The Ledger（签名交互）
底部横向长卷（高约 18–24vh，可折叠）。每条记录是一行「时间 · 印 · 星名 · 记事」，以**落墨**方式出现：文字从淡到浓、自左向右显影，笔画末端有一小段墨晕；重要事件（turn/end、error、approval）额外**钤印**（方形印章，缩放+抖动一次）。整卷左侧有「更漏」式细进度线，右侧可回滚浏览（悬停暂停自动滚动）。

- 记录文案由**结构化模板**生成（`ledger/templates.ts`，HUD builder 实现），不得编造数据里没有的事实；模板示例见 §7.6。
- 频率控制：短时间内高频 tool 事件按星合并（「器用 × 6 刻」），保持可读。
- 点击一条记录 → 聚焦对应星并打开档案。
- 减少动效时：直接出现（无显影），保留钤印静态图形。

### 5.3 授时 / The Time Service（开机序列）
首次打开（或 `?boot=1`）播放约 3.2s 开机：仪器环形线自中心绘出 → 刻度旋转校准 → 三行自检（读档/事件流/观测端口）→ 一声「钟鸣」视觉涟漪（并可选音效）→ 画面从中心 iris 展开进入星图。任何按键/点击可跳过；`localStorage` 记住不重复播放。

---

## 6. 节拍时钟（数据驱动的非均匀时间）

**目标**：一切运动都跟随「真实世界发生的事」，而不是固定 60Hz 正弦。

```
输入：
  eventBurst    最近 2000ms 内事件数（step/tool/turn/approval 加权）
  tokenRate     最近两个快照的 token 增量 / 秒
  liveCount     在案星数
  focusEnergy   被聚焦星的活跃度 0..1
输出：
  energy        = smooth(eventBurst*0.35 + tokenRate*0.02 + liveCount*0.08 + focusEnergy*0.2)  0..1
  tempo         = 0.28 + energy*1.9  (Hz，即脉冲频率)
  pulse         = 每次「击拍」输出一个 0..1 衰减包络（tick）
  jitter        = 每拍 ±12% 随机相位抖动；每 7±3 拍出现一次「弱拍」
```

- 环转速 = `base(0.02 rad/s) + energy*0.16`，并叠加**擒纵**：每拍瞬间加速 8% 再回弹（模拟机械钟的顿挫）。空闲时几乎停住，只有极慢漂移。
- 星的光晕、枢的呼吸、光束的亮度都乘 `pulse` 与 `energy`。
- 事件脉冲：`tool/call`、`step/end`、`turn/start`、`error`、`approval` 各自触发一次性的「冲击」（不同强度/波形），叠加在基础节拍上——这是「不均匀」的主体。
- 禁止：用 `sin(t)` 直接驱动任何主要视觉量（会露馅）。所有周期量都要经过 beat 或带随机相位的 LFO。

---

## 7. 数据 → 视觉编码表（权威）

> 所有编码必须**可反查**：hover/选中时能看到原始数字。任何视觉量只允许映射下表中的字段。

### 7.1 星（Agent session）
| 属性 | 映射 | 说明 |
|---|---|---|
| 位置 | 极坐标：Sector 环半径 + 会话角（哈希定基准角，角速度 ∝ 活跃度） | 同 Sector 的星落在同一环带 |
| 半径 | `2.2 + log10(outputTokens+1)*1.1` px，clamp 2.2–9 | 输出 token 总量 |
| 光晕 | `recentTokenRate` 平滑值 × pulse；live 星有外层呼吸 | 空闲星只有静态星点 |
| 颜色 | live 金 `--star-live`；idle 骨白 `--star-idle`；ended 灰 `--star-ended`；error 朱 `--star-error`；approval 玉 `--star-attn` | 颜色+形状/标记双编码 |
| 外圈弧 | 上下文压力 `pressureTokens/contextWindow` 0..1，>0.5 显示 | 金色→琥珀→朱砂渐变 |
| 环（step） | 每 `step/end` 产生 1 道同心涟漪（半径 8→40px，600ms） | |
| 尾迹 | 最近 5 次 event 的时间衰减痕迹（灰刻度） | 体现「星过留痕」 |
| 子 agent | 以 12–24px 半径的卫星星绕父星，虚线「派生弧」连接 | `parentSession` |
| TODOs | 星外 2–4 个小刻点沿弧排列；完成/未完成用实/空区分 | `todos` |
| 计划 | 运行中 plan 给星加一圈外括弧刻度 | `plan.active` |
| 团队 | `agentTeam.members` 之间连实线「协作弧」；任务点在中点闪烁 | |
| 标签 | 仅在 hover/选中/标题模式显示「星名」（title 截断 14 字） | 避免满屏文字 |

### 7.2 Sector（workspace）
| 属性 | 映射 |
|---|---|
| 环带 | 每个 workspace 一条同心细环（1px + 12% 填充），段弧长 ∝ 会话数 |
| 刻度 | 环上按分钟刻度；每 5 分钟主刻度 |
| 标签 | 环外缘沿切线方向排布 Sector 名 + 负载百分比 |
| 活跃度 | 环的转速与亮度 ∝ 该 Sector 的 live 数与 token 速率 |
| 层级 | 主 workspace（当前 cwd）在最内环；历史 workspace 在外环/尘埃带 |

### 7.3 枢（Hub）
中央「枢」= 授时/能量交换枢纽。所有 step/turn 事件在枢产生一次光涨；当 `liveCount=0` 时枢保持低频呼吸（约 0.2Hz）。

### 7.4 五类光束（对应工具类别，haloflux 五层光束的功能映射）
| 层 | 工具类别（依据 `tool/call.name` 映射） | 视觉 |
|---|---|---|
| L1 远景 | `read`/`glob`/`grep`/`list` 等读取类 | 极细骨白线，向外缓散 |
| L2 中景 | `edit`/`write`/`multi_edit` 写入类 | 金色束，短促 |
| L3 主层 | `bash`/`pwsh`/`exec`/命令类 | 琥珀厚束，带脉冲 |
| L4 近景 | `web_search`/`web_fetch`/网络类 | 玉色细束，带横向扫描点 |
| L5 回弹 | `subagent`/`spawn`/`team_*`/agent 编排类 | 白金双向束 + 回声涟漪 |

光束生命周期：起于星、终于枢（或外向），400–900ms；每个工具调用一条，同类可合并。错误调用：朱砂色束 + 断点。

### 7.5 全局指标（顶栏 + 角落仪器）
| 指标 | 来源 | 表现 |
|---|---|---|
| 系统钟 | 本机时间 | 汉字时辰 + HH:MM:SS（例如「酉时·三刻 · 18:42:07」） |
| 在案/活动 | live/idle/ended 计数 | 三个刻度徽标 |
| Token/s | 增量快照 | 微型手绘风 sparkline + 数值 |
| 上下文压力峰值 | 各会话 max | 0–100 刻度尺，>80% 朱砂 |
| 器用计数 | 近 1 分钟 tool/call 数 | 五类分色小柱 |
| 数据源 | connection state | 「实况 / 演练 / 回放 / 失联」四态徽标 |
| 视界模式 | 当前 ViewMode | 模式名 + 序号（七式） |

### 7.6 起居注模板（HUD builder 实现，数据字段必须真实）
```
turn/start    「〔星名〕受命 · 第 {turn} 轮启」
step/start    「〔星名〕第 {step} 步 · 推演中」
tool/call     「〔星名〕器用 · {tool中文名}：{参数摘要≤28字}」 / 合并：「器用 ×{n} · {类别}」
tool/result   错误时：「〔星名〕器用受阻 · {error摘要}」
step/end      「〔星名〕一步既毕 · {耗时}」
turn/end      「〔星名〕本轮告成 · 耗 {outputTokens} 言」（钤印）
approval      「〔星名〕候旨 · {工具} 待办」（玉色印）
error         「〔星名〕有误 · {摘要}」（朱印）
session live  「〔星名〕入案 · {workspace}」/ ended 「〔星名〕入档」
```
禁止：无来源的「完成/成功/失败」判断（tool/result 的 isError 之外不臆测）。

---

## 8. 运镜与导演系统（七式）

`ViewMode = survey | track | dossier | ledger | orrery | scan | vigil`（中文：云图 / 逐星 / 勘验 / 起居注 / 浑仪 / 拂扫 / 守夜）

| 模式 | 取景 | 何时进入 | 退出 |
|---|---|---|---|
| 云图 survey | 全景微俯视，慢轨旋 | 默认/无事件 20s | 事件打断 |
| 逐星 track | 跟随当前最活跃星，带缓慢推近（zoom 1.6→2.4） | 有 live 星且 3 次事件/10s | 目标换人或闲置 |
| 勘验 dossier | 聚焦选中星，构图让位右侧档案 | 用户点击星/名册 | Esc |
| 起居注 ledger | 低角度偏向账本，场景压暗 60% | 用户按 L 或账本聚焦 | Esc |
| 浑仪 orrery | 正俯视，环与刻度为主，光晕收束 | 用户按 O 或空闲 60s | 事件打断 |
| 拂扫 scan | 扫描网格掠过全场，标出风险/异常 | 用户按 S / 首次出现 error | 3s 自动 |
| 守夜 vigil | 极远、极慢，仅留微光与时间 | 用户按 W 或 10min 无交互 | 任意输入 |

**导演规则**：默认自动（auto-director）；切换间隔 9–18s，告警事件可立即抢占（priority: error/approval > turn/start > tool > 常规轮转）。用户手动选模式 → 暂停自动 60s；按 `Space` 暂停/恢复自动导演；`Esc` 回云图。转场：zoom+旋转缓动 900–1400ms，`cubic-bezier(.16,1,.3,1)` 类似的「推近后定住」曲线；`reduced-motion` 时改为 200ms 交叉淡入。

---

## 9. 交互规格

### 鼠标
- hover 星 → 微型铭牌（标题/模型/状态/token/s，0.15s 淡入）
- 点击星 → 选中 + 勘验模式；再次点击空白 → 取消
- 拖拽空白 → 手动轨道旋转（松开后 8s 回归自动）
- 滚轮 → 缩放（0.5–3.2x，有边界弹性）
- 悬停起居注 → 停止自动滚动

### 键盘（全流程可操作）
| 键 | 行为 |
|---|---|
| `1`–`7` | 七式直接切换 |
| `Space` | 暂停/恢复自动运镜 |
| `Esc` | 关闭覆层 → 取消选中 → 回云图 |
| `↑/↓` | 名册上下选择（聚焦对应星） |
| `Enter` | 打开选中星档案 |
| `L` | 起居注展开/折叠 |
| `C` | 调参台 |
| `M` | 静音切换（音效可选项） |
| `?` | 快捷键帮助覆层 |
| `/` | 搜索会话（标题/workspace/模型） |
| `W` | 守夜模式（再按退出） |
| `Tab` | 焦点环：顶栏→名册→档案→账本→工具钮 |

### 触屏
- 单指拖拽旋转、双指缩放；星点击=选中；账本横滑浏览；名册底部抽屉。

---

## 10. 视觉参数与调参台（56 参数的功能对应）

参数分 6 组、约 24 项（全部可实时生效、可导出/导入 JSON、URL 可覆盖、localStorage 持久化）：

| 组 | 参数（key / 默认 / 范围） |
|---|---|
| 节拍 Beat | `beatEnergy` 0.6 / `tempoGain` 1.4 / `jitter` 0.12 / `pulseDecay` 0.7 |
| 浑仪 Orrery | `ringSpeed` 0.18 / `ringCount` 3 / `ticks` 1 / `engravingDepth` 0.5 |
| 星场 Stars | `starDensity` 0.5 / `dust` 0.35 / `parallax` 0.3 / `twinkle` 0.4 |
| 光束 Beams | `beamLayers` 5 / `beamLength` 0.7 / `beamFade` 0.5 / `toolGlow` 0.6 |
| 质感 Post | `glow` 0.55 / `dof` 0.4 / `grain` 0.25 / `vignette` 0.5 / `aberration` 0.2 |
| 运镜 Camera | `autoDirector` true / `dwell` 12 / `pushIn` 0.7 / `manualReturn` 8 |

预设（可切换、可 `?preset=`）：`仪轨·夜航`（默认）/ `静观` / `疾录` / `勘验` / `守夜`。参数面板用「仪器旋钮/刻度尺」语言实现，不用浏览器默认 range 外观。

---

## 11. 性能预算与降级策略

- 目标：1440p、DPR≤1.75、60fps；单帧 Canvas 绘制 ≤ 7ms（dev 里用 `performance.now()` 统计 p50/p95，`?stats=1` 显示）。
- 分层缓存：星场/尘埃/外环刻度 → 首次绘制到离屏 canvas，之后仅变换；光晕层用 1/3 分辨率 + `filter: blur()`；粒子上限 700，光束上限 80。
- 后期链最多 3 次全屏操作（glow 合成、grain、vignette），综合用离屏合成。
- 自适应：连续 2s 平均帧 >22ms → 自动降一档（关 aberration → 降 glow → 减粒子/尘埃 → DPR 1.0）；`?quality=high|med|low` 可锁。
- DOM：账本最多保留 120 条可见节点（更多滚出即销毁）；名册 80 行虚拟滚动阈值。
- 内存：事件环 400；快照只留最新；图片/字体一次加载。

---

## 12. 无障碍

- 语义结构：`header`（顶栏）`nav`（名册）`main`（画布 + 选中摘要）`aside`（档案）`footer`（账本）；画布有 `role="img"` + `aria-label` 动态摘要。
- 屏幕阅读器实时区：`aria-live="polite"` 摘要，节流 ≥2s；提供「观测摘要」文本面板（`?a11y=1` 或按 `A`）。
- 键盘全可达（§9）；焦点可见（2px 金色外框 + 4px 偏移）；不依赖颜色单独传状态（配字形/文字）。
- 对比度：正文 ≥4.5:1，大字/图形 ≥3:1；所有动画可用 `prefers-reduced-motion` 与手动开关关闭。
- 字号最小 12px（中文），数字可 11px 等宽；支持浏览器 125%/150% 缩放不破版。

---

## 13. 状态矩阵（必须全部实现）

| 状态 | 表现 |
|---|---|
| 启动 boot | 授时开机序列（§5.3），可跳过 |
| 载入 loading | 仪器刻度自检中；≤1.5s 骨架，不出现空白屏 |
| 实况 live | 正常数据流，顶栏「实况」徽标 + 脉搏点 |
| 无会话空态 | 璇玑仍在运转但环上无星；中央铭文：「未有星入案 —— 运行 dsh 会话或进入演练」+ 操作提示 |
| 演练 demo | 顶栏「演练数据」徽标；数据流为合成；每条账本记录带虚线下划线以示区别 |
| 回放 replay | 「回放」徽标 + 进度条 + 暂停/倍速 |
| 重连 reconnecting | 顶栏告警条；scene 降功耗；指数退避 1/2/4/8s；恢复时账本记「观测复通」 |
| 离线 offline | 显示已有数据 + 中央提示；「重连」按钮 |
| 错误 error | 朱砂告警条 + 账本钤印；不弹窗打断 |
| 减少动效 | 静态构图 + 瞬时状态变化；场景仍在（不黑屏） |

---

## 14. 模块接口契约（TS）

> 以下签名即 builder 之间的 API；改动需 Lead 同意。

```ts
// src/state/types.ts（镜像 DATA-CONTRACT，前端只依赖此文件）
export type AgentState = 'live' | 'idle' | 'ended';
export type ToolCategory = 'read' | 'write' | 'exec' | 'net' | 'agent';
export interface AgentSession {
  id: string; title: string; workspace: string; cwd: string;
  state: AgentState; parentId: string | null; depth: number;
  model: string | null; reasoningEffort: string | null; preset: string | null;
  createdAt: number; lastActivityAt: number;
  turns: number; steps: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  recentTokenRate: number;         // tokens/s, collector 平滑
  contextPressure: number;         // 0..1
  contextWindow: number;
  openStep: { turn: number; step: number; startedAt: number; firstTokenAt: number | null } | null;
  pendingCalls: string[];
  toolCounts: Record<ToolCategory, number>;
  todos: { text: string; done: boolean }[] | null;
  planActive: boolean;
  team: { memberIds: string[]; tasks: number };
  lastPrompt: string | null; lastResponse: string | null;
}
export interface Sector { id: string; name: string; path: string; sessionIds: string[]; liveCount: number; }
export interface Aggregates {
  liveCount: number; idleCount: number; endedCount: number;
  tokenRate: number; toolRate: number; errorCount: number;
  maxContextPressure: number; stamp: number;
}
export interface AstroEvent {
  id: string; at: number; kind: 'turn/start'|'turn/end'|'step/start'|'step/end'|'tool/call'|'tool/result'|'approval'|'error'|'session/live'|'session/ended';
  sessionId: string; sessionTitle: string;
  tool?: string; toolCategory?: ToolCategory; detail?: string;
  isError?: boolean; turn?: number; step?: number; durationMs?: number;
}
export interface FleetSnapshot {
  generatedAt: number; source: 'live'|'demo'|'replay'; connection: 'live'|'reconnecting'|'offline';
  sessions: AgentSession[]; sectors: Sector[]; aggregates: Aggregates; events: AstroEvent[];
}

// src/scene/index.ts
export type ViewMode = 'survey'|'track'|'dossier'|'ledger'|'orrery'|'scan'|'vigil';
export interface VisualParams { /* §10 的 key 集合，全部 number|boolean 扁平结构 */ }
export interface SceneApi {
  mount(): void;
  frame(now: number): void;                 // 由 main.ts 的 rAF 驱动
  setFleet(snapshot: FleetSnapshot): void;
  pushEvents(events: AstroEvent[]): void;
  setSelection(sessionId: string | null): void;
  setMode(mode: ViewMode): void;
  setParams(params: Partial<VisualParams>): void;
  setQuality(q: 'high'|'med'|'low'): void;
  setPaused(paused: boolean): void;         // 冻结运镜（不冻结数据）
  resize(): void;
  onPick(cb: (sessionId: string | null) => void): void;
  onModeChange(cb: (mode: ViewMode) => void): void;
  stats(): { fps: number; frameMs: number; drawCalls: number };
  destroy(): void;
}

// src/hud/index.ts
export interface HudApi {
  mount(): void;
  setFleet(snapshot: FleetSnapshot): void;
  pushEvents(events: AstroEvent[]): void;
  setSelection(sessionId: string | null): void;
  setMode(mode: ViewMode): void;
  setParams(params: VisualParams): void;
  setBootComplete(): void;
  onSelect(cb: (sessionId: string | null) => void): void;   // 名册/账本点选 → 星聚焦
  onModeRequest(cb: (mode: ViewMode) => void): void;        // 顶栏模式切换
  onParamsChange(cb: (params: Partial<VisualParams>) => void): void;
  onConsoleOpen?(cb: (open: boolean) => void): void;
  destroy(): void;
}

// src/state/store.ts
export interface Store {
  getSnapshot(): FleetSnapshot;
  getEvents(limit?: number): AstroEvent[];
  subscribe(fn: (s: FleetSnapshot) => void): () => void;
  subscribeEvents(fn: (ev: AstroEvent[]) => void): () => void;
  connect(): void; disconnect(): void;
  setSelection(id: string | null): void; getSelection(): string | null;
}
```

---

## 15. 验收清单（Lead 亲自执行）

1. `pnpm install && pnpm build` 通过，`dist` 产物完整；`node apps/server/src/server.mjs` 可启动并 serve `dist`。
2. Chrome headless 截图：1440×900、1920×1080、390×844 三个视口，实况/无数据/演练三态，共 ≥6 张，人工审阅。
3. Console 无错误/无未捕获 rejection；network 面板 SSE 正常；断网重连有表现。
4. 键盘遍历：`1`–`7`、`Esc`、`↑↓`、`Enter`、`L`、`C`、`W`、`?` 全部生效；焦点可见。
5. `prefers-reduced-motion` 模拟（Chrome DevTools）下无自动运镜/无故障闪烁，信息完整。
6. 数据对账：任取 2 个 DSH 真实会话，核对 token/steps/模型/上下文压力与 projcache 一致。
7. 性能：`?stats=1` 下 p95 帧 ≤ 20ms（本机核显环境）；自适应降级可触发。
8. 素材合规：仅使用自绘 canvas/SVG、OFL 字体；`docs/CREDITS.md` 列出 haloflux 与参考作品的致谢及「仅研究、未使用其资产」声明。

---

## 16. 致谢与许可边界

- **haloflux**（https://github.com/Ryder191/haloflux，PolyForm Noncommercial 1.0.0）：本项目**仅借鉴其功能架构思想**（节拍驱动、环形面板、多层光束、自动运镜、实时调参），**不复制其代码与视觉风格**。致谢署名：HALOFLUX by Ryder191。
- 参考游戏（群星 / 绝区零 / 崩坏:星穹铁道 / 明日方舟 / 赛博朋克 2077）：仅作视觉资料研究，**不进入最终构建**，不使用其图片、字体、图标、音频。
- 本项目自身代码默认私有；字体使用 SIL OFL 授权（见 CREDITS）。

---

## 17. v2.0 追加：多来源 agent 与整机仪象（2026-10-28）

v1.0/v1.2 只观测 DSH 一个来源；v2.0 把「本机所有 agent」与「整机运行数据」纳入同一座仪器。

### 17.1 数据来源注册表（`apps/server/src/sources/`）

| source | 数据源 | 读取方式 | 增量水位 |
|---|---|---|---|
| `dsh` | `~/.dsh/storages/session_projcache/sessions/*.json` + `~/.dsh/sessions/**/session.v4.jsonl.zstd` | 文件快照 + zstd 多帧 tail | mtime/size + 帧游标 |
| `hermes` | `~/.hermes/state.db`（SQLite） | `node:sqlite` `DatabaseSync(readOnly)` + busy timeout | `messages.id` |
| `opencode` | `~/.local/share/opencode/opencode.db`（SQLite） | 同上 | `time_created` |
| `claude` | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | 逐行 JSONL tail | 文件 offset |
| `codex` | `~/.codex/`（当前仅 config.toml，无 rollout） | 预留 `~/.codex/sessions/**/rollout-*.jsonl` 解析器 | 文件 offset；当前 `state:'absent'` |

- 每个 adapter 只读打开原始数据，**绝不写入**其它 agent 的文件；SQLite 一律 `readOnly`。
- 统一输出 `AgentSession`（新增 `source`/`sourceLabel`）与 `AstroEvent`（新增 `source`）；`id` 带来源前缀（`hermes:…`、`opencode:ses_…`、`claude:…`）保证全局唯一。
- `FleetSnapshot.sources: AgentSourceInfo[]`（`{id,label,state:'detected'|'absent',sessions,live,lastActivityAt,detail}`）驱动 HUD 的「诸源」签；`absent` 来源不产生假会话。
- 分野键 = `source::workspaceKey`（DSH 保留历史 workspace uuid 作 id）；不变式：**`session.workspace` 必须等于其所属分野的 `name`**。
- 采集调度：DSH 500ms、其它来源 1000ms；单轮稳态 ≤80ms；事件按 `at` 二分有序插入。

### 17.2 整机遥测（`apps/server/src/system.mjs` + `system-sample.ps1`）

- 单进程 PowerShell 采样器（CPU/内存/磁盘/网络/进程/运行时长/电池），每 2s 输出一行 JSON（`[Console]::Out.Flush()` 防缓冲）；node 侧 spawn 一次、逐行解析，异常退出退避重启（≤10s）；非 Windows 或采样器不可用 → `available:false`。
- 输出 `SystemSnapshot`：`{at,available,cpu:{usage,perCore},mem:{usedPct,usedBytes,totalBytes},disks[],net:{rxBps,txBps,totalRxBytes,totalTxBytes},procs:[{pid,name,cpuPct,memBytes}],uptimeSec,battery}`。
- HTTP：`GET /api/system`；`GET /api/system/history?limit=120` → `{generatedAt, history:[…]}`；SSE：`event: system`（2s）。
- 采样只用系统公开接口，不上传网络、不保存原始数据文件。

### 17.3 前端双视图架构

- `ViewKind = 'agents' | 'system'`：观星（智能体浑仪）与整机（仪象盘面）两套空间语言，同一 Scene 实例内切换（620ms 推拉，各视图保留相机/选中状态）。
- 数据通道：`store.ts` 新增 system 环形历史（120 帧）与 `onSystem` 订阅；SSE `event: system` 与轮询兜底均支持。
- HUD：顶栏 `[data-hud="view-tabs"]` 两枚 tab；观星视图《起居注》+《星牒》+「诸源」签；整机视图《机枢》（CPU/内存/磁盘/网络 + sparkline）+《器录》（top20 进程表）+ 整机顶栏指标组。
- 键盘：`0` 切换视图（等价 `?view=system`）；整机视图 `1–7` 不生效（只有缩放/拖拽/双击复位），`Space` 暂停脉冲。
- 契约新增方法全部 optional（`SceneHandle.setView/setSystem/setSourceFilter`、`HudHandle.setView/setSystem/setSourceFilter`、对应 callbacks），保证并行开发与降级不破。
- 数据纪律（沿用 v1）：只画快照里存在的数字；遥测不可用显示「遥测不可用」而非 0；星数目上限 400；`aria-live` 摘要按视图切换话术。
