# HALOFLUX 架构解剖与 ASTRA 移植报告

> **调研对象**：开源项目 haloflux（作者 Ryder191），单文件纯 Canvas 2D 实验，许可证 PolyForm Noncommercial 1.0.0（禁止商业性使用；本报告只提炼机制，不复制其代码）。
> **目的**：为「ASTRA 观测台」——本机所有 DeepSeek Harness agent 会话的实时数据可视化——提取可移植架构。视觉风格完全自研，不复用 haloflux 的霓虹 synthwave 皮。
> **方法**：逐行通读 5 个文件（见 §1.1）；用 `node` 脚本做静态统计（函数表/参数表/行号断言）；用 headless Chrome 156 + CDP 对真实渲染循环做 660 帧采样（§8.8）。
> **证据约定**：行号一律指 `_research/haloflux/lab.html`（1710 行），除非特别注明其它文件名；函数起始行号来自对 `function NAME(` 的静态扫描，脚本输出见 §12.3。文中所有"实测"数字都注明测量环境；所有"结论"都可在对应源码行核对。
> **⚠ 许可证**：代码不可直接商用拷贝；我们只移植**结构与公式**，实现自己写。

---

## 0 结论摘要（先读这段）

1. **技术形态**：单文件、零构建、零依赖的纯 Canvas 2D 合成（1710 行）。唯一外部资源是 Google Fonts（JetBrains Mono）与可选 BGM mp3。没有 WebGL、没有 three.js、没有 GSAP、没有真实数据 API——所有"数据"都是本地合成假数据。真正值得学的是**运动编排 + 分层渲染 + 后期合成**。
2. **空间分三层**：① 中心编织光场（贝塞尔曲线网 + 流线 + 彗星，直接画在主 canvas）；② 外圈卡片环（每个 slot 一张预渲染 canvas，按旋转状态机贴上去）；③ 环外 5 层径向光束（Path2D 批量描边）。再外围是 8 个 DOM 面板小 canvas 与头部 KPI——它们与主视觉无关，是"仪表装饰"。
3. **灵魂机制是不均匀节拍时钟**（§3）：`PATTERN` 10 个不整齐的拍长 × 0.92 / `tempo`，每次 `onBeat()` 分发 5 类事件；全场用一个指数衰减包络 `env = exp(-sinceBeat * 4.5)` 驱动，所以"没有任何东西匀速"。
4. **"没有东西匀速"是可枚举的 8 条公式**（§3.6）：模式人格、包络脉冲、双正弦 idle、非对称缓动、对数相机、随机 hold、相位抖动、事件 kick。不是玄学，是公式。
5. **高密度数据靠"预渲染小卡 + 每帧 1 个重渲染预算"**（§5.4）：圆环 ~88 个 slot 平时只 `drawImage`，每帧最多重画 1 块、拍上随机作废 6 块、屏幕外 140px 剔除。这是本项目最值得抄的一点。
6. **批量描边**（§6.5、§8.7）：5 层光束可见的 ~1500 条线用 Path2D 三桶 + 扁平数组 + 分桶 key，压到每帧约 15 次原生 `stroke`；飞线按 `tint/lv/宽度/burst` 分桶。
7. **后期只有 4 件事**（§8）：1/3 降采样辉光（blur 6px）、1/2 分辨率远景 + depthBlur、canvas 暗角、CSS 扫描线。**没有 shadowBlur、没有色差、没有噪点**（grep 全文命中数：`shadowBlur`=0、`chrom`/`aberr`/`noise`/`grain`=0）。
8. **运镜是 7 个硬编码机位 + hold/move 状态机**（§7）：z 在对数空间插值 + "先拉远再推近"呼吸；视差用按系数插值的相机矩阵 `camTk` 实现，不是真 3D。
9. **实测**（§8.8，headless Chrome 156 + CDP，画布 1600×503）：DPR1 下 `drawStage` JS 7.86ms（p95 11.4ms），实测帧间隔 22.86ms（43.7fps，软件光栅）；DPR2 帧间隔 50.49ms（19.8fps）——**DPR 是第一性能杠杆**。每帧原生调用 `lineTo` 20486 / `moveTo` 11343 / `stroke` 1224 / `drawImage` 20。
10. **壁纸版是"删减 + 外部控制桥"**（§9）：删 BGM / 控制台 / 状态浮层，`window.__wpPaused` 暂停 rAF；面板隐藏用 `visibility` 而非 `display:none`（0 尺寸 canvas 会卡死绘制循环）；resize 二次调用。
11. **必须重写 3 块**（§12.2）：假数据层、视觉设计系统（含配色/字体/伪文本）、固定几何运镜。
12. **可移植性判断**：haloflux 的 canvas 合成技巧 100% 可迁移到 2D Canvas；但它的"氛围感"来自大量假数据仿真（伪代码打字、假 KPI、假热力格），我们只能迁移**容器**，内容必须由 DSH 真实事件流填充，否则会变成另一个假仪表盘。

---

## 1 文件与全局结构

### 1.1 交付物构成（5 个文件）

| 文件 | 行数 | 字节 | 角色 |
|---|---:|---:|---|
| `lab.html` | 1710 | 93546 | 主实验版：完整观测台（中心光场 + 环 + 光束 + 运镜 + 8 面板 + 控制台 + BGM） |
| `mobile.html` | 1757 | 96628 | 移动端版：与 lab 同一套函数，增加竖屏整体旋转 setXf 与移动布局/降配 |
| `index.html` | 27 | 1310 | 入口：UA 嗅探后 location.replace 分流到 mobile.html / lab.html |
| `wallpaper_index.html` | 1631 | 87560 | 壁纸版：删掉控制台/音乐/状态浮层，暴露 window.__wpPaused / window.__bgm 给 Wallpaper Engine |
| `wallpaper_wp.js` | 122 | 5024 | Wallpaper Engine 属性桥：把 WE 用户属性映射到参数/暂停/音量 |

版本关系：`index.html` 用 UA 嗅探把访客分流到 `mobile.html`（触屏）或 `lab.html`（桌面），分流代码在 `index.html:21-23`：`location.replace((touch?'mobile.html':'lab.html')+location.search)`。`wallpaper_index.html` + `wallpaper_wp.js` 是给 Wallpaper Engine 的裁剪版，靠 `wp.js` 里的 `wallpaperPropertyListener` 与 WE 通信。

### 1.2 lab.html 的分层与内部区块地图

| 行号区间 | 内容 | 关键点 |
|---|---|---|
| 1–20 | 文档头、meta、Google Fonts 预连接与 JetBrains Mono | 唯一与网络有关的资源（壁纸版已删） |
| 21–127 | CSS：设计 token（`--text/--faint/--line/--line2/--white`）、grid 布局、`.stage::after` 扫描线+暗角、8 面板、动效 | §1.6 |
| 129–164 | DOM：header（5 个 KPI）+ `.stage`（canvas + 4 个 overlay）+ `.panels`（8 个面板） | 见 §1.6 表 |
| 166–172 | 基础常量与工具 | `TAU/rnd/rr/pick/gauss/DPR/FONT` |
| 174–186 | canvas 工厂 `mk(w,h)` / `fit(c)` | 按 DPR 建 buffer 并 `setTransform` |
| 188–200 | 主 stage 全局状态 + 合成常量 | `S/S_MAIN/GS/FS/HAS_FILTER/easeIO/easeO` |
| 202–284 | 参数系统：`PARAMS`(56)、`BASE`、`PRESETS` A/B、`BAKED_MINE`(281)→`PRESETS.MINE`(282)、`const C={...PRESETS.MINE}`(283)、`zf`(284) | §1.5 |
| 286–289 | `TOK` 伪代码 token 池 | 假数据来源之一（§12.2） |
| 291–317 | 不均匀节拍时钟 | §3 |
| 319–367 | 自动运镜（`cam`、`buildShots`、`updateCam`、`camT/camTk`、`toScreen`） | §7 |
| 369–393 | canvas 工厂 `mkd(w,h,d)`、`resizeStage()` 几何计算与离屏 buffer 重建 | §2.3 |
| 395–498 | 编织网 `buildWeb`(396)、采样 `qpt`(451)、流线 `newRunner`(455)、彗星 `spawnComet`(469)/`mx`(484)/`cpt`(490)/`strokeComet`(491) | §4 |
| 500–565 | 光束剖面 `clamp`(507)/`makeProfile`(509)/`makeStrandLayer`(517)、`buildOuter`(533)、渐变 `mkG`(545)、`spawnHaze`(556)、`spawnFlare`(564) | §6 |
| 567–576 | 静态放射背景 `buildLanes` | 一次构建，之后只 drawImage |
| 577–626 | 外圈逐帧更新 `updateOuter`(577)、拍事件 `onBeatOuter`(613)、雾包络 `hazeEnv`(622) | §6.3 |
| 628–670 | 光束批量绘制 `drawStrands`(628)、径向线 `radialLines`(663) | §6.5 |
| 672–734 | 飞线系统 `newFlyBand`(675)/`newFlyer`(676)/`spawnFlyBurst`(684)/`initFlyers`(694)/`updateFlyers`(698)/`onBeatFlyers`(707)/`drawFlyers`(712) | §6.6 |
| 735–785 | 远景合成 `drawOuterFar`(735)、近景合成 `drawOuterNear`(752) | §2.2/§6 |
| 787–818 | 散景精灵 `mkBokehSprite`(789)/`newBokeh`(796)/`drawBokeh`(801) | §8.4 |
| 820–881 | 圆环常量与构建：`RING_SC`(820)、`easeOX`(822)、`rot`(823)、`ringMove`(824)、`flashSlotAt`(832)、`updateRing`(837)、`buildCards`(841)、`rgba/fmtNum`(858-859)、`glyphStrips`(860)、`header`(876) | §5 |
| 883–985 | 12 种数据块 `BLOCKS`(882 起)、权重 `BLOCK_W`(975)、`NEEDS_H`(977)、`pickBlock`(978) | §5.3 |
| 986–1071 | slot 渲染 `renderSlot`(986)、边缘宽 `rimW`(1018)、总装 `drawRing`(1019)、`tick`(1040)、`arc`(1059) | §5.4/§5.6 |
| 1073–1196 | 主合成 `drawStage`(1074) 15 个阶段 | §2.2 |
| 1198–1221 | 检查卡引线 `drawCallout`(1203) + `CHECKS` 数据 | HTML 浮层 + canvas 引线 |
| 1223–1422 | 侧面板：`kpiTick`(1227)、`feedPush`(1245)、`codeHtml`(1262)/`codeTick`(1270)、`renderRoutes`(1287)、`agentsTick`(1309)、`resizePanels`(1325)、流场 `flow`(1331)/`drawAdv`(1332)、`drawDiff`(1348)、`drawVal`(1376)、`drawIdx`(1402) | 与主视觉无关的假仪表 |
| 1424–1452 | 主循环 `frame`(1428)、`resizeAll`(1435)、全屏 `toggleFS`(1447) | §2.1 |
| 1454–1589 | 参数控制台：`localStorage` 封装(1459-1461)、`applyRebuilds`(1467)、`setParam`(1475)、`loadPreset`(1482)、滑块 DOM 生成(1492-1534)、导出/导入 JSON(1560-1572) | §1.5 |
| 1597–1707 | BGM 音频模块（`initBGM` IIFE；1591–1596 为注释头）：`audio/sw421k.mp3`、音量曲线 `fadeTo`、iOS `GainNode` 分支、`visibilitychange` 暂停、可选 `#bgmData` base64 内嵌 | 可整块删 |

一个易踩的坑：`let T = 0` 在 **1330 行**才声明（`drawAdv` 上方），但 167–1330 行里大量函数读 `T`。能跑是因为这些函数都在 `resizeAll()` 之后的 rAF 里才首次执行——阅读时不要以为那是早期声明。

### 1.3 运行时常量（决定全部手感的"魔数"）

| 名称 | 行号 | 值 | 作用 |
|---|---:|---|---|
| `TAU` / `rnd` | 167 | `Math.PI*2` / `Math.random` | 基础 |
| `rr(a,b)` | 168 | `a+rnd()*(b-a)` | 所有"不均匀"的源头 |
| `pick(a)` | 169 | 随机取元素 | 抽样块/颜色 |
| `gauss()` | 170 | `(rnd()+rnd()+rnd()-1.5)/1.5` | 近高斯噪声（三角分布） |
| `DPR` | 171 | `min(devicePixelRatio \|\| 1, 2)` | **性能总闸**，§8.8 实测 DPR2 直接掉帧 2.2× |
| `FONT` | 172 | `'"JetBrains Mono",Consolas,monospace'` | canvas 文字字体 |
| `GS` | 196 | 3 | 辉光层降采样倍数 |
| `FS` | 197 | 0.5 | 远景（景深）层降采样倍数 |
| `HAS_FILTER` | 198 | `'filter' in S` | 能力检测：不支持 `filter` 的浏览器跳过 all blur |
| `easeIO` | 199 | `t<0.5 ? 4t³ : 1-(-2t+2)³/2` | 对称三次缓动（相机/圆环/彗星共用） |
| `easeO` | 200 | `1-(1-t)³` | 只快出不回弹 |
| `OSTEP` | 195 | 0.0038 | 径向静态线的角步长（≈0.22°） |
| `RING_SC` | 820 | 2.4 | slot 小 canvas 的超采样倍率（文字清晰度） |
| `easeOX` | 822 | `1-2^(-10t)` | 圆环"急停"专用指数缓动（前 30% 距离内吃掉 90% 位移） |
| 相机 z | 341–360 | `zf(z)=1+(z-1)*C.camZoom`(284) | 用户 zoom 乘到所有机位 |

### 1.4 主 stage 的全局状态（全部是模块级 `let`）

| 组 | 变量（行号） | 用途 |
|---|---|---|
| 画布与上下文 | `stage`,`S`,`S_MAIN`(191) | 主 canvas 与 2D 上下文；`S` 会被临时切换成离屏上下文 |
| 几何 | `W,H,cx,cy,R,RO,RMAX,thV,thS`(192) | 中心点 `cx=W*0.07, cy=H*0.5`；`R`=内网半径，`RO`=卡片环外缘，`RMAX`=屏幕对角+60；`thV`/`thS`=内网/环的可视半角（`asin((H/2+60)/R)`、`asin((H/2+40)/RO)`）（§2.3） |
| 离屏层 | `webBase`,`webLayers[3]`(193)、`trailC`,`glowC`,`laneC`(193)、`farC`(197) | §2.3 表 |
| 实体数组 | `curves`,`runners`,`comets`,`cards`,`wedges`,`pulses`(194) | 全项目"对象池"就是这些模块级数组，resize/重建时整体重生成 |
| 相位 | `webRot,ringRot,ringVel,OSTEP`(195)、`layerEnv[3]` | 三层脉动、环角、网自转 |
| 相机 | `cam={x,y,z}`(319)、`shots,shotI,shotT,camPhase,camFrom`(320) | §7 |
| 圆环 | `slots=[]`(821)、`rot={from,to,t,dur,hold,ease}`(823) | §5.2 |

### 1.5 参数系统（56 项 + preset + rebuild）

参数是**声明式的**：`PARAMS` 每项 `[key, 中文label, min, max, step, group, rebuild?]`，UI 滑块、`localStorage`、preset 三处共用同一份声明（参数面板 DOM 由 `PARAMS` 动态生成，1492–1534）。`rebuild` 标记表示"改这个值要重建什么"：`'resize'`（环带宽 → 重算 R/RO）、`'slots'`（环缘宽度 → 重建卡片）、`'web'`（网亮度/网虚化 → 重烘焙网层）、`'runners'`/`'flyers'`（数量）。改参数时 `setParam`(1475) 只写 `C[key]` 并把 rebuild 任务塞进队列，`applyRebuilds`(1467) 用 **250ms debounce** 合并执行一次——避免拖动滑块时每帧重建 2600 条曲线。

运行时默认不是 `BASE` 而是 `PRESETS.MINE`：`const C={...PRESETS.MINE}`(283)。`BASE` 是"所有参数=1"的基准，`BAKED_MINE`(281) 是 2026-10-21 定稿的一组覆盖（更快的 tempo、更密的流线、更强的光束辉光、关掉景深模糊与暗角），`PRESETS.A/B` 是另外两套风格。

