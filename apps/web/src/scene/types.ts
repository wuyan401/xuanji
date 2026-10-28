// XUANJI · 璇玑 — Scene 内部共享类型与几何常量（仅 scene/** 使用）。
// 几何数值以 docs/DESIGN-BIBLE.md §18.1（v1.2 校准）为准，优先级高于 §6.1/§17.2。

import type {
  AgentSession,
  AgentState,
  ConnectionState,
  SourceId,
  SystemSnapshot,
  ViewKind,
  ViewMode,
} from '../state/types';
import type { VisualParams } from '../design/params';
import type { ThemeId } from '../design/themes';
import { clamp } from '../lib/math';

/** 每帧传递给各绘制模块的只读环境（由 index.ts 维护）。 */
export interface Env {
  params: VisualParams;
  reducedMotion: boolean;
  /** 自适应画质 0..1（1 = 满配） */
  quality: number;
  /** devicePixelRatio（已按 quality/上限收缩） */
  dpr: number;
  /** CSS 像素尺寸 */
  w: number;
  h: number;
  cx: number;
  cy: number;
  /** 浑仪基准半径 = min(vw, vh) * 0.50（移动端 min(vw, vh*0.92) * 0.46） */
  R: number;
  /** 窄屏（≤720px） */
  mobile: boolean;
  /** performance.now() */
  now: number;
  /** 秒，已钳制（后台标签页/长帧不会造成跳变） */
  dt: number;
  /** 分野整体转角（擒纵驱动） */
  skyRot: number;
  /** v2.4 §23.3：器数层附加转角（scifi 随势 ×1.25；xuanji 恒等于 skyRot） */
  skyRotFast: number;
  /** v2.4 §23.3：当前主题旋转倍率（xuanji 恒为 1；scifi = 随势 scifiDyn） */
  ringDyn: number;
  /** v2.4 §23.3：授时环扫描角（scifi 随势 ×0.8；xuanji 不使用） */
  tickScan: number;
  /** 0..1 仪器「生长」进度（连接中/首帧） */
  grow: number;
  /** 当前相机缩放（世界坐标 → CSS 像素） */
  zoom: number;
  mode: ViewMode;
  connection: ConnectionState;
  /** v2.0 顶层视图：观星 / 观机（同一台仪器，两套盘面） */
  view: ViewKind;
  /** v2.0 来源筛选（null = 全部来源）；非匹配星压暗 */
  sourceFilter: SourceId | null;
  /** 已检测到的来源数（≥2 时星体加 1px 来源断环、分野标签带来源短名） */
  sourceCount: number;
  /** 整机遥测是否可用（不可用时整盘 alpha .35 + 「遥测不可用」） */
  systemAvailable: boolean;
  /** v2.8 §27.2：整机遥测快照（整机核心 GPU 忙闲因子用）；null = 无遥测 */
  system: SystemSnapshot | null;
  /** v2.2：缩放手势进行中或缩放尚未收束（此时跳过景深副本/辉光 blur 等重型后期） */
  zooming: boolean;
  /**
   * v2.3 §22.2：缩放手势期的「后期权重」（1 → 0.55，240ms ease-in-out）。
   * 取代 v2.2 的 zooming 硬开关：手势期后期效果只降权、不切换模式，避免亮度跳变。
   */
  fxWeight: number;
  /** v2.3 §22.7：当前主题 id（palette 已由 applyTheme 原地改写 tokens，scene 只在需要时做主题差异化） */
  theme: ThemeId;
}

export interface CamState {
  x: number;
  y: number;
  zoom: number;
  rot: number;
  squash: number;
}

/** 节拍时钟对外暴露的视觉量（BeatClock 实现此接口）。 */
export interface BeatView {
  /** 0..~1.5，拍点抬升后按 pulseDecay 衰减 */
  pulse: number;
  strong: boolean;
  weak: boolean;
  /** 当前拍内进度 0..1 */
  q: number;
  /** 钟摆角 -1..1（拍点派生） */
  pendulum: number;
  /** 是否进入守夜（>6s 无事件） */
  idle: boolean;
  /** 最近一拍环面推进的角度（rad） */
  lastStep: number;
  /** 拍序号（用于判断是否跨拍） */
  serial: number;
}

/** 六合几何比例（DESIGN-BIBLE §18.1 v1.2）。 */
export const GEOM = {
  hub: 0.13,
  bandIn: 0.17,
  bandStep: 0.042,
  bandOut: 0.38,
  orbitIn: 0.42,
  orbitMid: 0.53,
  orbitOut: 0.64,
  sectorDivIn: 0.68,
  sectorIn: 0.7,
  sectorOut: 0.79,
  sectorDivOut: 0.81,
  labelR: 0.745,
  tickIn: 0.82,
  tickOut: 0.9,
  microIn: 0.93,
  microOut: 1.0,
  starfield: 0.92,
} as const;

/** 五行光带（内 → 外：木火土水金）。 */
export const CATEGORY_ORDER = ['read', 'write', 'exec', 'net', 'agent'] as const;

