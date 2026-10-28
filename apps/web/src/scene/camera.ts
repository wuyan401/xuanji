// XUANJI · 璇玑 — 七运镜 + auto-director（DESIGN-BIBLE §6.6 / §8）。
// 相机状态全部由「目标态 + 推近后定住转场 + 阻尼跟随」驱动，没有自由 sin(t)。
// v2.1 视野主权（§20）：默认不动 · 人动即锁 · 光标锚点深度缩放 · 视野记忆。

import { EASE } from '../design/tokens';
import type { VisualParams } from '../design/params';
import type { EventKind, ViewMode } from '../state/types';
import { clamp, clamp01, damp, easeInOutCubic } from '../lib/math';
import type { CamState, Env } from './types';

interface ModeCfg {
  zoom: number;
  rot: number;
  squash: number;
  /** 聚焦星在屏幕上的位置（黄金分割 / isolated） */
  fx: number;
  fy: number;
  /** 非聚焦星的降亮系数 */
  dim: number;
  starfield: number;
  ticks: number;
}

export const MODE_CFG: Record<ViewMode, ModeCfg> = {
  survey: { zoom: 1.12, rot: -0.014, squash: 0.966, fx: 0.5, fy: 0.5, dim: 1, starfield: 1, ticks: 1 },
  track: { zoom: 2.4, rot: -0.006, squash: 1, fx: 0.382, fy: 0.42, dim: 0.82, starfield: 0.66, ticks: 1 },
  dossier: { zoom: 3.4, rot: 0, squash: 1, fx: 0.44, fy: 0.46, dim: 0.6, starfield: 0.42, ticks: 0.9 },
  ledger: { zoom: 0.9, rot: 0, squash: 1, fx: 0.5, fy: 0.44, dim: 0.75, starfield: 0.58, ticks: 0.78 },
  orrery: { zoom: 1.35, rot: 0, squash: 0.988, fx: 0.5, fy: 0.5, dim: 0.9, starfield: 0.32, ticks: 1.18 },
  scan: { zoom: 1.0, rot: 0, squash: 0.985, fx: 0.5, fy: 0.52, dim: 0.92, starfield: 0.82, ticks: 1 },
  vigil: { zoom: 1.15, rot: -0.01, squash: 0.975, fx: 0.5, fy: 0.5, dim: 0.9, starfield: 0.46, ticks: 0.68 },
};

/** 滚轮缩放范围（§20.2：0.75–6.0×）。 */
const ZOOM_MIN = 0.75;
const ZOOM_MAX = 6.0;
/** 总缩放钳制（基准档位 × zoomUser） */
const TOTAL_MIN = 0.5;
const TOTAL_MAX = 8.0;
/** 拖拽视差上限（§20.2 说明：真实拖拽约 ±1.2R） */
const DRAG_LIMIT_R = 1.2;

/** 自动导播轮转顺序。 */
const CYCLE: ViewMode[] = ['survey', 'track', 'orrery', 'scan', 'vigil', 'track', 'dossier', 'ledger', 'orrery', 'track'];

export interface CameraHost {
  /** 自动导播切镜时通知装配层（→ HUD 模式标签） */
  onAutoMode(mode: ViewMode): void;
  /** v2.1：任何「人动」发生（拖拽/滚轮/双击/切机位/点星/分野聚焦） */
  onManualView?(): void;
}

/** v2.0：同一台仪器两套盘面，各自保留相机状态。 */
export interface CameraSnapshot {
  cam: CamState;
  mode: ViewMode;
  zoomUser: number;
  dragX: number;
  dragY: number;
  autoFocus: string | null;
  sectorFocus: { x: number; y: number; zoom: number; label: string } | null;
  /** v2.0：整机盘面的静态取景标记（恢复观星盘面时一并还原） */
  staticZoom: number | null;
  staticFrame: boolean;
  /** v2.1：视野锁定（人动即锁）随视图一起保存/恢复 */
  manualLocked: boolean;
}