| # | 参数 | 中文名 | 默认值 | 范围 | 步长 | 分组 | 重建 | 作用 |
|---:|---|---|---|---:|---:|---|---|---|
| 1 | `tempo` | 整体节拍速度 | **2.5** (BASE 1) | 0.4 – 2.5 | 0.05 | 全局 | — | 全局节拍倍率；实际拍长 = PATTERN[i]×0.92/tempo，越大越急 |
| 2 | `camera` | 自动运镜 (0关 1开) | 1 | 0 – 1 | 1 | 全局 | — | 自动运镜总开关（0=关闭，镜头锁死） |
| 3 | `camZoom` | 运镜推近幅度 | 1 | 0 – 2 | 0.05 | 全局 | — | 镜头推近倍率的额外缩放；zf(z)=1+(z-1)*camZoom |
| 4 | `glow` | 柔光层强度 | **1.1** (BASE 1) | 0 – 1.5 | 0.05 | 全局 | — | 辉光合成强度；alpha=min(1,0.9*glow)，在 1/GS 降采样层上 blur(6px) |
| 5 | `scan` | 扫描线 (0关 1开) | 1 | 0 – 1 | 1 | 全局 | — | CSS 扫描线开/关（body.noscan） |
| 6 | `ringSpeed` | 圆环转动幅度/速度 | **3** (BASE 1) | 0 – 3 | 0.05 | 圆环 | — | 圆环每次换挡的角位移倍率（叠加在 ringMove 的 d 上） |
| 7 | `ringPause` | 圆环停顿时长 | **1.2** (BASE 1) | 0 – 3 | 0.05 | 圆环 | — | 急停后 hold 时长倍率（hold=rr(0.04,0.4)*ringPause） |
| 8 | `ringWidth` | 环带厚度 | **1.3** (BASE 1) | 0.6 – 1.6 | 0.02 | 圆环 | `resize` | 环带宽倍率，直接改 RO；参数重建标记 resize |
| 9 | `rimBright` | 内外缘细线亮度 | **1.8** (BASE 1) | 0 – 2 | 0.05 | 圆环 | — | 内外缘毫线亮度；三遍描边亮度随 rimBright² |
| 10 | `rimWidth` | 内外缘细线带宽度 | **1.3** (BASE 1) | 0.3 – 2.5 | 0.05 | 圆环 | `slots` | 环内缘宽度系数，rimW=max(3,(RO-R)*0.065*rimWidth)；重建标记 slots |
| 11 | `dataFlicker` | 数据块刷新/闪烁 | 1 | 0 – 4 | 0.1 | 圆环 | — | 每拍被作废/闪烁的卡片数倍率（作废 6×，闪烁 2×） |
| 12 | `webBright` | 底层网线亮度 | **0.9** (BASE 1) | 0.1 – 3 | 0.05 | 圈内 | `web` | 编织网基础亮度；重建标记 web |
| 13 | `webPulseBase` | 网线闪烁层基础亮度 | **0.1** (BASE 0.15) | 0 – 1 | 0.02 | 圈内 | — | 网线 pulse 层基础 alpha |
| 14 | `webPulseAmp` | 网线闪烁层节拍亮度 | **0.8** (BASE 0.85) | 0 – 1 | 0.02 | 圈内 | — | pulse 层受 layerEnv 调制的幅度：alpha=clamp(base+amp*layerEnv[k]) |
| 15 | `webSpin` | 网线整体转速 | 1 | 0 – 5 | 0.1 | 圈内 | — | 网整体自转角速度倍率：webRot+=dt*(0.03+env*0.12)*webSpin |
| 16 | `runnerCount` | 单独亮线 数量 | **788** (BASE 336) | 0 – 900 | 1 | 圈内 | — | 游走流线数量；重建标记 runners |
| 17 | `runnerBright` | 单独亮线 亮度 | **0.5** (BASE 1) | 0 – 2 | 0.05 | 圈内 | — | 流线颜色亮度（白色 rgba(250,251,255,0.75*bright)） |
| 18 | `runnerWidth` | 单独亮线 粗细 | 1 | 0.3 – 3 | 0.05 | 圈内 | — | 流线线宽 |
| 19 | `runnerSpeed` | 单独亮线 速度 | **0.6** (BASE 1) | 0.1 – 4 | 0.05 | 圈内 | — | 流线相位推进倍率 |
| 20 | `runnerVariety` | 单独亮线 速度差异 | **0.4** (BASE 1) | 0 – 1 | 0.05 | 圈内 | — | 流线模式多样性；越高越容易出现脉冲/自加速/快闪等非匀速人格 |
| 21 | `cometPerBeat` | 成组光束 每拍数量 | **2.3** (BASE 1.1) | 0 – 6 | 0.1 | 圈内 | — | 每拍常规彗星条数（每 4 拍用 cometBurst） |
| 22 | `cometBurst` | 成组光束 重拍爆发数 | **9** (BASE 4) | 0 – 12 | 0.5 | 圈内 | — | 重拍（beatN%4===0）的彗星条数 |
| 23 | `cometTrickle` | 成组光束 拍间零星(每秒) | **1.5** (BASE 0) | 0 – 6 | 0.1 | 圈内 | — | 拍与拍之间涓流生成彗星的概率（默认 0 关闭） |
| 24 | `cometLines` | 成组光束 每组线数 | 1 | 0.3 – 3 | 0.05 | 圈内 | — | 每条彗星的并发线数倍率（弧束/汇聚束） |
| 25 | `cometWidth` | 成组光束 宽度 | 1 | 0.3 – 3 | 0.05 | 圈内 | — | 彗星线宽倍率 |
| 26 | `cometBright` | 成组光束 亮度 | 1 | 0.1 – 2.5 | 0.05 | 圈内 | — | 彗星主体亮度 |
| 27 | `cometGlow` | 成组光束 柔光 | 1.1 | 0 – 3 | 0.05 | 圈内 | — | 彗星辉光线亮度系数（在 glowC 上的第二遍） |
| 28 | `cometSpeed` | 成组光束 速度 | **0.8** (BASE 1) | 0.3 – 3 | 0.05 | 圈内 | — | 彗星速度；寿命 dur=rr(0.4,0.85)/cometSpeed，速度与寿命互锁 |
| 29 | `cometFollow` | 成组光束 跟随圆环 (0/1) | **1** (BASE 0) | 0 – 1 | 1 | 圈内 | — | 彗星是否跟随圆环旋转（rotate(ringRot-c.rot0)） |
| 30 | `beamBright` | 伸缩光束 亮度 | **1.8** (BASE 1) | 0 – 2.5 | 0.05 | 环外 | — | 5 层光束总亮度（乘在每 wedge 的 alpha 上） |
| 31 | `beamLen` | 伸缩光束 长度 | **1.8** (BASE 1) | 0.2 – 1.8 | 0.05 | 环外 | — | 光束长度倍率 |
| 32 | `beamWidth` | 伸缩光束 线粗细 | **0.7** (BASE 1) | 0.3 – 3 | 0.05 | 环外 | — | 光束线宽倍率 |
| 33 | `beamBounce` | 回弹波浪层 强度 | **2** (BASE 1) | 0 – 2 | 0.05 | 环外 | — | bounce 回弹层亮度倍率（默认 1） |
| 34 | `beamGlow` | 伸缩光束 柔光 | **3.5** (BASE 1) | 0 – 6 | 0.1 | 环外 | — | 高亮 wedge 第二遍 glow 笔的系数：lineWidth*2.5, alpha*0.06*beamGlow |
| 35 | `dashBright` | 流动短线 亮度 | **1.9** (BASE 1) | 0 – 2 | 0.05 | 环外 | — | dash 虚线段亮度 |
| 36 | `hazeCount` | 宽光带 数量 | **22** (BASE 8) | 0 – 30 | 1 | 环外 | — | haze 雾条目标数量（默认 8，实际按可见弧补充） |
| 37 | `hazeBright` | 宽光带 亮度 | **1.5** (BASE 1) | 0 – 3 | 0.05 | 环外 | — | haze 雾亮度 |
| 38 | `flyerCount` | 飞出流线(单独) 数量 | **3** (BASE 1) | 0 – 3 | 0.05 | 环外 | `flyers` | 飞线数量倍率；initFlyers 数量=min(750,320+W*0.25)*flyerCount；重建标记 flyers |
| 39 | `flyerBright` | 飞出流线(单独) 亮度 | **3** (BASE 1) | 0 – 3 | 0.05 | 环外 | — | 飞线亮度 |
| 40 | `flyerWidth` | 飞出流线 粗细 | **1.4** (BASE 1) | 0.3 – 3 | 0.05 | 环外 | — | 飞线线宽 |
| 41 | `flyerSpeed` | 飞出流线 速度 | **2.2** (BASE 1) | 0.2 – 3 | 0.05 | 环外 | — | 飞线径向速度倍率（基础 260–900 px/s） |
| 42 | `burstRate` | 飞出流线(成组) 频率 | **3.5** (BASE 1) | 0 – 5 | 0.1 | 环外 | — | 每拍飞线束生成频率（重拍 3-4 束，否则 1-2 束） |
| 43 | `burstSize` | 飞出流线(成组) 每组数量 | **3** (BASE 1) | 0.2 – 3 | 0.05 | 环外 | — | 每束飞线条数倍率（基础 14–44 条） |
| 44 | `burstBright` | 飞出流线(成组) 亮度 | **2.5** (BASE 1) | 0 – 2.5 | 0.05 | 环外 | — | 飞线束亮度 |
| 45 | `flareRate` | 根部闪光 频率 | **3.5** (BASE 1) | 0 – 5 | 0.1 | 环外 | — | 边缘 flare 生成率（rnd()<0.06*flareRate） |
| 46 | `flareBright` | 根部闪光 亮度 | **2** (BASE 1) | 0 – 2 | 0.05 | 环外 | — | flare 亮度 |
| 47 | `rimDensity` | 内外缘细线 密度 | **1.2** (BASE 1) | 0.3 – 3 | 0.05 | 圆环 | — | 环缘毫线密度；间距 0.14/rimDensity 度 |
| 48 | `depthBlur` | 远景虚化 (环外远层) | **0** (BASE 1.4) | 0 – 5 | 0.1 | 空间层次 | — | 远景景深模糊像素（只作用于半分辨率 farC） |
| 49 | `depthDim` | 远景亮度 | **0.1** (BASE 0.9) | 0 – 1.5 | 0.05 | 空间层次 | — | 远景降亮 alpha=min(1,depthDim) |
| 50 | `webBlur` | 圈内底层虚化 | **0** (BASE 0.7) | 0 – 4 | 0.1 | 空间层次 | `web` | 网线层虚化像素（只在重建 web 时用 filter 烘焙） |
| 51 | `parallax` | 视差 (运镜时远近错位) | **0** (BASE 0.6) | 0 – 1.5 | 0.05 | 空间层次 | — | 视差强度：网线层相机 k=1-0.1*parallax，bokeh 反向 k=1+0.6*parallax |
| 52 | `bokeh` | 前景光斑 数量 | **0** (BASE 16) | 0 – 80 | 1 | 空间层次 | — | 散景光斑数量（默认 16） |
| 53 | `bokehBright` | 前景光斑 亮度 | **0** (BASE 1) | 0 – 3 | 0.05 | 空间层次 | — | 散景亮度 |
| 54 | `atmos` | 空间雾气 | **0** (BASE 1) | 0 – 3 | 0.05 | 空间层次 | — | 大气径向雾强度（中心亮/边缘暗的叠加层） |
| 55 | `ringShadow` | 圆环遮挡阴影 | **0** (BASE 1) | 0 – 2 | 0.05 | 空间层次 | — | 环带对中心光场的遮挡阴影强度（径向渐变 alpha 到 0.8*ringShadow） |
| 56 | `vignette` | 暗角 | **0** (BASE 0.7) | 0 – 1.5 | 0.05 | 空间层次 | — | 暗角强度（canvas 径向渐变，0.75*vignette） |

`PRESETS.MINE`（运行时真正的默认 preset，`const C={...PRESETS.MINE}`）相对 `BASE` 全部写死的调整：

| 参数 | BASE | MINE | 说明 |
|---|---:|---:|---|
| `tempo` | 1 | 2.5 | 全局节拍倍率 |
| `glow` | 1 | 1.1 | 辉光合成强度 |
| `ringSpeed` | 1 | 3 | 圆环每次换挡的角位移倍率（叠加在 ringMove 的 d 上） |
| `ringPause` | 1 | 1.2 | 急停后 hold 时长倍率（hold=rr(0.04,0.4)*ringPause） |
| `ringWidth` | 1 | 1.3 | 环带宽倍率，直接改 RO |
| `rimBright` | 1 | 1.8 | 内外缘毫线亮度 |
| `rimWidth` | 1 | 1.3 | 环内缘宽度系数，rimW=max(3,(RO-R)*0.065*rimWidth) |
| `webBright` | 1 | 0.9 | 编织网基础亮度 |
| `webPulseBase` | 0.15 | 0.1 | 网线 pulse 层基础 alpha |
| `webPulseAmp` | 0.85 | 0.8 | pulse 层受 layerEnv 调制的幅度：alpha=clamp(base+amp*layerEnv[k]) |
| `runnerCount` | 336 | 788 | 游走流线数量 |
| `runnerBright` | 1 | 0.5 | 流线颜色亮度（白色 rgba(250,251,255,0.75*bright)） |
| `runnerSpeed` | 1 | 0.6 | 流线相位推进倍率 |
| `runnerVariety` | 1 | 0.4 | 流线模式多样性 |
| `cometPerBeat` | 1.1 | 2.3 | 每拍常规彗星条数（每 4 拍用 cometBurst） |
| `cometBurst` | 4 | 9 | 重拍（beatN%4===0）的彗星条数 |
| `cometTrickle` | 0 | 1.5 | 拍与拍之间涓流生成彗星的概率（默认 0 关闭） |
| `cometSpeed` | 1 | 0.8 | 彗星速度 |
| `cometFollow` | 0 | 1 | 彗星是否跟随圆环旋转（rotate(ringRot-c.rot0)） |
| `beamBright` | 1 | 1.8 | 5 层光束总亮度（乘在每 wedge 的 alpha 上） |
| `beamLen` | 1 | 1.8 | 光束长度倍率 |
| `beamWidth` | 1 | 0.7 | 光束线宽倍率 |
| `beamBounce` | 1 | 2 | bounce 回弹层亮度倍率（默认 1） |
| `beamGlow` | 1 | 3.5 | 高亮 wedge 第二遍 glow 笔的系数：lineWidth*2.5, alpha*0.06*beamGlow |
| `dashBright` | 1 | 1.9 | dash 虚线段亮度 |
| `hazeCount` | 8 | 22 | haze 雾条目标数量（默认 8，实际按可见弧补充） |
| `hazeBright` | 1 | 1.5 | haze 雾亮度 |
| `flyerCount` | 1 | 3 | 飞线数量倍率 |
| `flyerBright` | 1 | 3 | 飞线亮度 |
| `flyerWidth` | 1 | 1.4 | 飞线线宽 |
| `flyerSpeed` | 1 | 2.2 | 飞线径向速度倍率（基础 260–900 px/s） |
| `burstRate` | 1 | 3.5 | 每拍飞线束生成频率（重拍 3-4 束，否则 1-2 束） |
| `burstSize` | 1 | 3 | 每束飞线条数倍率（基础 14–44 条） |
| `burstBright` | 1 | 2.5 | 飞线束亮度 |
| `flareRate` | 1 | 3.5 | 边缘 flare 生成率（rnd()<0.06*flareRate） |
| `flareBright` | 1 | 2 | flare 亮度 |
| `rimDensity` | 1 | 1.2 | 环缘毫线密度 |
| `depthBlur` | 1.4 | 0 | 远景景深模糊像素（只作用于半分辨率 farC） |
| `depthDim` | 0.9 | 0.1 | 远景降亮 alpha=min(1,depthDim) |
| `webBlur` | 0.7 | 0 | 网线层虚化像素（只在重建 web 时用 filter 烘焙） |
| `parallax` | 0.6 | 0 | 视差强度：网线层相机 k=1-0.1*parallax，bokeh 反向 k=1+0.6*parallax |
| `bokeh` | 16 | 0 | 散景光斑数量（默认 16） |
| `bokehBright` | 1 | 0 | 散景亮度 |
| `atmos` | 1 | 0 | 大气径向雾强度（中心亮/边缘暗的叠加层） |
| `ringShadow` | 1 | 0 | 环带对中心光场的遮挡阴影强度（径向渐变 alpha 到 0.8*ringShadow） |
| `vignette` | 0.7 | 0 | 暗角强度（canvas 径向渐变，0.75*vignette） |

