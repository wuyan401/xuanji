// 应用层契约：main.ts 与场景/HUD 两个实现模块之间的唯一接口。
// 场景与 HUD 由不同 builder 实现，双方都只依赖这个文件；Lead 维护它，
// builder 不要修改本文件（需要扩展时找 Lead）。

import type {
  AstroEvent,
  ClientFleetSnapshot,
  ConnectionState,
  SystemSnapshot,
  ViewKind,
  ViewMode,
} from '../state/types';
import type { VisualParams } from '../design/params';
import type { ThemeId } from '../design/themes';

/** v2.3 运动稳定性验收（scene 内部统计，qa-v23 读取） */
export interface MotionStats {
  /** 最近采样窗口内「位置瞬移」次数（单帧角位移 >0.02rad 或径向 >3px，期望 0） */
  teleports: number;
  /** 最近窗口内星体 alpha 单帧最大跳变 0..1（期望 ≤0.08） */
  maxAlphaStep: number;
  /** 已采样帧数 */
  frames: number;
  /** 当前前景平均亮度 0..1（缩放期亮度稳定性验收用） */
  brightness: number;
}

/** v2.3 机器运转/数据交互反馈统计 */
export interface FxStats {
  /** 活跃协作连线（父子/团队/遣使） */
  links: number;
  /** 沿弧/连线飞行的数据包光点 */
  packets: number;
  /** 外环分野反应（脉冲/扫光/粒子）活跃数 */
  sectorFx: number;
  /** 累计出生/退场动画数 */
  spawns: number;
  /** 数据流粒子数 */
  streams: number;
  /** 核心层次数（≥4 = 复合核心已启用） */
  coreNodes: number;
}

/** v2.3 径向层级验收：越庞大越活跃越靠内 */
export interface HierarchyStats {
  /** 权重（体量+活跃）与轨道半径的 Spearman 秩相关，期望 ≤ -0.5 */
  spearman: number;
  innerAvgWeight: number;
  outerAvgWeight: number;
  stars: number;
}

/** v2.4 工作光流验收：星 → 中枢的持续数据流（连接/持续/断开三相位） */
export interface StreamsDebug {
  /** 正在持续发流的星数（应为 live 星中近段有活动者） */
  active: number;
  /** 正在播放「连接」动画的流数（星侧向中枢画入） */
  connecting: number;
  /** 正在播放「断开」动画的流数（中枢侧回收淡出） */
  disconnecting: number;
  /** 当前沿流流动的粒子总数（持续输送的直观计数） */
  packets: number;
  /** 当前在飞的工具光束数（五类笔触，保留原样式） */
  toolBeams: number;
  /** 其中起点位于工作光流之上的条数（应为多数：工具光束从流上发射） */
  toolBeamsFromStream: number;
  /** scifi 主题下外圈旋转的实时速度倍率（xuanji 恒为 1） */
  ringSpeed: number;
  /** 该主题的基准旋转倍率（无事件时的静息值） */
  ringSpeedBase: number;
  /** 当前光束主色（十六进制，用于断言主题配色是否协调） */
  beamColor: string;
  /** scene 内部最近一帧耗时 ms（硬预算 ≤8ms） */
  sceneMs: number;
}

export interface FrameStats {
  fps: number;
  /** 最近一段时间平均帧耗时 ms */
  frameMs: number;
  /** 自动降档后的画质档位 0..1 */
  quality: number;
}

export interface SceneCallbacks {
  /** 点击星体（空白处 null） */
  onPick(sessionId: string | null): void;
  /** 运镜模式变化（自动导演也会触发） */
  onModeChange(mode: ViewMode): void;
  /** 统计信息（建议每 ~500ms 一次） */
  onStats(stats: FrameStats): void;
  /** 场景内需要提示用户的话 */
  onNotice(text: string): void;
  /** 顶层视图切换（可选；目前主要由 HUD 发起，scene 回执） */
  onViewChange?(view: ViewKind): void;
  /**
   * v2.1 视野主权：用户在场景内做了手动取景操作（滚轮/拖拽/双击复位/分野聚焦/选中星）。
   * 装配层据此把自动运镜锁死（HUD 同步「已锁」态），直到用户按 Space 放开。
   */
  onManualView?(): void;
}