export class CameraSystem {
  cam: CamState = { x: 0, y: 0, zoom: 1, rot: MODE_CFG.survey.rot, squash: MODE_CFG.survey.squash };
  mode: ViewMode = 'survey';
  modeSince = 0;
  reduced: boolean;
  autoPaused = false;
  zoomUser = 1;
  /**
   * v2.2 丝滑缩放（§21.1）：滚轮只改「目标值」zoomGoal（乘性累加、clamp 0.75–6.0），
   * zoomUser 每帧只朝目标阻尼一次；可见 zoom 再由单级阻尼跟随——三处不再互相打架。
   */
  zoomGoal = 1;
  /** 最近一次滚轮时间戳（手势判定：now-lastWheelAt < 260ms 视为手势中） */
  lastWheelAt = -1e9;
  /** 拖拽视差（屏幕 px） */
  dragX = 0;
  dragY = 0;
  dragging = false;
  /** 手动操作时间戳（manualReturn 冷却） */
  manualAt = -1e9;
  /**
   * v2.1 视野锁定：一旦人动，取消自动导播与进行中的转场，镜头停在原处；
   * 只有 main 的 Space（releaseViewLock）或 setAutoPaused(false) 才解锁。
   */
  manualLocked = false;
  /** 自动导播聚焦的会话 */
  autoFocus: string | null = null;
  /** 分野聚焦（HUD 分野总览点击 / scene.focusSector）：世界点 + 目标放大 */
  sectorFocus: { x: number; y: number; zoom: number; label: string } | null = null;
  /** v2.0 整机视图：静态取景缩放（覆盖 mode 档位，仍吃用户滚轮）；null = 不覆盖 */
  staticZoom: number | null = null;
  /** v2.0 整机视图：锁定中心取景（不随机位档位平移/旋转，暂停自动导播） */
  staticFrame = false;
  params: VisualParams;
  /** v2.5 §24.8：本视图的滚轮缩放范围（观星/整机 0.75–6.0；百工 0.8–4.0） */
  zoomMin = ZOOM_MIN;
  zoomMax = ZOOM_MAX;
  /** v2.5 §24.8：本视图的拖拽硬限（R 的倍数；null = 沿用观星锚点补偿余量 R*3.2） */
  dragHardR: number | null = null;

  private from: CamState = { ...this.cam };
  private target: CamState = { ...this.cam };
  private transitioning = false;
  private transAt = 0;
  private transDur = 1000;
  private directorAt = 0;
  private urgent: { prio: number; sessionId: string | null } | null = null;
  private cycleIdx = 0;
  private pointerTX = 0;
  private pointerTY = 0;
  private pointerNX = 0;
  private pointerNY = 0;
  private host: CameraHost;
  private env: Env | null = null;
  private started = false;
  /** v2.2：待消费的累计滚轮 delta（每帧清零，避免一帧多跳） */
  private pendingWheel = 0;
  /** v2.2：缩放锚点 = 手势起点的屏幕点 + 其世界坐标（每帧反解 drag，偏差 >0.5px 才修） */
  private anchor: { sx: number; sy: number; worldX: number; worldY: number } | null = null;
  /** v2.2：双击复位走平滑归零（pan 也阻尼回 0，禁止瞬跳） */
  private resetPan = false;

  constructor(opts: { params: VisualParams; reducedMotion: boolean; host: CameraHost }) {
    this.params = opts.params;
    this.reduced = opts.reducedMotion;
    this.host = opts.host;
  }