共 46 项被 preset 覆盖；参数面板"重置"回到 BASE，选 preset MINE 回到上式。

> 启示：`C[key]` 这种"单一配置对象 + 声明式重建标记 + debounce"的结构，可以直接搬成 ASTRA 的**视觉参数层**；我们甚至可以让 agent 事件动态调参（例如上下文压力高时 `tempo` 提升），因为参数层与数据层完全解耦。

### 1.6 DOM/CSS 结构与"哪些效果不是 canvas"

| DOM | 内容 | 说明 |
|---|---|---|
| `header` | 5 个 `.kpi`（PAPERS/AGENTS/METHODS/REF. SCENES/FURTHER REVIEW）+ brand | 纯假 KPI，`kpiTick`(1227) 每 2600ms 抖一下数字；我们换成真实统计 |
| `.stage#stageWrap` | `<canvas id="stage">` + 4 个 overlay：`.ov.console`、"◱ CONSOLE"、`#bgm`（音乐开关+音量）、`#chk`（STABILITY CHECK）、`.ov.status` | overlay 全 `pointer-events:none`，只有 BGM 可交互 |
| `.panels` | 8 个 `.p`：INVESTIGATION FEED(`#feed`)、ADVECTION/PARTICLE SOLVER(`#cAdv`)、METHOD WORKSPACE(`#code`)、SHARED SCENE/DIFFERENCE FIELD(`#cDiff`)、SOURCE/EXTRACTION ROUTES(`#routes`)、VALIDATION/SAMPLE BUFFER(`#cVal`)、12 AGENTS/DISPATCH(`#agents`)、METHOD/REFERENCE INDEX(`#cIdx`) | 4 列 grid；4 个 canvas 面板各 ~150px 高 |
| CSS 效果 | `.stage::after`：`repeating-linear-gradient(0deg, rgba(0,0,0,.18) 0 1px, transparent 1px 3px)` 扫描线 + 径向暗角（45–47 行）；`.app` 为 `grid-template-rows:auto minmax(0,1fr) auto; height:100vh`（**为了让 main 区域吃掉剩余高度**，canvas 尺寸由布局驱动） | 扫描线是 CSS，不进 canvas，零成本 |

值得注意的两个细节：① 头部 KPI 与 4 个小 canvas 面板在 bench 统计里会被算进 `CanvasRenderingContext2D` 调用数（同 document 共享 prototype），读 §8.8 数字时要扣掉；② 暗角做了**两遍**——CSS `.stage::after` 一层静态暗角，canvas 里 `C.vignette` 每帧再叠一层径向渐变（1188–1193），两者都可独立关。我们只需一层。

---

## 2 主循环与渲染管线

### 2.1 `frame()` 与就绪/防御状态

`frame(now)`(1428–1433) 极短：

```js
const dt = Math.min(0.05, (now - last) / 1000); last = now; T += dt;
drawStage(dt); drawAdv(dt); drawDiff(); drawVal(); drawIdx(); agentsTick(dt);
requestAnimationFrame(frame);
```

三个防御：① **`dt` 上限 0.05s**——切后台再回来时不会一帧跳 10 秒把粒子吹飞；② `frame` 在启动时被包装成 `if(ready) origFrame(now) else {last=now; requestAnimationFrame(frame)}`（1441–1442），`ready` 由 `resizeAll`(1435) 判定（`stage` 宽高 < 20px 视为没布局完）；③ `ResizeObserver` 120ms debounce（1443）+ `document.fonts.ready.then(resizeAll)`（1444）——字体就绪后尺寸会变，必须重算 canvas buffer。

`resizeAll`(1435–1440) 做四件事：取 `stage` 的 rect → 重 clamp `DPR=Math.min(devicePixelRatio||1,2)` → 设 canvas buffer 并 `setTransform` → 重建所有离屏层与实体数组。

### 2.2 `drawStage` 的 15 个阶段（顺序即依赖）

`drawStage(dt)`(1074–1196)。注意：**渲染管线的顺序不是"先画后特效"，而是"先开一个低分辨率 glow 收集层，让后续该发光的东西顺手画进去"**。

| # | 行号 | 目标 | 混合 | 做什么 |
|---:|---|---|---|---|
| 1 | 1075–1079 | — | — | `updateBeat/updateCam/updateOuter` + `cometTrickle` + `webRot += dt*(0.03+env*0.12)` + `updateRing` + `layerEnv *= exp(-dt*2.2)` |
| 2 | 1082–1084 | 主 canvas | source-over | 清屏 `#08090b` |
| 3 | 1087–1089 | `glowC`(1/GS) | lighter | 清屏 + `camT(G,1/GS)`，把 glow 层当"收集器" |
| 4 | 1091–1121 | 主 canvas | lighter | `camTk(S,DPR,1-0.1*parallax)`（网在更远处）→ 画 `webBase` + 3 层 pulse 网 → 流线（先在 `trailC` 上画再贴回） |
| 5 | 1123–1129 | 主 canvas | source-over | 环带对中心网的**遮挡阴影**（径向渐变 + evenodd） |
| 6 | 1131–1154 | 主 + glowC | lighter | 彗星（主体 + 辉光双绘） |
| 7 | 1157–1158 | 主 canvas | lighter | 贴静态放射背景 `laneC` |
| 8 | 1160–1167 | `farC`(W*FS,H*FS) → 主 | lighter | 切 `S=farC` 调 `drawOuterFar()`；再以 `filter=blur(C.depthBlur)` + `alpha=C.depthDim` 贴回 = **景深** |
| 9 | 1169–1173 | 主 canvas | source-over | 大气径向雾（`C.atmos`） |
| 10 | 1174 | 主 canvas | — | `drawOuterNear()`：近景光束 + dash/tip 批量 + 飞线 + flare |
| 11 | 1176 | 主 canvas | — | `drawRing()`：卡片环、内外缘毫线、刻度 |
| 12 | 1179–1185 | 主 canvas | lighter | **辉光合成**：`filter=blur(6px)`、`alpha=min(1,0.9*C.glow)`、把 `glowC` 放大 3× 贴回 |
| 13 | 1187 | 主 canvas | lighter | `drawBokeh()` 散景（自带视差） |
| 14 | 1188–1193 | 主 canvas | source-over | 暗角径向渐变 |
| 15 | 1195 | 主 + DOM | — | `drawCallout()`：HTML 检查卡 + canvas 细引线 |

### 2.3 离屏 canvas 尺寸策略（降采样是核心）

| 离屏 canvas | 创建处 | 尺寸 | 缩放 | 用途 |
|---|---|---|---|---|
| `webBase` + `webLayers[3]` | `buildWeb`(396) | `2R+4` 见方 | `d=min(DPR,1.5)`（**网层不等真 retina**，1.5 封顶） | 70% 曲线烘进 base，30% 分 3 层做脉动 |
| `trailC` | 386 | `2R+4` 见方 | `min(DPR,1.5)` | 流线拖尾缓冲，每帧 `drawImage` 一次 |
| `farC` | 387 | `W*FS × H*FS` = 半分辨率 | `camT(F,FS)` 把 CSS 坐标映射进去 | 远景 + 景深模糊 |
| `glowC` | 388–389 | `ceil(W/GS) × ceil(H/GS)` = 1/3 | `camT(G,1/GS)` | 辉光收集层，blur 在 1/3 分辨率上做 |
| `laneC` | `buildLanes`(567) | 全尺寸（DPR 缩放） | 无 | 700 条静态放射线，一次构建永不重画 |
| 每个 slot 的卡片 | `renderSlot`(986) | `band*2.4 × (h+2)*2.4` | `RING_SC=2.4` | 2.4 倍超采样的"小数据卡"，保证小字清晰 |
| 面板 canvas ×4 | `fit(c)`(180) | DOM 尺寸 × DPR | DPR | 侧边 4 个假仪表 |
| bokeh 精灵 | `mkBokehSprite`(789) | 128×128 | — | 预渲染的虚焦光斑 |

**尺寸策略总结**：*该模糊的东西降采样（glow 1/3、far 1/2），该锐利的东西超采样（slot 2.4×），中间层用 1.5× 封顶*。这正是纯 Canvas 2D 跑得动密集内容的根本原因——不是优化代码，是**先决定分辨率**。

### 2.4 混合模式用法

- `source-over`：清屏、环带黑洞、暗角、大气雾。
- `lighter`（加法）：网 pulse 层、彗星、静态放射背景、辉光合成、散景、卡片 flash、环缘 glow——**所有"发光"统一走加法**。
- `destination-out`：`trailC` 的每帧擦除（1105）。用"擦一点"代替"清空重画"，才有拖尾。
- `evenodd`：环带中间的洞（1023 `arc(RO)` + 反向 `arc(R)`），以及环带阴影。
- 渐变：`GR`（`mkG` 545）三套径向渐变 `s0` 白 / `s1` 紫 / `s2` 青灰，`strokeStyle` 直接设为"径向渐变对象"，让一条描边沿半径方向自然衰减——省掉逐段算 alpha。

### 2.5 每帧的状态管理

实测（§8.8）一帧内 `save()` 62 次 / `restore()` 62 次（配平）、`setTransform` 9 次、`clip` 1 次（网裁剪）、`clearRect` 5 次（5 个离屏层）。`save/restore` 集中在"每个 slot / 每条楔形 / 每次相机切换"处，因此频率与实体数量线性相关：**这是可控成本**，但也是高密度时最容易膨胀的地方。

---

## 3 不均匀节拍时钟（核心机制）

> 如果只允许移植一个机制，就移植这一节。它决定了整个画面"活不活"。

### 3.1 数据结构

全部状态只有 5 个标量 + 1 个数组（291–293）：

```js
const PATTERN = [0.5,0.25,0.25,0.5,0.5,0.75,0.25,0.25,0.25,1.0];   // 292
let beatT = 0.4, beatI = 0, sinceBeat = 9, beatN = 0, env = 0;        // 293
let layerEnv = [0,0,0];                                              // 193
```

`PATTERN` 是"拍长的相对比例"，故意不整齐（相邻最短 0.25、最长 1.0，相差 4 倍）。`beatI` 是 10 拍循环的游标；`beatN` 是总拍数（用来做"每 4 拍爆发 / 每 8 拍重拍"）；`sinceBeat` 是距上一拍的秒数；`env` 是由 `sinceBeat` 派生的全局包络。

### 3.2 生成算法（`updateBeat` 294–298）

```js
function updateBeat(dt){
  beatT -= dt; sinceBeat += dt;
  if (beatT <= 0){
    beatT += PATTERN[beatI++ % PATTERN.length] * 0.92 / C.tempo;  // 295–296
    sinceBeat = 0; beatN++;
    onBeat();                                                     // 297
  }
  env = Math.exp(-sinceBeat * 4.5);                               // 298
}
```

四个关键设计：

1. **拍长 = `PATTERN[i] * 0.92 / tempo`**。`0.92` 让拍子比"整数网格"快一点点，整个循环 10 拍共 `4.5*0.92=4.14s`（tempo=1 时 ≈145 BPM）；`tempo` 参数整体缩放。
2. **用 `+=` 而不是 `=`**。`beatT` 是倒计时，溢出部分保留到下一拍，帧率抖动不会让节拍漂移。
3. **`env` 是拍后的指数衰减**：`exp(-sinceBeat*4.5)`，时间常数 ≈0.22s。60fps 下刚过拍 `sinceBeat=dt≈0.0167` → `env≈0.93`；0.5s 后 ≈0.105；1s 后 ≈0.011。所以每次拍是一根"几乎从 1 冲到 0 的窄脉冲"。
4. **`onBeat()` 是唯一的事件入口**（299–316），把一次拍分发给 5 个系统（下一节）。

### 3.3 `onBeat()` 分发的 5 类事件（299–316）

| # | 分发内容 | 细节 | 行号 |
|---:|---|---|---|
| 1 | 圆环换挡 | `if (rot.t >= rot.dur && rot.hold <= 0) ringMove()`——环只在"当前动画完成且 hold 结束"的拍上换挡 | 299–301 |
| 2 | 彗星生成 | `n = round((beatN%4===0 ? C.cometBurst : C.cometPerBeat) * rr(0.6,1.4))`；每条用 `setTimeout(spawnComet, i*rr(30,90))` **错峰 30–90ms** 发射，避免同一帧堆叠 | 302–304 |
| 3 | 三层网脉动 | 随机 `layerEnv[k]=1`；另外每 4 拍把三层全部重置为 `rr(0.6,1)` | 305–307 |
| 4 | 行进波 | `pulses.push({c: 起点角, v: 速度, w: 宽度, amp, life, L:0})`；`big = beatN%8===0` 时波更宽更强、速度×0.7 | 308–312 |
| 5 | 卡片刷新 | `6*dataFlicker` 个 slot 清空缓存（`s.c=null`）+ `2*dataFlicker` 个 slot 设 `flash=rr(0.35,0.7)` | 313–315 |

**这就是"不均匀"的种子**：一拍同时触发 5 个不同生命周期的事件，各自用不同衰减/时长，因此永远不会整齐收敛到同一相位。

### 3.4 侧链事件：`onBeatOuter` 与 `onBeatFlyers`

- `onBeatOuter()`(613–621)：随机挑一批 wedge，`kick=rr(0.4,1)`（回弹层做"往外冲一下"），50% 概率换一条新剖面 `prof`；重拍额外 `spawnHaze/spawnFlare`。→ **光束是"被拍子踢一下才伸出去"的。**
- `onBeatFlyers()`(707–710)：重拍 3–4 组、普通拍 1–2 组 `× C.burstRate` 飞线束。
- `onBeat` 里的圆环换挡与卡片作废，把"数据面板"也编进了节拍——这是它看起来整体感强的关键。

### 3.5 哪些量被节拍驱动（清单）

| 被驱动量 | 公式 / 行为 | 源码位置 |
|---|---|---|
| 拍长 | `PATTERN[i]*0.92/tempo` | 295–296 |
| 全局包络 | `env = exp(-sinceBeat*4.5)` | 298 |
| 网自转 | `webRot += dt*(0.03 + env*0.12)*webSpin`（**拍上转快 4 倍**） | 1077 |
| 三层网脉动 alpha | `clamp(webPulseBase + webPulseAmp*layerEnv[k])` | 1098 |
| 层包络衰减 | `layerEnv[k] *= exp(-dt*2.2)`（时间常数 0.45s，比 env 慢一倍） | 1079 |
| 流线"脉冲人格"速度 | `sp * (0.5 + 2.5*env)`（爆发时 3 倍速） | 1102、1111 |
| 彗星数量/错峰 | 每拍 `round(rr(0.6,1.4)*n)`，每 4 拍 burst | 302–304 |
| 行进波 | `pulses` 生成 → 在 `updateOuter` 里以高斯核推动楔形 | 308–312、587 |
| 环换挡时机 | 只在拍上、且上一段动画结束 | 299–301 |
| 卡片作废/闪烁 | 每拍 6/2 个 | 313–315 |
| 楔形 kick / 剖面更换 | 每拍随机批 | `onBeatOuter` 613–621 |
| 飞线束 | 每拍 1–4 组 | `onBeatFlyers` 707–710 |
| 相机 hold 期推近 | `cam.z = zf(cur.z)*(1+0.05*k*camZoom)`（k=本镜头 hold 进度） | 348 |
| 圆环 hold 期漂移 | `ringRot += 0.02*dt`（**不是完全静止**） | 839 |

### 3.6 "没有东西匀速"的 8 条具体公式

1. **模式人格**（`newRunner` 455–466）：每个流线随机分配 mode 0/1/2——`mode0` 匀速慢走/快闪，`mode1` 拍上脉冲（乘 `surge`），`mode2` 自加速（`sp + 1.3*t*t`）。一个场里永远混着三种时间感。
   ```js
   r.t += dt*C.runnerSpeed*(r.mode===1 ? r.sp*surge : r.mode===2 ? r.sp + 1.3*r.t*r.t : r.sp);  // 1111
   ```
