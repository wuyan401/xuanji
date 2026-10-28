// XUANJI · 璇玑 — 应用装配层。
// 职责：读 URL/存储 → 建 store → 建 scene/hud → 接事件 → 全局键盘 → 单一 rAF 循环。
// 不画任何像素（canvas 在 scene，DOM 文本在 hud），本文件只做接线与生命周期。

import './design/fonts.css';
import './design/tokens.css';
import './design/themes.css';
import { FleetStore } from './state/store';
import type {
  ClientFleetSnapshot,
  ConnectionState,
  SystemSnapshot,
  ViewKind,
  ViewMode,
} from './state/types';
import { VIEW_KIND_LABEL, VIEW_KIND_ORDER, VIEW_MODE_LABEL, VIEW_MODE_ORDER } from './state/types';
import {
  applyUrlParamOverrides,
  applyUrlPreset,
  clampParams,
  loadParams,
  saveParams,
  type VisualParams,
} from './design/params';
import { createScene } from './scene';
import { createHud } from './hud';
import type { FrameStats, HudHandle, SceneHandle } from './app/contracts';
import {
  applyTheme,
  isThemeId,
  loadTheme,
  nextTheme,
  saveTheme,
  THEME_LABEL,
  type ThemeId,
} from './design/themes';

interface AppUrl {
  params: VisualParams;
  skipBoot: boolean;
  hideHud: boolean;
  showStats: boolean;
  demo: boolean;
  reducedMotion: boolean;
  reducedQuality: boolean;
  /** 顶层视图：?view=system 直接进整机仪象 */
  view: ViewKind;
  /** v2.3 主题：?theme=xuanji|scifi，否则读 localStorage，默认璇玑 */
  theme: ThemeId;
}

function readUrl(): AppUrl {
  const search = window.location.search;
  const sp = new URLSearchParams(search);
  const mediaReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const quality = sp.get('quality');
  const themeParam = sp.get('theme');
  return {
    params: applyUrlParamOverrides(applyUrlPreset(clampParams(loadParams()), search), search),
    skipBoot: sp.get('boot') === '0',
    hideHud: sp.get('hud') === '0',
    showStats: sp.get('stats') === '1',
    demo: sp.get('demo') === '1',
    reducedMotion: mediaReduced || sp.get('motion') === 'off',
    reducedQuality: quality === 'low' || mediaReduced,
    view: sp.get('view') === 'system' ? 'system' : sp.get('view') === 'processes' ? 'processes' : 'agents',
    theme: isThemeId(themeParam) ? themeParam : loadTheme(),
  };
}

const INLINE_CSS = `
.astra-stats {
  position: fixed; left: 12px; bottom: 12px; z-index: 60;
  font: 11px/1.6 var(--font-mono, monospace);
  color: var(--bone-400, #8d8778);
  background: rgba(4,6,10,.72);
  border: 1px solid var(--ink-line, rgba(196,178,138,.16));
  padding: 6px 9px; white-space: pre; pointer-events: none; letter-spacing: .02em;
}
.astra-toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  z-index: 70; max-width: min(76vw, 640px);
  font: 12px/1.6 var(--font-mono, monospace); color: var(--bone-100, #efe9d8);
  background: rgba(7,11,18,.9); border: 1px solid var(--ink-line-strong, rgba(196,178,138,.34));
  padding: 8px 14px; opacity: 0; transition: opacity .22s ease;
  pointer-events: none; letter-spacing: .02em;
}
.astra-toast[data-show="1"] { opacity: 1; }
`;