  get cfg(): ModeCfg {
    return MODE_CFG[this.mode];
  }
  get transitionMs(): number {
    return this.reduced ? 200 : 900 + 500 * clamp01(1 - this.params.pushIn);
  }
  get scanAngle(): number {
    if (!this.env) return 0;
    return (((this.env.now - this.modeSince) / 3600) % 1) * Math.PI * 2;
  }
  /** v2.1：静态离屏层清晰度档位（<1.6× 一档 / <3.2× 二档 / ≥3.2× 三档）。 */
  get zoomTier(): number {
    const z = this.cam.zoom;
    return z >= 3.2 ? 3 : z >= 1.6 ? 2 : 1;
  }
  /** v2.2：滚轮手势是否仍在进行（<260ms，静态层此时禁止重烘）。 */
  get wheelActive(): boolean {
    const now = this.env?.now ?? performance.now();
    return now - this.lastWheelAt < 260;
  }
  /** v2.2：可见缩放是否已收束（延迟重烘/跨档淡入用）。 */
  get zoomSettled(): boolean {
    return Math.abs(this.cam.zoom - this.target.zoom) < 0.002;
  }

  setParams(p: VisualParams): void {
    this.params = p;
  }

  /**
   * v2.5 §24.8：每种视图自己的取景边界。
   * - 观星 / 整机：滚轮 0.75–6.0、拖拽沿用 R*1.2 舒适区（锚点补偿留 R*3.2 余量）；
   * - 百工：滚轮 0.8–4.0、拖拽硬限 ±0.8R（机械盘面不允许把仪器拖出视野）。
   * 切视图时立刻把越界状态收回，避免上一视图的缩放/位移带到下一视图。
   */
  setViewLimits(zoomMin: number, zoomMax: number, dragHardR: number | null): void {
    this.zoomMin = Math.max(0.2, Math.min(zoomMin, zoomMax));
    this.zoomMax = Math.max(this.zoomMin + 0.01, zoomMax);
    this.dragHardR = dragHardR;
    this.zoomGoal = clamp(this.zoomGoal, this.zoomMin, this.zoomMax);
    this.zoomUser = clamp(this.zoomUser, this.zoomMin, this.zoomMax);
    if (dragHardR !== null && this.env) {
      const lim = this.env.R * dragHardR;
      this.dragX = clamp(this.dragX, -lim, lim);
      this.dragY = clamp(this.dragY, -lim, lim);
    }
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
  }

  /**
   * v2.1：自动运镜开关。
   * - paused=true：锁住视野（人动即锁的另一种入口，HUD/Space 都会走这里）。
   * - paused=false：解锁并给 3s 宽限，从当前视野开始不瞬移（§20.1 定律三）。
   */
  setAutoPaused(paused: boolean, now: number = performance.now()): void {
    if (paused === this.autoPaused) {
      if (paused) this.urgent = null;
      return;
    }
    this.autoPaused = paused;
    this.urgent = null;
    if (paused) {
      this.lockManual(now, true);
    } else {
      this.unlock(now);
    }
  }

  /**
   * v2.1：人动即锁。取消正在进行的转场（相机以当前姿态继续阻尼收束，不瞬移），
   * 清掉待抢镜头的告警，并通知装配层（HUD 播报一次「视野已锁定」）。
   */
  lockManual(now: number, silent = false): void {
    this.manualAt = now;
    this.manualLocked = true;
    this.urgent = null;
    if (this.transitioning) {
      this.from = { ...this.cam };
      this.target = { ...this.cam };
      this.transitioning = false;
    }
    if (!silent) this.host.onManualView?.();
  }

  /** 兼容旧调用名：所有手动操作都走 lockManual。 */
  markManual(now: number): void {
    this.lockManual(now);
  }

  /** v2.1：释放视野锁定（仅 main 的 Space 开自动运镜时调用）。 */
  releaseViewLock(now: number = performance.now()): void {
    this.unlock(now);
  }

  private unlock(now: number): void {
    this.manualLocked = false;
    this.urgent = null;
    // 3s 宽限：从当前视野开始，不瞬间跳回中心
    this.directorAt = now + 3000;
    // 让 manualReturn 冷却立即通过，真正的自动转场由上面的 3s 宽限决定
    this.manualAt = now - Math.max(2500, this.params.manualReturn * 1000);
  }