/** 星的世界极坐标姿态与状态。 */
export interface StarNode {
  id: string;
  session: AgentSession;
  sectorId: string;
  /** 分野弧内 0..1 基准位置（同分野最小角距 ≥0.6°） */
  local: number;
  /** 漂移方向 ±1 */
  driftDir: number;
  /** 相对基准角的漂移量（rad） */
  drift: number;
  /** 世界角（rad） */
  angle: number;
  /** v2.2 轨道层号（0..ringCount-1；每层独立角速度 zoneSpeed） */
  zone: number;
  /** v2.2 每星游速系数（0.55–1.60，不同星的绕行速度不同，§21.2） */
  speedK: number;
  /** v2.2 基准轨道半径（不含 ±2.5% 极慢呼吸） */
  radiusBase: number;
  /** v2.2 半径呼吸相位（0..1）与周期（40–120s） */
  breathPhase: number;
  breathPeriod: number;
  /** v2.2 反重合松弛后的角度补正（rad，相对基准角；布局不被挤压时自然派生） */
  shift: number;
  /** v2.3 反重合松弛给出的目标角向补正（rad）；update 内阻尼追赶，避免逐帧重排抖动 */
  shiftTarget?: number;
  /** v2.2 每帧相邻推开量（rad，动态防重合；随密度变化缓慢回零） */
  sep: number;
  /** v2.3 §22.3 径向层级权重：0.55*normLog10(outputTokens+1)+0.35*activityNorm+0.10*liveBonus */
  weight: number;
  /** v2.3 §22.5 出生动画进度 0..1（0 = 刚出现，1 = 就位） */
  spawn: number;
  /** v2.3 §22.5 出生开始时刻（performance.now） */
  spawnAt: number;
  /** v2.3 §22.1 上一帧实际绘制的星体 alpha（用于把单帧 alpha 跳变限制在 ≤0.06） */
  alphaVis: number;
  radius: number;
  radiusTarget: number;
  /** 基础视觉半径（css px） */
  r: number;
  /** v2.8 §27.1：新鲜度尺寸倍数（0.55 久置 → 1.30 刚活动；平滑过渡，单帧变化 ≤0.02） */
  shownFresh: number;
  /** 0..1 点火 / 0..1 熄灭动画进度 */
  appear: number;
  vanishing: boolean;
  vanishStep?: number;
  pulse: number;
  glow: number;
  activity: number;
  errorAt: number;
  approvalAt: number;
  lastEventAt: number;
  satellites: SatelliteMote[];
  /** 近 4 次事件的角（尾迹刻度） */
  trail: number[];
  teamTasks: number;
  teamLinks: string[];
}

export interface SatelliteMote {
  id: string;
  angle: number;
  radius: number;
  r: number;
  state: AgentState;
  appear: number;
  /** v2.2 卫星独立绕行方向 ±1（不与父星同速同向，§21.2） */
  dir: number;
}

/** 星过留痕：轨道环上的一段墨痕弧。 */
export interface Mark {
  angle: number;
  radius: number;
  /** rad */
  width: number;
  born: number;
  life: number;
  /** 0 = 金墨，1 = 骨白 */
  tone: number;
}

export interface SectorArc {
  id: string;
  /** 展示名（同名跨来源自动加来源短名，同来源同名加路径尾缀，如 `deepseek harness · AI/`） */
  name: string;
  /** 完整 workspace 路径（hover 提示用） */
  path: string;
  /** v2.0 来源 id（分野 = source::workspace；来源断环 / 筛选 / 标签用） */
  source: SourceId;
  /** 占 12 宫中的几个 30° 主分割 */
  units: number;
  /** 局部起始角/跨度（未加 skyRot），当前值 */
  start: number;
  span: number;
  /** 目标起始角/跨度（主分割网格上是精确 30° 倍数） */
  startTarget: number;
  spanTarget: number;
  count: number;
  live: number;
  ended: number;
  /** live 弧带呼吸相位（拍点驱动） */
  breath: number;
}

/** 绘制模块共享的只读视图。 */
export interface View {
  env: Env;
  arcs: SectorArc[];
  marks: Mark[];
  stars: StarNode[];
  /** 五带亮度 0..1（按 60s 工具速率） */
  bands: number[];
  beat: BeatView;
  /** 当前时辰刻的世界角（rad） */
  shichenAngle: number;
  selected: string | null;
  hovered: string | null;
  /** 运镜聚焦的星（track/dossier） */
  focusId: string | null;
}

/**
 * v2.4.2 §20.2 再修订：世界内文字的反向缩放系数。
 * 屏幕字号目标：screenGrow(env) = clamp(1.08 · zoom^0.5 · layout · boost, 0.95, 4)
 *   - zoom：相机缩放（2.42× → 1.68×、6.72× → 2.80×，比 v2.4.1 更明显）
 *   - layout = clamp(sqrt(R/450),1,1.6)：窗口/全屏变大时字也跟着大（R=450 为 1440×900 基准）
 *   - boost = 调参台「字号」textBoost（0.8–2.4，默认 1.4）
 * 世界内字号 × screenGrow/zoom，乘回 zoom 后得到的屏幕字号即 screenGrow。
 */
export function textScreenGrow(env: Env): number {
  const layout = clamp(Math.sqrt(env.R / 450), 1, 1.6);
  const boost = clamp(env.params.textBoost ?? 1.4, 0.6, 3);
  const z = Math.max(0.5, env.zoom);
  return clamp(1.08 * Math.sqrt(z) * layout * boost, 1, 5);
}

export function textScale(env: Env): number {
  const z = Math.max(0.5, env.zoom);
  return clamp(textScreenGrow(env) / z, 0.05, 2);
}
