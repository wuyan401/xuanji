# 璇玑 · 无损性能优化验收（2026-11）

## 结论

保留现有三视图、两主题、粒子/光流/核心效果、DPR、可见页面默认动画调度和交互。主要收益来自后台页面停止场景帧循环、隐藏 HUD 暂缓 DOM 绘制、结构共享避免重复派生，以及 SSE 增量帧；没有删效果或放宽验收阈值。

- **后台页**：8 秒浏览器审计中，场景帧从 31 降为 0，Canvas 调用从持续绘制降为 0；DOM mutations 从 10,128 节点 / 4,314 属性变为 0 / 2。使用默认增量流后，后台 8 秒的 SSE 序列化负载从 6,170,472 B 降到 85,064 B。
- **HUD DOM**：前台 agents 从 10,128 / 4,314 降到 2,144 / 2,282（节点 −78.8%，属性 −47.1%）。system / processes 同样降到约 2.3k / 1.7k 与 2.15k / 1.63k。
- **场景帧**：单次同夹具测量中，system `scene.frame` 平均 / p95 从 1.83 / 3.2 ms 到 1.11 / 1.8 ms；processes 从 4.69 / 7.1 ms 到 2.89 / 5.2 ms。agents 从 9.53 / 14.5 ms 到 9.33 / 14.4 ms，基本持平；不能声称 agents 场景或整页总 CPU 已可靠下降。
- **总 CPU 与内存**：Chromium CDP `TaskDuration` 是单次、单机、单核占用观测，不是场景帧时。agents 三次分别为 89.87%（旧版 full）、89.88%（新版 full）、89.74%（新版 delta），说明本轮没有可证明的 agents 总 CPU 降幅。其它视图单次值虽有下降，也受同机其它任务影响；末端 JS heap 在各轮有波动，不能据此宣称稳定的全局内存降幅。
- **传输**：相同 445 sessions / 38 sectors / 200 processes 的 8 秒窗口中，legacy full 为 6.17 MB，delta 为 85,064 B，下降约 **98.6%**。delta 是默认前端连接使用的 opt-in `?delta=1` 协议；每秒 fleet 更新、tick/system 语义和背压后的 full 重同步仍保留。

## 浏览器测量

以下为初轮优化的量测记录：基线为优化前保存的生产 `dist`，优化后为当时的生产 build；提交前修复后的复测另列，不以旧数值冒充最终包结果。通过 `tools/perf-audit.mjs` 起隔离的本地同源 fixture server，不连接实时数据源。每个视图分别启动 Chromium 156.0.8078.80，在 1440×900、DPR 1 下先预热，再测 8 秒。固定输入为 445 sessions / 38 sectors / 200 processes；时钟随墙钟推进，随机序列固定。记录 CDP Task/Script/Layout/Recalc/heap、Canvas 原语调用、DOM MutationObserver、传输字节及 `scene.frame`。hidden 案例模拟 `visibilitychange`，不改变系统级浏览器窗口状态。

| 视图 | 构建/传输 | CDP 单核 CPU % | scene.frame 平均 / p95 ms | 渲染帧 | JS heap MB | DOM mutations 节点 / 属性 | SSE 字节 / 帧 |
|---|---|---:|---:|---:|---:|---:|---:|
| agents | 优化前 / full | 89.87 | 9.53 / 14.5 | 353 | 15.95 | 10,128 / 4,314 | 6,170,472 / 12 |
| agents | 优化后 / full | 89.88 | 9.33 / 14.4 | 383 | 10.57 | 2,144 / 2,282 | 6,170,472 / 12 |
| agents | 优化后 / delta | 89.74 | 9.90 / 15.2 | 357 | 12.74 | 2,148 / 2,282 | 85,064 / 12 |
| system | 优化前 / full | 53.75 | 1.83 / 3.2 | 1,189 | 12.06 | 10,128 / 4,314 | 6,170,472 / 12 |
| system | 优化后 / full | 37.73 | 1.11 / 1.8 | 1,270 | 8.24 | 2,306 / 1,710 | 6,170,472 / 12 |
| system | 优化后 / delta | 41.88 | 1.23 / 1.9 | 1,308 | 4.67 | 2,306 / 1,710 | 85,064 / 12 |
| processes | 优化前 / full | 41.63 | 4.69 / 7.1 | 452 | 8.21 | 10,128 / 4,314 | 6,170,472 / 12 |
| processes | 优化后 / full | 27.76 | 2.89 / 5.2 | 444 | 6.52 | 2,154 / 1,626 | 6,170,472 / 12 |
| processes | 优化后 / delta | 27.71 | 3.33 / 5.3 | 417 | 7.39 | 2,154 / 1,626 | 85,064 / 12 |
| hidden | 优化前 / full | 24.78 | 10.61 / 16.4 | 31 | 10.39 | 10,128 / 4,314 | 6,170,472 / 12 |
| hidden | 优化后 / full | 2.86 | 0 / 0 | 0 | 7.74 | 0 / 2 | 6,170,472 / 12 |
| hidden | 优化后 / delta | 0.54 | 0 / 0 | 0 | 6.64 | 0 / 2 | 85,064 / 12 |