  /** 外部（键盘 1–7）或内部（选中星）切镜。opts.auto=true 表示自动导播。 */
  setMode(mode: ViewMode, opts: { immediate?: boolean; auto?: boolean } | undefined, now: number): void {
    const auto = opts?.auto === true;
    if (!auto) this.lockManual(now);
    if (mode === this.mode) {
      if (!auto && this.sectorFocus) this.sectorFocus = null;
      return;
    }
    if (!auto) this.sectorFocus = null;
    this.from = { ...this.cam };
    this.mode = mode;
    this.modeSince = now;
    this.transitioning = true;
    this.transAt = now;
    this.transDur = this.transitionMs;
    if (opts?.immediate) {
      this.transitioning = false;
      this.snapToTarget();
    }
    if (auto) {
      this.directorAt = now + this.dwellMs();
      this.host.onAutoMode(mode);
    } else {
      this.directorAt = now + Math.max(3000, this.params.manualReturn * 1000);
    }
  }

  /** 事件抢占：error/approval(3) > turn/start(2) > tool(1)。 */
  notifyEvent(kind: EventKind, sessionId: string, now: number): void {
    this.notifyRaw(kind, sessionId, now);
  }

  notifyRaw(kind: string, sessionId: string, now: number): void {
    const prio =
      kind === 'error' || kind === 'approval'
        ? 3
        : kind === 'turn/start'
          ? 2
          : kind === 'tool/call' || kind === 'session/live'
            ? 1
            : 0;
    if (prio >= 2) {
      if (!this.urgent || prio >= this.urgent.prio) this.urgent = { prio, sessionId };
    }
    this.lastEventAt = now;
  }

  lastEventAt = 0;

  /** 指针视差目标（-1..1）。 */
  setPointer(nx: number, ny: number): void {
    this.pointerTX = clamp(nx, -1, 1);
    this.pointerTY = clamp(ny, -1, 1);
  }

  /**
   * v2.2：滚轮只「记账」，不动可见缩放（§21.1）。
   * - 目标值 zoomGoal 乘性累加（clamp 0.75–6.0），累计 delta 每帧只消费一次；
   * - 首个滚轮记下光标下的世界点，之后每帧由 update() 反解 drag 把该世界点钉在光标下；
   * - 可见缩放由 update() 的两级阻尼完成，所以滚轮连打不会再抖。
   */
  wheel(deltaY: number, now: number, env?: Env, sx?: number, sy?: number): void {
    const gap = now - this.lastWheelAt;
    this.lastWheelAt = now;
    this.pendingWheel = clamp(this.pendingWheel + deltaY, -1400, 1400);
    if (env && sx !== undefined && sy !== undefined && (!this.anchor || gap > 260)) {
      const w = this.screenToWorld(env, sx, sy);
      this.anchor = { sx, sy, worldX: w.x, worldY: w.y };
    }
    this.resetPan = false;
    this.lockManual(now);
  }

  /** 双击复位：缩放回 1.0（平滑归零，§21.1 禁止瞬跳）、pan 归零、清分野聚焦。 */
  resetZoom(now: number): void {
    this.zoomGoal = 1;
    this.pendingWheel = 0;
    this.anchor = null;
    this.resetPan = true;
    this.sectorFocus = null;
    this.lockManual(now);
  }

  /** v2.0：保存/恢复某视图的相机（缩放/拖拽/机位/聚焦）。 */
  snapshot(): CameraSnapshot {
    return {
      cam: { ...this.cam },
      mode: this.mode,
      zoomUser: this.zoomUser,
      dragX: this.dragX,
      dragY: this.dragY,
      autoFocus: this.autoFocus,
      sectorFocus: this.sectorFocus ? { ...this.sectorFocus } : null,
      staticZoom: this.staticZoom,
      staticFrame: this.staticFrame,
      manualLocked: this.manualLocked,
    };
  }

