// XUANJI · 璇玑 — 顶栏（56px）
// 左：产品名「璇玑」+「授时」小印 ｜ 中：时辰 · 日期 · 等宽 HH:MM:SS ｜ 右：指标组 + 状态徽标 + 模式序号
// 纪律：无卡片 / 无圆角 / 无背景块，只有一条 1px 横线与 1px 竖分隔；数字一律 JetBrains Mono tabular-nums。
// 告警带挂在顶栏正下方（1px 朱砂上边线 + 45° 细斜纹，≤3s 收敛为静态线），不常驻、不整屏变红。
import { el, setText, svgEl } from '../lib/dom';
import { formatClock, formatCompact, formatDateCN, formatNumber, formatShichen } from '../lib/format';
import { TOOL_CATEGORY_LABEL, VIEW_KIND_LABEL, VIEW_MODE_ORDER } from '../state/types';
import type {
  Aggregates,
  ConnectionState,
  SourceKind,
  SystemSnapshot,
  ToolCategory,
  ViewKind,
  ViewMode,
} from '../state/types';
import {
  fmtBattery,
  fmtBytes,
  fmtNetPairCompact,
  fmtPct,
  fmtUptime,
} from './system-format';
import { THEME_LABEL, type ThemeId } from '../design/themes';

/** 五行类别字标（与 tokens.css 的 --cat-* 一一对应） */
const TOOL_MARK: Record<ToolCategory, string> = {
  read: '览',
  write: '书',
  exec: '作',
  net: '讯',
  agent: '遣',
};

const MODE_CN = ['壹', '贰', '叁', '肆', '伍', '陆', '柒'];

export interface TopbarModel {
  aggregates: Aggregates | null;
  catCounts: Record<ToolCategory, number>;
  connection: ConnectionState;
  source: SourceKind | null;
  mode: ViewMode;
  autoPaused: boolean;
  tokenSamples: number[];
  hasFleet: boolean;
  /** 顶层视图：智能体浑仪 / 整机仪象（铭牌与小字随视图换） */
  view: ViewKind;
  /** 整机遥测（view='system' 时使用；null = 尚无数据） */
  system: SystemSnapshot | null;
  /** 最近一帧遥测距今毫秒（null = 从未收到；>6000 视为断流「候采」） */
  systemAgeMs: number | null;
  /** 当前主题（v2.3 双主题：璇玑 / 深空） */
  theme: ThemeId;
}

export type AlarmKind = 'error' | 'offline' | 'reconnect';

export interface TopbarOptions {
  /** 点铭牌切换视图（没有回执时顶栏也会先本地切过去，保持点击即响应） */
  onViewRequest?: (view: ViewKind) => void;
  /** 点主题铭牌：由 main 统一 applyTheme/saveTheme 后回执 setTheme */
  onThemeRequest?: (theme: ThemeId) => void;
}

export interface TopbarHandle {
  root: HTMLElement;
  /** 「授时」小印：可点，重演一次授时（隐藏层次） */
  seal: HTMLButtonElement;
  update(model: TopbarModel): void;
  /** 只同步铭牌高亮（视图切换时先于 update 调用，避免等下一帧） */
  setView(view: ViewKind): void;
  /** 只同步主题铭牌（main 已切好 data-theme 后回执，HUD 不碰 localStorage） */
  setTheme(theme: ThemeId): void;
  raiseAlarm(kind: AlarmKind, text: string, sticky: boolean): void;
  clearStickyAlarm(): void;
  flashError(): void;
  dispose(): void;
}

interface MetricRefs {
  root: HTMLElement;
  value: HTMLElement;
}

function makeMetric(label: string, extraClass = ''): MetricRefs {
  const value = el('span', { class: 'tb-metric-value', text: '—' });
  const root = el('span', { class: `tb-metric ${extraClass}`.trim() }, [
    el('span', { class: 'tb-metric-label', text: label }),
    value,
  ]);
  return { root, value };
}