2. **包络脉冲**：`surge = 0.5 + 2.5*env`(1102) 与 `webRot` 的 `0.03+env*0.12`——速度不是常数，是"拍上加速、拍间衰减"。
3. **双正弦 idle**：光束未受激发时的长度 `w.base*(0.4 + 0.34*sin(T*a+ph1) + 0.14*sin(T*b+ph2))`（594–595），bounce 层 `base*(0.36+0.14*sin(T*0.9+w.ph))`(589)——两条不同频率正弦叠加，肉眼永远抓不到周期。
4. **非对称缓动**：`w.len += (tgt-w.len)*min(1, (tgt>len?15:2.2)*dt)`（bounce 层 592）与 `(tgt>len?5:1.3)`（普通层 598）——**"快出慢回"**：被打出去 15/5 倍速，收回 2.2/1.3 倍速。这是"有生命感"的核心手感公式。
5. **对数相机 z**：`z = exp(log(from) + (log(to)-log(from))*e)`（355 附近）——推近时先快后慢的透视感是对数空间的自然结果，线性插值做不出来。
6. **随机 hold/dur**：圆环 `dur` 在 `rr(0.18,0.38)`~`rr(1.1,2.1)` 之间、hold 在 `rr(0.04,0.4)`；彗星 `dur=rr(0.4,0.85)/cometSpeed`、窗口 `win=rr(0.22,0.4)`（488）——每个实体有自己的时钟。
7. **相位抖动预生成**：每 wedge 预生成 `pf/pp`（呼吸相位）、`ds`（dash 相位），绘制时 `0.92 + 0.08*sin(T*pf+pp)`(645)、`0.5+0.5*sqrt(edge)`、`hash(x)` 决定长度抖动——看起来是噪声，其实是**确定性哈希**，不会闪烁。
8. **事件 kick**：`w.kick`（回弹层的外冲量）、`pulses`（行进波高斯推动）、`s.flash`（卡片闪）——全部是"一次性冲量 + 衰减"，从无持续匀速。

### 3.7 多时间尺度表（为什么看起来"永不重复"）

| 尺度 | 周期 | 来源 |
|---|---|---|
| 单拍 | tempo=1 时 0.23–0.92s（`PATTERN[i]*0.92`）；MINE tempo=2.5 时 0.092–0.368s、平均 0.166s | `PATTERN` |
| 全局包络 | 时间常数 0.22s | `exp(-sinceBeat*4.5)` |
| 层包络 | 时间常数 0.45s | `exp(-dt*2.2)` |
| 行进波 | life 1.2–2.0s | `pulses` |
| 圆环换挡 | 0.18–2.1s 动画 + 0.04–0.4s hold | `ringMove` |
| 相机镜头 | hold 3.0–4.5s + move 2.2s | `buildShots/updateCam` |
| 拍模式循环 | 4.14s / tempo | 10 拍 |
| 彗星寿命 | 0.4–0.85s | `spawnComet` |

8 个尺度互不成整数比 → 组合周期极长；但它们都由同一个 `env` 闸门收束 → 整体又"像同一个心跳"。**这是我们最该抄的编排思想：多尺度随机 + 单一总包络。**

---

## 4 中心编织光场（Web / Runners / Comets）

中心区域一共 3 层动态内容：**静态编织网 → 沿网跑的流线 → 飞越网的彗星**。全部直接画在主 canvas 上（用 `clip` 限制在半径 R 的圆内），只有网层用离屏预渲染。

### 4.1 几何：520–2600 条贝塞尔弦

`buildWeb()`(396–450) 在 `2R+4` 见方的离屏 canvas 上烘焙整张网：

- **区域**：先画径向渐变底 `#111215 → #0c0d0f`（404–406），再 `arc(0,0,R)` 裁剪（407），保证所有线条不溢出内圆；
- **曲线数量**：`N = min(2600, round(1000 + W*H/800))`（409）——**随画布面积增长但有上限 2600**，这是"分辨率越大越密"的可控做法；
- **每条曲线**：两端点都在圆周上（`a1 = rnd()*TAU`，`a2 = a1 + rr(0.6, π*1.4)`，弦跨度 34°–252°），控制点半径 `cr = sqrt(rnd()) * R * 0.9`（409–424）——`sqrt` 让控制点靠近圆心（面积均匀分布），于是弦大量交叉在圆心附近、边缘稀疏，天然形成"编织"的疏密节奏；
- **颜色权重**：90% 白 `rgba(250,251,255,·)`，5% 粉，5% 紫（421）；
- **两层 alpha 分布**：70% 的曲线烘进 `webBase` 永久层，`al = 0.03 + pow(rnd(),3)*0.28`（绝大多数极淡，少数突然亮）；30% 分到 3 个 `webLayers` 脉动层，`al = 0.08 + pow(rnd(),2)*0.35`（更亮、会被 `layerEnv` 调制）；
- **细节**：70 个节点标记（427–434，圆点/小十字，给"网络"以锚点）、3 组点状小环链（436–440，模拟轨道/数据链）；
- **柔光烘焙**：若 `C.webBlur > 0`，每层重画时先叠一层带 `filter=blur((i?0.5:1)*C.webBlur*d px)` 的模糊副本（层号越大模糊越轻），并把原层 alpha 收到 `max(0.15, 1-webBlur*0.3)`（442–449）——**用重建时的一次性 filter 换运行时零模糊成本**。

`qpt(cv,t)`(451–454) 是二次贝塞尔求点函数，流线与彗星都靠它把 `t∈[0,1]` 映射为坐标。

### 4.2 运行时只做 4 次 `drawImage`

每帧网层绘制（1093–1100）只有：1 次 `webBase` + 3 次 `webLayers`，混合模式 `lighter`，alpha 由 `Math.min(1, C.webPulseBase + C.webPulseAmp*layerEnv[k])` 调制（1098）。层包络 `layerEnv` 由拍子随机点亮、以 `exp(-dt*2.2)` 衰减（§3.5）——所以三层轮流"呼吸"，每层呼吸周期不同。**2600 条曲线在运行时成本几乎为零**，代价只是内存里几张纹理。

### 4.3 流线 Runners：token 流的视觉原型

- **数量**：`C.runnerCount`（BASE 336，MINE 788）。
- **人格**（`newRunner` 455–466）：每个 runner 绑定一条随机曲线 + `{t: 进度, sp: 速度, mode: 0|1|2, px/py: 上一位置, b: 是否粉色(=10%)}`。mode 谱系见 §3.6 第 1 条：`mode1` 受 `env` 脉冲加速，`mode2` 自加速（`sp + 1.3*t*t`），其余按档位随机速度。
- **每帧**（1103–1121）：
  1. `trailC` 上以 `destination-out` + `rgba(0,0,0, 0.05+env*0.05)` 做整层半透明擦除（1105–1106）；
  2. 逐 runner 推进 `t`（1111），用 `qpt` 求新位置，从上一位置 `lineTo`（1116），`lineCap='round'`，白色 `rgba(250,251,255,0.75*runnerBright)` 或粉色；
  3. 整张 `trailC` `lighter` 贴回主 canvas（1120）。
- **拖尾半衰期**：擦除 alpha 0.05 → 每帧剩 95%，半衰 ≈13.5 帧 ≈0.22s；`env` 高时擦除 0.10 → 拖尾砍半。**"拍上拖尾短而亮、拍间拖尾长而柔"**，这是流线有生命感的原因。
- 该结构直接对应 ASTRA 的 **token 增量流**：每条 runner = 一个持续产出的 token 流，`t` 推进速度 = token 速率，颜色 = agent/会话身份。

### 4.4 彗星 Comets：跨层事件原型

- **生成**（`spawnComet` 469–489）：两种形状——约 60% 是"弧束"（几条线沿环的一段弧向外飞），40% 是"汇聚束"（从不同角度收束到同一点）；每条彗星带 `{a, r0, rot0, win, dur, life, burst, tone}`，`dur = rr(0.4,0.85)/C.cometSpeed`、**窗口 `win = rr(0.22,0.4)`**（488）；
- **生命周期**：`p = easeIO(min(1, life/dur))`（1137），`head = min(1, p*(1+win))`、`tail = max(0, p*(1+win)-win)`——**头尾窗口以不同速度扫过整条轨迹**，所以彗星是"一段发光线在飞"，不是一根刚体；最后 0.25s 淡出；
- **绘制**：`strokeComet`(491–498) 用折线采样（主体 18 段、亮线 8 段、辉光 6 段），主 canvas + `glowC` 双绘，`lighter`（1131–1154）；
- **命中回写**：`head >= 1` 时调用 `flashSlotAt(ang)`(832–836) 让环上最近的那张卡闪一下——**彗星是"内→外"的连线事件**，正好对应 ASTRA 的 `tool/call`（中心工具流飞向外圈对应的观测卡）；
- `cometFollow` 参数控制彗星是否随环旋转（`rotate(ringRot - c.rot0)`）。

### 4.5 遮挡与混合：2D 里造出前后关系

- 整片网用 `lighter` 叠加，靠"白线越叠越亮"形成密度；
- **环带阴影**（1123–1129）：在网之上、环之下画一个 `R-110 → R` 的径向渐变，alpha 到 `0.8*ringShadow`，用 `evenodd` 填充圆环带——**让卡片环看起来"压"在中心光场上**。这是全画面唯一的前后关系来源：没有 3D，只有投影阴影；
- 网层还有视差：绘制时用 `camTk(S,DPR,1-0.1*parallax)`（1091），即网只吃 90% 的相机位移 → 它看起来"更远"。

### 4.6 密度与成本

| 项 | 数量 | 成本 |
|---|---|---|
| 贝塞尔曲线 | `min(2600, 1000+W*H/800)` | 只在 rebuild 时画一次，运行时 0 |
| 节点标记 | 70 | 烘焙 |
| 点状小环链 | 3 组 | 烘焙 |
| Runner | 336（可调 788） | 每帧 1 条 `lineTo`/runner + 1 次大 `drawImage` |
| 彗星 | 每拍 1–4 条，寿命 0.4–0.85s | 每条 ~18+8+6 段折线 |
| 运行时贴图 | 4 张网层 | 4 次 `drawImage`（lighter） |

---

## 5 外圈微型数据面板圆环

这是整个项目**最接近"产品雏形"**的部分：一圈小卡片，每张是一块预渲染的数据面板，靠旋转状态机调度，看起来像"漂浮在空间里的观测站"。

### 5.1 几何构建（`buildCards` 841–851）

```js
const band = RO - R;                       // 环带宽
const mid  = R + band * 0.42;              // 卡片中心所在半径
// 沿 2π 铺满：
const hpx = rr(16, 62);                    // 每张卡的"厚度"（像素，沿半径方向? 实为角向厚度）
const da  = hpx / mid;                     // 屏幕像素 → 弧度
const gap = rr(3, 9) / mid;                // 卡间缝
slot = { a: a + da/2, da, hpx, c: null, flash: 0 };
```

要点：**卡片不是均匀网格**——厚度 16–62px、缝 3–9px 都随机，所以环上的卡"疏密不均"，视觉上像真实仪表盘。`da = hpx/mid` 把"像素厚度"换算成弧角，保证不同半径下卡片的屏幕厚度一致。

### 5.2 旋转状态机（`rot` 823 + `ringMove` 824–831 + `updateRing` 837–840）

```js
const rot = { from: 0, to: 0, t: 1, dur: 1, hold: 0, ease: easeIO };  // 823
```

`ringMove()` 用三档随机 + 一个反向特例决定"下一次转动"：

| 概率 | 档位 | 角位移 `d` | 时长 `dur` | 缓动 | 观感 |
|---:|---|---|---|---|---|
| 22% | 快旋 | `rr(1.1, 2.1)` | `rr(0.7, 1.05)` | `easeIO` | 快速滑过一屏卡片 |
| 42% | **急停** | `rr(0.14, 0.48)` | `rr(0.18, 0.38)` | `easeOX = 1-2^(-10t)` | 突然刹车，前 30% 吃掉 90% 位移 |
| 36% | 轻推 | `rr(0.05, 0.18)` | `rr(0.3, 0.6)` | `easeIO` | 微微挪一格 |

另有两处细节：`rnd() < 0.08` 时反向（`d = -d*0.5`，幅度减半）；所有 `d *= C.ringSpeed`；`hold = rr(0.04, 0.4) * C.ringPause`（830）——**停下之后不会立刻再动，而是随机静置**。`updateRing(dt)`(837–840)：动画中按 `ease(min(1, t/dur))` 插值；`hold` 期 `ringRot += 0.02*dt` 继续微漂移（839）——**"静止"也是动态的**。

如果画面上有值得注意的卡片，`flashSlotAt(ang)`(832–836) 会在角度差 <0.08rad 的最近 slot 上把 `flash` 抬到 0.8（彗星命中、事件通知都用它）。

### 5.3 12 种预渲染数据块（`BLOCKS` 882–974）

`renderSlot`(986–1017) 会先把整张卡切成一到两块（45% 概率 split 成上下两块，块间有分隔），每块随机抽一种 `BLOCKS` 绘制。权重 `BLOCK_W`(975–976) 与最小高度约束 `NEEDS_H`(977) 决定 `pickBlock(h)`(978–985) 的合法选择。

| 块 | 视觉内容 | 权重 | 最小高 |
|---|---|---:|---:|
| `code` | 行号 + 随机 token 组成的"伪代码行" | 16 | 18 |
| `kv` | 左 key、右 value + 横条 | 11 | — |
| `spark` | 40 点随机游走折线 + 端点方块 | 9 | 18 |
| `bars` | 6–16 条横条（条形图） | 8 | 20 |
| `prog` | 12 段进度格 + 百分比数字 | 7 | — |
| `grid` | 点阵（5–7% 粉色高亮单元） | 7 | — |
| `gauge` | 圆弧仪表，剩余空间递归画 `kv` | 3 | 16 |
| `wave` | 双频正弦叠加的两条曲线 | 4 | 18 |
| `para` | `glyphStrips` 生成的"伪文字段"（ragged 竖条） | 12 | — |
| `cols` | 带列间隙的竖条组 | 7 | — |
| `barcode` | 实心粗条（条码） | 6 | — |
| `matrix` | 稀疏点阵 | 8 | — |

`glyphStrips(x, x1, y0, y1, pitch, opt, ctx)`(860–874) 是"伪造不可读文本"的通用函数：按 `pitch` 竖排短竖条，`opt` 支持 `ragged`（高度参差）、`colGap`（列缝）、`solid`（实心）、`th`（阈值）。`header(c, x0, x1, y, t)`(876–881) 画随机标题（HEAD 池 853–854）+ 编号 + 下划线。**这套"不可读文本"视觉是我们必须丢掉的**（见 §10.4），但"小卡预渲染 + 随机内容块"的容器结构值得保留。

### 5.4 缓存策略（本项目最值得抄的一段）

`drawRing(dt)`(1019–1071) 每帧对每张卡只做 `drawImage`；内容只在两种情况下重画：

```js
let regen = 1;                                             // 1025：每帧全局重渲染预算 = 1 张卡
if (!s.c || (regen > 0 && rnd() < 0.02)) {                 // 1025-1032
  renderSlot(s); regen--;                                  //   没有缓存 or 抽中 2% 概率 → 重画
}
```

- 平时：~88 张卡只 `drawImage`（每张一次），**每帧最多重渲染 1 张**；
- 事件驱动：`onBeat` 每拍作废 `6*C.dataFlicker` 张、闪烁 `2*C.dataFlicker` 张（313–315）；
- 屏幕外剔除：卡片角度屏幕外 140px 内直接跳过；
- 闪烁：`s.flash > 0.02` 时用 `lighter` 把同一张缓存再叠画一次（`alpha=s.flash`，1036）；
- 渲染完成后 `S.rotate(A)` 把卡片贴到 `(R, -hh/2, band, hh)`——**贴图的一边是径向带宽 `band`、另一边是角向厚度 `hh`**，于是卡片的"透视"来自径向压缩，无需任何 3D 投影。

> **移植要点**：这个模式对 ASTRA 直接可用——每个 slot = 一个"观测卡"（会话/工具/错误），事件发生时只作废对应 slot（而不是像 haloflux 那样随机作废 6 张），每帧仍保留"最多重渲染 1 张"的预算闸门，确保 60fps 下限。

### 5.5 "透视与景深"：全是假的，但有效

| 效果 | 实现手段 | 行号 |
|---|---|---|
| 卡片随环倾斜 | `S.rotate(A)` 后贴到 `(R, -hh/2, band, hh)`，径向被压缩成弧 | 1035 |
| 环"压"在中心上 | 环带阴影径向渐变（evenodd） | 1123–1129 |
| 环自身的纵深 | 三层渲染顺序：`drawOuterFar`(远景) → 网/卡环 → `drawOuterNear`(近景) → 辉光/散景 | 1074–1196 |
| 卡片贴得"近" | 卡片在近景层之前画（1176 晚于 1174 的 near），环缘毫线最亮 | 1176、1054–1057 |
| 卡片"远"的模糊 | 远景 buffer 半分辨率 + `depthBlur`（但卡片不在远景层里，只在远景合成层有 haze/远处光束） | 1160–1167 |

