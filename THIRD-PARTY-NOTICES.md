# 第三方声明 / Third-Party Notices

璇玑（XUANJI）的本体代码以 MIT 许可证发布（见 `LICENSE`）。以下是与本项目相关、但不属于本项目成果的
第三方作品、字体与参考资料。本项目**不打包**任何游戏素材、影视截图或第三方美术资源。

## 1. 架构与实现思想参考

- **HALOFLUX** by Ryder191 — <https://github.com/Ryder191/haloflux>
  - 许可证：**PolyForm Noncommercial License 1.0.0**（仅限非商业用途）。
  - 本项目仅参考其**功能实现方式与架构思想**（节拍时钟驱动的非匀速动画、外圈微数据面板环、
    多层堆叠光束、自动运镜与参数台等设计思路），**未复制其源代码，也未沿用其视觉风格**。
  - 若你需要基于 haloflux 的原作本身做二次创作或商业使用，请遵守其原始许可证并保留原作者署名。

## 2. 字体（SIL Open Font License 1.1）

`apps/web/src/design/fonts/` 下随仓库分发以下字体的子集/原文件，均以 SIL OFL 1.1 授权：

| 字体 | 用途 | 许可证 |
|---|---|---|
| LXGW WenKai（霞鹜文楷） | 界面显示体 / 标题 | SIL OFL 1.1 |
| Noto Serif SC（思源宋体简体） | 正文 | SIL OFL 1.1 |
| JetBrains Mono | 数字与等宽标签 | SIL OFL 1.1 |

字体的版权归各原作者所有；SIL OFL 允许随软件再分发，但不允许单独售卖字体。

## 3. 设计研究参考（仅研究，不随仓库分发素材）

视觉方向研究阶段参考了以下作品的美术语言，仅用于提炼「可迁移的机制」与「禁止照搬的皮」，
**仓库内不含任何其截图、图标、字体或美术资源**：

- 《群星 / Stellaris》— Paradox Interactive
- 《赛博朋克 2077 / Cyberpunk 2077》— CD PROJEKT RED
- 《崩坏：星穹铁道》（翁法罗斯 / 如我所书）— HoYoverse
- 《绝区零》（Fairy / HDD 系统）— HoYoverse
- 《明日方舟》（莱茵生命）— Hypergryph

相关商标与美术版权归各权利方所有。

## 4. 数据格式与生态

本项目读取本机以下工具产生的**只读**数据，与这些项目**没有隶属或背书关系**：

- DeepSeek Harness（DSH）：`~/.dsh`（会话快照与 zstd 事件日志）
- Hermes Agent：`state.db`（SQLite）
- opencode：`opencode.db`（SQLite）
- Claude Code / Codex CLI：本地会话日志（JSONL / 配置目录）

数据格式归各自项目所有；本项目只按公开的本地文件结构做只读解析，不修改任何原始数据。

## 5. 运行时依赖

- **后端：零第三方运行时依赖**（仅 Node.js 内置模块；Node.js ≥ 24 提供原生 SQLite 与 zstd）。
- **前端构建与校验（均为开发依赖）**：Vite、TypeScript、playwright-core（仅用于本地 QA 脚本）。
  它们的许可证分别为 MIT / Apache-2.0，可另行查阅各自仓库。