这是一组固定夹具下的单次量测，不是跨设备基准；视图进入顺序、GPU 软件光栅化和同机其它 agent 工作会影响 CPU、heap 与帧数。`scene.frame` 只计场景调用内部；CDP CPU 还包括 HUD、JS 事件处理、浏览器合成等。Canvas 调用计数也没有普遍下降：保留视觉效果的前提下，主要收益是停止不应发生的重复结构工作和后台工作，而非减少可见粒子/绘制层。

截图做了人工结构检查：三视图构成、五轨进程盘面、核心与 HUD 布局仍在。动态事件导致 agents 档案在一张图中自动打开、另一张处于分野总览，因此这不是逐像素同状态对比；此处不把截图差异包装成像素等价证明。行为回归另由 QA 脚本覆盖。

## 提交前复测与失败记录（2026-11-06）

提交前审查修复了 delta 新客户端的共享基线对齐、旧 REST 请求覆盖新 SSE 快照、旧 EventSource 回调污染、隐藏账本队列无界/重复回放以及连接告警、主题/视图恢复等问题。另撤回 live-id 逐帧字符串 stamp 缓存，避免在热循环拼接所有星体状态。最终构建仍使用原生 rAF、原 DPR 和所有既有效果。

### 固定 455 会话 ABBA 对照

从同一时刻捕获 455 sessions / 38 sectors / 200 processes，固定输入后，以旧 A → 最终 A → 最终 B → 旧 B 顺序各测 8 秒；1920×1080、DPR 1、同一浏览器，均使用 full 传输以隔离传输收益。预定四轮全部保留，没有取最好值。夹具读取曾因 PowerShell 写入 UTF-8 BOM 而在启动前报错；修复 BOM 兼容读取后才产生下表，不把该脚本错误当作性能样本。

| 顺序 | 构建 | CDP 单核 CPU % | scene.frame 平均 / p95 ms | 页面帧间隔平均 / p95 ms | 渲染帧 | DOM 节点 / 属性变更 |
|---|---|---:|---:|---:|---:|---:|
| A1 | 旧包 | 88.84 | 8.32 / 15.9 | 23.22 / 72.7 | 346 | 10,128 / 4,320 |
| B1 | 最终包 | 89.40 | 8.93 / 14.7 | 23.41 / 66.7 | 343 | 2,128 / 2,280 |
| B2 | 最终包 | 86.58 | 8.90 / 14.6 | 25.95 / 72.8 | 310 | 2,128 / 2,280 |
| A2 | 旧包 | 87.98 | 8.97 / 15.4 | 25.12 / 72.8 | 320 | 10,126 / 4,320 |

四轮均传输 6,244,584 B / 12 帧、console/page 错误 0。前台 agents 总 CPU 与页面帧间隔仍处于重叠范围；最终包 scene 平均并未全面更低，不能宣称这条热路径已有可靠降耗，也不能仅凭这四轮解释所有真实负载下的掉帧。HUD 变更数的下降可重复，后台/传输/服务端收益由各自量尺验证。

### 不隐藏未通过记录

- 撤回字符串缓存前，真实遥测 `qa-v24` 曾测得最近一帧 `sceneMs=8.800000011920929`，超过原门槛 8ms；另次运行 5.1ms 通过。量尺是单帧 wall time，不是平均值；两次都保留，后一次不能抹掉前一次。
- 同阶段 `qa-check` 的功能、数据和错误检查通过，但性能为 **14.8fps / p95 133.4ms**，未达到原门槛 ≥24fps / ≤120ms。此前的 28.8fps / 78.8ms、无遥测隔离实例的 46fps / 60.6ms 不能替代这次失败，更不能据此称所有运行都通过。
- 最终包在撤回可疑缓存、固定对照后再进行一轮原阈值生产回归；结果见下方验收记录。没有放宽门槛、降低 DPR、减少粒子或调低可见页帧率。

## 服务端测量