function badgeFor(connection: ConnectionState, source: SourceKind | null): { key: string; text: string } {
  if (connection === 'offline') return { key: 'offline', text: '失联' };
  if (connection === 'reconnecting') return { key: 'reconnecting', text: '重连' };
  if (connection === 'connecting') return { key: 'connecting', text: '候' };
  if (source === 'demo') return { key: 'demo', text: '演练' };
  if (source === 'replay') return { key: 'replay', text: '回放' };
  return { key: 'live', text: '实况' };
}

export function createTopbar(container: HTMLElement, opts: TopbarOptions = {}): TopbarHandle {
  const region = el('div', { class: 'top-region' });

  // ── 顶栏本体 ────────────────────────────────────────────────
  const header = el('header', { class: 'tb', attrs: { role: 'banner', 'aria-label': '璇玑 · 本机智能体观测所' } });

  const seal = el('button', {
    class: 'tb-seal',
    attrs: { type: 'button', 'aria-label': '重演授时', title: '重演授时 · 点此再看一次开机' },
  });
  seal.append(el('span', { text: '授' }), el('span', { text: '时' }));

  // 视图铭牌：同一台仪器，两套铭牌（智能体 ｜ 整机）。数据视图跟 main 走，点击只发请求。
  let currentView: ViewKind = 'agents';
  // 主题铭牌（v2.3）：璇玑 / 深空。同样只发请求，回执由 main → hud.setTheme 回来。
  let currentTheme: ThemeId = 'xuanji';
  const subText = el('span', { class: 'tb-sub', text: '本机智能体观测所' });
  const viewTabs = el('div', {
    class: 'tb-views',
    attrs: { role: 'group', 'aria-label': '视图切换', 'data-hud': 'view-tabs' },
  });
  function viewTab(view: ViewKind): HTMLButtonElement {
    const node = el('button', {
      class: 'tb-view',
      attrs: {
        type: 'button',
        'data-view': view,
        'aria-pressed': view === currentView ? 'true' : 'false',
        title: view === 'agents' ? '观星 · 本机所有 agent（0 键切换）' : '观机 · 整机运行数据（0 键切换）',
      },
      text: VIEW_KIND_LABEL[view],
    });
    node.addEventListener('click', () => {
      if (currentView === view) return;
      applyView(view);
      opts.onViewRequest?.(view);
    });
    return node;
  }
  const tabAgents = viewTab('agents');
  const tabSystem = viewTab('system');
  viewTabs.append(tabAgents, el('span', { class: 'tb-view-sep', text: '｜', attrs: { 'aria-hidden': 'true' } }), tabSystem);

  const brand = el('div', { class: 'tb-brand' }, [
    el('h1', { class: 'tb-mark', text: '璇玑' }),
    seal,
    viewTabs,
    subText,
  ]);

  const shichen = el('span', { class: 'tb-shichen' });
  const date = el('span', { class: 'tb-date' });
  const clock = el('time', { class: 'tb-time', attrs: { 'aria-label': '本机时间' } });
  const uptime = el('span', { class: 'tb-uptime', title: '本机已连续运行时长' });
  const battery = el('span', { class: 'tb-battery', title: '电池余量' });
  const clockBox = el('div', { class: 'tb-clock' }, [shichen, date, clock, uptime, battery]);

  // 星数：行 / 驻 / 藏
  const liveM = makeMetric('行', 'tb-metric--live');
  liveM.root.dataset.state = 'live';
  const idleM = makeMetric('驻', 'tb-metric--idle');
  idleM.root.dataset.state = 'idle';
  const endedM = makeMetric('藏', 'tb-metric--ended');
  endedM.root.dataset.state = 'ended';
  liveM.root.title = '在行（live）的星数';
  idleM.root.title = '驻留（idle）的星数';
  endedM.root.title = '已藏（ended）的星数';

  // 文速 + 60 秒折线
  const rateValue = el('span', { class: 'tb-metric-value', text: '—' });
  const spark = svgEl('svg', {
    class: 'tb-spark',
    viewBox: '0 0 60 16',
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
  });
  spark.appendChild(
    svgEl('line', {
      x1: 0,
      y1: 15,
      x2: 60,
      y2: 15,
      stroke: 'rgba(200,182,142,0.16)',
      'stroke-width': 1,
    }),
  );
  const sparkLine = svgEl('polyline', {
    fill: 'none',
    stroke: 'var(--gold-300)',
    'stroke-width': 1.1,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
    points: '',
  });
  spark.appendChild(sparkLine);
  const rateUnit = el('span', { class: 'tb-unit', text: '文/秒', attrs: { 'aria-hidden': 'true' } });
  const rateMetric = el('span', { class: 'tb-metric tb-metric--rate', title: '近一分钟 token 输出速率' }, [
    el('span', { class: 'tb-metric-label', text: '文速' }),
    el('span', { class: 'tb-metric-row' }, [rateValue, rateUnit, spark]),
  ]);

  // 器用五色计数
  const catsRoot = el('span', { class: 'tb-cats', attrs: { role: 'group', 'aria-label': '器用分类累计' } });
  const catRefs = (Object.keys(TOOL_MARK) as ToolCategory[]).map((cat) => {
    const count = el('b', { class: 'tb-cat-count', text: '0' });
    const node = el(
      'span',
      {
        class: 'tb-cat',
        dataset: { cat },
        title: `${TOOL_CATEGORY_LABEL[cat]} · ${TOOL_MARK[cat]}`,
      },
      [el('i', { class: 'tb-cat-mark', text: TOOL_MARK[cat] }), count],
    );
    catsRoot.appendChild(node);
    return { cat, count };
  });

  // 误：只有出现错误时才显示，不常驻
  const errorM = makeMetric('误', 'tb-metric--error');
  errorM.root.dataset.state = 'error';
  errorM.root.hidden = true;
  errorM.root.title = '已观测到的错误数（误）';

  // 连接状态徽标
  const badgeDot = el('i', { class: 'tb-badge-dot', attrs: { 'aria-hidden': 'true' } });
  const badgeText = el('span', { class: 'tb-badge-text', text: '候' });
  const badge = el('span', { class: 'tb-badge', attrs: { role: 'status', 'aria-label': '连接状态' } }, [
    badgeDot,
    badgeText,
  ]);
  badge.dataset.state = 'connecting';

  // 模式序号
  const modeNum = el('i', { class: 'tb-mode-num', text: '壹' });
  const modeName = el('b', { class: 'tb-mode-name', text: '云图' });
  const modeRoot = el('span', { class: 'tb-mode', title: '视野模式 · 数字键 1–7 切换' }, [
    modeNum,
    el('span', { class: 'tb-mode-sep', text: '·', attrs: { 'aria-hidden': 'true' } }),
    modeName,
  ]);

  // v2.1 视野主权：自动运镜被手动取景锁死时显示「视野已锁」
  const pausedTitle = '视野已锁 · 手动取景优先 · Space 恢复自动运镜';
  const paused = el('span', {
    class: 'tb-paused',
    text: '视野已锁',
    title: pausedTitle,
    role: 'status',
    attrs: {
      'data-hud': 'auto-state',
      'data-auto': 'on',
      'aria-label': pausedTitle,
    },
  });
  paused.hidden = true;

  // ── 整机视图指标组（与观星指标组互斥显示） ──────────────────
  const sep = (): HTMLElement => el('span', { class: 'tb-sep', attrs: { 'aria-hidden': 'true' } });
  function sysMetric(label: string, title: string): { root: HTMLElement; value: HTMLElement } {
    const value = el('span', { class: 'tb-metric-value', text: '—' });
    const root = el('span', { class: 'tb-metric tb-metric--sys', title }, [
      el('span', { class: 'tb-metric-label', text: label }),
      value,
    ]);
    return { root, value };
  }
  const cpuMetric = sysMetric('处理器', '整机 CPU 使用率');
  const memMetric = sysMetric('内存', '物理内存占用');
  const diskMetric = sysMetric('磁盘', '系统盘（C:）占用；悬停查看全部磁盘');
  const netMetric = sysMetric('网速', '网络上下行速率（近 2s 采样）');
  diskMetric.root.classList.add('tb-metric--disk');
  netMetric.root.classList.add('tb-metric--net');
  const catchup = el('span', {
    class: 'tb-catchup',
    text: '候采 · 数据延迟',
    title: '超过 6 秒没有收到整机遥测，数值为最后一帧',
  });
  catchup.hidden = true;
  const sysMetrics = el('div', { class: 'tb-metrics tb-metrics--system' }, [
    cpuMetric.root,
    sep(),
    memMetric.root,
    sep(),
    diskMetric.root,
    sep(),
    netMetric.root,
    sep(),
    catchup,
  ]);

  const metrics = el('div', { class: 'tb-metrics tb-metrics--agents' }, [
    el('span', { class: 'tb-stars', attrs: { role: 'group', 'aria-label': '星数' } }, [
      liveM.root,
      idleM.root,
      endedM.root,
    ]),
    el('span', { class: 'tb-sep', attrs: { 'aria-hidden': 'true' } }),
    rateMetric,
    el('span', { class: 'tb-sep', attrs: { 'aria-hidden': 'true' } }),
    catsRoot,
    errorM.root,
    el('span', { class: 'tb-sep', attrs: { 'aria-hidden': 'true' } }),
  ]);

  // 状态徽标 / 模式 / 视野锁标记单独成侧栏：窄屏时它们留在第一行，指标退到第二行
  // v2.3 主题铭牌也放进侧栏（状态徽标附近），手机上折叠为只留当前主题一枚
  const themeTabs = el('div', {
    class: 'tb-theme',
    attrs: { role: 'group', 'aria-label': '主题切换', 'data-hud': 'theme-tabs' },
  });
  function themeTab(theme: ThemeId): HTMLButtonElement {
    const node = el('button', {
      class: 'tb-theme-btn',
      attrs: {
        type: 'button',
        'data-theme-id': theme,
        'aria-pressed': theme === currentTheme ? 'true' : 'false',
        title:
          theme === 'xuanji'
            ? '主题 · 璇玑（青铜史书）· T 键切换'
            : '主题 · 深空（舰桥仪表）· T 键切换',
      },
      text: THEME_LABEL[theme],
    });
    node.addEventListener('click', () => {
      if (currentTheme === theme) return;
      opts.onThemeRequest?.(theme);
    });
    return node;
  }
  const themeXu = themeTab('xuanji');
  const themeScifi = themeTab('scifi');
  themeTabs.append(themeXu, themeScifi);

  const side = el('div', { class: 'tb-side' }, [themeTabs, badge, modeRoot, paused]);
  const right = el('div', { class: 'tb-right' }, [metrics, sysMetrics, side]);

  header.append(brand, clockBox, right);
  // scifi 主题的 6s 顶栏扫描线（1px，仅主题内启用；reduced-motion 关闭）
  const scanline = el('span', { class: 'tb-scan', attrs: { 'aria-hidden': 'true' } });
  header.appendChild(scanline);
  header.dataset.currentView = currentView;
  header.dataset.theme = currentTheme;

  // ── 告警带 ──────────────────────────────────────────────────
  const alarmMark = el('span', { class: 'alarm-mark', text: '朱' });
  const alarmText = el('span', { class: 'alarm-text' });
  const alarm = el('div', { class: 'alarm' }, [alarmMark, alarmText]);
  alarm.dataset.kind = 'error';
  alarm.dataset.collapsed = '0';
  alarm.hidden = true;

  // ── 错误边闪（≤8% 面积，180ms 单次） ────────────────────────
  const flash = el('div', { class: 'edge-flash', attrs: { 'aria-hidden': 'true' } });

  region.append(header, alarm);
  container.appendChild(region);
  container.appendChild(flash);

  // ── 时钟：每秒更新 ──────────────────────────────────────────
  function tickClock(): void {
    const now = new Date();
    setText(shichen, formatShichen(now));
    setText(date, formatDateCN(now));
    setText(clock, formatClock(now));
  }
  tickClock();
  const clockTimer = window.setInterval(tickClock, 1000);

  // ── 告警计时器 ──────────────────────────────────────────────
  let collapseTimer = 0;
  let hideTimer = 0;
  let stickyRaised = false;
  let badgeKey = '';

  function hideAlarm(): void {
    alarm.hidden = true;
    alarm.dataset.collapsed = '0';
  }

  function raiseAlarm(kind: AlarmKind, text: string, sticky: boolean): void {
    alarm.hidden = false;
    alarm.dataset.kind = kind;
    alarm.dataset.collapsed = '0';
    alarmMark.textContent = kind === 'error' ? '朱' : '警';
    setText(alarmText, text);
    stickyRaised = sticky;
    if (collapseTimer) window.clearTimeout(collapseTimer);
    if (hideTimer) window.clearTimeout(hideTimer);
    collapseTimer = window.setTimeout(() => {
      collapseTimer = 0;
      alarm.dataset.collapsed = '1';
    }, 3000);
    if (!sticky) {
      hideTimer = window.setTimeout(() => {
        hideTimer = 0;
        hideAlarm();
      }, 6200);
    }
  }

  function flashError(): void {
    flash.classList.remove('is-on');
    // 强制回流，保证连续错误也能重新播放一次
    void flash.offsetWidth;
    flash.classList.add('is-on');
    const id = window.setTimeout(() => {
      flash.classList.remove('is-on');
    }, 220);
    flashTimers.add(id);
  }

  const flashTimers = new Set<number>();

  /** 铭牌与副题随视图切换；不改容器与其它模块，只动顶栏自身。 */
  function applyView(view: ViewKind): void {
    currentView = view;
    header.dataset.currentView = view;
    tabAgents.setAttribute('aria-pressed', view === 'agents' ? 'true' : 'false');
    tabSystem.setAttribute('aria-pressed', view === 'system' ? 'true' : 'false');
    setText(subText, view === 'agents' ? '本机智能体观测所' : '整机仪象');
  }

  /** 只同步主题铭牌；<html data-theme> 与 localStorage 由 main 负责，HUD 只做回执。 */
  function applyTheme(theme: ThemeId): void {
    currentTheme = theme;
    header.dataset.theme = theme;
    themeXu.setAttribute('aria-pressed', theme === 'xuanji' ? 'true' : 'false');
    themeScifi.setAttribute('aria-pressed', theme === 'scifi' ? 'true' : 'false');
  }

  function updateSpark(samples: number[]): void {
    if (samples.length === 0) {
      sparkLine.setAttribute('points', '');
      return;
    }
    const max = Math.max(1, ...samples);
    const xs = (i: number): number => (samples.length <= 1 ? 59 : (i / (samples.length - 1)) * 59);
    const points: string[] = [];
    samples.forEach((v, i) => {
      const r = Math.max(0, Math.min(1, v / max));
      points.push(`${xs(i).toFixed(1)},${(14 - r * 12).toFixed(1)}`);
    });
    sparkLine.setAttribute('points', points.join(' '));
  }

  function update(model: TopbarModel): void {
    if (model.view !== currentView) applyView(model.view);
    header.dataset.currentView = model.view;
    if (model.theme !== currentTheme) applyTheme(model.theme);

    const agg = model.aggregates;
    if (!model.hasFleet) {
      setText(liveM.value, '—');
      setText(idleM.value, '—');
      setText(endedM.value, '—');
      setText(rateValue, '—');
    } else if (agg) {
      setText(liveM.value, formatNumber(agg.liveCount));
      setText(idleM.value, formatNumber(agg.idleCount));
      setText(endedM.value, formatNumber(agg.endedCount));
      setText(rateValue, formatNumber(agg.tokenRate));
      errorM.root.hidden = agg.errorCount <= 0;
      setText(errorM.value, agg.errorCount > 0 ? formatNumber(agg.errorCount) : '0');
    }
    updateSpark(model.tokenSamples);
    for (const ref of catRefs) setText(ref.count, model.hasFleet ? formatCompact(model.catCounts[ref.cat]) : '—');

    const spec = badgeFor(model.connection, model.source);
    if (spec.key !== badgeKey) {
      badgeKey = spec.key;
      badge.dataset.state = spec.key;
      setText(badgeText, spec.text);
      header.dataset.connection = spec.key;
    }

    const idx = Math.max(0, VIEW_MODE_ORDER.indexOf(model.mode));
    setText(modeNum, MODE_CN[idx] ?? '壹');
    setText(modeName, MODE_LABEL[model.mode] ?? '云图');
    // v2.1：paused=true 表示自动运镜关闭/视野已锁（data-auto=off 便于 QA 读取）
    paused.hidden = !model.autoPaused;
    paused.dataset.auto = model.autoPaused ? 'off' : 'on';

    // ── 整机视图：中右两组指标（数据全部来自 setSystem 的最后一帧） ──
    const sys = model.system;
    const live = !!sys && sys.available;
    setText(cpuMetric.value, live ? fmtPct(sys?.cpu.usage) : '—');
    setText(memMetric.value, live ? fmtPct(sys?.mem.usedPct) : '—');
    const disk = sys?.disks?.find((item) => /^c:/i.test(item.name)) ?? sys?.disks?.[0] ?? null;
    setText(diskMetric.value, live && disk ? `C:${fmtPct(disk.usedPct)}` : '—');
    if (sys && sys.disks.length > 0) {
      diskMetric.root.title = sys.disks
        .map((item) => `${item.name} 已用 ${fmtPct(item.usedPct)} · 剩 ${fmtBytes(item.freeBytes)}`)
        .join('\n');
    }
    setText(netMetric.value, live ? fmtNetPairCompact(sys?.net.rxBps, sys?.net.txBps) : '—');
    setText(uptime, live && sys ? `已行 ${fmtUptime(sys.uptimeSec)}` : '');
    const batteryText = live ? fmtBattery(sys) : null;
    setText(battery, batteryText ? `电池 ${batteryText}` : '');
    const stale = model.systemAgeMs != null && model.systemAgeMs > 6000;
    catchup.hidden = !stale;
  }

  return {
    root: region,
    seal,
    update,
    setView: applyView,
    setTheme: applyTheme,
    raiseAlarm,
    clearStickyAlarm(): void {
      if (!stickyRaised) return;
      stickyRaised = false;
      if (collapseTimer) {
        window.clearTimeout(collapseTimer);
        collapseTimer = 0;
      }
      if (hideTimer) {
        window.clearTimeout(hideTimer);
        hideTimer = 0;
      }
      hideAlarm();
    },
    flashError,
    dispose(): void {
      window.clearInterval(clockTimer);
      if (collapseTimer) window.clearTimeout(collapseTimer);
      if (hideTimer) window.clearTimeout(hideTimer);
      for (const id of flashTimers) window.clearTimeout(id);
      flashTimers.clear();
      region.remove();
      flash.remove();
    },
  };
}

const MODE_LABEL: Record<ViewMode, string> = {
  survey: '云图',
  track: '逐星',
  dossier: '勘验',
  ledger: '起居注',
  orrery: '浑仪',
  scan: '拂扫',
  vigil: '守夜',
};
