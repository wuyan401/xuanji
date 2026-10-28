// XUANJI · 璇玑 — Scene 入口：单 Canvas 浑仪。
// 本文件负责「编排」：数据窗口 → 节拍时钟 → 事件→视觉映射 → 运镜 → 分层绘制。
// 具体几何/星/事件特效分别在 instrument / stars / effects 中实现。
// 设计依据：docs/DESIGN-BIBLE.md §6–§8、§13、§17（v1.1）；契约：src/app/contracts.ts。

import type { SceneCallbacks, SceneHandle, SceneInitOptions, ProcessesDebug, StreamsDebug } from '../app/contracts';
import type {
  AstroEvent,
  ClientFleetSnapshot,
  SourceId,
  SystemSnapshot,
  ViewKind,
  ViewMode,
} from '../state/types';
import type { VisualParams } from '../design/params';
import { clampParams } from '../design/params';
import { BEAM_TINT, type ThemeId } from '../design/themes';
import { COLORS, withAlpha } from '../design/tokens';
import { TAU, clamp, clamp01, damp, easeInOutCubic, lerp } from '../lib/math';
import { AirSystem } from './air';
import { BeatClock, ringCurve } from './beat';
import { CameraSystem, type CameraSnapshot } from './camera';
import { CoreSystem } from './core';
import { drawScan, EffectsSystem } from './effects';
import { FxSystem } from './fx';
import { MicroSystem } from './micro';
import { SkySystem } from './sky';
import { SystemPlate } from './system';
import {
  buildStarfield,
  buildTickRing,
  createDust,
  drawBackground,
  drawBands,
  drawDust,
  drawHub,
  drawOrbits,
  drawSectors,
  drawSkyGrid,
  drawStarfield,
  drawTickDynamic,
  drawTickLabels,
  drawTickRing,
  type DustMote,
  type StarfieldCache,
  type TickCache,
} from './instrument';
import { drawQuietHorizon, PostSystem } from './post';
// —— v2.5 §24：第三视图「百工 · 器群」（全进程机械化盘面）
import { ProcessesPlate } from './processes';
import { StarSystem } from './stars';
import { WorkStreamSystem } from './streams';
import { CATEGORY_ORDER, GEOM, textScale, textScreenGrow, type BeatView, type Env, type StarNode, type View } from './types';

const MAX_PENDING_EVENTS = 420;
const STATS_INTERVAL = 500;

// —— v2.1 §20.3 视野记忆（两视图各存一份；刷新后静默恢复，URL 优先）
const CAMERA_KEY = 'xuanji.camera.v1';

interface SavedAgentCamera {
  mode: ViewMode;
  zoomUser: number;
  dragX: number;
  dragY: number;
  sectorFocus: { x: number; y: number; zoom: number; label: string } | null;
}

interface SavedSystemCamera {
  zoomUser: number;
  dragX: number;
  dragY: number;
}

interface SavedProcessCamera {
  zoomUser: number;
  dragX: number;
  dragY: number;
}

interface SavedCamera {
  view: ViewKind;
  agents: SavedAgentCamera | null;
  system: SavedSystemCamera | null;
  /** v2.5 §24.8：百工视图也有自己的取景记忆（0.8–4.0 缩放 / ±0.8R 拖拽） */
  processes: SavedProcessCamera | null;
}


