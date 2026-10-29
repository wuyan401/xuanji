// XUANJI · 璇玑 — HUD 总装：授时 / 顶栏 /《起居注》/ 星牒 / 调参台 / 帮助 / 短告 / 状态矩阵
// 契约见 app/contracts.ts；数据只来自 setFleet / pushEvents，界面不编造任何数字。
import type {
  FrameStats,
  HudCallbacks,
  HudHandle,
  HudInitOptions,
} from '../app/contracts';
import type {
  AstroEvent,
  ClientFleetSnapshot,
  ConnectionState,
  SourceKind,
  SystemSnapshot,
  ToolCategory,
  ViewKind,
  ViewMode,
} from '../state/types';
import { TOOL_CATEGORY_LABEL, VIEW_KIND_LABEL, VIEW_MODE_LABEL, VIEW_MODE_ORDER } from '../state/types';
import type { VisualParams } from '../design/params';
import { THEME_LABEL, type ThemeId } from '../design/themes';
import { el, setText } from '../lib/dom';
import { truncate } from '../lib/format';
import { createBoot } from './boot';
import { createConsole } from './console';
import { createDossier } from './dossier';
import { createHelp } from './help';
import { createLedger } from './ledger';
import { createProcPanel } from './proc-panel';
import { createProcessDetail } from './process-detail';
import { createProcessList } from './process-list';
import { createSystemPanel } from './system-panel';
import { createToasts } from './toast';
import { createTopbar } from './topbar';
import { isEditableTarget } from './ui';
import { isDesktopViewport, loadFold, saveFold, type FoldPanelKey } from './panel-fold';

import '../styles/hud.css';
import '../styles/ledger.css';
import '../styles/dossier.css';
import '../styles/console.css';
import '../styles/help.css';
import '../styles/boot.css';
import '../styles/view2.css';
import '../styles/theme.css';
import '../styles/process.css';
import '../styles/fold.css';

const MODE_CN = ['壹', '贰', '叁', '肆', '伍', '陆', '柒'];
const HINT_MOBILE = 'Space 自动运镜 · 滚轮缩放 · 双击复位 · [ ] 面板';
const HINT_PROCESS_SHORT = '0 切视图 · ↑↓ 择进程 · Esc 清选 · [ ] 面板';
const COLLECTOR = '127.0.0.1:8787';

/** v2.1 视野主权（BIBLE §20.4）：提示行实时反映自动运镜开关。v2.5 百工视图换进程键位。v2.9 加面板收放键。 */
function hintKeysFor(view: ViewKind, paused: boolean): string {
  const auto = `Space 自动运镜（${paused ? '关' : '开'}）`;
  if (view === 'processes') return '0 切视图　↑↓ 择进程　Esc 清选　[ ] 面板　滚轮 缩放　? 快捷键';
  return view === 'system'
    ? `0 观星　${auto}　[ ] 面板　滚轮 对准缩放 · 双击 复位　? 快捷键`
    : `↑↓ 择星　Enter 勘验　L 起居注　[ ] 面板　/ 调参　${auto}　滚轮 对准缩放 · 双击 复位　? 快捷键`;
}

function emptyToolCounts(): Record<ToolCategory, number> {
  return { read: 0, write: 0, exec: 0, net: 0, agent: 0 };
}

function toolCountsOf(snap: ClientFleetSnapshot | null): Record<ToolCategory, number> {
  const out = emptyToolCounts();
  if (!snap) return out;
  for (const session of snap.sessions) {
    for (const cat of Object.keys(out) as ToolCategory[]) {
      out[cat] += session.toolCounts?.[cat] ?? 0;
    }
  }
  return out;
}