export interface SceneHandle {
  /** 每帧调用一次；scene 用 now 做插值，自己维护上一帧时间 */
  frame(now: number): void;
  setFleet(snapshot: ClientFleetSnapshot): void;
  pushEvents(events: AstroEvent[]): void;
  setMode(mode: ViewMode, opts?: { immediate?: boolean; auto?: boolean }): void;
  setSelection(sessionId: string | null): void;
  /** 相机对准某一分野（null = 回到全局取景）。可选能力，scene 可实现。 */
  focusSector?(sectorId: string | null): void;
  /**
   * 切换顶层视图：'agents' 智能体浑仪 / 'system' 整机仪象。可选能力。
   * 同一台仪器、两套铭牌：切换用推拉运镜（620ms），两视图各自保留相机状态。
   */
  setView?(view: ViewKind): void;
  /** 整机遥测快照（view==='system' 时使用；null = 无数据/不可用）。可选能力。 */
  setSystem?(snapshot: SystemSnapshot | null): void;
  /** 只显示某来源的星（null = 全部）。可选能力。 */
  setSourceFilter?(sourceId: string | null): void;
  /** 调试/验收用：当前星数、可见星数、相机缩放、模式、视野锁定态。可选能力。 */
  debugInfo?(): {
    stars: number;
    visibleStars: number;
    zoom: number;
    mode: ViewMode;
    view?: ViewKind;
    sectors?: number;
    sourceFilter?: string | null;
    /** v2.1：自动导演当前是否生效（参数开 && 未锁 && 非整机静态帧） */
    autoEnabled?: boolean;
    /** v2.1：是否因手动操作锁死了视野 */
    manualLocked?: boolean;
    /** v2.1：拖拽位移（世界 px），验收「不被拉回中心」用 */
    dragX?: number;
    dragY?: number;
    /** v2.4.1：世界内文字反向系数（≤1） */
    textScale?: number;
    /** v2.4.1：屏幕上实际字号倍数 = textScale × zoom（应随 zoom 单调变大，而不是变小） */
    textScreen?: number;
  };
  /**
   * v2.2 调试/验收用：当前轨道布局与速度（世界 px / rad·s⁻¹）。
   * zones = 每条轨道层的角速度；minPairDist = 当前同屏星最小圆心距；
   * speedSpread = 星游速 max/min 比（用于断言「每个轨道速度不一致」）。可选能力。
   */
  debugOrbits?(): {
    zones: Array<{ index: number; speed: number }>;
    stars: number;
    minPairDist: number;
    speedSpread: number;
  };
  /** v2.3 验收：位置/亮度稳定性（闪烁与错位） */
  debugMotion?(): MotionStats;
  /** v2.3 验收：协作/通讯/分野反应/出生退场等动效计数 */
  debugFx?(): FxStats;
  /** v2.3 验收：径向层级（活跃体量大 → 靠内） */
  debugHierarchy?(): HierarchyStats;
  /** v2.4 验收：星→中枢工作光流（连接/持续/断开）与主题旋转/配色 */
  debugStreams?(): StreamsDebug;
  /** v2.3 主题切换（canvas 侧 palette 已由 applyTheme 改写，调用方负责落 data-theme 与持久化） */
  setTheme?(theme: ThemeId): void;
  setParams(params: VisualParams): void;
  /** 自动运镜暂停 / 恢复（Space）。paused=false 时应解除手动锁。 */
  setAutoPaused(paused: boolean): void;
  /** v2.1：显式解除「手动操作锁死视野」（Space 放开自动运镜时调用）。可选能力。 */
  releaseViewLock?(): void;
  /** v2.1 验收用：世界坐标 → 屏幕坐标（CSS px）。可选能力。 */
  projectPoint?(x: number, y: number): { x: number; y: number };
  /** v2.1 验收用：屏幕坐标 → 世界坐标。可选能力。 */
  unprojectPoint?(x: number, y: number): { x: number; y: number };
  setReducedMotion(reduced: boolean): void;
  dispose(): void;
}

export interface HudCallbacks {
  onSelectSession(sessionId: string | null): void;
  /** 分野总览里点选分野（null = 取消分野聚焦）。可选能力。 */
  onSelectSector?(sectorId: string | null): void;
  /** HUD 请求切换顶层视图（顶栏「观」按钮 / 快捷键）。可选能力。 */
  onViewRequest?(view: ViewKind): void;
  /** 来源筛选（null = 全部）。可选能力。 */
  onSourceFilter?(sourceId: string | null): void;
  /** 请求切换主题（HUD 主题铭牌/快捷键 T）。可选能力。 */
  onThemeRequest?(theme: ThemeId): void;
  onModeRequest(mode: ViewMode): void;
  onParamsChange(params: VisualParams): void;
  onPauseAutoChange(paused: boolean): void;
  onNotice(text: string): void;
}

export interface HudHandle {
  setFleet(snapshot: ClientFleetSnapshot): void;
  pushEvents(events: AstroEvent[]): void;
  setSelection(sessionId: string | null): void;
  setMode(mode: ViewMode): void;
  /** 回执当前顶层视图。可选能力。 */
  setView?(view: ViewKind): void;
  /** 整机遥测快照（2s 一条）。可选能力。 */
  setSystem?(snapshot: SystemSnapshot | null): void;
  /** 来源筛选态（HUD 自己也可能发起，收到后同步 UI）。可选能力。 */
  setSourceFilter?(sourceId: string | null): void;
  /** 主题回执（HUD 同步铭牌文案与 aria）。可选能力。 */
  setTheme?(theme: ThemeId): void;
  setParams(params: VisualParams, opts?: { silent?: boolean }): void;
  setConnection(state: ConnectionState): void;
  setAutoPaused(paused: boolean): void;
  setReducedMotion(reduced: boolean): void;
  setStats(stats: FrameStats | null): void;
  /** 返回 true 表示该键已被 HUD 消费（面板开关、调参台内导航等） */
  handleKey(event: KeyboardEvent): boolean;
  showToast(text: string): void;
  dispose(): void;
}

export interface HudInitOptions {
  params: VisualParams;
  reducedMotion: boolean;
  /** URL ?boot=0 关掉开机序列 */
  skipBoot: boolean;
  /** 初始视图（URL ?view=system 时为 'system'） */
  view?: ViewKind;
  /** 初始主题（URL ?theme= 或 localStorage） */
  theme?: ThemeId;
}

export interface SceneInitOptions {
  params: VisualParams;
  reducedMotion: boolean;
  reducedQuality: boolean;
  /** 初始视图（URL ?view=system 时为 'system'） */
  view?: ViewKind;
  /** 初始主题（palette 已由 applyTheme 写入 tokens，scene 只需知道 id 以便内部差异化） */
  theme?: ThemeId;
}
