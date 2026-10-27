# NOTICE · 署名与权利声明

**璇玑 XUANJI · 本机智能体观测所**（Local Agent Observatory）
个人非商业项目。以下为必须随产品一同保留的署名与许可信息。

---

## 1. 架构思想借鉴

本项目的**节拍时钟、单 Canvas 分层管线、离屏缓存与重渲染预算、注意力运镜、参数台**等机制，
借鉴自 [HALOFLUX](https://github.com/Ryder191/haloflux)：

> **HALOFLUX by Ryder191** — PolyForm Noncommercial License 1.0.0

本项目：
- 仅借鉴其**架构思想与公式形态**（详见 `docs/research/01-haloflux-architecture.md` 的机制映射表）；
- **未复制**其源代码、未复用其视觉风格（配色、光场、面板皮、文案均自研）；
- 遵循 PolyForm Noncommercial 1.0.0 的**非商业**使用边界——本项目为个人学习/自用，不用于任何商业目的。
- 若将本项目用于商业用途，必须移除全部 HALOFLUX 派生机制或另行取得许可。

## 2. 研究参考系

`docs/research/` 下的视觉参考研究（群星 Stellaris、赛博朋克 2077、崩坏：星穹铁道·翁法罗斯 / 如我所书、
绝区零 Fairy、明日方舟·莱茵生命）仅用于**机制层面的观察与测量**：

- 所有参考图片（`docs/research/assets/`）版权归原权利方所有，**仅本地研究比对使用**，不进入 `apps/`，
  不随产品构建产物分发；
- 产品中不包含任何可识别的游戏图形、专名、徽记、字体或版式；
- 研究文档中标注了「实测」与「推测」的区分，缺口已如实记录在各报告附录 B。

## 3. 字体

| 字体 | 用途 | 许可 |
|---|---|---|
| 霞鹜文楷 LXGW WenKai | 显示体（标题、《起居注》卷名） | SIL Open Font License 1.1 |
| 思源宋体 Noto Serif SC | 正文 | SIL Open Font License 1.1 |
| JetBrains Mono | 数字/代码/标签 | SIL Open Font License 1.1 |

六个 woff2（霞鹜文楷 500 / 思源宋体 400、600 / JetBrains Mono 400、500、700）以本地文件形式放在
`apps/web/src/design/fonts/` 并由 `src/design/fonts.css` 手写 `@font-face` 加载，构建产物不含 `.woff` 兜底与外部请求。

## 4. 运行时依赖

- 后端：**零第三方依赖**（Node.js 内置 `http` / `fs` / `zlib`）。
- 前端：Vite + TypeScript（构建期），运行时无框架依赖。
- 数据来源：本机 DeepSeek Harness、Hermes、opencode、Claude Code、Codex 的本地日志与数据库，以及本机整机遥测；
  **全程只读、不联网、不上传**任何数据。

## 5. 第三方素材

- 无第三方图片、音频、图标素材进入构建产物。
- 界面图形（浑仪、星、刻度、纹样）全部为代码程序化绘制。

---

*最后更新：2026-10-27*