function average(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function pruneTimes(list: number[], now: number, windowMs: number): void {
  let i = 0;
  while (i < list.length && now - (list[i] ?? 0) > windowMs) i += 1;
  if (i > 0) list.splice(0, i);
}

export function createScene(
  container: HTMLElement,
  opts: SceneInitOptions,
  cb: SceneCallbacks,
): SceneHandle {
  const doc = container.ownerDocument ?? document;
  const canvas = doc.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'none';
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);
  const mainCtx = canvas.getContext('2d', { alpha: false });

  // —— 系统
  let params: VisualParams = clampParams({ ...opts.params });
  let reducedMotion = opts.reducedMotion;
  let quality = opts.reducedQuality ? 0.5 : 1;
  let autoPaused = false;
  let disposed = false;

  // —— v2.0：同一台仪器，三套盘面（v2.5 起加「百工 · 器群」进程视图）
  let currentView: ViewKind =
    opts.view === 'system' ? 'system' : opts.view === 'processes' ? 'processes' : 'agents';
  let systemSnapshot: SystemSnapshot | null = null;
  let sourceFilter: SourceId | null = null;
  let sourceCount = 0;
  const camSnapshots: Partial<Record<ViewKind, CameraSnapshot>> = {};
  /** 视图切换（620ms / reduced 160ms） */
  let viewTrans: { from: ViewKind; to: ViewKind; start: number; dur: number } | null = null;

  // —— v2.1 §20：视野主权（默认不动 · 人动即锁 · 深度缩放 · 视野记忆）
  let zoomTier = 1;
  /** v2.2 §21.1：静态层分档重烘状态（手势中禁烘 · 逐帧队列 · 180ms 交叉淡入） */
  let builtTier = 1;
  let tierBusy = false;
  let tierQueue: Array<'instrument' | 'micro' | 'air' | 'plate'> = [];
  let prevTickRing: TickCache | null = null;
  let tickFadeAt = -1e9;
  let zoomCalmAt = 0;
  let lastZoomSeen = 0;
  /** 手势期辉光隔帧合成（v2.3 §22.8 手势帧时）。 */
  let glowTick = 0;
  let restoring = false;
  let savedCam: SavedCamera | null = null;
  let saveTimer = 0;

  // —— v2.3 §22：主题（调色板由 main 的 applyTheme 写入 tokens，scene 只做内部差异化与 400ms 颜色插值）
  let theme: ThemeId = opts.theme === 'scifi' ? 'scifi' : 'xuanji';
  /** 手势后期权重：1 → 0.55，240ms ease（§22.2，取代 zooming 硬开关） */
  let fxWeight = 1;
  /** 主题切换的 400ms 画布颜色插值（旧帧快照压在新帧上淡出） */
  let themeFade: { canvas: HTMLCanvasElement; start: number; dur: number } | null = null;

  let fleet: ClientFleetSnapshot | null = null;
  let selectedId: string | null = null;
  let hoveredId: string | null = null;
  let lastReportedMode: ViewMode | null = null;

  const startAt = performance.now();
  let lastFrameNow = 0;
  let lastEventAt = startAt;
  let baseRot = 0;
  let lastBeatSerial = -1;
  let grow = 0;
  // —— v2.4 §23.3：深空随势旋转（器数层 ×1.25 / 授时环 ×0.8 由 skyRot 派生）
  let baseRotFast = 0;
  /** 主题旋转倍率：璇玑恒为 1；深空 = scifiDyn（damp λ2） */
  let scifiDyn = 1;
  /** 平滑后的基准转速（debugStreams.ringSpeedBase；深空 400ms 内可读到上冲） */
  let ringBaseSlow = 1;
  /** 授时环扫描角（仅深空累加） */
  let tickScan = 0;
  /** v2.4 §23.4：单帧 scene 全程耗时（debugStreams.sceneMs） */
  let lastSceneMs = 0;

  const eventTimes: number[] = [];
  const focusTimes: number[] = [];
  const bandTimes: number[][] = CATEGORY_ORDER.map(() => []);
  const bandLevels: number[] = CATEGORY_ORDER.map(() => 0);
  const pendingEvents: AstroEvent[] = [];

  const beat = new BeatClock();
  const camera = new CameraSystem({
    params,
    reducedMotion,
    host: {
      // 自动切镜的统一上报在 frame 里按 camera.mode 去重，这里不做重复回调
      onAutoMode: () => {},
      // §20：任何手动操作 → 锁视野 + 记住这份视野
      onManualView: () => {
        if (restoring) return;
        scheduleCameraSave();
        cb.onManualView?.();
      },
    },
  });
  const stars = new StarSystem();
  const effects = new EffectsSystem();
  const post = new PostSystem();
  const micro = new MicroSystem();
  const air = new AirSystem();
  const sky = new SkySystem();
  const plate = new SystemPlate();
  // —— v2.5 §24：百工 · 器群（本机全部进程，机械盘面）
  const processes = new ProcessesPlate();
  // —— v2.3 §22.4/§22.6：机器运转 + 复合核心
  const fx = new FxSystem();
  const core = new CoreSystem();
  // —— v2.4 §23.1：星 → 中枢的工作光流（connect / stream / disconnect 三相位）
  const workStreams = new WorkStreamSystem();

  const viewBeat: BeatView = {
    get pulse() {
      return beat.pulse * (reducedMotion ? 0.45 : 1) * beat.breathe;
    },
    get strong() {
      return !reducedMotion && beat.strong;
    },
    get weak() {
      return !reducedMotion && beat.weak;
    },
    get q() {
      return beat.q;
    },
    get pendulum() {
      return reducedMotion ? 0 : beat.pendulum;
    },
    get idle() {
      return beat.idle;
    },
    get lastStep() {
      return beat.lastStep;
    },
    get serial() {
      return beat.serial;
    },
  };

  const env: Env = {
    params,
    reducedMotion,
    quality,
    dpr: 1,
    w: 1,
    h: 1,
    cx: 0.5,
    cy: 0.5,
    R: 1,
    mobile: false,
    now: performance.now(),
    dt: 1 / 60,
    skyRot: 0,
    skyRotFast: 0,
    ringDyn: 1,
    tickScan: 0,
    grow: 0,
    zoom: 1,
    mode: 'survey',
    connection: 'connecting',
    view: currentView,
    sourceFilter: null,
    sourceCount: 0,
    systemAvailable: false,
    /** v2.8 §27.2：整机遥测快照（GPU 忙闲因子） */
    system: null,
    zooming: false,
    // —— v2.3 §22：手势后期权重（平滑降权，不是硬开关）与主题
    fxWeight: 1,
    theme: opts.theme === 'scifi' ? 'scifi' : 'xuanji',
  };

  const view: View = {
    env,
    arcs: stars.arcs,
    marks: stars.marks,
    stars: stars.stars,
    bands: bandLevels,
    beat: viewBeat,
    shichenAngle: 0,
    selected: null,
    hovered: null,
    focusId: null,
  };

  // —— 离屏层
  const glowCanvas = doc.createElement('canvas');
  const glowCtx = glowCanvas.getContext('2d');
  let glowScale = 1 / 3;
  let starfield: StarfieldCache = { canvas: glowCanvas, w: 1, h: 1 };
  let tickRing: TickCache = { canvas: glowCanvas, size: 2 };
  const dust: DustMote[] = [];
  let cacheKey = '';
  let pendingResize = false;
  let pendingRebuild = true;

  // ———————————————————————————————— v2.1 §20 视野记忆 / 清晰度档位

  /** 深度放大时的静态离屏层档位（§20.2 / task-12：zoom<1.6 → 1，<3.2 → 1.7，≥3.2 → 2.4） */
  function tierSharp(): number {
    return zoomTier >= 3 ? 2.4 : zoomTier >= 2 ? 1.7 : 1;
  }

  function captureAgentsCamera(): SavedAgentCamera {
    return {
      mode: camera.mode,
      zoomUser: camera.zoomUser,
      dragX: camera.dragX,
      dragY: camera.dragY,
      sectorFocus: camera.sectorFocus ? { ...camera.sectorFocus } : null,
    };
  }

  function captureSystemCamera(): SavedSystemCamera {
    return { zoomUser: camera.zoomUser, dragX: camera.dragX, dragY: camera.dragY };
  }

  function persistCameraMemory(): void {
    try {
      window.localStorage.setItem(CAMERA_KEY, JSON.stringify(savedCam));
    } catch {
      /* 隐私模式 / 存储不可用：静默忽略，不影响画面 */
    }
  }

  function saveCameraMemory(): void {
    if (disposed || restoring) return;
    const base: SavedCamera = savedCam ?? { view: currentView, agents: null, system: null, processes: null };
    base.view = currentView;
    if (currentView === 'agents') base.agents = captureAgentsCamera();
    else if (currentView === 'processes') base.processes = captureSystemCamera();
    else base.system = captureSystemCamera();
    savedCam = base;
    persistCameraMemory();
  }

  /** 手动操作后 debounce 500ms 保存（§20.3） */
  function scheduleCameraSave(): void {
    if (disposed || restoring) return;
    if (saveTimer !== 0) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      saveCameraMemory();
    }, 500);
  }

  function clearCameraMemory(view: ViewKind): void {
    if (!savedCam) return;
    if (view === 'agents') savedCam.agents = null;
    else if (view === 'processes') savedCam.processes = null;
    else savedCam.system = null;
    if (!savedCam.agents && !savedCam.system && !savedCam.processes) {
      savedCam = null;
      try {
        window.localStorage.removeItem(CAMERA_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    persistCameraMemory();
  }

  /** 取消尚未落盘的 debounce 保存（双击复位时用，避免复位后的状态又被写回记忆） */
  function cancelCameraSave(): void {
    if (saveTimer !== 0) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
    }
  }

  function loadCameraMemory(): SavedCamera | null {
    try {
      let reset = false;
      try {
        reset = new URLSearchParams(window.location.search).get('reset') === '1';
      } catch {
        reset = false;
      }
      if (reset) {
        window.localStorage.removeItem(CAMERA_KEY);
        return null;
      }
      const raw = window.localStorage.getItem(CAMERA_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<SavedCamera> | null;
      if (!parsed || (parsed.view !== 'agents' && parsed.view !== 'system' && parsed.view !== 'processes')) {
        return null;
      }
      const out: SavedCamera = {
        view: parsed.view,
        agents: parsed.agents ?? null,
        system: parsed.system ?? null,
        processes: parsed.processes ?? null,
      };
      savedCam = out;
      return out;
    } catch {
      return null;
    }
  }

  /** 静默恢复上次视野（不 toast、不转场；§20.3） */
  function restoreSavedCamera(saved: SavedCamera): void {
    restoring = true;
    const now = performance.now();
    const lim = env.R * 1.2;
    if (currentView === 'processes') {
      // v2.5 §24.8：百工视图的取景记忆（0.8–4.0 缩放 / ±0.8R 拖拽）
      const p = saved.processes;
      if (p) {
        camera.zoomUser = clamp(p.zoomUser, 0.8, 4.0);
        camera.dragX = clamp(p.dragX, -env.R * 0.8, env.R * 0.8);
        camera.dragY = clamp(p.dragY, -env.R * 0.8, env.R * 0.8);
      }
    } else if (currentView === 'system') {
      const s = saved.system;
      if (s) {
        camera.zoomUser = clamp(s.zoomUser, 0.75, 6.0);
        camera.dragX = clamp(s.dragX, -lim, lim);
        camera.dragY = clamp(s.dragY, -lim, lim);
      }
    } else {
      const a = saved.agents;
      if (a) {
        camera.zoomUser = clamp(a.zoomUser, 0.75, 6.0);
        camera.setMode(a.mode, { immediate: true, auto: false }, now);
        camera.dragX = clamp(a.dragX, -lim, lim);
        camera.dragY = clamp(a.dragY, -lim, lim);
        camera.sectorFocus = a.sectorFocus ? { ...a.sectorFocus } : null;
        camera.manualLocked = true;
      }
    }
    camera.snapToTarget();
    // v2.2：恢复的缩放目标同步到 zoomGoal，否则下一帧 zoomUser 会被拉回默认 1（QA persist.restored）
    camera.zoomGoal = camera.zoomUser;
    restoring = false;
    lastReportedMode = camera.mode;
    cb.onModeChange?.(camera.mode);
  }


  // —— 性能采样
  const dtSamples: number[] = [];
  const drawSamples: number[] = [];
  let lastStatsAt = startAt;
  let slowSince = 0;
  let lastDegradeAt = 0;

  // ———————————————————————————————— 尺寸与缓存

  function measure(): void {
    const rect = container.getBoundingClientRect();
    let w = Math.round(rect.width);
    let h = Math.round(rect.height);
    if (w < 8) w = Math.round(window.innerWidth);
    if (h < 8) h = Math.round(window.innerHeight);
    if (w < 8) w = 8;
    if (h < 8) h = 8;
    env.w = w;
    env.h = h;
    env.mobile = w <= 720;
    // §18.1 v1.2：画布中心即浑仪中心；R=min(vw,vh)*0.50（mobile min(vw,vh*0.92)*0.46）
    env.cx = w / 2;
    env.cy = h / 2;
    env.R = env.mobile ? Math.min(w, h * 0.92) * 0.46 : Math.min(w, h) * 0.5;

    const qdpr = quality >= 0.9 ? 1 : quality >= 0.7 ? 0.86 : 0.72;
    const cap = env.mobile ? 1.6 : 1.75;
    env.dpr = clamp(Math.min(window.devicePixelRatio || 1, cap) * qdpr, 1, cap);

    const pw = Math.max(2, Math.round(w * env.dpr));
    const ph = Math.max(2, Math.round(h * env.dpr));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;

    glowScale = env.dpr / 3;
    const gw = Math.max(2, Math.round(w * glowScale));
    const gh = Math.max(2, Math.round(h * glowScale));
    if (glowCanvas.width !== gw) glowCanvas.width = gw;
    if (glowCanvas.height !== gh) glowCanvas.height = gh;

    pendingRebuild = true;
  }

  function rebuildCaches(): void {
    const key = [
      env.w,
      env.h,
      env.dpr.toFixed(2),
      params.starDensity.toFixed(2),
      params.dust.toFixed(2),
      params.ticks.toFixed(2),
      params.engravingDepth.toFixed(2),
      clamp(Math.round(params.ringCount), 1, 5),
      quality.toFixed(2),
      reducedMotion ? 'r' : 'n',
      builtTier,
    ].join('|');
    if (key === cacheKey) return;
    cacheKey = key;
    starfield = buildStarfield(env);
    tickRing = buildTickRing(env, tierSharp());
    dust.length = 0;
    dust.push(...createDust(env));
    if (mainCtx) post.build(mainCtx, env);
    air.rebuild(env, quality);
    micro.rebuild(env, stars.arcs, quality, tierSharp());
    if (fleet) micro.updateStats(fleet, env);
    if (fleet) fx.updateStats(fleet, stars.arcs, env);
    plate.build(env, tierSharp());
    // —— v2.5 §24：百工盘面的静态层（工程网格/三轨/总线环）随视图/主题重烘
    processes.build(env, tierSharp());
    // §22.6：复合核心的光点/短弧数量随 quality 重生成
    core.build(env);
    builtTier = zoomTier;
    tierBusy = false;
    tierQueue = [];
    prevTickRing = null;
  }

  // ———————————————————————————————— 视图切换（§19.4：同一台仪器换盘面）

  function applyView(next: ViewKind): void {
    if (next === currentView || disposed) return;
    const now = performance.now();
    const from = currentView;
    camSnapshots[from] = camera.snapshot();
    currentView = next;
    env.view = next;
    if (next === 'system') {
      // 整机盘面：中心锁定 + 静态取景（只吃用户缩放），暂停自动导播
      camera.setViewLimits(0.75, 6.0, null);
      camera.setStaticZoom(0.98);
      camera.setStaticFrame(true);
      camera.setMode('survey', { immediate: true, auto: false }, now);
      // §20.3：整机视图有自己的视野记忆
      const saved = savedCam?.system;
      if (saved) {
        camera.zoomUser = clamp(saved.zoomUser, 0.75, 6.0);
        camera.dragX = clamp(saved.dragX, -env.R * 1.2, env.R * 1.2);
        camera.dragY = clamp(saved.dragY, -env.R * 1.2, env.R * 1.2);
      }
      plate.build(env, tierSharp());
    } else if (next === 'processes') {
      // v2.5 §24.8：百工盘面 = 固定居中构图 + 静态取景（只吃用户缩放/拖拽，无自动运镜）
      camera.setViewLimits(0.8, 4.0, 0.8);
      camera.setStaticZoom(1.0);
      camera.setStaticFrame(true);
      camera.setMode('survey', { immediate: true, auto: false }, now);
      const savedP = savedCam?.processes;
      if (savedP) {
        camera.zoomUser = clamp(savedP.zoomUser, 0.8, 4.0);
        camera.dragX = clamp(savedP.dragX, -env.R * 0.8, env.R * 0.8);
        camera.dragY = clamp(savedP.dragY, -env.R * 0.8, env.R * 0.8);
      }
      processes.build(env, tierSharp());
    } else {
      camera.setViewLimits(0.75, 6.0, null);
      camera.setStaticZoom(null);
      camera.setStaticFrame(false);
      const snap = camSnapshots.agents;
      if (snap) camera.restore(snap, now);
      else camera.setMode('survey', { immediate: true, auto: false }, now);
      camera.autoFocus = selectedId;
    }
    viewTrans = { from, to: next, start: now, dur: reducedMotion ? 160 : 620 };
    pendingResize = true;
    scheduleCameraSave();
  }

  // ———————————————————————————————— 事件 → 视觉

  function starOf(event: AstroEvent): StarNode | null {
    const loc = stars.locate(event.sessionId);
    return loc ? loc.star : null;
  }

  function pulseStar(star: StarNode, amount: number, now: number): void {
    star.pulse = Math.max(star.pulse, amount);
    star.lastEventAt = now;
  }

  function linkAgent(star: StarNode): void {
    const from = stars.worldPos(star);
    let count = 0;
    for (const sat of stars.satellitesOf(star.id)) {
      if (count >= 3) break;
      const to = stars.satellitePos(star, sat);
      effects.spawnTeamLink(from, to, env);
      // §22.4：协作光包沿 1px 贝塞尔弧走完（QA debugFx.links/packets）
      fx.spawnCollab(from.x, from.y, to.x, to.y, env.now);
      count += 1;
    }
    if (count === 0) {
      for (const mid of star.teamLinks) {
        if (count >= 2) break;
        const pos = stars.focusPos(mid);
        if (pos) {
          effects.spawnTeamLink(from, pos, env);
          fx.spawnCollab(from.x, from.y, pos.x, pos.y, env.now);
          count += 1;
        }
      }
    }
    if (count === 0) {
      // 无明确目标（generic agent 工具）时：连向最活跃的 live 星作为协作对象，再退到中枢
      const target = stars.liveIds().find((id) => id !== star.id) ?? null;
      const pos = target ? stars.focusPos(target) : null;
      const tx = pos ? pos.x : 0;
      const ty = pos ? pos.y : 0;
      if (Math.hypot(tx - from.x, ty - from.y) > 8) {
        effects.spawnTeamLink(from, { x: tx, y: ty }, env);
        fx.spawnCollab(from.x, from.y, tx, ty, env.now);
      }
    }
  }

  function handleEvent(event: AstroEvent, now: number): void {
    lastEventAt = now;
    eventTimes.push(now);
    const toolCat = event.toolCategory;
    if ((event.kind === 'tool/call' || event.kind === 'tool/result') && toolCat) {
      const idx = CATEGORY_ORDER.indexOf(toolCat);
      if (idx >= 0) {
        const list = bandTimes[idx];
        if (list) list.push(now);
      }
    }
    const focusId = selectedId ?? camera.autoFocus;
    if (focusId && event.sessionId === focusId) focusTimes.push(now);
    camera.notifyEvent(event.kind, event.sessionId, now);
    // 整机盘面下不生成观星特效（星层不在画面上），但节拍/统计照常记账
    if (currentView === 'system') return;
    // §18.7 星野：事件触发的单颗流星（内部冷却，不循环）
    if (event.kind === 'session/live' || event.kind === 'turn/start' || event.kind === 'session/ended') {
      sky.spawn(env);
    }

    const star = starOf(event);
    if (!star) return;
    const cat = event.toolCategory;
    // §18.5 器用气流：器用事件推一笔；错误走朱砂断点 + 一次坠落
    if (event.kind === 'tool/call' || event.kind === 'tool/result') {
      micro.noteEvent(star.sectorId, env);
      // §22.4：一次器用 → 外环该分野亮起脉冲 / 器数环对应块点亮
      if (event.kind === 'tool/call') fx.noteToolCall(star.sectorId, !!event.isError);
      air.kick(cat, star.angle - env.skyRot, env, !!event.isError);
    } else if (event.kind === 'error') {
      micro.noteEvent(star.sectorId, env);
      fx.noteToolCall(star.sectorId, true);
      air.kick(cat, star.angle - env.skyRot, env, true);
    }

    switch (event.kind) {
      case 'tool/call': {
        pulseStar(star, 0.6, now);
        if (cat === 'agent') linkAgent(star);
        else if (cat) {
          // v2.4 §23.1：工具光束改锚——起点取该星工作光流上 t∈[0.25,0.85] 的一点；
          // 没有光流（非 live / 不在 64 条之内）时退回星体边缘（原行为）
          const anchor = workStreams.pointOn(env, stars, star.id, 0.25 + Math.random() * 0.6);
          if (anchor) effects.spawnCallAt(star, cat, env, !!event.isError, anchor);
          else effects.spawnCall(star, cat, env, !!event.isError);
        }
        break;
      }
      case 'tool/result': {
        pulseStar(star, 0.4, now);
        if (cat === 'agent') linkAgent(star);
        else if (cat) effects.spawnResult(star, cat, env, event.durationMs);
        break;
      }
      case 'turn/start': {
        pulseStar(star, 0.85, now);
        effects.spawnRippleAt(star, env, COLORS.gold200);
        break;
      }
      case 'step/start': {
        const pos = stars.worldPos(star);
        pulseStar(star, 0.3, now);
        effects.spawnRipple(pos.x, pos.y, env, COLORS.bone300, 1, env.R * 0.035, 460);
        break;
      }
      case 'step/end':
      case 'turn/end': {
        stars.addMark(star, event.kind === 'turn/end' ? 0 : 1, now);
        pulseStar(star, 0.32, now);
        break;
      }
      case 'approval': {
        pulseStar(star, 0.7, now);
        star.approvalAt = now;
        effects.spawnApproval(star, env);
        break;
      }
      case 'error': {
        pulseStar(star, 0.9, now);
        star.errorAt = now;
        effects.spawnCall(star, cat ?? 'exec', env, true);
        break;
      }
      case 'session/live': {
        star.appear = Math.max(star.appear, 0.15);
        effects.spawnIgnite(star, env);
        break;
      }
      case 'session/ended': {
        effects.spawnExtinguish(star, env);
        break;
      }
      default:
        break;
    }
  }

  // ———————————————————————————————— 数据接入

  function applyFleet(snap: ClientFleetSnapshot): void {
    const prev = fleet;
    fleet = snap;
    env.connection = snap.connection;
    const now = performance.now();
    const prevIds = new Set<string>(prev ? prev.sessions.map((s) => s.id) : []);
    stars.setFleet(snap, env);
    // §18.4 器数环：数据刷新 + 分野几何变化时重建整圈
    micro.updateStats(snap, env);
    micro.rebuild(env, stars.arcs, quality);
    // 新星点火 / 消失熄灭（parent 由 StarSystem 以卫星处理）
    for (const s of snap.sessions) {
      if (prevIds.has(s.id) || s.parentId) continue;
      const star = stars.find(s.id);
      if (star && star.appear < 0.2) effects.spawnIgnite(star, env);
    }
    if (prev) {
      const nextIds = new Set(snap.sessions.map((s) => s.id));
      let added = 0;
      for (const s of snap.sessions) {
        if (nextIds.has(s.id) && !prevIds.has(s.id) && !s.parentId) added += 1;
      }
      if (added > 0) fx.spawns += added;
      for (const s of prev.sessions) {
        if (nextIds.has(s.id) || s.parentId) continue;
        const star = stars.find(s.id);
        if (star) effects.spawnExtinguish(star, env);
      }
    }
    // §22.4：外环数据流密度 ∝ 各分野近实时工具速率
    fx.updateStats(snap, stars.arcs, env);
    void now;
  }

  // ———————————————————————————————— 每帧

  function frame(now: number): void {
    if (disposed || !mainCtx) return;
    const drawStart = performance.now();
    const intervalMs = lastFrameNow > 0 ? now - lastFrameNow : 16.7;
    lastFrameNow = now;
    const dt = clamp(intervalMs / 1000, 0.0005, 0.12);

    env.now = now;
    env.dt = dt;
    env.params = params;
    env.reducedMotion = reducedMotion;
    env.quality = quality;
    env.connection = fleet?.connection ?? 'connecting';
    env.view = currentView;
    env.sourceFilter = sourceFilter;
    sourceCount = fleet ? (fleet.sources ?? []).filter((x) => x.state === 'detected').length : 0;
    env.sourceCount = sourceCount;
    env.systemAvailable = plate.available;
    env.system = systemSnapshot;

    if (pendingResize) {
      pendingResize = false;
      measure();
    }
    if (pendingRebuild) {
      pendingRebuild = false;
      rebuildCaches();
    }

    // —— 抽干事件队列
    if (pendingEvents.length > 0) {
      const batch = pendingEvents.splice(0, 140);
      for (const event of batch) handleEvent(event, now);
    }
    pruneTimes(eventTimes, now, 1500);
    pruneTimes(focusTimes, now, 10000);
    for (const list of bandTimes) pruneTimes(list, now, 60000);

    // —— 节拍时钟
    const tokenRate = fleet?.aggregates.tokenRate ?? 0;
    const liveCount = fleet?.aggregates.liveCount ?? 0;
    const toolRate = fleet?.aggregates.toolRate ?? 0;
    const eventBurst = clamp(eventTimes.length / 12, 0, 1.5);
    const focusEnergy = clamp(focusTimes.length / 6, 0, 1.5);
    beat.update(env, {
      eventBurst,
      tokenRate,
      liveCount,
      focusEnergy,
      idleMs: now - lastEventAt,
    });

    // —— 擒纵：分野转角由拍点驱动（加速→匀速→急停→回弹）
    const connectionScale = env.connection === 'offline' ? 0 : env.connection === 'reconnecting' ? 0.6 : 1;
    const baseScale = connectionScale * (reducedMotion ? 0.35 : 1);

    // —— v2.4 §23.3：深空主题「随势旋转」——实时数据活跃度 → 转速倍率（damp λ2）；
    // 璇玑主题恒等于基准（不随数据变），两套主题的「随势」差异必须可肉眼读
    const liveNorm = clamp01(liveCount / 8);
    const dynTarget =
      theme === 'scifi' ? clamp(0.35 + 0.9 * beat.energy + 0.25 * liveNorm + 0.15 * eventBurst, 0.35, 2.2) : 1;
    scifiDyn = damp(scifiDyn, dynTarget, 2, dt);
    ringBaseSlow = damp(ringBaseSlow, theme === 'scifi' ? scifiDyn : 1, theme === 'scifi' ? 1.2 : 2.5, dt);
    env.ringDyn = theme === 'scifi' ? scifiDyn : 1;
    // 授时环扫描角：仅深空累加，随势 ×0.8 基准（2.5s/圈 × ringDyn）
    if (theme === 'scifi') tickScan += dt * (TAU / 2.5) * env.ringDyn;
    env.tickScan = tickScan;

    const rotationScale = baseScale * (theme === 'scifi' ? scifiDyn : 1);
    // 器数层 ×1.25：与分野层同源同相，只在深空下多转 1/4（璇玑时严格相等）
    const fastMul = theme === 'scifi' ? 1.25 : 1;
    if (beat.serial !== lastBeatSerial) {
      lastBeatSerial = beat.serial;
      baseRot += beat.lastStep * rotationScale;
      baseRotFast += beat.lastStep * rotationScale * fastMul;
    }
    env.skyRot = baseRot + beat.lastStep * ringCurve(beat.q) * rotationScale;
    env.skyRotFast = baseRotFast + beat.lastStep * ringCurve(beat.q) * rotationScale * fastMul;

    // —— 五行带亮度（近 60s 该类工具速率，平滑）
    for (let i = 0; i < bandTimes.length; i += 1) {
      const list = bandTimes[i] ?? [];
      const target = clamp(list.length / 8, 0, 1);
      bandLevels[i] = damp(bandLevels[i] ?? 0, target, 1.15, dt);
      view.bands[i] = bandLevels[i] ?? 0;
    }

    // —— 授时开机（首帧渐显，不是批量入场）
    grow = clamp01((now - startAt) / 1500);
    env.grow = easeInOutCubic(grow);

    // —— 星与特效
    stars.update(env, beat.energy);
    const focusId = selectedId ?? camera.autoFocus;
    const focusPos = currentView === 'agents' ? stars.focusPos(focusId) : null;
    camera.update(env, focusPos, currentView === 'agents' ? focusEnergy : 0, stars.liveIds(), now);
    env.zoom = camera.cam.zoom;
    env.mode = camera.mode;
    // v2.3 §22.2：后期权重 1 → 0.55（240ms 指数平滑）取代 v2.2 的 zooming 硬开关——
    // 辉光/景深/颗粒/色散随权重连续降权，杜绝手势期间亮度硬跳（qa-v23 brightness.stable）。
    const fxTarget = camera.wheelActive ? 0.55 : 1;
    fxWeight = damp(fxWeight, fxTarget, 12.5, dt);
    env.fxWeight = fxWeight;
    env.theme = theme;
    env.zooming = fxWeight < 0.86;
    // §21.1 深度放大：静态层需要更清晰的档位，但手势中禁止重烘——
    // 先记目标档位，等「缩放安静 140ms 或手势结束 240ms」后，逐帧队列一次烘一个子系统，
    // 跨档新旧静态层 180ms 交叉淡入（禁止硬切、禁止掉帧）。
    const wantTier = camera.zoomTier;
    zoomTier = wantTier;
    const zSpeed = Math.abs(camera.cam.zoom - lastZoomSeen);
    lastZoomSeen = camera.cam.zoom;
    if (zSpeed >= 0.002) zoomCalmAt = now;
    if (wantTier !== builtTier && !tierBusy) {
      const calm = now - zoomCalmAt > 140 || now - camera.lastWheelAt > 240;
      if (calm) {
        tierBusy = true;
        tierQueue = ['instrument', 'micro', 'air', 'plate'];
      }
    }
    if (tierBusy && tierQueue.length > 0 && !camera.wheelActive) {
      const task = tierQueue.shift()!;
      if (task === 'instrument') {
        prevTickRing = tickRing;
        tickFadeAt = now;
        tickRing = buildTickRing(env, tierSharp());
      } else if (task === 'micro') {
        micro.rebuild(env, stars.arcs, quality, tierSharp());
      } else if (task === 'air') {
        air.rebuild(env, quality);
      } else {
        plate.build(env, tierSharp());
      }
    }
    if (tierBusy && tierQueue.length === 0) {
      tierBusy = false;
      builtTier = camera.zoomTier;
    }
    if (camera.mode !== lastReportedMode) {
      lastReportedMode = camera.mode;
      cb.onModeChange(camera.mode);
    }
    effects.update(env);

    // —— 视图刷新（StarSystem 会替换数组引用）
    view.env = env;
    view.arcs = stars.arcs;
    view.marks = stars.marks;
    view.stars = stars.stars;
    view.beat = viewBeat;
    view.bands = bandLevels;
    view.selected = selectedId;
    view.hovered = hoveredId;
    view.focusId = camera.autoFocus ?? selectedId;

    // —— §18.4/§18.5/§18.7：器数环、气流、流星
    micro.update(env, view);
    air.update(env, view);
    sky.update(env);
    // —— §19.2：整机遥测 2s 一帧 → 平滑插值（只在整机视图推进；切回时由 applyView 重新对齐）
    if (currentView === 'system') plate.update(env);
    // —— v2.5 §24：百工盘面（芯片数据插值 / 严格 1Hz 节拍 / 240ms 线性进出；只在百工视图推进）
    if (currentView === 'processes') processes.update(env);
    // —— §22.4 机器运转 / §22.6 复合核心
    fx.update({ dt, now });
    core.update(env, view, beat.energy);
    // —— v2.4 §23.1：工作光流（用本帧最新的星位/仰角实时算路径，不缓存角度）
    workStreams.update(env, stars, viewBeat, dt, effects, tokenRate, toolRate);

    // —————————————————————————— 绘制
    const c = mainCtx;
    const dpr = env.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';

    const cfg = camera.cfg;
    const gdim = 0.2 + 0.8 * env.grow;
    const dim = cfg.dim * gdim;
    const dimOthers =
      camera.mode === 'dossier'
        ? 0.6
        : camera.mode === 'vigil'
          ? 0.34
          : camera.mode === 'ledger'
            ? 0.78
            : camera.mode === 'track'
              ? 0.88
              : 1;

    drawBackground(c, env);
    if (fleet?.source === 'demo' && quality > 0.5) drawDemoGrid(c, env);
    if (stars.stars.length === 0 && currentView === 'agents') drawQuietHorizon(c, env, 0.55 + 0.45 * gdim);

    const camOffX = camera.cam.x + camera.dragX;
    const camOffY = camera.cam.y + camera.dragY;
    // v2.2 深看性能：放大到 2.6× 以上时星野/尘埃几乎全在视野外或被裁切，整层跳过；
    // 缩放手势中（≥1.6×）也跳过星野（拉伸后的全屏 blit 感知不到）
    // v2.3 §22.2：星野层不硬跳过——手势/深看期靠 fxWeight 连续降权，避免亮度阶跃
    // （实测全屏 blit 并非本机 headless 的帧时瓶颈，硬淡出只会引入亮度跳变，故保持整层常绘）
    drawStarfield(c, env, starfield, camOffX * 0.7, camOffY * 0.7);
    drawDust(c, env, dust, camOffX * 0.9, camOffY * 0.9, 0.25 + 0.75 * clamp01(fxWeight));
    // §22.7 scifi 天穹：12.8px 极细网格（其他主题直接返回）
    drawSkyGrid(c, env);
    if (currentView === 'agents' && !viewTrans) sky.draw(c, env);

    const tickAlpha = clamp(0.5 + 0.5 * cfg.ticks, 0.35, 1) * gdim;
    // 观星盘面（世界层）
    const drawAgentsPlate = (alpha: number, reveal: number): void => {
      c.save();
      c.globalAlpha = clamp01(alpha);
      camera.apply(c, env);
      const d = dim * reveal;
      drawSectors(c, view, d, camera);
      drawOrbits(c, view, d);
      drawBands(c, view, d);
      // §22.4：外环分野弧数据流 + 事件脉冲（机器在运转）
      fx.drawStreams(c, view, d, camera);
      fx.drawPulses(c, view, d);
      drawHub(c, view, d);
      // §22.6：紫宫复合核心（L0–L5）
      core.draw(c, view, d);
      // v2.4 §23.1：星 → 中枢工作光流（在星体之下、核心之上）
      workStreams.draw(c, env, stars, d);
      stars.draw(c, view, dimOthers * gdim, view.focusId, camera);
      // §22.4：遣使/父子协作的贝塞尔弧 + 光包
      fx.drawLinks(c, env, dimOthers * gdim);
      effects.draw(c, view, dim);
      if (camera.mode === 'scan') drawScan(c, view, camera);
      drawTickDynamic(c, view, tickAlpha);
      // §21.1 跨档 180ms 交叉淡入：新旧两版同屏 alpha 总和恒定（§22.2 帧间亮度不跳）
      if (prevTickRing && now - tickFadeAt < 180) {
        const f = clamp01((now - tickFadeAt) / 180);
        drawTickRing(c, tickRing, tickAlpha * f);
        drawTickRing(c, prevTickRing, tickAlpha * (1 - f));
        if (f >= 1) prevTickRing = null;
      } else {
        drawTickRing(c, tickRing, tickAlpha);
      }
      // §20.2：宿名/时辰文字在世界空间按 1/zoom 反向缩放（不烘进静态层），6× 仍清晰
      drawTickLabels(c, view, gdim, camera);
      // §18.5 气流在授时环外；§18.4 器数环再外一圈
      air.draw(c, view, d * gdim);
      micro.draw(c, view, d * gdim);
      c.restore();
    };
    // 整机盘面（世界层：中枢/内存/磁盘/网络/进程/uptime）
    const drawSystemPlate = (alpha: number, reveal: number): void => {
      c.save();
      c.globalAlpha = clamp01(alpha);
      camera.apply(c, env);
      plate.draw(c, view, { alpha: 1, reveal });
      c.restore();
    };
    // 百工盘面（世界层：进程芯片 / 三轨 / 数据总线 / 机轴；无辉光、无暖金、无痕）
    const drawProcessesPlate = (alpha: number, reveal: number): void => {
      c.save();
      c.globalAlpha = clamp01(alpha);
      camera.apply(c, env);
      processes.draw(c, env, 1, reveal);
      c.restore();
    };

    const drawPlate = (kind: ViewKind, alpha: number, reveal: number, scale: number): void => {
      if (scale === 1) {
        if (kind === 'agents') drawAgentsPlate(alpha, reveal);
        else if (kind === 'processes') drawProcessesPlate(alpha, reveal);
        else drawSystemPlate(alpha, reveal);
        return;
      }
      c.save();
      c.translate(env.cx, env.cy);
      c.scale(scale, scale);
      c.translate(-env.cx, -env.cy);
      if (kind === 'agents') drawAgentsPlate(alpha, reveal);
      else if (kind === 'processes') drawProcessesPlate(alpha, reveal);
      else drawSystemPlate(alpha, reveal);
      c.restore();
    };

    // §19.4 换盘面：收缩 → 授时环单次扫光 → 新盘面展开（reduced-motion 160ms 交切）
    if (viewTrans) {
      const p = clamp01((now - viewTrans.start) / viewTrans.dur);
      if (reducedMotion) {
        if (p < 1) {
          drawPlate(viewTrans.from, 1 - p, 1, 1);
          drawPlate(viewTrans.to, p, 1, 1);
        }
      } else {
        if (p < 0.45) {
          const k = clamp01(p / 0.35);
          const fade = p < 0.35 ? 1 : clamp01(1 - (p - 0.35) / 0.1);
          drawPlate(viewTrans.from, (1 - 0.4 * k) * fade, 1, 1 - 0.06 * k);
        }
        if (p > 0.3 && p < 0.72) drawSweep(c, env, (p - 0.3) / 0.42);
        if (p >= 0.5) {
          const q = clamp01((p - 0.5) / 0.5);
          const e = easeInOutCubic(q);
          drawPlate(viewTrans.to, e, e, 0.94 + 0.06 * e);
        }
      }
      if (p >= 1) {
        const done = viewTrans.to;
        viewTrans = null;
        cb.onViewChange?.(done);
      }
    } else if (currentView === 'agents') {
      drawAgentsPlate(1, 1);
    } else if (currentView === 'processes') {
      const k = easeInOutCubic(env.grow);
      drawProcessesPlate(1, k);
      // §24.4：扫描线/无遥测提示是屏幕层（不进世界变换，1px 硬线不随缩放变粗）
      processes.drawScan(c, env, k, k);
    } else {
      drawSystemPlate(1, easeInOutCubic(env.grow));
    }

    // —— 辉光层（1/3 分辨率离屏 + 一次 blur + lighter 合成）
    // v2.3 §22.2：不随手势硬关；post.drawGlow 内按 env.fxWeight 连续降权（消除亮度阶跃）。
    // 手势期辉光软且面积小，隔帧合成——省一半全屏 lighter 合成（软件光栅热点），
    // 90ms 采样下亮度差 <1%，不会触发 qa-v23 brightness 的 8% 跳变阈值。
    glowTick += 1;
    const glowOn = quality >= 0.42 && params.glow > 0.02;
    const glowHot = !env.zooming || glowTick % 2 === 0;
    if (glowOn && glowHot && glowCtx && !viewTrans) {
      glowCtx.setTransform(glowScale, 0, 0, glowScale, 0, 0);
      glowCtx.globalCompositeOperation = 'source-over';
      glowCtx.globalAlpha = 1;
      glowCtx.clearRect(0, 0, env.w, env.h);
      glowCtx.save();
      camera.apply(glowCtx, env);
      if (currentView === 'agents') {
        stars.drawGlow(glowCtx, view, dimOthers * gdim, view.focusId, camera);
        effects.drawGlow(glowCtx, view, dim);
      } else if (currentView === 'system') {
        plate.drawGlow(glowCtx, view, 1);
      }
      // 百工盘面没有辉光：机械盘面只允许 1px 硬边（§24.1 / §24.7 反模式）
      glowCtx.restore();
      post.drawGlow(c, env, glowCanvas);
    }

    // —— 屏幕空间世界内标注（星名/引线 / 进程名 / 整机部件名）
    if (currentView === 'agents') stars.drawLabels(c, env, view, camera);
    else if (currentView === 'processes') processes.drawLabels(c, env, camera);
    else plate.drawLabels(c, env, camera);

    // —— 后期：暗角 + 颗粒 + 错误侧闪
    post.draw(c, env);
    effects.drawFlash(c, env);

    // —— §22.7 主题切换：canvas 400ms 颜色插值（旧帧快照压在新帧上淡出，不闪白、不硬切）
    if (themeFade) {
      const t = clamp01((now - themeFade.start) / themeFade.dur);
      if (t < 1) {
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalAlpha = 1 - t;
        c.imageSmoothingEnabled = true;
        c.drawImage(themeFade.canvas, 0, 0);
        c.globalAlpha = 1;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
      } else {
        themeFade = null;
      }
    }

    const drawMs = performance.now() - drawStart;
    lastSceneMs = drawMs;
    drawSamples.push(drawMs);
    if (drawSamples.length > 40) drawSamples.splice(0, drawSamples.length - 40);
    dtSamples.push(intervalMs);
    if (dtSamples.length > 90) dtSamples.splice(0, dtSamples.length - 90);

    // —— 统计上报 + 自适应降档
    if (now - lastStatsAt >= STATS_INTERVAL) {
      lastStatsAt = now;
      const avgDt = average(dtSamples);
      const avgDraw = average(drawSamples.slice(-30));
      cb.onStats({ fps: 1000 / Math.max(8, avgDt), frameMs: avgDraw, quality });
      if (avgDt > 22) {
        if (slowSince === 0) slowSince = now;
      } else {
        slowSince = 0;
      }
      if (slowSince > 0 && now - slowSince > 2000 && quality > 0.42 && now - lastDegradeAt > 4000) {
        quality = Math.max(0.42, quality - 0.2);
        lastDegradeAt = now;
        slowSince = 0;
        pendingResize = true;
      }
    }
  }

  // ———————————————————————————————— 指针交互

  const pointers = new Map<number, { x: number; y: number }>();
  let pressAt = 0;
  let dragMoved = false;
  let lastPX = 0;
  let lastPY = 0;
  let pinchDist = 0;
  let primaryPointer = -1;

  function localPoint(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function pickAt(x: number, y: number): string | null {
    return stars.pick(env, camera, x, y);
  }

  function applyPick(id: string | null, dossier: boolean): void {
    const now = performance.now();
    if (id) {
      selectedId = id;
      camera.autoFocus = id;
      camera.markManual(now);
      if (dossier) camera.setMode('dossier', { auto: false }, now);
    } else {
      selectedId = null;
      camera.markManual(now);
    }
    view.selected = selectedId;
    cb.onPick(id);
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = localPoint(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      primaryPointer = e.pointerId;
      pressAt = performance.now();
      dragMoved = false;
      lastPX = p.x;
      lastPY = p.y;
    }
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 某些环境不支持捕获，不影响点击 */
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      if (a && b) pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    camera.setPointer((p.x / Math.max(1, env.w)) * 2 - 1, (p.y / Math.max(1, env.h)) * 2 - 1);
    canvas.style.cursor = 'grabbing';
  }

  function onPointerMove(e: PointerEvent): void {
    const p = localPoint(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    camera.setPointer((p.x / Math.max(1, env.w)) * 2 - 1, (p.y / Math.max(1, env.h)) * 2 - 1);

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      if (a && b) {
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) {
          // §20.2 双指缩放锚点 = 两指中点
          camera.wheel(-(dist - pinchDist) * 6, performance.now(), env, (a.x + b.x) / 2, (a.y + b.y) / 2);
        }
        pinchDist = dist;
        dragMoved = true;
        camera.markManual(performance.now());
      }
      return;
    }

    if (e.pointerId === primaryPointer) {
      const dx = p.x - lastPX;
      const dy = p.y - lastPY;
      if (!dragMoved && Math.hypot(p.x - lastPX, p.y - lastPY) > 5) {
        dragMoved = true;
        camera.markManual(performance.now());
      }
      if (dragMoved) {
        camera.dragBy(dx, dy, env);
        lastPX = p.x;
        lastPY = p.y;
        return;
      }
    }
    // hover 勘验（触控不显示 hover）
    if (pointers.size === 0 && e.pointerType === 'mouse') {
      if (currentView === 'processes') {
        // v2.5 §24.8：百工盘面只做芯片拾取（无星、无引线）
        const proc = processes.hoverAt(env, camera, p.x, p.y);
        canvas.style.cursor = proc ? 'pointer' : 'grab';
        return;
      }
      if (currentView === 'system') {
        const proc = plate.hoverAt(env, camera, p.x, p.y);
        plate.hoverPid = proc ? proc.pid : null;
        canvas.style.cursor = proc ? 'pointer' : 'grab';
        return;
      }
      const id = pickAt(p.x, p.y);
      if (id !== hoveredId) {
        hoveredId = id;
        view.hovered = id;
      }
      canvas.style.cursor = id ? 'pointer' : 'grab';
    }
  }

  function onPointerUp(e: PointerEvent): void {
    const wasPrimary = e.pointerId === primaryPointer;
    pointers.delete(e.pointerId);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (pointers.size < 2) pinchDist = 0;
    if (wasPrimary) {
      const p = localPoint(e);
      const quick = performance.now() - pressAt < 520;
      if (!dragMoved && quick && currentView === 'agents') {
        const id = pickAt(p.x, p.y);
        applyPick(id, false);
      } else if (!dragMoved && quick && currentView === 'processes') {
        // v2.5 §24.8：点芯片 = 选中（同步给装配层 → HUD「工籍」展开）
        const pid = processes.pick(env, camera, p.x, p.y);
        processes.setSelected(pid);
        camera.markManual(performance.now());
        cb.onPickProcess?.(pid);
      }
      primaryPointer = -1;
      camera.endDrag();
      canvas.style.cursor = hoveredId ? 'pointer' : 'grab';
    }
  }

  function onPointerLeave(): void {
    pointers.clear();
    pinchDist = 0;
    primaryPointer = -1;
    camera.endDrag();
    if (hoveredId !== null) {
      hoveredId = null;
      view.hovered = null;
    }
    processes.hoverPid = null;
    canvas.style.cursor = 'grab';
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    // §20.2：滚轮缩放锚点 = 光标位置（保持光标下世界点不动）
    const p = localPoint(e);
    camera.wheel(e.deltaY, performance.now(), env, p.x, p.y);
  }

  function onDblClick(e: MouseEvent): void {
    const p = localPoint(e);
    // v2.5 §24.8：百工盘面双击芯片 = 选中该进程；双击空白 = 复位取景
    if (currentView === 'processes') {
      const pid = processes.pick(env, camera, p.x, p.y);
      if (pid !== null) {
        processes.setSelected(pid);
        cb.onPickProcess?.(pid);
        return;
      }
    }
    const id = pickAt(p.x, p.y);
    if (id) applyPick(id, true);
    // §20.2：双击空白 = 复位（zoom 1.0 / pan 归零 / 云图）+ 清当前视图的视野记忆
    else {
      const now = performance.now();
      camera.resetZoom(now);
      camera.setMode('survey', { auto: false }, now);
      // 复位后清当前视图的视野记忆，并取消被 lock 顺带排上的保存（否则默认视野又被写回）
      cancelCameraSave();
      clearCameraMemory(currentView);
    }
  }

  function onWindowResize(): void {
    pendingResize = true;
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('resize', onWindowResize);

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      pendingResize = true;
    });
    resizeObserver.observe(container);
  }

  // —— 首帧前先量一次，保证 setFleet 前 env.R 已就绪
  measure();
  rebuildCaches();
  if (currentView === 'system') {
    camera.setStaticZoom(0.98);
    camera.setStaticFrame(true);
  } else if (currentView === 'processes') {
    camera.setViewLimits(0.8, 4.0, 0.8);
    camera.setStaticZoom(1.0);
    camera.setStaticFrame(true);
  }
  // §20.3：刷新恢复上次视野（先恢复，URL 的 ?view 已通过 opts.view 生效，故 URL 优先）
  const restored = loadCameraMemory();
  if (restored) restoreSavedCamera(restored);

  // ———————————————————————————————— 对外句柄

  const handle: SceneHandle = {
    frame,
    setFleet(snap: ClientFleetSnapshot): void {
      if (disposed) return;
      applyFleet(snap);
    },
    pushEvents(events: AstroEvent[]): void {
      if (disposed || events.length === 0) return;
      for (const event of events) {
        if (pendingEvents.length >= MAX_PENDING_EVENTS) pendingEvents.shift();
        pendingEvents.push(event);
      }
    },
    setMode(mode: ViewMode, modeOpts?: { immediate?: boolean; auto?: boolean }): void {
      if (disposed) return;
      camera.setMode(mode, modeOpts, performance.now());
    },
    setSelection(id: string | null): void {
      if (disposed) return;
      selectedId = id;
      camera.autoFocus = id;
      view.selected = id;
      if (!id) camera.setSectorFocus(null, performance.now());
    },
    /** §18.3/§18.9：分野聚焦（HUD 分野总览点击），null = 回全局取景 */
    focusSector(sectorId: string | null): void {
      if (disposed) return;
      const now = performance.now();
      if (!sectorId) {
        camera.setSectorFocus(null, now);
        return;
      }
      const arc = stars.arcs.find((a) => a.id === sectorId);
      if (!arc) return;
      const ang = env.skyRot + arc.start + arc.span / 2;
      const rr = env.R * GEOM.labelR;
      camera.autoFocus = null;
      camera.setSectorFocus({ x: Math.sin(ang) * rr, y: -Math.cos(ang) * rr, label: arc.name }, now);
    },
    /** §19.4：换盘面（智能体观星 ⇄ 整机仪象），620ms 转场，reduced-motion 160ms */
    setView(next: ViewKind): void {
      if (disposed) return;
      applyView(next);
    },
    /** §19.2：整机遥测快照（2s 一帧，damp 插值）；null = 尚未收到 */
    setSystem(snapshot: SystemSnapshot | null): void {
      if (disposed) return;
      systemSnapshot = snapshot;
      plate.setSystem(snapshot);
      processes.setSystem(snapshot);
    },
    /** §19.1：来源筛选；null = 全部来源 */
    setSourceFilter(sourceId: string | null): void {
      if (disposed) return;
      sourceFilter = sourceId;
      env.sourceFilter = sourceId;
    },
    /** QA 验收：当前星数 / 视口内可见星数 / 相机 zoom / 模式（卫星也算星：每个 agent 都是星） */
    debugInfo(): {
      stars: number;
      visibleStars: number;
      zoom: number;
      mode: ViewMode;
      view?: ViewKind;
      sectors?: number;
      sourceFilter?: SourceId | null;
      autoEnabled?: boolean;
      manualLocked?: boolean;
      dragX?: number;
      dragY?: number;
      textScale?: number;
      textScreen?: number;
    } {
      let total = 0;
      let visible = 0;
      for (const st of stars.stars) {
        const appear = st.appear * (1 - (st.vanishStep ?? 0));
        total += 1;
        const p = camera.worldToScreen(env, Math.sin(st.angle) * st.radius, -Math.cos(st.angle) * st.radius);
        if (appear > 0.5 && p.x >= 0 && p.x <= env.w && p.y >= 0 && p.y <= env.h) visible += 1;
        for (const sat of st.satellites) {
          total += 1;
          const sp = stars.satellitePos(st, sat);
          const q = camera.worldToScreen(env, sp.x, sp.y);
          if (sat.appear * appear > 0.5 && q.x >= 0 && q.x <= env.w && q.y >= 0 && q.y <= env.h) visible += 1;
        }
      }
      return {
        stars: total,
        visibleStars: visible,
        zoom: camera.cam.zoom,
        mode: camera.mode,
        view: currentView,
        sectors: stars.arcs.length,
        sourceFilter,
        // §20.1：自动运镜是否真正在跑（默认关 · 手动锁 · Space 才开）
        autoEnabled: params.autoDirector > 0.5 && !autoPaused && !camera.manualLocked && !camera.staticFrame,
        manualLocked: camera.manualLocked,
        dragX: camera.dragX,
        dragY: camera.dragY,
        // v2.4.1：世界内文字的反向系数 / 屏幕上实际看到的字号倍数（zoom 越大 → 字越大，不缩小）
        textScale: textScale(env),
        textScreen: textScreenGrow(env),
      };
    },
    /** v2.2 验收（§21.2）：轨道层速 / 星数 / 当前最小圆心距 / 星游速比 */
    debugOrbits(): {
      zones: Array<{ index: number; speed: number }>;
      stars: number;
      minPairDist: number;
      speedSpread: number;
    } {
      return stars.debugOrbits();
    },
    /** v2.3 验收（§22.1）：运动稳定性（200 帧窗口：teleport 次数 / alpha 单帧最大跳变 / 均亮度） */
    debugMotion(): { teleports: number; maxAlphaStep: number; frames: number; brightness: number } {
      return stars.debugMotion();
    },
    /** v2.3 验收（§22.4）：机器运转（协作弧/光包/分野脉冲/出生计数/数据流/核心层数） */
    debugFx(): {
      links: number;
      packets: number;
      sectorFx: number;
      spawns: number;
      streams: number;
      coreNodes: number;
    } {
      const s = fx.stats;
      return {
        links: s.links,
        packets: s.packets,
        sectorFx: s.sectorFx,
        spawns: s.spawns,
        streams: s.streams,
        coreNodes: core.nodeCount,
      };
    },
    /** v2.3 验收（§22.3）：径向层级（权重↔半径的 Spearman / 内外平均权重） */
    debugHierarchy(): { spearman: number; innerAvgWeight: number; outerAvgWeight: number; stars: number } {
      return stars.debugHierarchy();
    },
    /** v2.8 验收（§27.1）：星体新鲜度尺寸（近期/久置组平均倍数、跨组比、单帧最大变化） */
    debugStarFreshness(): {
      recentAvg: number;
      oldAvg: number;
      ratio: number;
      maxStepRatio: number;
      stars: number;
    } {
      return stars.debugStarFreshness();
    },
    /** v2.4 验收（§23）：工作光流 / 工具光束改锚 / 随势旋转 / 单帧 scene 耗时 */
    debugStreams(): StreamsDebug {
      const s = workStreams.stats;
      return {
        active: s.active,
        connecting: s.connecting,
        disconnecting: s.disconnecting,
        packets: s.packets,
        toolBeams: effects.beamCount,
        toolBeamsFromStream: effects.beamFromStream,
        ringSpeed: theme === 'scifi' ? scifiDyn : 1,
        ringSpeedBase: ringBaseSlow,
        beamColor: BEAM_TINT.tool,
        sceneMs: lastSceneMs,
      };
    },
    /** v2.5 §24.8：选中进程（HUD「工籍」行 / Esc 清选都走这里；不回传装配层，避免回声） */
    selectProcess(pid: number | null): void {
      if (disposed) return;
      processes.setSelected(pid);
    },
    /** v2.5 验收（§24）：百工盘面实测值（芯片/轨道/流线/节拍/总线速/选中） */
    debugProcesses(): ProcessesDebug {
      const s = processes.stats;
      return { ...s, mode: currentView, sceneMs: lastSceneMs };
    },
    /** §22.7 双主题：调色板由 main 的 applyTheme 写入 tokens；这里做 400ms 画布颜色插值与内部差异化 */    setTheme(next: ThemeId): void {
      if (disposed || next === theme) return;
      // 先把旧主题的当前画面抓成快照，新帧压上去 400ms 淡出（颜色插值，不闪白、不硬切）
      try {
        const snap = themeFade?.canvas ?? doc.createElement('canvas');
        snap.width = Math.max(1, Math.round(env.w * env.dpr));
        snap.height = Math.max(1, Math.round(env.h * env.dpr));
        const sg = snap.getContext('2d');
        if (sg) {
          sg.clearRect(0, 0, snap.width, snap.height);
          sg.drawImage(canvas, 0, 0);
          themeFade = { canvas: snap, start: performance.now(), dur: reducedMotion ? 160 : 400 };
        }
      } catch {
        themeFade = null;
      }
      theme = next;
      env.theme = next;
      cacheKey = '';
      pendingRebuild = true;
    },
    /** v2.1 §20.1：Space 开锁（仅 main 调用）→ 之后事件可再抢镜 */
    releaseViewLock(): void {
      if (disposed) return;
      camera.releaseViewLock(performance.now());
    },
    /** v2.1 验收：世界坐标 → 屏幕坐标（CSS px） */
    projectPoint(x: number, y: number): { x: number; y: number } {
      return camera.worldToScreen(env, x, y);
    },
    /** v2.1 验收：屏幕坐标 → 世界坐标 */
    unprojectPoint(x: number, y: number): { x: number; y: number } {
      return camera.screenToWorld(env, x, y);
    },
    setParams(next: VisualParams): void {
      if (disposed) return;
      params = clampParams({ ...next });
      camera.setParams(params);
      env.params = params;
      pendingRebuild = true;
    },
    setAutoPaused(paused: boolean): void {
      autoPaused = paused;
      camera.setAutoPaused(paused, performance.now());
    },
    setReducedMotion(reduced: boolean): void {
      reducedMotion = reduced;
      camera.setReducedMotion(reduced);
      env.reducedMotion = reduced;
      pendingRebuild = true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (saveTimer !== 0) {
        window.clearTimeout(saveTimer);
        saveTimer = 0;
      }
      resizeObserver?.disconnect();
      resizeObserver = null;
      window.removeEventListener('resize', onWindowResize);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
      pendingEvents.length = 0;
      pointers.clear();
      post.dispose();
      canvas.remove();
      fleet = null;
    },
  };

  void autoPaused;
  void lerp;
  void TAU;

  return handle;
}