严格说 haloflux **没有真实景深**，它用"**分层 + 明暗 + 遮挡阴影 + 半分辨率远景**"让大脑补出纵深。

### 5.6 内缘/外缘毫线与刻度

- `rimW()`(1018)：`max(3, (RO-R)*0.065*C.rimWidth)`——缘线宽度随环带宽自适应；
- 内缘 R 与外缘 RO 各画一圈"毫线"（hairline）：间距 `0.14/C.rimDensity` 度，每 6 条加长，长度用 `hash()` 确定性抖动（1048–1053）；
- **三遍描边**造辉光：`lighter` 粗 glow（亮度 ∝ `rimBright²`）→ `lighter` 中等 → `source-over` 0.55px 实线（1054–1057）；
- 基准弧：R、RB、RO 四条 `arc`（1059–1062）；
- 刻度：内缘 1° 短刻线、外缘 0.25° 刻度，每 20 条加粗到 9px、每 5 条 5px、其余 2.5px（1063–1069）；`tick(step, fn)`(1040–1043) 只按可见弧段循环，屏幕外不画。

---

## 6 环外 5 层光束

环外区域是"从中心向外辐射的光束群"。它不是粒子，而是**5 层预生成的楔形（wedge）+ 每层几十条径向线**，靠逐帧长度/亮度调制产生"爆发"。

### 6.1 楔形生成（`makeStrandLayer` 517–532）

`buildOuter()`(533–542) 创建 5 层（5 层定义在 536–540），每层调用 `makeStrandLayer(stepDeg, rotK, lumK, lw, lenK, solidK, cover, nMin, nMax, brightP, dyn)`：

- **楔形数量** = `floor(TAU / step)`（step 为弧度步长，注释里叫 `stepDeg`，实际按弧度使用；值 0.12–0.45 rad ≈ 6.9°–25.8°）→ 每层 14–52 个楔形；
- 每楔形预生成：`prof` = `makeProfile(n)` 的随机游走低通剖面（509–516）——所以每条径向线的长度**生来就不齐**；`pf/pp` 呼吸相位、`ds` dash 相位、`flow` 流动量、`kick` 冲量、`len` 当前长度、`i0/n` 在全局线序中的区间；
- `n`（每楔形线数）在 `nMin..nMax` 间随机：远层 20–90 条、近层只有 4–16 条。

### 6.2 5 层参数（`buildOuter` 533–542；5 层定义在 536–540）

| 层 | 生成参数 `(step, rotK, lumK, lw, lenK, solidK, cover, nMin, nMax, brightP, dyn)` | 视觉角色 |
|---|---|---|
| 1 far | `(0.22, 0.45, 0.30, 0.55, 1.15, 0.9, 1.1, 20, 90, 0.2)` | 最淡、最细、最慢；半分辨率远景层里画（景深模糊） |
| 2 mid | `(0.16, 0.75, 0.58, 0.8, 1.05, 0.7, 0.9, 14, 70, 0.28)` | 中景主体，跟环旋转 0.75 倍 |
| 3 main | `(0.12, 1.0, 1.0, 1.0, 1.0, 0.5, 0.75, 12, 60, 0.32)` | 主光束；带 dash 虚线与 tip 端点 |
| 4 near | `(0.45, 1.0, 0.5, 1.8, 0.8, 0.6, 0.35, 4, 16, 0.3)` | 少量、粗、亮：跨在环上方的近景光束 |
| 5 bounce | `(0.12, 1.0, 0.85, 1.0, 1.0, 0.5, 0.55, 14, 70, 0.32, 'bounce')` | **回弹层**：被拍子踢出去后缓慢收回 |

`rotK` 让各层以不同倍率跟随 `ringRot`（多层错动产生纵深感）；`lumK/lenK/solidK` 分别是亮度/长度/实心段比例的层系数。`wedges = strandLayers[2].wedges.concat(strandLayers[4].wedges)`(542)——**只有 main 与 bounce 层的楔形吃 `onBeatOuter` 的 kick**。

### 6.3 每帧更新（`updateOuter` 577–612）

1. 行进波位置推进 `p.c += p.v*dt`；
2. 对每个楔形先算中心角 `am = normA((w.i0 + w.n/2)*step + rot)`，`vis = |am| < thS + 0.2` 才参与计算；
3. 长度目标基值 `p = Σ_kick`？更准确地说：`flow += dt*dsp*(0.45 + 2.2*env)`（流动累积）；行进波贡献 `p += Σ pl.amp*f*exp(-((am - pl.c)/pl.w)²)`（587）——**高斯核**，所以波过处是一条平滑的"驼峰"，不是硬边；
4. 每层按 `dyn` 分两支更新（见 6.4）；
5. 每帧按概率补 haze / flare（`rnd() < 0.06*C.flareRate`，610）；`updateFlyers` 同步更新飞线。

### 6.4 伸展 / 回弹公式

**回弹层（bounce）**（589–592）：

```js
const idle = w.base * (0.36 + 0.14*Math.sin(T*0.9 + w.ph));     // 589：自身呼吸
const tgt  = Math.min(1, idle + p*0.75 + w.kick*0.6);            // 590–591：目标长度
w.len += (tgt - w.len) * Math.min(1, (tgt > w.len ? 15 : 2.2) * dt);  // 592：快出慢回
```

**普通层**（594–598）：`idle = w.base*(0.4 + 0.34*n1 + 0.14*n2)`（双正弦）；`w.len += (tgt-w.len)*min(1, (tgt>len ? 5 : 1.3)*dt)`。两类都是**非对称缓动**：伸出比收回快 2.3–6.8 倍——这是"光束有弹性"的全部秘密。

**当帧实际画出的线段长度**（`drawStrands` 645）：

```js
const l = L * prof[k] * (0.5 + 0.5*Math.sqrt(edge)) * (0.92 + 0.08*Math.sin(T*pf + pp));
```

`edge` 是楔形在可见弧内的边缘权重（越靠边越短），`prof` 是预生成剖面，最后一因子是呼吸。实心段再用 `l * (solidK + 0.3*pr*(1-solidK))` 收一档。**每根线的长度 = 全局包络 × 预生成人格 × 边缘渐隐 × 呼吸 × 实心比例**——五重调制。

### 6.5 绘制批处理（`drawStrands` 628–661）

- 每楔形按 `edge` 分 3 个亮度的 **Path2D 桶**（`EDGE_A = [0.28, 0.62, 1]`，627），每个桶一次 `stroke`；
- `strokeStyle = GR['s' + w.tint]`：`GR` 是 3 套沿半径衰减的径向渐变（`s0` 白 / `s1` 紫 / `s2` 青灰，`mkG` 545）——**一条描边沿半径自动变淡**，省掉逐段算 alpha；
- `globalAlpha = min(1, w.lum*Lr.lumK*(0.3+0.7*min(1,len*1.8))*C.beamBright*(bounce?C.beamBounce:1))`（637）；
- **近景层的 dash/tip 走"扁平数组 + 按 alpha 分档批量 stroke"**：`drawStrands(2/4, collect)` 时把 dash 段压成 `[ca,sa,s0,s1,da]`、tip 压成 `[ca,sa,l,da]`（650–655）；`drawOuterNear` 里按 alpha 分 3 档，各一次 `stroke`（758–767）；tip 用 `fillRect 1.6×1.6`（768–773）；
- 高亮楔形额外叠一遍 `lineWidth*2.5, alpha*0.06*C.beamGlow` 的 glow 笔（659）；
- 径向静态线 `radialLines`(663–670) 用确定性哈希 `hash(x)=sin(x*12.9898)*43758.5453 取小数`（662）抖长度——**帧间稳定，不会闪烁**。

### 6.6 附属粒子：haze / flyers / flares

| 系统 | 生成 | 生命周期 | 绘制 |
|---|---|---|---|
| **haze 雾条** `spawnHaze`(556–563) | 角宽 `rr(0.015,0.18)`、life `rr(0.35,1.6)`、alpha `rr(0.12,0.42)`、3 色 tint、漂移 `±0.04` | `hazeEnv`(622–626)：进入 `min(1,age/0.12)`、退出 `max(0,1-(age-life)/0.6)`、闪烁 `0.85+0.15*sin(age*30)` | 远景层里两层描边：粗 2.2px `alpha*e*0.05*hazeBright` + 细 0.55px `alpha*e*0.6`（735–751） |
| **flyers 飞线** `newFlyer`(676) | 7 条随机角带；`len=20+rnd²*320`、`sp=260–900`、`lw`、`lv`、`tint`、`burst` | `f.r += f.sp*dt*k`，`k=(0.7+0.9*env)*C.flyerSpeed`（700）；burst 飞出即删，普通越界重生（704） | `drawFlyers`(712–734) 按 key `tint*10+lv+(lw>1.15?100:0)+(burst?1000:0)` 分桶一次 stroke；`FLY_A=[0.16,0.36,0.7]` |
| **flares 边缘闪光** `spawnFlare`(564–566) | 角宽 `rr(0.006,0.04)`、长 `18–110`、life `0.2–0.55` | 信封 `t<0.15? t/0.15 : pow(1-(t-0.15)/0.85, 2)`，长度 `len*(0.6+0.4*easeO(min(1,t*3)))` | 细粗双描边（776–783） |

数量：`initFlyers` 的 `min(750, 320+W*0.25)*C.flyerCount`（694）；haze 目标 `C.hazeCount`（默认 8，按可见弧补货）。

---

## 7 自动运镜：7 个镜头与 2 态调度

### 7.1 7 个机位（`buildShots` 321–335）

`P(a,r)` 是"以环心为原点、角度 a、半径 r"的取点函数；`mid = (R+RO)/2` 是环带中部。7 个镜头**按数组顺序循环**：

| # | 机位 | z（推近） | hold（秒） | 语义 |
|---:|---|---:|---:|---|
| 0 | 画面中心 `{W/2,H/2}` | 1 | 4.5 | 全景交代 |
| 1 | `P(-thS*0.45, mid)` 环带左侧 | 2.3 | 3.4 | 推近环带卡片 |
| 2 | `P(0.04, RO+(RMAX-RO)*0.3)` 环外远处 | 1.6 | 3.2 | 看光束远端 |
| 3 | 画面中心 | 1 | 3.0 | 回到全景（让前三个镜头"落地"） |
| 4 | `P(0.22, R*0.8)` 网内偏上 | 1.9 | 3.4 | 钻进中心光场 |
| 5 | `P(thS*0.5, mid+10)` 环带右侧 | 2.8 | 3.0 | 最大推近（观察细节） |
| 6 | `P(-0.12, RO+40)` 环外右 | 1.35 | 3.2 | 松出去看整体 |

机位全部**绑定几何量**（`R/RO/thS`），所以窗口缩放/环带宽变化时构图仍然成立——这是硬编码但**参数化**的镜头语言。

### 7.2 状态机与缓动（`updateCam` 341–360）

- 状态在 `hold` 与 `move` 间切换（`camPhase`）：
  - **hold**：`cam.x = cur.x; cam.y = cur.y + (cur.z > 1 ? sin(k*PI)*6 : 0)`（推近镜头缓慢上下浮动 6px）；`cam.z = zf(cur.z)*(1 + 0.05*k*C.camZoom)`（`k = shotT/hold`，**持续缓慢推近 5%**）——「静止镜头也在呼吸」；
  - **move**：`dur = 2.2s`，`e = easeIO(shotT/dur)`；`x/y` 线性插值，`z` 在**对数空间**插值：
    `z = exp(log(camFrom.z) + (log(zf(next.z)) - log(camFrom.z))*e)`；若起止两端 z 都 >1.2，再乘 `(1 - 0.4*sin(PI*e))` —— **先拉远、再推近**的呼吸；
  - `cam.z = max(1, z)` 防止穿模；`clampCam()`(336–340) 保证相机中心不离开画面有效区。
- `camT(ctx, d)`(362) 应用 `translate + scale(z)`；`camTk(ctx, d, k)`(363–366) 按系数 `k` 插值相机（**视差层专用**）；`toScreen(x,y)`(367) 由世界坐标求屏幕坐标（引线/overlay 用）。

### 7.3 视差：一个系数就是一层纵深

| 层 | 相机系数 | 效果 |
|---|---|---|
| 中心网 | `camTk(S,DPR, 1 - 0.1*parallax)`（1091） | 网只吃 90% 位移 → 更远 |
| 主层（环/光束/彗星） | `camT(S,DPR)` | 基准 |
| 散景 bokeh | `k = 1 + 0.6*parallax`（807）且反向偏移 | 比主层更"近"，位移更大 → 最前景 |
| 远景 | 独立半分辨率 buffer + `depthBlur` | 最远 |

**这是一个 2D 引擎造纵深的完整清单：位置视差（0.9×/1×/1.6×）+ 尺寸降采样（1/2）+ 模糊（depthBlur）+ 明暗（depthDim）+ 遮挡阴影。** 没有一处用到真正的 3D 变换。

### 7.4 镜头调度给我们的启示

haloflux 的镜头是**时间驱动**（每个镜头 hold 3–4.5s 后自动切）。ASTRA 应该改成**注意力驱动**：新 turn 开始 → 全景；tool 密集 → 推近环；审批/错误 → 急停对准对应卡片；子 agent 生成 → 在父卡与新卡之间摇镜头；长时间无事件 → 缓慢拉远回到"呼吸全景"。切换仍复用它的 hold/move + 对数 z 插值 + 呼吸公式。

## 8 后期质感与性能

### 8.1 后期效果一览（8 个独立小效果，不是一条后处理链）

haloflux 没有 WebGL、没有 shader、没有 EffectComposer。"后期"是**在主画布画完之后，按固定顺序叠 4–8 层**，每层都是一个 2D 操作：

| # | 效果 | 实现 | 位置 | 参数 | 每帧成本 |
|---:|---|---|---|---|---|
| 1 | 辉光 glow | 1/3 分辨率收集层 → 上采样 + `blur(6px)` + `lighter` | 1087–1089、1179–1185 | `GS=3`、`alpha=min(1,0.9*C.glow)`、blur 固定 6px | 1 次大 `drawImage` + 1 次 filter 合成 |
| 2 | 景深 DOF | 远景层半分辨率渲染 → `blur(C.depthBlur px)` → `alpha=C.depthDim` 贴回 | 1160–1167 | `FS=0.5`、`depthBlur` 默认 1.4（**MINE 设 0 关掉**）、`depthDim` 0.9 | 1 次半分辨率 `drawImage` + 可选 blur |
| 3 | 网线虚化 webBlur | **重建时**把每层网用 `filter: blur` 叠画（不是每帧） | 442–449 | `webBlur` 默认 0.7 | 0（只在 rebuild 时） |
| 4 | 大气光 atmos | 中心径向渐变雾 | 1169–1173 | `C.atmos` 默认 1 | 1 次全屏渐变填充 |
| 5 | 环带投影 ringShadow | `R-110 → R` 径向渐变，`evenodd` 填环带 | 1123–1129 | `C.ringShadow` 默认 1 | 1 次渐变填充 |
| 6 | 散景 bokeh | 128px 预渲染虚焦光斑精灵，`lighter` + 视差 | 789–818、1187 | `C.bokeh` 默认 16 个、`bokehBright`、`parallax` 1.6× | 16 次 `drawImage` 小图 |
| 7 | 暗角 vignette | canvas 径向渐变压边 | 1188–1193 | `0.75*C.vignette`（MINE = 0） | 1 次全屏渐变 |
| 8 | 扫描线 + CSS 暗角 | `.stage::after` 的 `repeating-linear-gradient` | CSS 45–47 | `scan` 参数切 `body.noscan` | 0（合成器） |

**必须纠正一个常见误判**：全文 grep `shadowBlur` = **0 次**，`chromatic|aberration` = 0 次，`noise|grain` = 0 次。也就是说：

- **没有 `shadowBlur`**——所有辉光都来自"降采样 + 模糊 + 加色混合"，因为 `shadowBlur` 在 Canvas 2D 里是出了名的慢且不可控；
- **没有色差（chromatic aberration）**——画面里的紫/青只是配色，不是通道偏移；
- **没有 canvas 噪点/颗粒**——`filter` 出现 8 次全部是 `blur`，没有 `noise`/`turbulence`（那是 SVG filter 才有的）；
- 扫描线与暗角是 **CSS 层**（`.stage::after`），不是画进 canvas 的，所以它们不占 drawStage 时间。