export function createHud(
  container: HTMLElement,
  opts: HudInitOptions,
  cb: HudCallbacks,
): HudHandle {
  container.classList.add('xj-hud');
  if (!container.hasAttribute('data-reduced')) {
    container.dataset.reduced = opts.reducedMotion ? 'true' : 'false';
  }

  // ── 状态 ────────────────────────────────────────────────────
  let fleet: ClientFleetSnapshot | null = null;
  let hasFleet = false;
  let selection: string | null = null;
  let mode: ViewMode = 'survey';
  let connection: ConnectionState = 'connecting';
  let autoPaused = false;
  let reducedMotion = opts.reducedMotion;
  let params: VisualParams = { ...opts.params };
  let stats: FrameStats | null = null;
  let source: SourceKind | null = null;
  let view: ViewKind = opts.view ?? 'agents';
  let system: SystemSnapshot | null = null;
  let systemAt = 0;
  let sourceFilter: string | null = null;
  // v2.3 双主题：main 负责 applyTheme/saveTheme，HUD 只回执铭牌与做 320ms 交叉淡入
  let theme: ThemeId = opts.theme ?? 'xuanji';
  let themeFadeTimer = 0;
  // v2.5 百工视图：进程选中态（由 main 的 selectProcess 回执；HUD 只在本地高亮）
  let processSelection: number | null = null;
  // v2.9 面板收放：桌面端四块常驻面板的本地记忆（移动端 loadFold 恒为全展开）
  const panelFold = loadFold();
  const tokenSamples: number[] = [];

  // ── 图层：顶栏（v2.0 含「智能体 ｜ 整机」视图铭牌，v2.3 含「璇玑 / 深空」主题铭牌）──
  const topbar = createTopbar(container, {
    onViewRequest: (next) => requestView(next),
    onThemeRequest: (next) => cb.onThemeRequest?.(next),
  });
  container.dataset.view = view;
  container.dataset.theme = theme;
  topbar.setView(view);
  topbar.setTheme(theme);

  // ── 图层：中央底部提示 ──────────────────────────────────────
  const hintNum = el('i', { class: 'hint-num', text: '壹' });
  const hintName = el('b', { class: 'hint-name', text: '云图' });
  const hintKeys = el('span', { class: 'hint-keys', text: hintKeysFor(view, autoPaused) });
  const hintKeysShort = el('span', {
    class: 'hint-keys hint-keys--short',
    text: HINT_MOBILE,
  });
  const hint = el(
    'div',
    {
      class: 'hint',
      attrs: { 'aria-hidden': 'true', 'data-hud': 'hint', 'data-auto': 'on' },
    },
    [
      el('span', { class: 'hint-mode' }, [
        hintNum,
        el('span', { class: 'hint-sep', text: '·' }),
        hintName,
      ]),
      hintKeys,
      hintKeysShort,
    ],
  );
  container.appendChild(hint);

  // ── 图层：《起居注》 ────────────────────────────────────────
  const ledger = createLedger(container, {
    onSelectSession: (id) => cb.onSelectSession(id),
    onOpenChange: (open) => setPanelOpen('ledger', open, true),
  });

  // ── 图层：《机枢》（整机视图左下，替代起居注）──────────────
  const systemPanel = createSystemPanel(container, {
    onOpenChange: (open) => setPanelOpen('system', open, true),
  });

  // ── 图层：星牒 ──────────────────────────────────────────────
  const dossier = createDossier(container, {
    onSelect: (id) => {
      dossier.setSelection(id);
      if (id) cb.onSelectSession(id);
    },
    onSelectSector: (sectorId) => {
      cb.onSelectSector?.(sectorId);
    },
    onSourceFilter: (sourceId) => {
      cb.onSourceFilter?.(sourceId);
    },
    onRequestClose: () => {
      dossier.close();
      dossier.setSectorFocus(null);
      cb.onSelectSession(null);
      cb.onSelectSector?.(null);
      refreshPanelState();
    },
  });

  // ── 图层：《器录》（整机视图右侧，替代星牒）────────────────
  const procPanel = createProcPanel(container, {
    onRequestClose: () => {
      procPanel.close();
      refreshPanelState();
    },
  });

  // ── 图层：《工籍》《器牒》（v2.5 百工视图，替代起居注 / 星牒）──────
  const processList = createProcessList(container, {
    onSelectProcess: (pid) => cb.onSelectProcess?.(pid),
    onOpenChange: (open) => setPanelOpen('worklist', open, true),
  });
  const processDetail = createProcessDetail(container, {
    onSelectProcess: (pid) => cb.onSelectProcess?.(pid),
    onRequestClose: () => {
      processDetail.close();
      refreshPanelState();
    },
    onOpenChange: (open) => setPanelOpen('procdetail', open, true),
  });

  // ── 图层：调参台 ────────────────────────────────────────────
  const consolePanel = createConsole(container, params, {
    onParamsChange: (next) => {
      params = next;
      cb.onParamsChange(next);
    },
    onNotice: (text) => {
      toasts.show(text);
    },
  });

  // ── 图层：帮助 ──────────────────────────────────────────────
  const help = createHelp(container);

  // ── 图层：短告 ──────────────────────────────────────────────
  const toasts = createToasts(container);

  // ── 图层：中央铭文（失联 / 空态） ───────────────────────────
  const centerMark = el('p', { class: 'center-mark' });
  const centerSub = el('p', { class: 'center-sub' });
  const centerNote = el('div', { class: 'center-note', attrs: { role: 'status' } }, [centerMark, centerSub]);
  centerNote.hidden = true;
  container.appendChild(centerNote);

  // ── 图层：演练角标 ──────────────────────────────────────────
  const demoNote = el('div', { class: 'demo-note', attrs: { 'aria-hidden': 'true' } }, [
    el('span', { class: 'demo-note-mark', text: '演练' }),
    el('span', { class: 'demo-note-text', text: '假源数据 · 非真实会话' }),
  ]);
  demoNote.hidden = true;
  container.appendChild(demoNote);

  // ── 无障碍摘要（aria-live polite，≥2s 节流；随视图切换播报）──
  const liveRegion = el('p', {
    class: 'sr-only',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
  container.appendChild(liveRegion);
  let announceLast = 0;
  let announceTimer = 0;
  let announcePending = '';
  function announce(text: string): void {
    if (!text) return;
    const now = Date.now();
    if (now - announceLast >= 2000) {
      announceLast = now;
      liveRegion.textContent = text;
      return;
    }
    announcePending = text;
    if (announceTimer) return;
    announceTimer = window.setTimeout(() => {
      announceTimer = 0;
      announceLast = Date.now();
      liveRegion.textContent = announcePending;
    }, 2000 - (now - announceLast));
  }

  // ── 顶栏刷新 ────────────────────────────────────────────────
  /**
   * v2.5 百工：顶栏读机器级负载（与整机视图同语义）+ 进程级计数。
   * O(n) 只在每次 setSystem（2s 一帧）算一次，不逐帧。
   */
  function computeProcAgg(): { count: number; cpuPct: number; memPct: number; threads: number } | null {
    if (!system || !system.available || system.procs.length === 0) return null;
    let threads = 0;
    for (const proc of system.procs) {
      threads += typeof proc.threads === 'number' ? proc.threads : 0;
    }
    return {
      count: system.procs.length,
      cpuPct: system.cpu.usage * 100,
      memPct: system.mem.usedPct,
      threads,
    };
  }

  function refreshTopbar(): void {
    topbar.update({
      aggregates: fleet?.aggregates ?? null,
      catCounts: toolCountsOf(fleet),
      connection,
      source,
      mode,
      autoPaused,
      tokenSamples,
      hasFleet,
      view,
      system,
      systemAgeMs: systemAt > 0 ? Date.now() - systemAt : 0,
      theme,
      procAgg: computeProcAgg(),
    });
  }

  // ── v2.9 面板收放（BIBLE §28）────────────────────────────────
  // 四块常驻面板的收起态只影响桌面；移动端沿用抽屉/sheet，按钮由 CSS 隐藏。
  function setPanelOpen(key: FoldPanelKey, open: boolean, persist: boolean): void {
    panelFold[key] = open ? 'open' : 'closed';
    if (key === 'ledger') ledger.setFolded(!open);
    else if (key === 'system') systemPanel.setFolded(!open);
    else if (key === 'worklist') processList.setFolded(!open);
    else if (open) processDetail.open();
    else processDetail.close();
    if (persist) saveFold(panelFold);
    refreshPanelState();
  }

  function toggleLeftPanel(): void {
    if (view === 'agents') {
      setPanelOpen('ledger', ledger.isFolded(), true);
      return;
    }
    if (view === 'system') {
      setPanelOpen('system', systemPanel.isFolded(), true);
      return;
    }
    setPanelOpen('worklist', processList.isFolded(), true);
  }

  function toggleRightPanel(): void {
    if (view === 'agents') {
      // 星牒：展开 = 分野总览（≥1280 首屏也是它），收起 = 藏回竖签
      if (dossier.isOpen()) {
        dossier.close();
        dossier.setSectorFocus(null);
      } else {
        dossier.openOverview();
      }
      refreshPanelState();
      return;
    }
    if (view === 'system') {
      if (procPanel.isOpen()) procPanel.close();
      else procPanel.open();
      refreshPanelState();
      return;
    }
    setPanelOpen('procdetail', !processDetail.isOpen(), true);
  }

  // ── 视图切换（顶栏铭牌 / 0 键 / ?view=system 共用同一条路径）──
  function requestView(next: ViewKind): void {
    if (next === view) return;
    cb.onViewRequest?.(next);
    applyView(next);
  }

  function applyView(next: ViewKind): void {
    view = next;
    container.dataset.view = next;
    topbar.setView(next);
    if (next === 'agents') {
      procPanel.close();
      systemPanel.setSource(source);
      processList.setSource(source);
      processDetail.setSource(source);
    } else if (next === 'system') {
      procPanel.setSource(source);
      systemPanel.setSource(source);
      processList.setSource(source);
      processDetail.setSource(source);
      // 整机视图右侧就是《器录》：桌面自动展开（窄屏保留竖签，点开为 sheet）
      if (window.matchMedia('(min-width: 1280px)').matches) procPanel.open();
    } else {
      // v2.5 百工：名册与档案一起换到进程盘面（深度由 scene 绘制，HUD 只读 system.procs）
      processList.setSource(source);
      processDetail.setSource(source);
      processList.setSystem(system);
      processDetail.setSystem(system);
      processDetail.setSelection(processSelection);
      // v2.9：百工视图右侧《器牒》按记忆恢复（桌面默认展开，收起时显示竖签）
      if (isDesktopViewport()) {
        if (panelFold.procdetail === 'open') processDetail.open();
        else processDetail.close();
      }
    }
    refreshTopbar();
    refreshHint();
    refreshPanelState();
    refreshDemo();
    updateCenter();
    if (next === 'agents') {
      announce(`智能体视图 · ${VIEW_KIND_LABEL.agents}`);
    } else if (next === 'system') {
      announce(
        `整机视图 · CPU ${system ? Math.round(system.cpu.usage * 100) : 0}% 内存 ${system ? Math.round(system.mem.usedPct * 100) : 0}%`,
      );
    } else {
      const agg = computeProcAgg();
      announce(agg ? `百工视图 · ${agg.count} 进程 · CPU ${Math.round(agg.cpuPct)}%` : '百工视图 · 进程遥测不可用');
    }
  }

  function setView(next: ViewKind): void {
    if (next === view) return;
    applyView(next);
  }

  function setSystem(next: SystemSnapshot | null): void {
    system = next;
    systemAt = next ? Date.now() : 0;
    systemPanel.setSystem(next);
    procPanel.setSystem(next);
    // v2.5 百工：《工籍》《器牒》只读 system.procs（2s 一帧，O(n) 聚合一次）
    processList.setSystem(next);
    processDetail.setSystem(next);
    processDetail.setSelection(processSelection);
    refreshTopbar();
    updateCenter();
    if (view === 'system') {
      announce(
        next && next.available
          ? `整机视图 · CPU ${Math.round(next.cpu.usage * 100)}% 内存 ${Math.round(next.mem.usedPct * 100)}%`
          : '整机视图 · 遥测不可用',
      );
    } else if (view === 'processes') {
      const agg = computeProcAgg();
      announce(agg ? `百工视图 · ${agg.count} 进程 · CPU ${Math.round(agg.cpuPct)}%` : '百工视图 · 进程遥测不可用');
    }
  }

  // ── v2.5 进程选中回执（main ⇄ scene ⇄ HUD 双向同步）────────────
  function setProcessSelection(pid: number | null): void {
    const changed = processSelection !== pid;
    processSelection = pid;
    processList.setSelection(pid);
    processDetail.setSelection(pid);
    if (pid != null && view === 'processes' && window.matchMedia('(max-width: 720px)').matches) {
      processDetail.open();
    }
    if (changed && view === 'processes') {
      if (pid == null) {
        announce('进程已清选');
      } else {
        const proc = system?.procs.find((item) => item.pid === pid);
        announce(proc ? `${proc.name} · CPU ${proc.cpuPct.toFixed(1)}%` : '进程已选中');
      }
    }
    refreshPanelState();
  }

  function setSourceFilter(sourceId: string | null): void {
    if (sourceFilter === sourceId) return;
    sourceFilter = sourceId;
    dossier.setSourceFilter(sourceId);
  }

  // ── v2.3 主题回执：main 已 applyTheme → 这里只同步铭牌/十字淡入/播报 ──
  function setTheme(next: ThemeId): void {
    if (theme === next) return;
    theme = next;
    container.dataset.theme = next;
    topbar.setTheme(next);
    if (themeFadeTimer) window.clearTimeout(themeFadeTimer);
    container.classList.remove('is-theme-in');
    // 强制回流，保证连续切换时淡入也能重播（只淡入、不位移、不动布局）
    void container.offsetWidth;
    container.classList.add('is-theme-in');
    themeFadeTimer = window.setTimeout(() => {
      container.classList.remove('is-theme-in');
      themeFadeTimer = 0;
    }, reducedMotion ? 180 : 360);
    announce(`主题 · ${THEME_LABEL[next]}`);
  }

  // ── 中央铭文 ────────────────────────────────────────────────
  function updateCenter(): void {
    const sessions = fleet?.sessions.length ?? 0;
    if (connection === 'offline') {
      centerNote.hidden = false;
      centerNote.dataset.kind = 'offline';
      setText(centerMark, '仪器停止转动');
      setText(centerSub, `检查采集器 (${COLLECTOR})`);
      return;
    }
    if (view === 'system' || view === 'processes') {
      // 整机/百工视图无「空会话」概念：不显示观星空态铭文
      centerNote.hidden = true;
      return;
    }
    if (hasFleet && sessions === 0) {
      centerNote.hidden = false;
      centerNote.dataset.kind = 'empty';
      setText(centerMark, '未有星入案');
      setText(centerSub, '运行 dsh 会话或进入演练');
      return;
    }
    centerNote.hidden = true;
  }

  // ── 提示区 ──────────────────────────────────────────────────
  function refreshHint(): void {
    const keys = hintKeysFor(view, autoPaused);
    hint.dataset.auto = autoPaused ? 'off' : 'on';
    setText(hintKeys, keys);
    setText(hintKeysShort, view === 'processes' ? HINT_PROCESS_SHORT : HINT_MOBILE);
    if (view === 'system') {
      setText(hintNum, '整机');
      setText(hintName, '仪象');
      return;
    }
    if (view === 'processes') {
      setText(hintNum, '百工');
      setText(hintName, '器群');
      return;
    }
    const index = Math.max(0, VIEW_MODE_ORDER.indexOf(mode));
    setText(hintNum, MODE_CN[index] ?? '壹');
    setText(hintName, VIEW_MODE_LABEL[mode] ?? '云图');
  }

  function refreshPanelState(): void {
    // 整机/百工的左右面板在桌面上是常设仪表，不参与「让位」判断；
    // 观星视图才按星牒/调参台/帮助是否打开来让出中央提示。
    const panelOpen =
      view === 'agents'
        ? dossier.isOpen() || consolePanel.isOpen() || help.isOpen()
        : view === 'system'
          ? consolePanel.isOpen() || help.isOpen()
          : consolePanel.isOpen() || help.isOpen() || processDetail.isOpen();
    container.classList.toggle('is-panel-open', panelOpen);
  }

  function refreshDemo(): void {
    demoNote.hidden = !(source === 'demo' && hasFleet);
  }

  function refreshSourceText(): void {
    help.setSource(source, connection);
  }

  // ── 授时 ────────────────────────────────────────────────────
  function agentCounts(): { live: number; total: number; sources: number } | null {
    if (!fleet) return null;
    const live = fleet.aggregates?.liveCount ?? fleet.sessions.filter((s) => s.state === 'live').length;
    const sources = (fleet.sources ?? []).filter((src) => src.state !== 'absent').length;
    return { live, total: fleet.sessions.length, sources };
  }

  // 初始回填的历史事件不弹出星牒：等授时结束（或跳过开机 1.6s 后）再让新到的误事自动立案
  let primed = false;
  let primeTimer = 0;
  function markPrimed(): void {
    primed = true;
  }
  let boot = createBoot(container, {
    reducedMotion: opts.reducedMotion,
    skip: opts.skipBoot,
    getAgents: agentCounts,
    onDone: () => {
      markPrimed();
      container.classList.add('is-ready');
    },
  });
  if (opts.skipBoot) {
    container.classList.add('is-ready');
    primeTimer = window.setTimeout(markPrimed, 1600);
  }

  // 隐藏层次：点顶栏「授时」小印 → 重演一次授时（本地已看过则走 600ms 短序列）
  topbar.seal.addEventListener('click', () => {
    if (boot.root !== null && container.contains(boot.root)) return;
    boot.dispose();
    boot = createBoot(container, {
      reducedMotion,
      skip: false,
      getAgents: agentCounts,
      onDone: () => {
        container.classList.add('is-ready');
      },
    });
    boot.setAgents();
    toasts.show('授时重演 · 按任意键越过');
  });

  // ── 初始 ────────────────────────────────────────────────────
  ledger.setReducedMotion(opts.reducedMotion);
  dossier.setReducedMotion(opts.reducedMotion);
  systemPanel.setReducedMotion(opts.reducedMotion);
  procPanel.setReducedMotion(opts.reducedMotion);
  refreshTopbar();
  refreshHint();
  refreshSourceText();
  refreshDemo();
  updateCenter();

  // v1.2.1 · 桌面首屏直接亮出《星牒 · 分野总览》
  // 用户最先要问的是「本机还有哪些 agent 在跑」，不能把 6 分野总览藏在一次点击之后。
  // 只展开总览面板（openOverview 不选会话、不选分野）；窄屏仍保留收起竖签；隐藏 HUD 的场景不展开。
  // 只在初始化时调用这一次 —— 用户手动关掉后，本次页面会话内不会自动再开。
  {
    const usp = new URLSearchParams(window.location.search);
    const hudHidden = usp.get('hud') === '0' || usp.get('stats') === '1';
    if (!hudHidden && view === 'agents' && window.matchMedia('(min-width: 1280px)').matches) {
      dossier.openOverview();
      refreshPanelState();
    }
    if (view === 'system') {
      if (window.matchMedia('(min-width: 1280px)').matches) procPanel.open();
      refreshPanelState();
    }
    // v2.9：桌面端按记忆恢复四块常驻面板的收放状态（移动端不读取、不写入）
    if (isDesktopViewport()) {
      ledger.setFolded(panelFold.ledger === 'closed');
      systemPanel.setFolded(panelFold.system === 'closed');
      processList.setFolded(panelFold.worklist === 'closed');
      if (panelFold.procdetail === 'open') processDetail.open();
      else processDetail.close();
    }
  }

  // 整机帧断流时也要让顶栏「候采」出现：每秒复查一次时间戳（无数据也更新）
  const sysTimer = window.setInterval(() => {
    if (view === 'system' || systemAt > 0) refreshTopbar();
  }, 1000);

  // ── 契约实现 ────────────────────────────────────────────────
  function setFleet(snap: ClientFleetSnapshot): void {
    fleet = snap;
    hasFleet = true;
    source = snap.source ?? null;
    const rate = snap.aggregates?.tokenRate;
    if (typeof rate === 'number' && Number.isFinite(rate)) {
      tokenSamples.push(rate);
      if (tokenSamples.length > 60) tokenSamples.shift();
    }
    ledger.setFleet(snap);
    dossier.setFleet(snap);
    systemPanel.setSource(source);
    procPanel.setSource(source);
    boot.setAgents();
    refreshTopbar();
    refreshDemo();
    refreshSourceText();
    updateCenter();
    if (view === 'agents' && hasFleet) {
      const counts = agentCounts();
      if (counts) announce(`观星 · ${counts.live} 位在行 · 诸源 ${counts.sources}`);
    }
  }

  function pushEvents(events: AstroEvent[]): void {
    if (!events || events.length === 0) return;
    ledger.pushEvents(events);
    dossier.pushEvents(events);
    // 误：临时告警带 + ≤8% 面积侧闪一次 + 星牒自动弹出（§10 状态矩阵）
    for (const ev of events) {
      if (ev.kind !== 'error') continue;
      const text = ev.detail ? truncate(ev.detail, 42) : '有误';
      topbar.raiseAlarm('error', `有误 · ${text}`, false);
      topbar.flashError();
      if (primed && view === 'agents' && (!dossier.isOpen() || selection == null)) dossier.setSelection(ev.sessionId);
      refreshPanelState();
      break;
    }
  }

  function setSelection(id: string | null): void {
    selection = id;
    ledger.setSelection(id);
    dossier.setSelection(id);
    refreshPanelState();
  }

  function setMode(next: ViewMode): void {
    mode = next;
    refreshHint();
    refreshTopbar();
  }

  function setParams(next: VisualParams, setOpts?: { silent?: boolean }): void {
    params = { ...next };
    consolePanel.setParams(params, setOpts);
  }

  function setConnection(state: ConnectionState): void {
    const prev = connection;
    connection = state;
    ledger.setConnection(state);
    refreshTopbar();
    refreshSourceText();
    updateCenter();
    if (state === 'offline') {
      topbar.raiseAlarm('offline', `仪器停止转动 · 检查采集器 (${COLLECTOR})`, true);
    } else if (state === 'reconnecting') {
      topbar.raiseAlarm('reconnect', '墨尽 · 与采集器失联，正在重连……', true);
    } else if (state === 'live') {
      topbar.clearStickyAlarm();
      if (prev === 'offline' || prev === 'reconnecting') toasts.show('观测复通 · 星图续转');
    }
  }

  function setAutoPaused(paused: boolean): void {
    autoPaused = paused;
    refreshTopbar();
    refreshHint();
  }

  function setReducedMotion(value: boolean): void {
    reducedMotion = value;
    container.dataset.reduced = value ? 'true' : 'false';
    ledger.setReducedMotion(value);
    dossier.setReducedMotion(value);
    systemPanel.setReducedMotion(value);
    procPanel.setReducedMotion(value);
    void reducedMotion;
  }

  function setStats(next: FrameStats | null): void {
    stats = next;
    void stats;
  }

  function showToast(text: string): void {
    toasts.show(text);
  }

  // ── 键盘：只消费 HUD 自己的键 ────────────────────────────────
  function handleKey(e: KeyboardEvent): boolean {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;

    if (help.isOpen()) {
      if (help.handleKey(e)) return true;
      if (e.key === '?') {
        help.close();
        refreshPanelState();
        return true;
      }
      return false;
    }
    if (consolePanel.isOpen()) {
      const consumed = consolePanel.handleKey(e);
      if (consumed) refreshPanelState();
      return consumed;
    }
    if (e.key === 'Escape') {
      // 只有当前视图自己的浮层才消费 Esc；百工视图把 Esc 留给 main 清进程选中
      if (view === 'system' && procPanel.isOpen()) {
        procPanel.close();
        refreshPanelState();
        return true;
      }
      if (view === 'agents' && dossier.isOpen()) {
        dossier.close();
        dossier.setSectorFocus(null);
        refreshPanelState();
        cb.onSelectSession(null);
        cb.onSelectSector?.(null);
        return true;
      }
      return false;
    }
    if (isEditableTarget(e.target)) return false;

    // v2.5 百工视图：↑↓/Home/End 在《工籍》里移选（选中回执由 main → HUD 双向同步）
    if (
      view === 'processes' &&
      (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')
    ) {
      const pids = processList.getPids();
      if (pids.length === 0) return false;
      const at = processSelection == null ? -1 : pids.indexOf(processSelection);
      let nextIndex = 0;
      if (e.key === 'ArrowDown') nextIndex = at < 0 ? 0 : Math.min(pids.length - 1, at + 1);
      else if (e.key === 'ArrowUp') nextIndex = at < 0 ? 0 : Math.max(0, at - 1);
      else if (e.key === 'End') nextIndex = pids.length - 1;
      e.preventDefault();
      cb.onSelectProcess?.(pids[nextIndex]);
      return true;
    }

    switch (e.key) {
      case '?':
        help.open();
        refreshPanelState();
        return true;
      case '/':
        consolePanel.open();
        refreshPanelState();
        return true;
      case 'l':
      case 'L':
        if (view === 'system') {
          // 整机视图：L 把焦点交给《机枢》面板
          systemPanel.root.querySelector<HTMLElement>('.sys-grip')?.focus();
          return true;
        }
        if (view === 'processes') {
          // 百工视图：L 把焦点交给《工籍》，便于键盘移选
          processList.focusFirst();
          return true;
        }
        cb.onModeRequest('ledger');
        return true;
      // v2.9 面板收放（BIBLE §28.4）：[ 收放左下，] 收放右侧
      case '[':
        e.preventDefault();
        toggleLeftPanel();
        return true;
      case ']':
        e.preventDefault();
        toggleRightPanel();
        return true;
      default:
        return view === 'agents' ? ledger.handleKey(e) : false;
    }
  }

  function dispose(): void {
    window.clearTimeout(primeTimer);
    window.clearTimeout(announceTimer);
    window.clearTimeout(themeFadeTimer);
    window.clearInterval(sysTimer);
    boot.dispose();
    help.dispose();
    consolePanel.dispose();
    procPanel.dispose();
    systemPanel.dispose();
    processDetail.dispose();
    processList.dispose();
    dossier.dispose();
    ledger.dispose();
    toasts.dispose();
    topbar.dispose();
    hint.remove();
    centerNote.remove();
    demoNote.remove();
    liveRegion.remove();
    container.classList.remove('xj-hud', 'is-ready', 'is-panel-open');
  }

  return {
    setFleet,
    pushEvents,
    setSelection,
    setMode,
    setParams,
    setConnection,
    setAutoPaused,
    setReducedMotion,
    setStats,
    handleKey,
    showToast,
    dispose,
    setView,
    setSystem,
    setSourceFilter,
    setTheme,
    setProcessSelection,
  };
}