  restore(s: CameraSnapshot, now: number): void {
    this.cam = { ...s.cam };
    this.from = { ...s.cam };
    this.target = { ...s.cam };
    this.mode = s.mode;
    this.zoomUser = s.zoomUser;
    this.dragX = s.dragX;
    this.dragY = s.dragY;
    this.autoFocus = s.autoFocus;
    this.sectorFocus = s.sectorFocus ? { ...s.sectorFocus } : null;
    this.staticZoom = s.staticZoom;
    this.staticFrame = s.staticFrame;
    this.manualLocked = s.manualLocked;
    this.zoomGoal = s.zoomUser;
    this.pendingWheel = 0;
    this.anchor = null;
    this.resetPan = false;
    this.transitioning = false;
    this.modeSince = now;
    this.manualAt = now;
    this.directorAt = now + this.dwellMs();
    this.urgent = null;
  }

  /** v2.0：整机视图静态取景（null = 恢复机位档位）。 */
  setStaticZoom(z: number | null): void {
    this.staticZoom = z;
  }

  /** v2.0：锁定中心取景（整机盘面不随机位档位平移/旋转，暂停自动导播）。 */
  setStaticFrame(b: boolean): void {
    this.staticFrame = b;
  }

  /** 分野聚焦（§18.9）：传 null 回全局取景。 */
  setSectorFocus(point: { x: number; y: number; label: string } | null, now: number): void {
    this.lockManual(now);
    if (!point) {
      if (this.sectorFocus) {
        this.sectorFocus = null;
        this.directorAt = now + this.dwellMs();
      }
      return;
    }
    this.sectorFocus = { x: point.x, y: point.y, zoom: 2.1, label: point.label };
    this.zoomUser = 1;
    this.zoomGoal = 1;
    this.pendingWheel = 0;
    this.anchor = null;
    this.resetPan = false;
    this.directorAt = now + 1e9;
    this.from = { ...this.cam };
    this.transitioning = true;
    this.transAt = now;
    this.transDur = this.reduced ? 200 : this.transitionMs * 0.85;
  }

  dragBy(dx: number, dy: number, env: Env): void {
    this.dragging = true;
    const lim = env.R * (this.dragHardR ?? 3.2);
    // 拖拽本身只允许 ±1.2R 的舒适区（百工视图硬限 ±0.8R），但滚轮锚点需要更大的补偿余量
    this.dragX = clamp(this.dragX + dx, -lim, lim);
    this.dragY = clamp(this.dragY + dy, -lim, lim);
    void DRAG_LIMIT_R;
  }

  endDrag(): void {
    this.dragging = false;
  }