/** §19.4 换盘面扫光：授时环上的一次单向扫光（只此一次，不循环）。q=0..1 */
function drawSweep(ctx: CanvasRenderingContext2D, env: Env, q: number): void {
  const a = -Math.PI / 2 + clamp01(q) * TAU;
  const rIn = env.R * GEOM.tickIn;
  const rOut = env.R * GEOM.tickOut;
  ctx.save();
  ctx.translate(env.cx, env.cy);
  // 扫过的弧带：窄的一段，随扫光前进
  ctx.strokeStyle = withAlpha(COLORS.gold300, 0.2);
  ctx.lineWidth = rOut - rIn;
  ctx.beginPath();
  ctx.arc(0, 0, (rIn + rOut) / 2, a - 0.22, a + 0.015);
  ctx.stroke();
  // 前缘与外/内沿
  ctx.strokeStyle = withAlpha(COLORS.gold100, 0.8);
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.arc(0, 0, rOut, a - 0.26, a + 0.02);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, rIn, a - 0.2, a + 0.02);
  ctx.stroke();
  ctx.restore();
}

/** demo 数据源的星野极淡网格（§10 状态矩阵：demo 与 live 可区分）。 */
function drawDemoGrid(ctx: CanvasRenderingContext2D, env: Env): void {
  const step = env.mobile ? 64 : 96;
  ctx.save();
  ctx.strokeStyle = 'rgba(143,160,184,0.045)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let x = (env.w % step) / 2; x < env.w; x += step) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, env.h);
  }
  for (let y = (env.h % step) / 2; y < env.h; y += step) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(env.w, Math.round(y) + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}