function boot(): void {
  const url = readUrl();
  const app = document.getElementById('app');
  const stage = document.getElementById('stage');
  const hudRoot = document.getElementById('hud');
  if (!app || !stage || !hudRoot) throw new Error('index.html 缺少 #app / #stage / #hud');

  const styleEl = document.createElement('style');
  styleEl.textContent = INLINE_CSS;
  document.head.appendChild(styleEl);

  let params = url.params;
  saveParams(params);

  // v2.3 主题：必须先于 scene/hud 创建（canvas palette 由此改写）
  let theme: ThemeId = url.theme;
  applyTheme(theme);

  // ---- scene / hud 稍后创建；先声明句柄，回调里引用 ----
  let scene: SceneHandle;
  let hud: HudHandle;

  let selectedId: string | null = null;
  /** v2.1 视野主权（BIBLE §20）：默认由参数决定是否自动运镜；默认关。 */
  let autoPaused = params.autoDirector < 0.5;
  /** 顶层视图：智能体浑仪 / 整机仪象 / 百工器群 */
  let view: ViewKind = url.view;
  /** 来源筛选（null = 全部） */
  let sourceFilter: string | null = null;
  /** v2.5 百工视图：选中的进程 pid（null = 未选） */
  let selectedPid: number | null = null;

  function toast(text: string): void {
    hud.showToast(text);
  }

  function selectSession(id: string | null): void {
    if (selectedId === id) return;
    selectedId = id;
    // v2.1：点星/账本行也是手动取景 —— 锁死自动导播，别把镜头抢走
    if (id !== null && !autoPaused) setAutoPaused(true);
    store.setSelectedId(id);
    scene?.setSelection(id);
    hud?.setSelection(id);
    const s = id ? store.getSession(id) : null;
    if (s) toast(`${s.title} — ${s.workspace}`);
  }

  function setMode(mode: ViewMode, fromUser = true): void {
    scene?.setMode(mode, { auto: !fromUser });
    hud?.setMode(mode);
    if (fromUser) {
      // v2.1：手动切机位 = 手动取景，锁死自动导播（§20.1）
      if (!autoPaused) setAutoPaused(true);
      else toast(`已切至「${VIEW_MODE_LABEL[mode]}」· Space 恢复自动运镜`);
    }
  }

  function setAutoPaused(paused: boolean): void {
    if (autoPaused === paused) return;
    autoPaused = paused;
    scene?.setAutoPaused(paused);
    hud?.setAutoPaused(paused);
    if (!paused) {
      // Space 放开：把「自动运镜」参数真正打开，并解除视野锁
      params = clampParams({ ...params, autoDirector: 1 });
      saveParams(params);
      scene?.setParams(params);
      hud?.setParams(params, { silent: true });
      scene?.releaseViewLock?.();
      toast('自动运镜 · 开（Space 可关）');
    } else {
      toast('视野已锁定 · Space 恢复自动运镜');
    }
  }

  /** 切换顶层视图（智能体 → 整机 → 百工，0 键循环）。scene 负责 620ms 推拉，HUD 换铭牌。 */
  function setView(next: ViewKind): void {
    if (view === next) return;
    view = next;
    scene?.setView?.(next);
    hud?.setView?.(next);
    if (next === 'agents') {
      toast(`${VIEW_KIND_LABEL.agents} · 本机全 agent`);
      return;
    }
    const sys = store.getSystem();
    scene?.setSystem?.(sys);
    hud?.setSystem?.(sys);
    if (next === 'system') {
      toast(sys.available ? '整机仪象 · 处理器 / 内存 / 磁盘 / 网络' : '整机仪象 · 遥测不可用');
    } else {
      // v2.5 百工：全进程机械化盘面
      scene?.selectProcess?.(selectedPid);
      hud?.setProcessSelection?.(selectedPid);
      toast(sys.available ? '百工 · 全进程运转 · 无悲无喜，只按指令' : '百工 · 进程遥测不可用');
    }
  }

  /** v2.5 百工视图：进程选中（场景芯片 ⇄ 《工籍》行 双向同步）。 */
  function selectProcess(pid: number | null): void {
    if (selectedPid === pid) return;
    selectedPid = pid;
    scene?.selectProcess?.(pid);
    hud?.setProcessSelection?.(pid);
  }

  function setSourceFilter(sourceId: string | null): void {
    if (sourceFilter === sourceId) return;
    sourceFilter = sourceId;
    scene?.setSourceFilter?.(sourceId);
    hud?.setSourceFilter?.(sourceId);
  }

  /** v2.3 主题切换（T 键 / 顶栏铭牌 / URL）。canvas 调色由 applyTheme 改写 tokens，DOM 由 data-theme 驱动。 */
  function setTheme(next: ThemeId): void {
    if (theme === next) return;
    theme = next;
    applyTheme(theme);
    saveTheme(theme);
    scene?.setTheme?.(theme);
    hud?.setTheme?.(theme);
    toast(`主题 · ${THEME_LABEL[theme]}${theme === 'scifi' ? '（深空 · 舰桥仪表）' : '（青铜史书）'}`);
  }

  const store = new FleetStore('/api/stream', { demo: url.demo });

  scene = createScene(
    stage,
    {
      params,
      reducedMotion: url.reducedMotion,
      reducedQuality: url.reducedQuality,
      view: url.view,
      theme,
    },
    {
      onPick: (id) => selectSession(id),
      onPickProcess: (pid) => selectProcess(pid),
      onModeChange: (mode) => hud?.setMode(mode),
      onStats: (stats) => hud?.setStats(stats),
      onNotice: (text) => toast(text),
      onViewChange: (next) => hud?.setView?.(next),
      // v2.1：任何手动取景（滚轮/拖拽/双击/分野聚焦）→ 锁死自动导播
      onManualView: () => {
        if (!autoPaused) setAutoPaused(true);
      },
    },
  );

  hud = createHud(
    hudRoot,
    { params, reducedMotion: url.reducedMotion, skipBoot: url.skipBoot, view: url.view, theme },
    {
      onSelectSession: (id) => selectSession(id),
      onSelectSector: (sectorId) => {
        scene?.focusSector?.(sectorId);
        if (sectorId) {
          // v2.1：聚焦分野 = 手动取景，锁死自动导播
          if (!autoPaused) setAutoPaused(true);
          const sec = store.getSectors().find((s) => s.id === sectorId);
          if (sec) toast(`分野聚焦 · ${sec.name}（${sec.sessionIds.length} 位）`);
        }
      },
      onViewRequest: (next) => setView(next),
      onSourceFilter: (sourceId) => setSourceFilter(sourceId),
      onThemeRequest: (next) => setTheme(next),
      onSelectProcess: (pid) => selectProcess(pid),
      onModeRequest: (mode) => setMode(mode),
      onParamsChange: (next) => {
        params = clampParams(next);
        saveParams(params);
        scene.setParams(params);
      },
      onPauseAutoChange: (paused) => setAutoPaused(paused),
      onNotice: (text) => toast(text),
    },
  );

  if (url.hideHud) {
    document.documentElement.dataset.hud = 'off';
    hudRoot.style.display = 'none';
  }

  // ---- 数据接线 ----
  store.onFleet((snap: ClientFleetSnapshot) => {
    scene.setFleet(snap);
    hud.setFleet(snap);
  });
  store.onEvents((events) => {
    scene.pushEvents(events);
    hud.pushEvents(events);
  });
  store.onConnection((state: ConnectionState) => hud.setConnection(state));
  store.onSystem((sys: SystemSnapshot) => {
    scene.setSystem?.(sys);
    hud.setSystem?.(sys);
  });

  // 初始推送：不等第一条 SSE 帧，先把当前视图/遥测塞给两个模块
  const initialSystem = store.getSystem();
  scene.setView?.(view);
  hud.setView?.(view);
  scene.setSystem?.(initialSystem);
  hud.setSystem?.(initialSystem);

  // v2.1：把 scene 静默恢复/初始化的机位与视野锁同步给 HUD（不触发转场）
  const bootInfo = scene.debugInfo?.();
  if (bootInfo?.mode) hud.setMode(bootInfo.mode);
  hud.setAutoPaused(autoPaused);

  // ---- 统计覆层（QA 用，独立于 HUD 实现） ----
  const statsEl = document.createElement('div');
  statsEl.className = 'astra-stats';
  statsEl.setAttribute('aria-hidden', 'true');
  app.appendChild(statsEl);
  let statsVisible = url.showStats;
  statsEl.style.display = statsVisible ? 'block' : 'none';

  function toggleStats(): void {
    statsVisible = !statsVisible;
    statsEl.style.display = statsVisible ? 'block' : 'none';
  }

  // ---- HUD 隐藏（壁纸模式） ----
  function toggleHud(): void {
    const off = document.documentElement.dataset.hud !== 'off';
    document.documentElement.dataset.hud = off ? 'off' : 'on';
    hudRoot!.style.display = off ? 'none' : '';
    if (!off) toast('HUD 已恢复');
  }

  // ---- 全局键盘 ----
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (hud.handleKey(e)) return;

      const digit = /^Digit([1-7])$/.exec(e.code);
      if (digit) {
        e.preventDefault();
        if (view !== 'agents') {
          toast(`${VIEW_KIND_LABEL[view]}视图只有缩放 · 0 返回观星`);
          return;
        }
        setMode(VIEW_MODE_ORDER[Number(digit[1]) - 1], true);
        return;
      }
      if (e.code === 'Digit0' || e.code === 'Numpad0') {
        e.preventDefault();
        // 0 循环切换：智能体 → 整机 → 百工 → 智能体
        const at = VIEW_KIND_ORDER.indexOf(view);
        setView(VIEW_KIND_ORDER[(at + 1) % VIEW_KIND_ORDER.length]);
        return;
      }
      if (e.code === 'Escape') {
        if (selectedId) {
          e.preventDefault();
          selectSession(null);
        } else if (selectedPid !== null) {
          e.preventDefault();
          selectProcess(null);
        }
        return;
      }
      if (e.code === 'Enter' && selectedId) {
        e.preventDefault();
        setMode('dossier', true);
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        setAutoPaused(!autoPaused);
        return;
      }
      if (e.code === 'Backquote') {
        e.preventDefault();
        toggleStats();
        return;
      }
      if (e.code === 'KeyW') {
        e.preventDefault();
        toggleHud();
        return;
      }
      // v2.3 主题切换：璇玑 ⇄ 深空
      if (e.code === 'KeyT' && !e.shiftKey) {
        e.preventDefault();
        setTheme(nextTheme(theme));
      }
    },
    { passive: false },
  );

  // ---- reduced motion 动态跟随 ----
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (ev) => {
    scene.setReducedMotion(ev.matches);
    hud.setReducedMotion(ev.matches);
  });

  // ---- 单一 rAF 循环 ----
  let last = performance.now();
  let lastHiddenFrame = 0;
  let samples: number[] = [];
  let lastSampleAt = 0;
  let reportedStatsAt = 0;

  function frame(now: number): void {
    requestAnimationFrame(frame);
    const dt = now - last;
    last = now;

    if (document.hidden) {
      if (now - lastHiddenFrame < 250) return;
      lastHiddenFrame = now;
    }

    const frameStart = performance.now();
    scene.frame(now);
    const frameMs = performance.now() - frameStart;

    if (now - lastSampleAt > 250) {
      lastSampleAt = now;
      samples.push(frameMs);
      if (samples.length > 40) samples = samples.slice(-40);
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;

      if (statsVisible) {
        const sys = store.getSystem();
        statsEl.textContent = [
          `fps    ${(1000 / Math.max(1, dt)).toFixed(0).padStart(4)}`,
          `frame  ${avg.toFixed(2)}ms  peak ${Math.max(...samples).toFixed(2)}ms`,
          `agents ${store.getSessions().length}   events ${store.getEvents().length}`,
          `conn   ${store.getConnection()}   source ${store.getSnapshot().source}`,
          `view   ${view}   sys ${sys.available ? `cpu ${(sys.cpu.usage * 100).toFixed(0)}%` : '—'}   procs ${sys.procs?.length ?? 0}${selectedPid !== null ? ` sel ${selectedPid}` : ''}`,
          `auto   ${autoPaused ? 'paused' : 'on'}   theme ${theme}`,
        ].join('\n');
      }
      if (now - reportedStatsAt > 500) {
        reportedStatsAt = now;
        hud.setStats({ fps: 1000 / Math.max(1, dt), frameMs: avg, quality: 1 });
      }
    }
  }
  requestAnimationFrame(frame);

  // ---- 清理 ----
  window.addEventListener('beforeunload', () => {
    scene.dispose();
    hud.dispose();
    store.dispose();
  });

  // ---- 全局异常兜底 ----
  let lastErrorAt = 0;
  function reportError(msg: string): void {
    const now = Date.now();
    if (now - lastErrorAt < 8000) return;
    lastErrorAt = now;
    toast(`运行异常：${msg}`);
    console.error('[astra]', msg);
  }
  window.addEventListener('error', (ev) => reportError(ev.message || 'unknown error'));
  window.addEventListener('unhandledrejection', (ev) => {
    reportError(String((ev.reason as { message?: string } | undefined)?.message ?? ev.reason));
  });

  store.connect();

  // 调试入口（QA / 截图自动化用）
  Object.assign(window as unknown as Record<string, unknown>, {
    __astra: {
      store,
      scene,
      hud,
      get params() {
        return params;
      },
      get view() {
        return view;
      },
      get sourceFilter() {
        return sourceFilter;
      },
      get theme() {
        return theme;
      },
      getSystem: () => store.getSystem(),
      getSystemHistory: () => store.getSystemHistory(),
      getTheme: () => theme,
      getProcessSelection: () => selectedPid,
      selectProcess,
      selectSession,
      setMode,
      setView,
      setSourceFilter,
      setTheme,
      setThemeById: (t: string) => {
        if (isThemeId(t)) setTheme(t);
      },
      toggleStats,
      toggleHud,
    },
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