  update(env: Env, focus: { x: number; y: number } | null, focusEnergy: number, liveIds: string[], now: number): void {
    this.env = env;
    const dt = env.dt;
    if (!this.started) {
      this.started = true;
      this.modeSince = now;
      this.directorAt = now + this.dwellMs();
      this.snapToTarget();
    }

    this.pointerNX = damp(this.pointerNX, this.pointerTX, 5, dt);
    this.pointerNY = damp(this.pointerNY, this.pointerTY, 5, dt);
    // v2.1：视野锁定后拖拽位移必须留住（这正是用户要的「自定义视野」），不再回中。
    if (!this.dragging && !this.manualLocked) {
      this.dragX = damp(this.dragX, 0, 2.4, dt);
      this.dragY = damp(this.dragY, 0, 2.4, dt);
    }

    // —— v2.2 丝滑缩放：每帧只消费一次累计滚轮 delta（乘性、clamp），zoomUser 阻尼追它
    if (this.pendingWheel !== 0) {
      this.zoomGoal = clamp(this.zoomGoal * Math.exp(-this.pendingWheel * 0.0011), this.zoomMin, this.zoomMax);
      this.pendingWheel = 0;
    }
    const prevUser = this.zoomUser;
    this.zoomUser = damp(this.zoomUser, this.zoomGoal, 16, dt);
    // 帧间限速（§21.1 每帧 zoom 比值 ≤1.10）：防止事件累积造成单帧跳变
    const step = clamp(this.zoomUser / Math.max(1e-6, prevUser), 1 / 1.09, 1.09);
    this.zoomUser = clamp(prevUser * step, this.zoomMin, this.zoomMax);
    // 双击复位：pan 也平滑归零（禁止瞬跳）
    if (this.resetPan) {
      this.dragX = damp(this.dragX, 0, 9, dt);
      this.dragY = damp(this.dragY, 0, 9, dt);
      if (Math.abs(this.dragX) < 0.2 && Math.abs(this.dragY) < 0.2) {
        this.dragX = 0;
        this.dragY = 0;
        this.resetPan = false;
      }
    }

    // —— 目标态
    const cfg = this.cfg;
    let zoom = cfg.zoom;
    if (this.mode === 'track') zoom = 2.1 + 0.75 * clamp01(focusEnergy);
    else if (this.mode === 'vigil') zoom += 0.06 * clamp01((now - this.modeSince) / 26000);
    zoom = clamp(zoom * this.zoomUser, TOTAL_MIN, TOTAL_MAX);
    // v2.0 整机视图：静态取景（不随机位档位变化，只吃用户滚轮）
    if (this.staticZoom !== null) zoom = clamp(this.staticZoom * this.zoomUser, TOTAL_MIN, TOTAL_MAX);
    let tx = 0;
    let ty = 0;
    const sf = this.sectorFocus;
    if (sf && !(focus && (this.mode === 'track' || this.mode === 'dossier'))) {
      // 分野聚焦：把该分野弧上的点拉到画面中心，并推近看清弧带与双行标注
      zoom = clamp(sf.zoom * this.zoomUser, TOTAL_MIN, TOTAL_MAX);
      tx = -sf.x * zoom;
      ty = -sf.y * zoom;
    } else if (focus && (this.mode === 'track' || this.mode === 'dossier')) {
      tx = env.w * cfg.fx - env.cx - focus.x * zoom;
      ty = env.h * cfg.fy - env.cy - focus.y * zoom;
    } else if (this.mode === 'ledger') {
      ty = -env.h * 0.055;
    } else if (this.mode === 'scan') {
      ty = env.h * 0.008;
    }
    this.target = { x: tx, y: ty, zoom, rot: cfg.rot, squash: cfg.squash };
    // v2.0 整机盘面：锁定中心，旋转/压扁归零（只保留 zoomUser 缩放）
    if (this.staticFrame) {
      this.target = {
        x: 0,
        y: 0,
        zoom: clamp((this.staticZoom ?? 1) * this.zoomUser, TOTAL_MIN, TOTAL_MAX),
        rot: 0,
        squash: 1,
      };
    }

    // —— 转场「推近后定住」/ 阻尼跟随
    if (this.transitioning) {
      const raw = clamp01((now - this.transAt) / this.transDur);
      const t = this.transCurve(raw);
      this.cam.x = this.from.x + (this.target.x - this.from.x) * t;
      this.cam.y = this.from.y + (this.target.y - this.from.y) * t;
      this.cam.zoom = this.from.zoom + (this.target.zoom - this.from.zoom) * t;
      this.cam.rot = this.from.rot + (this.target.rot - this.from.rot) * t;
      this.cam.squash = this.from.squash + (this.target.squash - this.from.squash) * t;
      if (raw >= 1) this.transitioning = false;
    } else {
      const l = 5;
      this.cam.x = damp(this.cam.x, this.target.x, l, dt);
      this.cam.y = damp(this.cam.y, this.target.y, l, dt);
      // v2.2：帧间限速——长帧（截图/后台恢复）后 dt 变大会一帧追平，造成「鼓包式」跳变；
      // 钳住每帧比值为 ≤1.06/帧，视觉上仍是连续加速而不是一帧闪进（QA smooth.ratios ≤1.10）
      const prevZoom = this.cam.zoom;
      const nextZoom = damp(prevZoom, this.target.zoom, 26, dt);
      const zStep = clamp(nextZoom / Math.max(1e-6, prevZoom), 1 / 1.06, 1.06);
      this.cam.zoom = clamp(prevZoom * zStep, TOTAL_MIN, TOTAL_MAX);
      this.cam.rot = damp(this.cam.rot, this.target.rot, 4, dt);
      this.cam.squash = damp(this.cam.squash, this.target.squash, 4, dt);
    }

    // —— v2.2 光标锚点：手势期间每帧反解 drag，让起点世界点钉在光标下（§21.1）
    if (this.anchor) {
      const cur = this.worldToScreen(env, this.anchor.worldX, this.anchor.worldY);
      const errX = cur.x - this.anchor.sx;
      const errY = cur.y - this.anchor.sy;
      if (Math.abs(errX) > 0.5 || Math.abs(errY) > 0.5) {
        const lim = env.R * (this.dragHardR !== null ? this.dragHardR + 1.4 : 3.2);
        this.dragX = clamp(this.dragX - errX, -lim, lim);
        this.dragY = clamp(this.dragY - errY, -lim, lim);
      }
      // 手势结束且缩放收束后清锚点（之后视野完全交给用户，不再自我修正）
      if (now - this.lastWheelAt > 420 && Math.abs(this.cam.zoom - this.target.zoom) < 0.006) {
        this.anchor = null;
      }
    }

    // —— auto-director（v2.1：人动即锁，锁定期间误/批/turn 不得抢镜）
    if (this.staticFrame || this.manualLocked) return;
    const canAuto =
      !this.autoPaused &&
      !this.reduced &&
      !this.sectorFocus &&
      this.params.autoDirector > 0.5 &&
      env.connection !== 'offline' &&
      now - this.manualAt > Math.max(2500, this.params.manualReturn * 1000);
    if (!canAuto) return;
    const sinceMode = now - this.modeSince;
    // 抢占只在当前机位站稳之后发生：告警（误/批）约 5s 后可抢，普通 turn/start
    // 要等本轮停留过半或本就在「逐星」里才跟随，避免事件洪峰把导播钉死在特写。
    const urgentAt = this.urgent
      ? this.urgent.prio >= 3
        ? 5000
        : Math.max(8000, this.dwellMs() * 0.55)
      : Infinity;
    if (this.urgent && sinceMode > urgentAt) {
      const prio = this.urgent.prio;
      const sid = this.urgent.sessionId;
      this.urgent = null;
      if (sid) this.autoFocus = sid;
      this.autoSwitch(prio >= 3 ? 'dossier' : 'track', now);
    } else if (now >= this.directorAt) {
      const next = this.pickNext(liveIds);
      if (liveIds.length > 0) {
        const cur = this.autoFocus;
        const pool = liveIds.filter((id) => id !== cur);
        const pickFrom = pool.length > 0 ? pool : liveIds;
        this.autoFocus = pickFrom[Math.floor(Math.random() * pickFrom.length)] ?? null;
      }
      this.autoSwitch(next, now);
    }
  }