真实本机临时实例（不重启正式 8787）测得：无 SSE 客户端时 Node CPU 从 24 秒窗口 **192.7 ms/s（约 19.3% 单核）**降至 **23.3–33.1 ms/s（约 2.3–3.3%）**。主要原因是 eventlog 改为 `fs.watch` 增量队列 + 15 秒安全扫描，projcache 改为 watch + 10 秒安全扫描，减少每 500ms 的全树 walk/readdir。eventlog poll 平均从约 74.5 ms 降到 8.4 ms（热轮询 p50 0.8 ms、p90 1.3 ms；15 秒安全扫描会带来高最大值）。启动 ready 实测约 2.65–3.06 秒，启动阶段 CPU burst 本轮未优化。

SSE 方面，全量快照仍用于首连接、结构改变与丢帧重同步；delta 只发送改变的会话、移除 id 和必要聚合/来源元数据。客户端若任一 SSE chunk 因背压跳过，服务端标记需 full 同步，基线只在成功写入后推进。旧客户端不带 `delta=1` 时协议保持 legacy。

## 改动与保真边界

- `apps/web/src/main.ts`：document hidden 时停掉 rAF；恢复从 store 取最新快照、丢弃超过 10 秒的过期场景事件并重置帧样本。用户手动 W 隐藏与 document hidden 分开记忆。
- `apps/web/src/scene/`：暂停场景更新；按当前视图与转场两端门控子系统更新；快照结构引用不变时跳过星弧/微图重建；用 map 缓存弧查找并复用科幻格栅路径；百工无 glow 层时跳过空 glow 合成。曾尝试的 live-id 字符串 stamp 缓存会产生逐帧分配，已撤回，保留原过滤/排序逻辑。
- `apps/web/src/hud/`：隐藏 HUD 延迟 DOM 更新但继续维护最新数据、系统采样历史和账本事件；恢复时从缓存刷新。重复 DOM 文本/属性及可复用行不再无意义重写。
- `apps/web/src/state/`：结构共享复用未变对象；SSE delta 合并移除；重复 system timestamp 去重。
- `apps/server/src/`：eventlog/projcache watcher 与安全扫描；共享序列化帧；opt-in delta 和丢帧 full 恢复。
- 未改可见帧率策略、DPR、粒子池/包池上限、动效常量、数据采样频率、QA 通过阈值或任何视图效果。
- 最终提交前修复后的生产 build：JS 279.19 kB（gzip 92.61 kB），CSS 96.54 kB（gzip 17.12 kB）；相较 v2.9 基线 JS 包约增加 3.1%，换取缓存、增量状态与保真处理逻辑。页面运行资源与下载包大小是不同指标。

## 验收与复现

在仓库根执行：

```bash
pnpm --dir apps/web run typecheck
pnpm --dir apps/web run build
pnpm test
pnpm verify:data
pnpm verify:ui
node tools/qa-v29.mjs
node tools/test-store.mjs
node tools/perf-audit.mjs --label before --dist docs/qa/perf-baseline-dist --seconds 8
node tools/perf-audit.mjs --label after --dist apps/web/dist --seconds 8
node tools/perf-audit.mjs --label after-delta --dist apps/web/dist --seconds 8 --delta 1
```

最终包在具备真实遥测的隔离生产端口 8892 上完成一轮完整门禁：typecheck/build 通过；server suite **27/27**（0 fail）；store **10/10**；qa-v29 **22/22**，包括 520 条隐藏事件恢复后仅保留 120 行、重复快照不回灌旧事件、抽屉重开、连接告警及隐藏时切换主题/视图的恢复；qa-v24 **16/16**（最近一帧 sceneMs=5.4ms）、qa-v28 **9/9**（真实 GPU API/history/HUD 与 200 进程）、qa-v27 **15/15**（五轨、芯片、速度/光束、六层核心、移动端）。`qa-check` 的 live/behavior/demo/reduced-motion/perf 均通过，console/page/request 错误 0，**37.7fps / p95 72.7ms**（151 帧、24 长帧）；`verify:data` **16,053/16,053、FAIL 0、WARN 0**，当时为 455 会话 / 38 分野 / 300 事件 / 200 进程。条目数随本机数据变化，不是固定门槛。

此前 qa-v23 23/23、qa-v21 24/24 也通过，但不是最后一轮重新执行的套件。最终轮通过不抹掉上面的未通过记录；未把无遥测实例或较早包的结果当作最终真实遥测证据。临时 8892 实例在验收后停止，正式 8787 未为本轮测试重启。

详细原始 JSON、截图与固定真实本机采集夹具因含本地活动信息，放在本机 `docs/qa/perf-before-1440-1/`、`docs/qa/perf-after-1440-1/`、`docs/qa/perf-after-delta-1440-1/`、`docs/qa/check-perf-after-20261105/`，由 `.gitignore` 排除，不随仓库发布。复现命令会要求存在本机 `docs/qa/perf-fleet.json`、`perf-system.json` 与浏览器 Chromium；不要把本机夹具/截图提交到公开仓库。