> ASTRA 如果要"质感"，正确路径是照抄这 4 件：**降采样辉光 + 半分辨率景深 + 预渲染散景 + CSS 扫描线/暗角**，而不是引入 `shadowBlur` 或 WebGL 后处理。

### 8.2 辉光链（glowC）

```
drawStage 内：
glowC = 1/GS 大小离屏 canvas（GS=3，见 196）
... 中途把需要发光的元素以 lighter 画进 glowC（代码里彗星是显式双绘，1131–1154）
... 最后：
S.globalCompositeOperation = 'lighter'
if (HAS_FILTER) S.filter = 'blur(6px)'
S.globalAlpha = Math.min(1, 0.9 * C.glow)
S.drawImage(glowC, 0, 0, glowC.width*GS, glowC.height*GS)   // 1179–1185
```

三步省钱的组合：**1/3 分辨率画光斑（像素数 1/9）→ 一次 6px 模糊（模糊半径与分辨率无关地便宜）→ 上采样放大 3×（浏览器双线性插值自带平滑）**。`HAS_FILTER` 能力检测（198）保证不支持 canvas filter 的环境自动退化成"不模糊、只加色"。`glow` 参数只调最后合成 alpha，不重建任何东西。

### 8.3 景深链（farC）

```js
F.clearRect(...); camT(F, FS); S = F; drawOuterFar(); S = main;   // 1161–1163
if (HAS_FILTER && C.depthBlur > 0) S.filter = `blur(${C.depthBlur}px)`;  // 1165
S.globalAlpha = Math.min(1, C.depthDim); S.drawImage(farC, 0,0, W,H);    // 1166–1167
```

远景层（第 1、2 层光束 + haze + 非 burst 飞线）画在 `W*0.5 × H*0.5` 的 buffer 上，再放大贴回并补一次 1.4px 模糊。**景深=分辨率差 + 模糊 + 降亮**三件事，成本是半分辨率绘制 + 一次贴图。MINE preset 把 `depthBlur` 设 0（只要半分辨率放大自带的柔化），说明作者认为这层默认可以更省。

### 8.4 合成顺序（画完主画布之后的收尾链）

| 步 | 操作 | 目的 |
|---:|---|---|
| 1 | 背景纯色 `#08090b` | 定基调 |
| 2 | 收集发光元素到 glowC | 为第 12 步备料 |
| 3 | 中心网 + runner 拖尾 | 暗部主体 |
| 4 | 环带投影 | 建立"环压住中心"的前后关系 |
| 5 | 彗星 | 内→外的亮事件 |
| 6 | 静态放射线 laneC（lighter） | 背景纹理 |
| 7 | 远景层（半分辨率 + 可选 blur + 降亮） | 纵深 |
| 8 | atmos 雾 | 体积感 |
| 9 | 近景光束 + dash/tip + 飞线 + flares | 前景爆发 |
| 10 | 面板圆环（含卡、毫线、刻度） | 信息主体 |
| 11 | glowC 上采样 + blur + lighter | 统一发光 |
| 12 | bokeh 散景 | 前景虚焦 |
| 13 | 暗角 | 压边 |
| 14 | HTML overlay 引线（drawCallout） | 标注 |

关键规律：**先暗后亮、先远后近、先结构后光效**。辉光放在面板环之后 → 卡片也被"照"亮；暗角放最后 → 压住所有角落。ASTRA 可以直接沿用这个顺序，只换内容。

### 8.5 性能技巧清单（源码级）

| 技巧 | 代码证据 | 收益级别 |
|---|---|---|
| **降采样渲染** | `GS=3` 辉光层、`FS=0.5` 远景层 | 巨大（像素数 1/9、1/4） |
| **预渲染成贴图** | `buildWeb` 烘焙 2600 条曲线；`renderSlot` 烘焙卡片；`mkBokehSprite` 128px 精灵；`buildLanes` 700 条放射线 | 巨大（运行时 O(1) `drawImage`） |
| **Path2D 批处理** | `drawStrands` 每楔形按亮度分 3 桶各一次 stroke（643–658） | 大（native 调用 179 vs 14K lineTo） |
| **扁平数组批量描边** | dash `[ca,sa,s0,s1,da]`、tip `[ca,sa,l,da]`，按 alpha 分 3 档 stroke（650–655、758–767） | 大 |
| **分桶一次 stroke** | flyers 按 `tint*10+lv+(lw>1.15?100:0)+(burst?1000:0)` 分桶（712–734） | 大 |
| **屏幕外剔除** | slot 屏外 140px 跳过（1029）；strand 可见弧判定 `vis = abs(am) < thS+0.2`（583）；tick 只画可见弧（1040–1043） | 中 |
| **数量公式随分辨率** | 网线 `min(2600,1000+W*H/800)`；flyers `min(750,320+W*0.25)` | 中（大屏不爆） |
| **对象池/数组复用** | runners 按 count 截断/补（390）；comets/pulses 用 splice 回收；flyers 越界重生（704） | 中（免 GC 峰值） |
| **DPR 上限** | `Math.min(devicePixelRatio, 2)`（171，1438 再 clamp）；mobile 1.75 | **巨大**（见 8.6） |
| **能力检测** | `HAS_FILTER = 'filter' in S`（198），不支持时跳过模糊 | 兼容性 |
| **rebuild 分组** | `ringWidth→resize`、`rimWidth→slots`、`webBright/webBlur→web`、`flyerCount→flyers`；debounce 250ms（1467–1481） | 中（调参不卡） |
| **dt 上限** | `dt = Math.min(0.05, ...)`（1428） | 防切后台回来爆帧 |
| **resize debounce** | ResizeObserver + 120ms 定时（1443） | 防拖窗口时重建成灾 |
| **暂停即停算** | 壁纸版 `if(window.__wpPaused) return`（1441–1444） | 省电 |

### 8.6 实测数据（headless Chrome，必须带免责声明）

**环境与方法**：Chrome 156 headless（`--headless=new`），1600×900 窗口，iframe 加载 `lab.html`（舞台实际 1600×503），强制 DPR=1 或 2；patch `CanvasRenderingContext2D.prototype` 的 15 个方法按 canvas 归属计数，patch `drawStage` 计时，采样 660 个 rAF 间隔取稳态。**这是软件光栅（SwiftShader），不是真 GPU**，绝对值不能代表用户桌面，但**相对结论**（DPR 影响、JS 占比、调用数）有效。

| Run | DPR | canvas 缓冲 | `drawStage` JS（mean/p95） | rAF 间隔（mean/p50） | 折算 fps |
|---|---:|---|---:|---:|---:|
| A | 1 | 1600×503 | 7.86 / 11.4 ms | 22.86 / 24.2 ms | 43.7 |
| B | 2 | 3200×1005 | 10.38 / 14.0 ms | **50.49** / 48.5 ms | **19.8** |
| C | 1（窗口 1920） | 1600×503 | 10.72 / 14.3 ms | 29.27 / 27.5 ms | 34.2 |
| D | 1（归因） | 1600×503 | 10.71 / 14.3 ms | 23.11 / 24.2 ms | 43.3 |

**读法**：
1. **DPR 从 1→2，帧间隔 22.9→50.5ms（2.2×）**，而 JS 只从 7.9→10.4ms（+32%）——差额全在光栅化/合成填充率。**60fps 的第一约束是像素数，不是 JS 代码量**；
2. JS 侧 `drawStage` 7.9–10.7ms 已占 60fps 预算（16.7ms）的一半以上，剩下 6–9ms 留给其它 5 个 canvas 面板 + 浏览器合成；
3. headless 下 43fps 不代表桌面 Chrome 不行：同一台机器带 GPU 合成时，这些填充是 GPU 做的；但**在 4K/高 DPR 屏上会重演 DPR=2 的 2.2× 惩罚**，所以 DPR clamp 是必需项。

**每帧 native 调用归因**（Run D，全 document）：

| canvas | lineTo | moveTo | stroke | fillRect | beginPath | drawImage | fillText |
|---|---:|---:|---:|---:|---:|---:|---:|
| `#stage`（主画布） | 13,944 | 5,377 | 179 | 173 | 86 | 22 | 0 |
| `(offscreen)`（trailC + 卡重渲染等） | 5,145 | 4,468 | **1,022** | 147 | 886 | — | 12 |
| `#cAdv`（粒子流场） | 320 | 320 | 1 | 271 | 1 | — | 0 |
| `#cDiff`（差分网格） | 0 | 0 | 0 | 600 | 0 | — | 2 |
| `#cVal`（折线） | 463 | 7 | 7 | 0 | 7 | — | 3 |
| `#cIdx`（索引热力） | 0 | 0 | 0 | 308 | 0 | — | 22 |

结论：主画布把 **~1.4 万条线段压成 179 次 stroke**（Path2D 批处理），真正的热点是**离屏层 1,022 次 stroke**——主要是每帧 1 张 `renderSlot` 卡片重渲染（`RING_SC=2.4` 下每张卡 ~37 条线 + 文字 + 毫线）。**这直接告诉我们：如果要做 N 张卡的数据面板，卡的重渲染频率就是第一优化对象。**

### 8.7 60fps 的预算表（给 ASTRA 的推算）

| 项 | haloflux 实测/代码值 | ASTRA 建议上限 |
|---|---|---|
| 单帧 JS（drawStage 级） | 7.9–10.7ms（软件光栅） | ≤ 6ms（目标 DPR=1） |
| 主画布 lineTo 数 | ~1.4 万 | ≤ 6 千 |
| 每帧 stroke（全部 canvas） | ~1,200 | ≤ 400 |
| 每帧 `filter:blur` 合成 | 1 大 + 1 远景（可选） | ≤ 1 |
| 每帧 `drawImage` 大图 | 1（glow）+ 1（far）+ 22 小图 | ≤ 8 |
| 卡片重渲染 | ≤ 1/帧、2% 概率 | ≤ 1/帧（事件作废优先） |
| DPR | min(2, dpr) | min(1.5, dpr) 或固定 1 |
| 粒子（含飞线/haze） | ~750 建、~17% 可见 | ≤ 400 |

---

## 9 壁纸版 vs 实验版（三个变体）

同一个引擎被切成 3 份交付：

| 变体 | 文件 | 行数 | 定位 |
|---|---|---:|---|
| 主实验版 | `lab.html` | 1,710 | 带控制台的可调实验室（作者自用） |
| 移动版 | `mobile.html` | 1,757 | 竖屏旋转 + 降量 + 底部抽屉控制台 |
| 壁纸版 | `wallpaper_index.html` + `wallpaper_wp.js` | 1,631 + 122 | Wallpaper Engine 壁纸：无交互、由 Wallpaper Engine 宿主控制 |
| 入口 | `index.html` | 27 | UA 嗅探跳转：`location.replace((touch ? 'mobile.html' : 'lab.html') + location.search)`（行 21–23） |

**三份的函数集合几乎完全一致**（node 静态扫描：lab 78 个函数、mobile 79、wallpaper 78，仅 mobile 多 `setXf`），差异全部是"入口/控制层/降量"的删改——**这本身就是一个架构优点：渲染核心是单文件、零依赖、易裁剪**。

### 9.1 实验版 → 壁纸版删了什么

| 项 | lab.html | wallpaper_index.html |
|---|---|---|
| 控制台面板 | `#cpanel` DOM 动态生成（1492–1534） | **整段删除**；HTML 只剩 header + stage + 8 个 panels（135–163） |
| BGM 控制条 | `#bgm` 音乐开关 + 音量滑杆 + `#bgmAudio[data-src="audio/sw421k.mp3"]` | UI 删掉，BGM 引擎保留，UI 对象换成 noop 桩（1520–1525），暴露 `window.__bgm={set,setVol,kick,isOn}`（1620–1626） |
| 状态浮层 | `#chk` STABILITY CHECK + `.ov.status` 大字 | 保留 stage 内 overlay（壁纸也要显示） |
| 字体 | Google Fonts 加载 JetBrains Mono | 删外链，改系统 `ui-monospace`（26、171）——壁纸环境不一定有网 |
| 暂停机制 | 无 | `frame()` 包装加 `if (window.__wpPaused) { last = now; rAF(frame); return; }`（1441–1444） |
| preset 兜底 | `loadPreset` 查 `PRESETS[name]` | 改成 `PRESETS[name]` 兜底 `BASE`，并遍历 BASE 全量下发（1484–1491）——宿主传来的属性可能不完整 |
| 初始化 | 完整注册面板、同步控制台 | 删 `syncPanel()` 与 console 初始化，注释"wallpaper: 无面板"（1502–1510） |
| 尾部脚本 | 无 | `<script src="wp.js"></script>`（1629） |
| localStorage | `paperlab.cfg.v2` | 仍是 `paperlab.cfg.v2`（1459）——壁纸版**不隔离**配置 |

### 9.2 `wallpaper_wp.js`：宿主桥（122 行）

Wallpaper Engine 通过 `wallpaperPropertyListener` 注入用户属性，wp.js 做三件事：

1. **属性 → 引擎参数**（80–96）：`preset / tempo / glow / ringspeed / beamglow / camera / camzoom / showui / scanlines / music / volume` 共 11 个映射到 `loadPreset` + `setParam(...)`；
2. **UI 显示/隐藏**（51–68）：`applyUI` 关闭 UI 时**不能用 `display:none`**——面板里小画布的尺寸会归零，而绘制循环仍然跑，会卡死/报错。它改用 `position:absolute; visibility:hidden; pointer-events:none` + `gridTemplateRows='minmax(0,1fr)'`，并在 rAF + 30ms + 220ms 三次时机调 `resizeAll()`（因为布局变化后 canvas 尺寸要重新量）；
3. **暂停/静音**（97–108）：`setPaused` 写 `window.__wpPaused` 并暂停音乐；`setAudioMuted` 调 `__bgm`。

默认值 `DEFAULTS`（18–30）：`preset:'MINE', tempo:0.6, glow:1.1, ringSpeed:0.6, beamGlow:2.6, camera:true, camZoom:1, showui:true, scanlines:true, music:true, volume:55`——**壁纸版默认把 tempo 压到 0.6、ringSpeed 0.6（更慢更安静），beamGlow 提到 2.6（更亮）**，这是"壁纸"场景的产品级调参：**慢、亮、低干扰**。

### 9.3 移动版差异（一句话版）

- 竖屏时整场景旋转 -90° 绘制（`setXf` 用矩阵 `setTransform(0,-d*z, d*z,0, ty, SH*d-tx)`），因为环+放射线是横向构图；
- `DPR` clamp 1.75（比桌面 2 低）；
- `MOBILE_K = { runnerCount:0.5, flyerCount:0.55, burstSize:0.75, bokeh:0.6 }` 对所有 preset 统一降量；
- CSS 换成横滑 panels + bottom sheet 控制台 + safe-area；localStorage key 换成 `paperlab.mobile.cfg.v2`。

### 9.4 三个变体教给 ASTRA 的

1. **核心引擎单文件零依赖**，输入输出只有"参数 + 画布尺寸"，可以同时喂给 Web 应用、壁纸、嵌入 iframe；
2. **控制面与渲染面分离**：lab 的控制台、壁纸的宿主属性、移动版的抽屉，都只是往同一个 `setParam/loadPreset` 写；
3. **最贵的降量开关是数量和 DPR**，不是代码路径——`MOBILE_K` 一行就砍掉一半成本；
4. **容器尺寸会变**：canvas 面板必须用 `getBoundingClientRect` 实际尺寸（`fit()` 180–186）+ ResizeObserver，否则 CSS 隐藏/布局切换就出 bug（wp.js 的教训）。

## 10 可移植设计模式清单（本报告的目的地）

### 10.1 总映射表：产品功能点 → haloflux 实现 → 我们的数据驱动版