  private autoSwitch(mode: ViewMode, now: number): void {
    if (mode === this.mode) {
      this.directorAt = now + this.dwellMs();
      return;
    }
    this.from = { ...this.cam };
    this.mode = mode;
    this.modeSince = now;
    this.transitioning = true;
    this.transAt = now;
    this.transDur = this.reduced ? 200 : 900 + 500 * clamp01(1 - this.params.pushIn);
    this.directorAt = now + this.dwellMs();
    this.host.onAutoMode(mode);
  }

  private pickNext(liveIds: string[]): ViewMode {
    for (let i = 0; i < CYCLE.length; i += 1) {
      const mode = CYCLE[this.cycleIdx % CYCLE.length];
      this.cycleIdx += 1;
      // v2.1 修正：轮转不得选中当前机位（否则本轮空转，首个自动转场会被
      // 9–18s 的下一轮 dwell 推后，超出「Space 开锁后 12s 内转场」的验收）。
      if (mode === this.mode) continue;
      if (mode === 'dossier' && liveIds.length === 0) continue;
      if (mode === 'track' && liveIds.length === 0) continue;
      if (this.env?.connection === 'offline' && mode !== 'survey' && mode !== 'vigil') continue;
      return mode;
    }
    return this.mode === 'survey' ? 'orrery' : 'survey';
  }