| # | ASTRA 产品功能点 | haloflux 里的对应机制（源码证据） | ASTRA 的数据驱动实现 | 由哪类事件驱动 |
|---:|---|---|---|---|
| 1 | **活跃 agent 的实时状态** | 环上卡片 = 预渲染的"假数据面板"，随机内容块（`renderSlot` 986–1017，`BLOCKS` 882–974） | 每个 slot = 一个 DSH 会话/agent 的观测卡；卡内容由真实状态聚合渲染（不是随机抽块） | `turn/start`、`step/end`、`tool/call` 更新对应卡；每帧最多重渲染 1 张 |
| 2 | **token 流速率** | `runners` 沿贝塞尔网流 + `trailC` 拖尾（455–466、1103–1121） | 每条 runner = 一个 token 通道（per session/turn）；`t` 推进速度 = 实时 token/s；拍上突发 = 批量 token | `token 增量`（按 100–250ms 聚合后换算速度） |
| 3 | **step 节拍/节奏** | `PATTERN` + `updateBeat` + `env` 指数包络（292–298） | **把"时钟节拍"换成"事件节拍"**：每次 `step/start` 或 `step/end` 触发一次 `beat`，`env=exp(-sinceEvent*4.5)`；事件间隔极短时用 PATTERN 做"细分拍"；空闲时进入慢速 idle 时钟 | `step/start`、`step/end`、`turn/start`、`turn/end` |
| 4 | **单调感消除（"没有东西匀速"）** | 8 条公式：runner 三 mode（455–465、1111）、web pulse（1098）、彗星 easeIO（1137）、光束双正弦（594–598）、环三档状态机（824–831）、flyers env（700）、环漂移（839）、相机 creep（348） | 保留 8 条公式，但每个随机源换成**不同事件类别的实时统计**：token/s 驱动 surge、tool 频率驱动 kick、错误率驱动 flare、上下文压力驱动亮度 | 各信号独立采样，禁止共享一个"总强度" |
| 5 | **tool/call 事件连线** | 彗星从中心飞向环上卡片，命中 `flashSlotAt`（469–498、1131–1154、832–836） | `tool/call` 时从"当前 agent 所在的中心节点"向"该工具的观测卡"发射彗星，命中时卡片闪 | `tool/call`（start）；`tool result/错误` 时反向闪或变红 |
| 6 | **上下文压力** | `gauge`/`prog`/`bars` 三种块（882–974） | 一个主 gauge（环形/弧）+ 历史 sparkline；压力 >80% 时卡片描边转暖色、并触发 `flareRate` | `上下文压力` 采样（每 step 或每 N 秒） |
| 7 | **todos 变化** | `prog` 12 段进度格 + 百分比（BLOCKS） | 一张 checklist 卡片：每项一行；完成项用 `bars` 式横条点亮，新增项时卡上触发一次 `flash` | `todos 变化`（diff 后只重渲染这张卡） |
| 8 | **审批/错误需要被看见** | `flare`（564–566、776–783）、`flashSlotAt`、`haze` 高亮 | 审批 = 环上对应卡**急停对准**（`ringMove` 的急停档 824–831）+ 持续呼吸描边；错误 = 红色 flare + 相机短促推近 + 该卡 `flash`（来源：haloflux 的 `flashSlotAt`） | `审批请求`、`错误`（优先级最高，可打断当前相机 hold） |
| 9 | **子 agent 生成关系** | 网线（2600 条贝塞尔）+ 节点标记 + 点状环链（409–440）；彗星"汇聚束"形状（469–489） | 父卡 → 子卡之间画一条**持续存在**的细线（静态网层的子集，只有拓扑变化时重建）；子 agent 生成时发射一次"汇聚束"彗星 | `子 agent 生成`、`子 agent 结束` |
| 10 | **turn 起止的时间结构** | 相机 7 镜头 + hold/move 状态机（321–360） | `turn/start` → 切到全景镜头 + 节拍重置；tool 密集期 → 推近环；`turn/end` → 拉远、彗星/飞线逐渐收束；空闲 >30s → 最慢的呼吸全景 | `turn/start`、`turn/end`、idle 计时器 |
| 11 | **多 agent 空间布局** | 5 层光束（far/mid/main/near/bounce，533–542；层定义 536–540）+ 视差层（1091、807） | 层 = 重要级：当前活动 turn 在主层；其它会话在 mid/far 层；历史/结束的在远景层（模糊+降亮）；bokeh 只做装饰不放信息 | session 活跃度（最近事件时间 + 当前 turn 状态） |
| 12 | **全局 KPI/总览** | 顶部 KPI（`#k0`–`#k4`）+ HTML overlay + 引线（`drawCallout` 1203–1221） | 顶部 5 个 KPI 换：活跃会话数 / 今日 token / 工具调用数 / 错误数 / 上下文压力峰值；引线标注当前最值得注意的卡 | 每 1–2s 聚合计时器（`kpiTick` 模式 1227–1232） |
| 13 | **后台/无活动时的生命感** | `drawAdv` 320 粒子流场（1331–1345）、bokeh、haze | 空闲时用低成本的"呼吸"层（haze + bokeh + kpi 微动画），不要 320 粒子全速跑；有事件时再提高活动层 | 无事件 N 秒 → idle 模式 |
| 14 | **暂停/隐藏省电** | 壁纸版 `__wpPaused`（1441–1444）、`dt=min(0.05,…)`（1428）、visibilitychange 暂停 BGM | DSH GUI 切后台/隐藏时停 rAF 或降频；恢复时重置 `last`，避免 dt 尖峰 | 浏览器 `visibilitychange` / GUI 窗口事件 |

### 10.2 数据信号 → 视觉通道契约（"每个机制由哪类事件驱动"）

| DSH 信号 | 语义 | 主通道（复用 haloflux 的哪个机制） | 副通道 | 强度/公式来源 |
|---|---|---|---|---|
| `step/start` | 一次模型步开始 | **节拍**：`beatN++`、`env=1`（替代 292–298 的定时器） | 当前 turn 卡片闪光 | `env=exp(-sinceStep*4.5)` |
| `step/end` | 一次模型步结束 | 环上"当前卡"重渲染（缓存作废 1 张）；token 结算 | 相机 hold 相轻微推近 | 复用 `regen=1` 预算（1025） |
| `tool/call` | 工具调用开始 | **彗星**：中心 → 工具卡（469–498） | 光束 kick（`onBeatOuter` 613–621） | 彗星数 = 1（大量并发时合并为"扇束"） |
| `tool/result` | 工具返回 | 命中卡 `flash`（`flashSlotAt` 832–836）；耗时时长 → 彗星尾长 | 若错误 → flare | 复用 `win=rr(0.22,0.4)` 的窗口逻辑 |
| `token 增量` | 流式 token | **runner 速度**：`t += dt * rate`（1111）；trail 擦除随量变化 | 该会话的 web 层 alpha 提升 | `rate = tokens/s`；`surge=0.5+2.5*env` 仅用于突发 |
| `上下文压力` | 上下文占比 | 主 gauge + 环带颜色/亮度 | `atmos`/`beamBright` 微调 | pressure 0–1 直接映射 alpha |
| `turn/start` | turn 开始 | 相机切全景（shot[0]，321–335）；节拍重置 | 该 agent 进入主层 | hold 4.5s 改为"直到首个 tool/call" |
| `turn/end` | turn 结束 | 相机拉远；彗星/飞线逐步收割 | 卡片转为"完成"样式 | 复用 `easeIO` 过渡 |
| `审批请求` | 需要人介入 | **急停对准**：`ringMove` 急停档（824–831）+ 卡片呼吸边 | 顶部 KPI 高亮 | easeOX=1-2^(-10t) 的"秒停"观感 |
| `错误` | 失败 | flare（564–566、776–783）+ 红色 tint | 短暂推近（`z` +0.3） | flare 生命周期 `len*(0.6+0.4*easeO)` |
| `子 agent 生成` | spawn | 父子卡连线（网层子集）+ 汇聚束彗星 | 父卡 flash | 线只在拓扑变化时重建 |
| `todos 变化` | 任务清单 | 清单卡 diff 重渲染（只重画变化行） | 完成瞬间 `flash` | `prog`/`bars` 块复用 |
| `idle`（无事件） | 空闲 | 慢速节拍（`tempo` 降到 0.4–0.6）+ 相机呼吸 | haze/bokeh 存活 | 复用 MINE 的慢速参数（BEAT 默认慢） |

> 关键设计决策：**不要把 haloflux 的定时节拍照搬**。它的 `PATTERN` 是"看起来随机"的视觉节奏；ASTRA 的真实数据本身就有天然节奏（step 间隔 = 模型推理步长，几十 ms 到几秒不等）。正确做法是**用事件间隔作为拍长**，`PATTERN` 只在同一事件内做细分（比如一个长 turn 内部用 0.25× 倍率再切三次），这样"节拍"就同时是信息。

### 10.3 明确**不要**模仿的部分（"皮"清单）

| 不要 | 为什么 | 对应 haloflux 证据 |
|---|---|---|
| 紫/青霓虹色板、60% 亮紫 + 青色高光、"合成波"渐变 | 我们要求视觉完全自研，且深色霓虹在信息密度高时会糊 | `TINTS`（852）、`GR['s1']` 紫渐变（545–552）、`.stage::after` 的暗角 |
| 伪造数据文本（假代码行、假 token、伪文字段） | ASTRA 展示真实 agent 数据，任何"假文本"都会误导 | `TOK` 池（286–289）、`code`/`para` 块（882–974）、`feedPush` 假条目 |
| 伪造 KPI 名称（PAPERS / METHODS / REF. SCENES…） | 术语必须来自 DSH 真实概念 | HTML 129–164 的 KPI 标签 |
| "观测站/控制台"装饰框（四角括号、乱码标题、`◱ CONSOLE`） | 换成我们自己的信息层级与标注系统 | `header()` 876–881、overlay 文案 |
| 扫描线作为主视觉特征 | 可选的低强度叠加可以留，但不能当风格标签 | CSS 45–47 |
| 大量"无意义粒子"当背景 | 我们的算力预算要留给真实数据 | `drawAdv` 320 粒子（1331–1345）、`flyers` 750（694） |

**保留的机制而非外观**：不均匀时钟、事件包络、缓存 + 重渲染预算、Path2D 批处理、降采样后期、注意力相机、分层视差、单文件零依赖、几何参数化（所有尺寸由 `R/RO/W/H` 推导，不写死像素）。

### 10.4 ASTRA 的建议架构（从 haloflux 的单文件结构反推）

haloflux 是"**单文件、零依赖、渲染核心 + 控制台 + 假数据**"三合一。我们要把它拆成 4 层，只保留渲染核心的形态：

```
astra/
├─ index.html          # 一个全屏 canvas + 顶部 KPI + 少量 HTML overlay
├─ astra.js            # 渲染核心（单文件零依赖，≈ lab.html 的 script）
│   ├─ config.js?      # 也可以内联：视觉参数对象（对应 C / BASE / PRESETS）
│   ├─ layers/         # 逻辑分层，不是文件分层：
│   │   ├─ beat        # 事件驱动的包络时钟（替代 updateBeat）
│   │   ├─ stage       # 中心流场（token 流 + 会话网）
│   │   ├─ ring        # 观测卡圆环（缓存 + 事件作废）
│   │   ├─ beams       # 活动度光束（5 层 → 建议 3 层）
│   │   ├─ camera      # 注意力调度（替代 7 镜头时间调度）
│   │   └─ post        # 辉光/景深/暗角/扫描线（4 件）
│   └─ panels          # 侧面板（可后置，非首版必须）
├─ data/
│   └─ adapter.js      # DSH 事件 → 内部事件总线（haloflux 完全没有这一层）
└─ styles.css          # 扫描线/暗角/布局（CSS 层，不占 canvas 预算）
```

数据流：`DSH events → adapter 归一化 → Store（会话/工具/错误/todos 状态）→ beat + 视觉映射 → renderer 每帧读 Store`。**Store 是新增的关键层**——haloflux 的假数据是"每帧随机"，我们必须是"事件更新 Store、帧内只读"，否则无法保证视觉与真实状态一致。

### 10.5 移植优先级

| 优先级 | 模块 | 理由 | 对应 haloflux 证据 |
|---|---|---|---|
| **P0** | 事件节拍 + 包络 | 没有它就没有"活着"的感觉 | 292–316 |
| **P0** | 环带缓存 + 每帧重渲染预算 | 卡多必卡；这是他们最成熟的做法 | 1019–1032 |
| **P0** | Path2D / 扁平数组批处理 | native 调用 179 vs 14K lineTo | 628–670、712–734 |
| **P0** | DPR clamp + `dt` clamp + ResizeObserver debounce | 稳定性底线 | 171/1428/1443 |
| **P0** | 单文件零依赖渲染核心 | 可嵌入任意宿主（含 DSH GUI） | lab.html 本身 |
| **P1** | 注意力相机 | 比 haloflux 的定时镜头更适合真实数据 | 321–360 |
| **P1** | 彗星连线（tool/call） | 信息价值最高的事件可视化 | 469–498、1131–1154 |
| **P1** | 环三段状态机（快旋/急停/轻推/漂移） | 轮播的自然感 | 824–840 |
| **P1** | 降采样辉光 | 质感的核心，成本可控 | 1179–1185 |
| **P2** | 视差/散景/景深 | 锦上添花，先保 60fps | 1091、807、1160–1167 |
| **P2** | flyers/haze 粒子 | 需要预算，首版可省 | 674–785 |
| **P2** | 侧面板 4 个小画布 | 信息冗长，先做核心 | 1223–1422 |
| **P2** | 壁纸/暂停模式 | 有嵌入需求时再做 | 1441–1444、wp.js |

---

## 11 纯 Canvas 2D 在本机（Windows/Chrome）跑 60fps 的硬约束清单

目标：**60fps（16.7ms/帧）**，纯 Canvas 2D、零依赖、单页；宿主可能是 Chrome 或 DSH 的 GUI 外壳（Electron/嵌入 WebView）。以下是"踩了就掉帧"的硬约束，每条都尽量给 haloflux 的源码/实测证据。

### 11.1 硬约束表

| # | 约束 | 硬数值 / 做法 | 证据（haloflux） | ASTRA 建议 |
|---:|---|---|---|---|
| 1 | **像素总数是第一成本** | 单画布 backing store ≤ ~2.5M px；DPR 上限 2（桌面）/1.75（移动） | 实测 DPR 1→2：帧间隔 22.9→50.5ms（2.2×），JS 只 +32% | 固定 `backingScale = min(devicePixelRatio, 1.5)`；4K 屏优先降分辨率再放大 |
| 2 | **全屏 `filter: blur` 每次都是一次额外 pass** | 每帧 ≤ 2 次；只在**小尺寸/降采样**画布上做 | 辉光 `blur(6px)` 在 1/3 尺寸图上（1181–1183）；远景 `blur(depthBlur)` 在 1/2 尺寸图上（1165） | 辉光链照抄；其他效果不要用 blur 代替渐变 |
| 3 | **禁用 `shadowBlur`** | 0 使用 | 全文 grep `shadowBlur` = 0 次 | 需要"发光"就降采样 + blur + lighter，或预渲染光斑贴图 |
| 4 | **每帧 stroke 数要压到几百** | ≤ 400；每 stroke 里塞尽量多线段 | 实测全 doc ~1,200 stroke（其中 stage 仅 179、离屏 1,022） | 用 Path2D 分桶、把同 alpha 的线段合并 |
| 5 | **每帧 lineTo/moveTo 控制量级** | ≤ 6K lineTo（我们目标）；haloflux 实测 stage 13.9K | Run D 归因表 | 我方内容量小，但要限制粒子/网格分辨率 |
| 6 | **每帧大图 `drawImage` ≤ 8 次** | 每次全屏 drawImage ≈ 一次填充率成本 | stage 22 次 drawImage（含小图），全屏级 2 次（glow、far） | glow 1 次 + 背景/静态层用 1–2 次，其它用贴图 |
| 7 | **离屏 canvas 数量 ≤ 8** | 每个离屏都有内存与切换成本 | haloflux：glowC/farC/webBase/3×webLayers/trailC/laneC/约 88 张 slot canvas/bokeh/4 面板 | 卡片改用**单张 atlas**（一张大图 + 每帧按 UV 贴），别 per-card canvas |
| 8 | **小字不要每帧重画** | 文本预渲染；每帧 fillText 总量 ≤ 100 | `renderSlot` 每帧最多重渲染 1 张（1025）；面板文字各自节流 | 卡内容只在数据变化时重画；数字用等宽位图数字 |
| 9 | **`lighter` 叠加次数有限** | 大图级 lighter ≤ 4 次/帧 | 辉光 1、laneC 1、彗星/光束若干 | 合并静态发光层，减少中途合成 |
| 10 | **背景粒子 ≤ 400 可见** | 建 750、可见 17% 是 haloflux 的预算；我们首版 ≤ 200 | `initFlyers` 694、`vis` 剔除 583 | 无事件时降到几十个 |
| 11 | **避免每帧分配对象/数组** | 用预分配池 + 索引复用；`splice` 只用于少量回收 | runners 数组复用（390）、comets/pulses splice | 事件对象用 ring buffer；渲染循环零 new |
| 12 | **`dt` 必须 clamp** | `dt = min(0.05, Δ)`（16.7ms 帧时长也要兼容 30/144Hz） | 1428 | 同上；相机/节拍全部用 dt 驱动，不用帧数 |
| 13 | **隐藏/后台必须暂停** | `visibilitychange` 或宿主 `__paused`；恢复时 `last = now` | 壁纸版 1441–1444、BGM visibilitychange | DSH GUI 切 tab 场景必须有 |
| 14 | **尺寸变化要 debounce 重算** | ResizeObserver + ~120ms；尺寸 < 20px 视为未就绪 | 1443、1436–1439 | 同上；注意 `display:none` 会让尺寸归零，用 `visibility` |
| 15 | **字体加载完再量文本** | `document.fonts.ready.then(resizeAll)` | 1444 | 或用位图字体，避免 webfont 抖动 |
| 16 | **CSS 做装饰层** | 扫描线/暗角/边框走 CSS，不占 canvas | CSS 45–47 | 保留 |
| 17 | **几何全参数化** | 所有半径/角度由 `R/RO/W/H` 推导，不写死像素 | `resizeStage` 375–393 | 窗口/缩放自适应 |
| 18 | **每帧新增视觉元素限流** | 同一帧最多 3–5 个新彗星/闪光，超出合并 | `onBeat` 的 `n` 与 `setTimeout` 错峰（303–306） | 事件突发时合并成"扇束" |
| 19 | **测量方式** | Chrome DevTools Performance / `PerformanceObserver('longtask')` / rAF 间隔直方图 | 本报告 Run A–D 的方法 | 上线前在目标机跑一次 rAF 采样 |
| 20 | **多 canvas 的 DPR 一致性** | 每个 DOM canvas 都要 `fit()` 按 rect 重设；面板容器高度固定（如 150px） | `fit()` 180–186、`.p{height:150px}`（CSS） | 侧面板可后置，先单画布 |

### 11.2 验收清单（可执行）

1. **rAF 采样**：连续 600 帧，`p95 帧间隔 ≤ 20ms`、`max ≤ 50ms`（软件光栅下允许 30fps 但必须稳定）；
2. **JS 预算**：`drawStage` 级 ≤ 6ms（DPR=1、1600×900 视野）；
3. **native 调用**：单帧 `stroke+fill+fillRect+drawImage` 合计 ≤ 1,500（DevTools → Rendering → Paint flashing / Performance 面板）；
4. **内存**：10 分钟运行，`performance.memory.usedJSHeapSize` 无持续增长（事件/粒子对象池不泄漏）；
5. **高频事件压测**：模拟 50 events/s 持续 30s，帧率不低于稳态 85%；
6. **切后台恢复**：隐藏 10s 再回来，无 dt 尖峰（不出现 1–2 秒的黑屏/糊帧）。

### 11.3 已知失败模式（haloflux 代码里能学到的坑）

| 坑 | 现象 | 来源 | 规避 |
|---|---|---|---|
| `display:none` 隐藏画布容器 | 面板 canvas 尺寸归零 → 绘制循环卡死/报错 | wp.js 51–68 明确注释 | 用 `visibility:hidden` + 保持布局尺寸 |
| 字体未就绪就测量 | 首帧字宽/行高错位 | 1444 | `fonts.ready` 后再初始化 |
| resize 不 debounce | 拖窗口时重建网/卡，帧率断崖 | 1443 | 120ms debounce |
| 切后台回来 dt 巨大 | 一帧跑几秒的模拟，画面跳跃 | 1428 | `dt` clamp + `last=now` |
| 不支持 canvas `filter` | 辉光变硬边 | `HAS_FILTER` 198 | 能力检测降级 |
| DPR=2 直接跑 | 帧间隔 2×+ | Run B | clamp / 自适应降分辨率 |
| 每帧随机重渲染卡片 | 上百次 stroke/帧 | `renderSlot` 的 2% 概率 + `regen=1` 预算 | 事件驱动作废 + 每帧预算 |
| 每帧 `new` 粒子对象 | GC 抖动、偶发掉帧 | flyers 越界重生（704）已尽量复用 | 对象池 |
| 全屏 `filter` 变化 | 整个图层重建 | 辉光每帧 blur 6px（该 blur 作用在 1/3 尺寸，成本可接受） | 不在全尺寸画布上做每帧 filter |

## 12 附录

### 12.1 值得直接借鉴的 10 个函数/技巧

| # | 函数 / 技巧 | 行号 | 做什么 | 为什么值得抄 | 移植时改什么 |
|---:|---|---|---|---|---|
| 1 | **`drawStage` 阶段编排** | 1074–1196 | 一个函数里按固定顺序完成 15 个阶段：更新 → 背景 → 发光收集 → 主层 → 遮挡 → 事件 → 远景 → 大气 → 近景 → 环 → 辉光合成 → 散景 → 暗角 → overlay | **整条管线的顺序本身就是架构**；照着改内容比重新设计管线快得多 | 换成我们的层列表；保留"先暗后亮、先远后近、先结构后光效" |
| 2 | **`updateBeat` + `onBeat` 事件包络** | 292–316 | 拍长 = `PATTERN[i] * 0.92 / tempo`；`env = exp(-sinceBeat*4.5)`；每拍集中派发 5 类副作用（环换挡、彗星、层包络、行进波、卡刷新） | 一个标量 `env` 驱动全部"呼吸/突发"；事件集中派发，逻辑清晰 | 拍长改由事件间隔决定；`onBeat` 换成事件总线 handler |
| 3 | **`drawRing` 重渲染预算** | 1019–1032 | `regen = 1`；`!s.c` 或 `rnd() < 0.02` 才重画 1 张；屏外 140px 跳过；平时只 `drawImage` | 面向"几十张会变的面板"最实用的 60fps 技巧，几乎没有之一 | 把"随机 2%"改成"该 slot 数据变了才作废"，预算仍是 1 张/帧 |
| 4 | **`renderSlot` + `pickBlock` 卡片容器** | 978–1017 | 卡片 = 离屏 canvas，按高度选内容块，绘制后缩放贴到环上；内容块 12 种共享同一套"区块 + 头 + 刻度 + 点阵"装饰 | 卡片尺寸/内容自适应 + 预渲染，两件事一次解决 | 内容块换成真实数据渲染器（gauge/spark/progress/list） |
| 5 | **`drawStrands` Path2D 分桶** | 628–661 | 每楔形按边缘亮度分 3 个 Path2D 桶，每桶一次 `stroke`；用 `GR['s'+tint]` 径向渐变描边自动衰减；高亮楔形再叠 glow 笔 | 把"几千条线段"压成"每楔形 3 次调用"；径向渐变描边是 2D 造光的便宜办法 | 层数减到 3；数据结构原样可用 |
| 6 | **`drawFlyers` 按 key 分桶** | 712–734 | key = `tint*10 + lv + (lw>1.15?100:0) + (burst?1000:0)`，同 key 的飞线合并成一条路径一次 stroke | 把"几百个粒子"压成十几次调用，且保留颜色/宽度/状态差异 | 直接用；可以再加"按 alpha 档"分桶 |
| 7 | **`updateCam` 相机状态机** | 341–360 | hold 相缓慢推近 5% + 上下浮动 6px；move 相 2.2s `easeIO`、z 在**对数空间**插值、两端都 >1.2 时 `1-0.4*sin(PI*e)` 呼吸；`cam.z=max(1,z)` 防穿模 | "镜头感"= 缓动 + 对数 z + 呼吸；公式短、可复制 | 调度从"定时切换"改成"注意力事件触发" |
| 8 | **`ringMove` + `updateRing` 三档状态机** | 824–840 | 22% 快旋 / 42% 急停（`easeOX = 1-2^(-10t)`）/ 36% 轻推，8% 反向半幅；空档 `hold` 随机；hold 时 `ringRot += 0.02*dt` 微漂移 | 用 3 个随机档位 + 指数急停，把"轮播"做出机械/呼吸混合的手感 | 触发从"拍子到点"改成"事件/注意力"，角位移按"目标卡到注视位置"反算 |
| 9 | **`resizeStage` 几何参数化** | 375–393 | 所有半径/角度由 `R=H*0.78` 起算：`RO=R+max(90,min(240,H*0.3,W*0.13))*ringWidth`、`RMAX=hypot(W-cx,H/2)+60`、`thV/thS=asin(...)`；`fit()/mk()/mkd()` 统一 DPR 处理（174–186、370–374） | 窗口任意变化/任何 DPR 下构图都成立；这是"壁纸版/移动版"能复用同一套代码的根本 | 照抄；我们的环带宽度系数应更小（信息密度更高） |
| 10 | **确定性哈希抖动 + 后期合成链** | 662–670、1160–1193 | `hash(x)=sin(x*12.9898)*43758.5453 取小数` 给每条径向线稳定的长度抖动（帧间不闪）；后期链 = 远景半分辨率 + blur + 降亮 → 1/3 辉光 + 6px blur + lighter → 径向暗角 | 两件"便宜且质感强"的事：**稳定的随机**（避免闪烁）和**降采样后期**（避免全尺寸 blur） | 哈希函数直接用；后期参数按我们的暗色调重新标定 |

### 12.2 若移植到 ASTRA，**必须重写**的 3 个部分

| # | 部分 | 为什么不能照搬 | 重写方案 |
|---:|---|---|---|
| 1 | **数据层：假数据系统** | haloflux 的一切内容都是随机生成的：`TOK` 假 token 池（286–289）、`BLOCKS` 随机数据块（882–974）、假 KPI（HTML 129–164）、`feedPush` 假 feed（1245–1252）。它是"有生命感的装饰"，不是"可读的信息"。ASTRA 的每个像素都必须能追溯到真实事件，否则用户会读到假状态。 | 建 **Store**：会话表 / turn 状态机 / 工具调用表 / token 速率环形缓冲 / 上下文压力 / 错误列表 / todos；事件写入、渲染只读。卡内容由 Store 快照渲染，禁止 `Math.random()` 决定内容（只允许决定装饰细节） |
| 2 | **驱动层：定时节拍 + 随机环调度** | `updateBeat` 是定时器，`ringMove` 是纯随机；两者与数据无关。真实 agent 的节奏是**事件密度驱动**的：推理步几十毫秒、工具调用几百毫秒到几秒、空闲可长达分钟。定时拍会与真实节奏打架，随机环会让用户找不到"为什么转"。 | 节拍改**事件时钟**（§10.2）；环改**注意力调度**（新事件/审批/错误 → 急停对准；空闲 → 慢旋 + 漂移）；保留 haloflux 的缓动公式与包络形状，替换触发源 |
| 3 | **结构层：单文件三合一** | haloflux 把渲染核心、控制台、假数据、DOM 面板、BGM 全塞进一个 1710 行 HTML。它是作者自用的 demo，可维护性不是目标；而 ASTRA 要接 DSH 事件、要嵌进 GUI、要多种宿主（浏览器/壁纸/嵌入）。单文件会导致数据层与渲染层耦合，无法安全迭代。 | 拆成 §10.4 的 4 层：`adapter`（事件归一化）/ `Store` / `renderer`（保留 haloflux 式单文件零依赖核心）/ `ui`（KPI/设置/宿主桥）。渲染核心仍保持"只依赖 config + 尺寸 + Store 快照"的纯函数形态，方便测试与复用 |

> 可选保留、不必重写的部分：参数系统（`PARAMS`/`BASE`/`PRESETS`/localStorage 持久化）、`fit/mk/mkd` 的 DPR 处理、`HAS_FILTER` 能力检测、ResizeObserver debounce、`dt` clamp、壁纸版的暂停桥。这些是通用工程资产，与"皮"无关。

### 12.3 行号抽查（对源码逐条核对）

抽查方法：用 `node` 直接读取源文件对应行并断言关键字，结果由脚本生成（非手写）。抽查点覆盖报告中最关键的 8 处引用：

| 报告引用 | 断言关键字 | 源码该行原文（截断 120 字符） | 结果 |
|---:|---|---|---|
| `lab.html:292` §3.1 不均匀节拍图案 PATTERN | `PATTERN` | `const PATTERN = [0.5, 0.25, 0.25, 0.5, 0.5, 0.75, 0.25, 0.25, 0.25, 1.0];` | ✅ PASS |
| `lab.html:294` §3.2 updateBeat 入口 | `function\s+updateBeat` | `function updateBeat(dt) {` | ✅ PASS |
| `lab.html:296` §3.2 拍长推进/重置核心行 | `beatT\s*\+=\|sinceBeat` | `if (beatT <= 0) { beatT += PATTERN[beatI++ % PATTERN.length] * 0.92 / C.tempo; sinceBeat = 0; beatN++; onBeat(); }` | ✅ PASS |
| `lab.html:540` §6.2 buildOuter 第 5 层（bounce） | `makeStrandLayer\|bounce` | `makeStrandLayer(0.12, 1.0,  0.85, 1.0,  1.0,  0.5,  0.55, 14,  70, 0.32, 'bounce'),  // v4 wave / rebound layer` | ✅ PASS |
| `lab.html:823` §5.2 圆环旋转状态对象 rot | `rot\s*=\s*\{` | `const rot = { from: 0, to: 0, t: 1, dur: 1, hold: 0, ease: easeIO };` | ✅ PASS |
| `lab.html:824` §5.2 ringMove 三档状态机 | `function\s+ringMove` | `function ringMove() {` | ✅ PASS |
| `lab.html:1075` §2.2 drawStage 更新阶段 | `updateBeat` | `updateBeat(dt); updateCam(dt); updateOuter(dt);` | ✅ PASS |
| `lab.html:1181` §8.2 辉光合成 blur | `blur\|filter\|glow` | `if (HAS_FILTER) S.filter = 'blur(6px)';` | ✅ PASS |

合计 8/8 处引用行号与源码一致（292/294/296/540/823/824/1075/1181）。

> 修正说明：初版抽查把第 541 行当作"第 5 层 bounce"引用，复核发现 541 行是数组结束的 `];`，第 5 层定义实际在 **540 行**（`buildOuter` 函数始于 533 行，层定义在 536–540，`wedges` 合并在 542 行）。报告正文已同步改为精确区间，抽查点已修正为 540 行并通过。

### 12.4 报告信息与局限

- **对象**：haloflux（Ryder191）实验版 `lab.html` 1710 行、移动版 `mobile.html` 1757 行、壁纸版 `wallpaper_index.html` 1631 行 + `wallpaper_wp.js` 122 行、入口 `index.html` 27 行。
- **许可证**：源码头注释为 PolyForm Noncommercial License 1.0.0（lab.html:2–13）。**本报告仅做架构与机制分析，ASTRA 不复制其代码/外观**；如需直接复用任何代码片段，必须先确认许可条款。
- **实测局限**：性能数据来自 Chrome 156 headless（软件光栅）中 iframe 加载 lab.html，**不是**真 GPU、不是 DSH GUI 内嵌环境；绝对值偏悲观，相对结论（DPR、批处理、调用量）有效。60fps 结论需在目标机（真 GPU Chrome / DSH GUI）复测一次。
- **源码版本**：本机下载快照；行号以该快照为准，上游若更新可能漂移（结构/函数名基本稳定）。
- **复现方式**：性能采样脚本在 `%TEMP%\halofluxbench\`（`bench2.html` = iframe 加载 lab.html 并按 canvas 分桶统计；`cdp2.js` = CDP 连 headless Chrome 取结果；`gen_report_tables.js` = 生成 §1 参数表与 §12.3 抽查表）。注意 Chrome 156 headless **不能**把 URL 当命令行参数传入（会报 `Multiple targets are not supported`），必须先启动浏览器、再用 CDP `Target.createTarget` 打开页面。
- **未覆盖**：haloflux 的 BGM 合成细节（1597–1707，与本次目标无关）、移动版竖屏旋转矩阵细节、控制台 56 参数的 UI 细节——这些在 §1/§9 只做定位说明，未展开逐行分析。

---

*报告完。下一步：ASTRA 视觉方案（配色/字体/布局规范）与数据契约设计，将基于本报告的 §10 映射表展开。*