  /** 9–18s 停留（dwell 参数为基准）。 */
  private dwellMs(): number {
    const base = clamp(this.params.dwell, 6, 24) * 1000;
    return base * (0.75 + Math.random() * 0.75);
  }

  private transCurve(p: number): number {
    if (this.reduced) return easeInOutCubic(p);
    if (p < 0.6) return EASE.out(p / 0.6) * 0.965;
    if (p < 0.9) return 0.965 + 0.035 * EASE.engrave((p - 0.6) / 0.3);
    // 最后 10%：8% 过冲后的极轻回弹（≤2px 级微调）
    const t = (p - 0.9) / 0.1;
    return 1 + 0.006 * Math.sin(t * Math.PI) * (1 - t);
  }

  /** 立刻把相机放到目标态（首帧 / immediate 切镜 / 视野恢复）。 */
  snapToTarget(): void {
    this.cam = {
      x: 0,
      y: 0,
      zoom: clamp(MODE_CFG[this.mode].zoom * this.zoomUser, TOTAL_MIN, TOTAL_MAX),
      rot: MODE_CFG[this.mode].rot,
      squash: MODE_CFG[this.mode].squash,
    };
    this.target = { ...this.cam };
    this.transitioning = false;
  }

  /** 世界坐标（CSS px，原点=浑仪中心）→ 屏幕坐标。 */
  worldToScreen(env: Env, x: number, y: number): { x: number; y: number } {
    const [px, py] = this.parallax(env);
    const c = Math.cos(this.cam.rot);
    const s = Math.sin(this.cam.rot);
    const sx = x * this.cam.zoom;
    const sy = y * this.cam.zoom * this.cam.squash;
    return {
      x: env.cx + this.cam.x + this.dragX + px + sx * c - sy * s,
      y: env.cy + this.cam.y + this.dragY + py + sx * s + sy * c,
    };
  }

  /** 屏幕坐标 → 世界坐标。 */
  screenToWorld(env: Env, x: number, y: number): { x: number; y: number } {
    const [px, py] = this.parallax(env);
    const dx = x - (env.cx + this.cam.x + this.dragX + px);
    const dy = y - (env.cy + this.cam.y + this.dragY + py);
    const c = Math.cos(-this.cam.rot);
    const s = Math.sin(-this.cam.rot);
    const rx = dx * c - dy * s;
    const ry = dx * s + dy * c;
    return { x: rx / this.cam.zoom, y: ry / (this.cam.zoom * this.cam.squash) };
  }

  /** 把世界坐标系压到主画布上。 */
  apply(ctx: CanvasRenderingContext2D, env: Env): void {
    const [px, py] = this.parallax(env);
    ctx.translate(env.cx + this.cam.x + this.dragX + px, env.cy + this.cam.y + this.dragY + py);
    ctx.rotate(this.cam.rot);
    ctx.scale(this.cam.zoom, this.cam.zoom * this.cam.squash);
  }

  private parallax(env: Env): [number, number] {
    // v2.1：锁定视野后不得有任何自动视差
    if (env.mobile || env.reducedMotion || this.manualLocked) return [0, 0];
    const k = env.R * 0.045 * this.params.parallax;
    return [this.pointerNX * k, this.pointerNY * k * 0.7];
  }
}
