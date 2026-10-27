// XUANJI · 璇玑 — 星牒（右侧 320px 档案面板）
// 默认态＝「分野总览」：本机所有 workspace 一律可见（v1.2，用户反馈「其它 agent 呢」）；
// 选中态＝该星档案，顶部有「← 分野总览」返回行。出现时为卷轴展开（宽 0→320 + 内容落墨）。
// §17.3：档案行制式 —— 无竖线、无斑马纹、行间 1px ink-line、数字列等宽右对齐。
import { el, setText } from '../lib/dom';
import {
  formatCheng,
  formatClock,
  formatCompact,
  formatDuration,
  formatNumber,
  shortenPath,
  truncate,
} from '../lib/format';
import { sourceShort, TOOL_CATEGORY_LABEL } from '../state/types';
import type {
  AgentSession,
  AgentSourceInfo,
  AstroEvent,
  ClientFleetSnapshot,
  Sector,
  ToolCategory,
} from '../state/types';
import { SHIERCI } from './ledger-templates';
import { makeCloseButton, rafThrottle } from './ui';

const TOOL_MARKS: Record<ToolCategory, string> = {
  read: '览',
  write: '书',
  exec: '作',
  net: '讯',
  agent: '遣',
};
const TOOL_ORDER: ToolCategory[] = ['read', 'write', 'exec', 'net', 'agent'];

const STATE_CN: Record<AgentSession['state'], string> = {
  live: '在行',
  idle: '驻留',
  ended: '已藏',
};

const MAX_ERRORS = 5;
/** 每星最多留存的最近器用记录 */
const MAX_TRACES = 32;
/** 分野行里的器用小条格数（§task：24 格） */
const SECTOR_SLOTS = 24;
const RECENT_TOOLS = 5;

interface ToolTrace {
  id: string;
  tool: string;
  cat: ToolCategory | null;
  at: number;
  durationMs: number | null;
}

export interface DossierCallbacks {
  /** 选中一颗星（null = 取消选中，回到总览） */
  onSelect(id: string | null): void;
  /** 点选一个分野（null = 取消分野聚焦） */
  onSelectSector(id: string | null): void;
  /** 按来源筛选（null = 全部）；由「诸源」签发起 */
  onSourceFilter?(sourceId: string | null): void;
  /** 关闭请求（右上角 ✕）：由 HUD 总装决定是否同时取消选中 */
  onRequestClose(): void;
}

export interface DossierHandle {
  root: HTMLElement;
  setFleet(snap: ClientFleetSnapshot): void;
  pushEvents(events: AstroEvent[]): void;
  setSelection(id: string | null): void;
  setSectorFocus(id: string | null): void;
  setSourceFilter(sourceId: string | null): void;
  setReducedMotion(reduced: boolean): void;
  openOverview(): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

interface RowOpts {
  mono?: boolean;
  wide?: boolean;
  valueNode?: Node;
}

interface SectorStats {
  live: number;
  idle: number;
  ended: number;
  total: number;
  rate: number;
  recentAt: number;
  totals: Record<ToolCategory, number>;
  top2: { cat: ToolCategory; count: number }[];
}

interface SectorRowRefs {
  root: HTMLButtonElement;
  src: HTMLElement;
  name: HTMLElement;
  suffix: HTMLElement;
  recent: HTMLElement;
  counts: HTMLElement;
  rate: HTMLElement;
  top2: HTMLElement;
  bar: HTMLElement;
  cells: HTMLElement[];
}

/** 相对时间：刚刚 / n 分前 / n 时前 / n 日前 */
function relTime(at: number, now = Date.now()): string {
  if (!at || !Number.isFinite(at)) return '—';
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 时前`;
  return `${Math.floor(diff / 86_400_000)} 日前`;
}

/** 把器用总量分配成 24 格（最大余数法），无器用时返回全空槽 */
function allocateSlots(totals: Record<ToolCategory, number>): (ToolCategory | null)[] {
  const slots: (ToolCategory | null)[] = new Array(SECTOR_SLOTS).fill(null);
  const total = TOOL_ORDER.reduce((sum, cat) => sum + (totals[cat] ?? 0), 0);
  if (total <= 0) return slots;
  const exact = TOOL_ORDER.map((cat) => ({
    cat,
    n: Math.floor(((totals[cat] ?? 0) / total) * SECTOR_SLOTS),
    frac: ((totals[cat] ?? 0) / total) * SECTOR_SLOTS,
  }));
  for (const item of exact) item.frac -= item.n;
  let used = exact.reduce((sum, item) => sum + item.n, 0);
  const byRemainder = exact.slice().sort((a, b) => b.frac - a.frac);
  let cursor = 0;
  while (used < SECTOR_SLOTS && byRemainder.length > 0) {
    byRemainder[cursor % byRemainder.length].n += 1;
    used += 1;
    cursor += 1;
  }
  let index = 0;
  for (const item of exact) {
    for (let i = 0; i < item.n && index < SECTOR_SLOTS; i += 1) slots[index++] = item.cat;
  }
  return slots;
}

export function createDossier(parent: HTMLElement, cb: DossierCallbacks): DossierHandle {
  // ── 收起的页签（始终在右缘，点开分野总览） ──────────────────
  const tab = el('button', {
    class: 'ds-tab',
    attrs: { type: 'button', 'aria-label': '展开星牒 · 分野总览', 'aria-expanded': 'false' },
  });
  tab.append(el('span', { class: 'ds-tab-text', text: '星牒' }), el('i', { class: 'ds-tab-badge' }));

  // ── 面板 ────────────────────────────────────────────────────
  const root = el('aside', {
    class: 'dossier',
    attrs: { 'aria-label': '星牒 · 分野与星之档案', 'data-open': 'false' },
  });
  root.dataset.open = 'false';

  const subText = el('span', { class: 'ds-sub', text: '分野 · 总览' });
  const metaText = el('span', { class: 'ds-meta', text: '本机 — 分野 · — 位' });
  const closeBtn = makeCloseButton('收起星牒', () => cb.onRequestClose());
  const head = el('header', { class: 'ds-head' }, [
    el('span', { class: 'ds-stamp', text: '星牒', attrs: { 'aria-hidden': 'true' } }),
    el('div', { class: 'ds-head-text' }, [
      el('h2', { class: 'ds-title', text: '星牒' }),
      subText,
      metaText,
    ]),
    closeBtn,
  ]);

  const scroll = el('div', { class: 'ds-scroll' });

  // ── 分野总览 ────────────────────────────────────────────────
  const sectorsBox = el('div', { class: 'ds-sectors' });
  const sectorNote = el('span', { class: 'ds-sec-note', text: '' });
  const sectorTitle = el('div', { class: 'ds-sec-title' }, [
    el('h3', { text: '分野' }),
    el('span', { class: 'ds-sec-sub', text: '总览' }),
    sectorNote,
  ]);
  const sectorsEmpty = el('p', { class: 'ds-empty', text: '候录中……' });

  // ── 诸源（v2.0 · 只做来源筛选，不改数据口径）────────────────
  const sourcesBox = el('div', {
    class: 'ds-sources',
    // QA 钩子：自动化验收以 data-hud="source-chips" 定位来源签
    attrs: { role: 'group', 'aria-label': '按来源筛选', 'data-hud': 'source-chips' },
  });
  const sourcesNote = el('span', { class: 'ds-sec-note', text: '点签只看来源 · 再点取消' });
  const sourcesTitle = el('div', { class: 'ds-sec-title ds-sec-title--sources' }, [
    el('h3', { text: '诸源' }),
    el('span', { class: 'ds-sec-sub', text: '本机' }),
    sourcesNote,
  ]);

  // 警情
  const liveValue = el('dd', { class: 'ds-value is-mono', text: '—' });
  const idleValue = el('dd', { class: 'ds-value is-mono', text: '—' });
  const endedValue = el('dd', { class: 'ds-value is-mono', text: '—' });
  const pressureFill = el('i', { class: 'ds-bar-fill' });
  const pressureBar = el('span', { class: 'ds-bar', attrs: { 'aria-hidden': 'true' } }, [pressureFill]);
  const pressureValue = el('dd', { class: 'ds-value is-mono', text: '—' });
  const teamValue = el('dd', { class: 'ds-value is-mono', text: '—' });
  const errCount = el('dd', { class: 'ds-value is-mono', text: '—' });

  // 器用五色图例
  const legend = el('div', { class: 'ds-legend' });
  const legendRefs = TOOL_ORDER.map((cat) => {
    const count = el('span', { class: 'ds-leg-count', text: '—' });
    const chip = el('span', { class: 'ds-chip', dataset: { cat }, attrs: { 'aria-hidden': 'true' } });
    chip.textContent = TOOL_MARKS[cat];
    const item = el('div', { class: 'ds-leg', title: TOOL_CATEGORY_LABEL[cat] }, [chip, count]);
    legend.appendChild(item);
    return { cat, count, item };
  });

  const errorsBox = el('div', { class: 'ds-errors' });

  const overview = el('section', {
    class: 'ds-overview',
    // QA 钩子：自动化验收以 data-hud="sector-overview" 定位分野总览面板
    attrs: { 'aria-label': '分野总览', 'data-hud': 'sector-overview' },
  }, [
    sourcesTitle,
    sourcesBox,
    sectorTitle,
    sectorsBox,
    sectorsEmpty,
    el('div', { class: 'ds-sec-title ds-sec-title--sub' }, [
      el('h3', { text: '警情' }),
      el('span', { class: 'ds-sec-sub', text: '本机' }),
    ]),
    el('dl', { class: 'ds-table' }, [
      el('div', { class: 'ds-row' }, [el('dt', { text: '在行' }), liveValue]),
      el('div', { class: 'ds-row' }, [el('dt', { text: '驻留' }), idleValue]),
      el('div', { class: 'ds-row' }, [el('dt', { text: '已藏' }), endedValue]),
      el('div', { class: 'ds-row ds-row--bar' }, [
        el('dt', { text: '最高卷帙' }),
        el('dd', { class: 'ds-value is-mono ds-bar-cell' }, [pressureBar, pressureValue]),
      ]),
      el('div', { class: 'ds-row' }, [el('dt', { text: '团队任务' }), teamValue]),
      el('div', { class: 'ds-row' }, [el('dt', { text: '累积误' }), errCount]),
    ]),
    el('div', { class: 'ds-sec-title ds-sec-title--sub' }, [
      el('h3', { text: '器用' }),
      el('span', { class: 'ds-sec-sub', text: '五色' }),
    ]),
    legend,
    el('div', { class: 'ds-sec-title ds-sec-title--sub' }, [
      el('h3', { text: '最近' }),
      el('span', { class: 'ds-sec-sub', text: '误' }),
    ]),
    errorsBox,
  ]);

  // ── 详情 ────────────────────────────────────────────────────
  const detail = el('section', { class: 'ds-detail', attrs: { 'aria-label': '星之档案' } });
  detail.hidden = true;

  scroll.append(overview, detail);
  root.append(head, scroll);

  const wrap = el('div', { class: 'ds-wrap' });
  wrap.append(tab, root);
  parent.appendChild(wrap);

  // ── 状态 ────────────────────────────────────────────────────
  let snap: ClientFleetSnapshot | null = null;
  let sessionById = new Map<string, AgentSession>();
  let selection: string | null = null;
  let sectorFocus: string | null = null;
  let sourceFilter: string | null = null;
  let errors: AstroEvent[] = [];
  let reduced = false;
  let open = false;
  let runNode: HTMLElement | null = null;
  let runStartedAt = 0;
  let disposed = false;
  let detailSig = '';
  let errorSig = '';

  const traces = new Map<string, ToolTrace[]>();
  const traceIds = new Set<string>();
  const sectorRows = new Map<string, SectorRowRefs>();
  const errBadge = tab.querySelector<HTMLElement>('.ds-tab-badge');

  const tickRun = rafThrottle((): void => {
    if (!runNode || !runStartedAt) return;
    setText(runNode, formatDuration(Date.now() - runStartedAt));
  });
  const runTimer = window.setInterval(() => {
    if (!open || !runNode) return;
    tickRun();
  }, 250);

  /** 收集最近器用（tool/call + tool/result，含真实耗时） */
  function harvestEvents(events: AstroEvent[] | undefined): void {
    if (!events || events.length === 0) return;
    for (const ev of events) {
      if (ev.kind !== 'tool/call' && ev.kind !== 'tool/result') continue;
      if (traceIds.has(ev.id)) continue;
      traceIds.add(ev.id);
      let bucket = traces.get(ev.sessionId);
      if (!bucket) {
        bucket = [];
        traces.set(ev.sessionId, bucket);
      }
      bucket.push({
        id: ev.id,
        tool: ev.tool ?? '—',
        cat: ev.toolCategory,
        at: ev.at,
        durationMs: ev.durationMs,
      });
      if (bucket.length > MAX_TRACES) bucket.splice(0, bucket.length - MAX_TRACES);
    }
  }

  function row(label: string, value: string, opts: RowOpts = {}): HTMLElement {
    const dd = el('dd', { class: `ds-value${opts.mono ? ' is-mono' : ''}`, text: value });
    if (opts.wide) dd.classList.add('is-wide');
    if (opts.valueNode) {
      dd.textContent = '';
      dd.appendChild(opts.valueNode);
    }
    if (!opts.wide) dd.title = value;
    return el('div', { class: 'ds-row' }, [el('dt', { text: label }), dd]);
  }

  function subRow(label: string, body: Node): HTMLElement {
    return el('div', { class: 'ds-row ds-row--stack' }, [
      el('dt', { text: label }),
      el('dd', { class: 'ds-value is-wide' }, [body]),
    ]);
  }

  // ── 分野总览渲染 ────────────────────────────────────────────
  function sectorStats(sec: Sector): SectorStats {
    const totals: Record<ToolCategory, number> = { read: 0, write: 0, exec: 0, net: 0, agent: 0 };
    let live = 0;
    let idle = 0;
    let ended = 0;
    let rate = 0;
    let recentAt = 0;
    for (const id of sec.sessionIds) {
      const session = sessionById.get(id);
      if (!session) continue;
      if (session.state === 'live') live += 1;
      else if (session.state === 'idle') idle += 1;
      else ended += 1;
      rate += session.recentTokenRate ?? 0;
      recentAt = Math.max(recentAt, session.lastActivityAt ?? 0);
      for (const cat of TOOL_ORDER) totals[cat] += session.toolCounts?.[cat] ?? 0;
    }
    const top2 = TOOL_ORDER.map((cat) => ({ cat, count: totals[cat] }))
      .filter((item) => item.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 2);
    return { live, idle, ended, total: live + idle + ended, rate, recentAt, totals, top2 };
  }

  /** 同名分野加路径尾缀区分（如 `deepseek harness · AI/`） */
  function sectorLabel(sec: Sector): { name: string; suffix: string } {
    const sectors = snap?.sectors ?? [];
    const sameName = sectors.filter((item) => item.name === sec.name).length > 1;
    if (!sameName) return { name: sec.name, suffix: '' };
    const segments = (sec.path || '').split(/[\\/]+/).filter(Boolean);
    const tail = segments[segments.length - 1] ?? '';
    return { name: sec.name, suffix: tail ? `${tail}/` : '' };
  }

  function createSectorRow(sec: Sector): SectorRowRefs {
    const src = el('span', { class: 'ds-sector-src', attrs: { 'aria-hidden': 'true' } });
    const name = el('span', { class: 'ds-sector-name', text: sec.name });
    const suffix = el('em', { class: 'ds-sector-suffix', text: '' });
    name.appendChild(suffix);
    const recent = el('span', { class: 'ds-sector-recent', text: '—' });
    const counts = el('span', { class: 'ds-sector-counts', text: '—' });
    const rate = el('span', { class: 'ds-sector-rate', text: '' });
    const top2 = el('span', { class: 'ds-sector-top2' });
    const cells: HTMLElement[] = [];
    const bar = el('span', { class: 'ds-sector-bar', attrs: { 'aria-hidden': 'true' } });
    for (let i = 0; i < SECTOR_SLOTS; i += 1) {
      const cell = el('i', { class: 'ds-sector-cell is-empty' });
      cells.push(cell);
      bar.appendChild(cell);
    }
    const rootEl = el(
      'button',
      {
        class: 'ds-sector',
        attrs: {
          type: 'button',
          'data-live': 'false',
          'data-sector': sec.id,
          // QA 钩子：每行带稳定的分野 id 与名称
          'data-sector-id': sec.id,
          'data-sector-name': sec.name,
          'aria-pressed': 'false',
        },
      },
      [
        el('span', { class: 'ds-sector-line' }, [
          el('i', { class: 'ds-sector-dot', attrs: { 'aria-hidden': 'true' } }),
          src,
          name,
          bar,
          recent,
        ]),
        el('span', { class: 'ds-sector-line ds-sector-line--data' }, [
          counts,
          rate,
          top2,
        ]),
      ],
    );
    return { root: rootEl, src, name, suffix, recent, counts, rate, top2, bar, cells };
  }

  /** 本机已发现的来源（absent 不参与筛选） */
  function detectedSources(): AgentSourceInfo[] {
    return (snap?.sources ?? []).filter((src) => src.state !== 'absent');
  }

  function syncSectors(): void {
    const sectors = snap?.sectors ?? [];
    const hasData = snap != null;
    const ids = new Set(sectors.map((sec) => sec.id));
    for (const [id, refs] of sectorRows) {
      if (!ids.has(id)) {
        refs.root.remove();
        sectorRows.delete(id);
      }
    }
    sectorsEmpty.hidden = sectors.length > 0;
    if (sectors.length === 0) {
      setText(sectorsEmpty, hasData ? '未有分野入案。' : '候录中……');
      setText(sectorNote, '');
    }

    let liveAll = 0;
    let endedAll = 0;
    let totalAll = 0;
    for (const sec of sectors) {
      let refs = sectorRows.get(sec.id);
      if (!refs) {
        refs = createSectorRow(sec);
        sectorRows.set(sec.id, refs);
      }
      sectorsBox.appendChild(refs.root);

      const label = sectorLabel(sec);
      setText(refs.name, label.name);
      setText(refs.suffix, label.suffix ? ` · ${label.suffix}` : '');
      refs.root.dataset.live = 'false';
      refs.root.dataset.sector = sec.id;
      refs.root.dataset.source = sec.source;
      refs.root.setAttribute('aria-pressed', sectorFocus === sec.id ? 'true' : 'false');
      // ≥2 来源时给分野名前缀来源短名（BIBLE §19.1）
      const multiSource = detectedSources().length > 1;
      setText(refs.src, sourceShort(sec.source));
      refs.src.hidden = !multiSource;
      refs.src.dataset.source = sec.source;
      refs.root.classList.toggle('is-dimmed', sourceFilter != null && sec.source !== sourceFilter);

      if (!hasData) {
        setText(refs.recent, '—');
        setText(refs.counts, '—');
        setText(refs.rate, '');
        refs.top2.textContent = '';
        refs.bar.hidden = true;
        continue;
      }

      const stats = sectorStats(sec);
      liveAll += stats.live;
      endedAll += stats.ended;
      totalAll += stats.total;
      refs.root.dataset.live = stats.live > 0 ? 'true' : 'false';

      setText(refs.recent, relTime(stats.recentAt));
      setText(refs.counts, `行${stats.live} · 藏${stats.ended} · 共${stats.total}`);
      setText(refs.rate, stats.rate > 0 ? `文速 ${formatNumber(Math.round(stats.rate))}` : '文速 —');

      refs.top2.textContent = '';
      if (stats.top2.length === 0) {
        refs.top2.appendChild(el('span', { class: 'ds-sector-tool is-none', text: '器用 —' }));
      } else {
        for (const item of stats.top2) {
          refs.top2.appendChild(
            el('span', { class: 'ds-sector-tool', dataset: { cat: item.cat }, title: TOOL_CATEGORY_LABEL[item.cat] }, [
              el('i', { class: 'ds-sector-mark', text: TOOL_MARKS[item.cat], attrs: { 'aria-hidden': 'true' } }),
              el('b', { text: formatCompact(item.count) }),
            ]),
          );
        }
      }

      const slots = allocateSlots(stats.totals);
      const hasTools = stats.top2.length > 0 || slots.some((cat) => cat !== null);
      refs.bar.hidden = !hasTools;
      for (let i = 0; i < SECTOR_SLOTS; i += 1) {
        const cat = slots[i];
        setClass(refs.cells[i], cat ? `ds-sector-cell is-${cat}` : 'ds-sector-cell is-empty');
      }

      refs.root.title = [
        `${label.name}${label.suffix ? ` · ${label.suffix}` : ''}`,
        sec.path,
        `在行 ${stats.live} · 驻留 ${stats.idle} · 已藏 ${stats.ended} · 共 ${stats.total}`,
        `文速 ${Math.round(stats.rate)} 文/秒 · 最近动静 ${relTime(stats.recentAt)}`,
        stats.top2.length > 0
          ? `器用前二 ${stats.top2.map((item) => `${TOOL_CATEGORY_LABEL[item.cat]} ${item.count}`).join(' · ')}`
          : '器用 —',
      ].join('\n');
      refs.root.setAttribute(
        'aria-label',
        `分野 ${label.name}${label.suffix ? ` ${label.suffix}` : ''}，在行 ${stats.live}，驻留 ${stats.idle}，已藏 ${stats.ended}，共 ${stats.total} 位；文速 ${Math.round(stats.rate)} 文每秒；器用前二 ${stats.top2.map((item) => `${TOOL_CATEGORY_LABEL[item.cat]} ${item.count}`).join('、') || '无'}；最近动静 ${relTime(stats.recentAt)}`,
      );
    }

    setText(
      sectorNote,
      hasData ? `行 ${liveAll} · 藏 ${endedAll} · 共 ${totalAll}` : '',
    );
  }

  function setClass(node: HTMLElement, value: string): void {
    if (node.className !== value) node.className = value;
  }

  function setSectorFocus(id: string | null, notify: boolean): void {
    if (sectorFocus === id) {
      if (notify) cb.onSelectSector(id);
      return;
    }
    sectorFocus = id;
    syncSectors();
    if (selection == null) {
      const focused = snap?.sectors.find((sec) => sec.id === id) ?? null;
      const label = focused ? sectorLabel(focused) : null;
      subText.textContent = label ? `分野 · ${label.name}` : '分野 · 总览';
    }
    if (notify) cb.onSelectSector(id);
  }

  // ── 诸源渲染（v2.0）─────────────────────────────────────────
  function renderSources(): void {
    const sources = snap?.sources ?? [];
    const demo = snap?.source === 'demo';
    const hasSources = sources.length > 0;
    sourcesTitle.hidden = !hasSources;
    sourcesBox.hidden = !hasSources;
    sourcesBox.textContent = '';
    if (!hasSources) return;

    setText(
      sourcesNote,
      sourceFilter != null
        ? `只看 ${sourceShort(sourceFilter)} · 再点取消`
        : '点签只看来源 · 再点取消',
    );

    for (const src of sources) {
      const absent = src.state === 'absent';
      const kids: (Node | string)[] = [
        el('span', { class: 'ds-source-label', text: src.label }),
        absent
          ? el('span', { class: 'ds-source-count is-absent', text: '未发现' })
          : el('span', { class: 'ds-source-count', text: String(src.sessions) }),
      ];
      if (!absent && demo) kids.push(el('i', { class: 'ds-source-demo', text: '演' }));
      const chip = el(
        'button',
        {
          class: 'ds-source',
          attrs: {
            type: 'button',
            'data-source': src.id,
            'data-state': absent ? 'absent' : 'detected',
            'aria-pressed': sourceFilter === src.id ? 'true' : 'false',
            title: absent
              ? `${src.label} · 未发现\n${src.detail}`
              : `${src.label} · ${src.sessions} 会话 · ${src.live} 在行\n${src.detail}`,
            'aria-label': absent
              ? `来源 ${src.label}，未发现`
              : `来源 ${src.label}，${src.sessions} 会话，${src.live} 在行`,
          },
        },
        kids,
      );
      chip.addEventListener('click', () => {
        setSourceFilter(sourceFilter === src.id ? null : src.id, true);
      });
      sourcesBox.appendChild(chip);
    }
  }

  function setSourceFilter(id: string | null, notify: boolean): void {
    if (sourceFilter === id) {
      if (notify) cb.onSourceFilter?.(id);
      return;
    }
    sourceFilter = id;
    renderSources();
    syncSectors();
    if (notify) cb.onSourceFilter?.(id);
  }

  // ── 警情渲染 ────────────────────────────────────────────────
  function renderOverview(): void {
    const agg = snap?.aggregates;
    const sessions = snap?.sessions ?? [];
    const live = agg?.liveCount ?? sessions.filter((s) => s.state === 'live').length;
    const idle = agg?.idleCount ?? sessions.filter((s) => s.state === 'idle').length;
    const ended = agg?.endedCount ?? sessions.filter((s) => s.state === 'ended').length;
    setText(liveValue, snap ? formatNumber(live) : '—');
    setText(idleValue, snap ? formatNumber(idle) : '—');
    setText(endedValue, snap ? formatNumber(ended) : '—');

    const pressure =
      agg?.maxContextPressure ??
      sessions.reduce((max, s) => Math.max(max, s.contextPressure), 0);
    pressureFill.style.width = `${Math.round(Math.max(0, Math.min(1, pressure)) * 100)}%`;
    setText(pressureValue, snap ? formatCheng(pressure) : '—');

    const teamTasks = sessions.reduce((sum, s) => sum + (s.team?.tasks ?? 0), 0);
    setText(teamValue, snap ? formatNumber(teamTasks) : '—');
    setText(errCount, snap ? formatNumber(agg?.errorCount ?? errors.length) : '—');

    const totals = new Map<ToolCategory, number>();
    for (const cat of TOOL_ORDER) totals.set(cat, 0);
    for (const session of sessions) {
      for (const cat of TOOL_ORDER) {
        totals.set(cat, (totals.get(cat) ?? 0) + (session.toolCounts?.[cat] ?? 0));
      }
    }
    for (const ref of legendRefs) {
      const value = totals.get(ref.cat) ?? 0;
      ref.count.textContent = snap ? formatCompact(value) : '—';
      ref.item.setAttribute('aria-label', `${TOOL_CATEGORY_LABEL[ref.cat]} ${value}`);
    }

    setText(metaText, snap ? `本机 ${snap.sectors.length} 分野 · ${snap.sessions.length} 位` : '本机 — 分野 · — 位');
    renderSources();
    syncSectors();
    renderErrors();
  }

  function renderErrors(): void {
    const sig = errors.map((ev) => ev.id).join(',');
    if (sig === errorSig) return;
    errorSig = sig;
    errorsBox.textContent = '';
    if (errors.length === 0) {
      errorsBox.appendChild(el('p', { class: 'ds-empty', text: '今夜无警。' }));
    } else {
      for (const ev of errors.slice(0, MAX_ERRORS)) {
        const session = sessionById.get(ev.sessionId);
        const item = el('button', {
          class: 'ds-error',
          attrs: { type: 'button', 'aria-label': `误 · ${ev.sessionTitle || session?.title || ''}` },
        });
        const detailText = ev.detail ? truncate(ev.detail, 46) : '有误';
        item.append(
          el('span', { class: 'ds-error-time', text: formatClock(new Date(ev.at)) }),
          el('span', { class: 'ds-error-body' }, [
            el('span', { class: 'ds-error-star', text: ev.sessionTitle || session?.title || '无名之星' }),
            el('span', { class: 'ds-error-text', text: `有误 · ${detailText}` }),
          ]),
        );
        item.addEventListener('click', () => cb.onSelect(ev.sessionId));
        errorsBox.appendChild(item);
      }
    }
    if (errBadge) {
      const count = errors.length;
      errBadge.textContent = count > 0 ? String(Math.min(count, 9)) : '';
      errBadge.hidden = count === 0;
    }
  }

  // ── 详情渲染 ────────────────────────────────────────────────
  function recentTraceTable(sessionId: string): HTMLElement {
    const table = el('div', { class: 'ds-tools', attrs: { role: 'table', 'aria-label': '最近器用' } });
    const list = (traces.get(sessionId) ?? []).slice(-RECENT_TOOLS).reverse();
    if (list.length === 0) {
      table.appendChild(el('p', { class: 'ds-empty', text: '尚无器用记录。' }));
      return table;
    }
    for (const trace of list) {
      const mark = trace.cat ? TOOL_MARKS[trace.cat] : '·';
      const item = el('div', { class: 'ds-tool-row', attrs: { role: 'row' } }, [
        el('span', { class: 'ds-tool-time', text: formatClock(new Date(trace.at)), attrs: { role: 'cell' } }),
        el('span', { class: 'ds-tool-mark', dataset: trace.cat ? { cat: trace.cat } : {}, text: mark, attrs: { role: 'cell', 'aria-hidden': 'true' } }),
        el('span', { class: 'ds-tool-name', text: truncate(trace.tool, 22), attrs: { role: 'cell' } }),
        el('span', {
          class: 'ds-tool-dur',
          text: trace.durationMs != null ? formatDuration(trace.durationMs) : '—',
          attrs: { role: 'cell' },
        }),
      ]);
      table.appendChild(item);
    }
    return table;
  }

  function detailSignature(session: AgentSession): string {
    const traceCount = traces.get(session.id)?.length ?? 0;
    return [
      session.id,
      session.state,
      session.turns,
      session.steps,
      session.pendingCalls.join('|'),
      session.todos ? session.todos.map((todo) => `${todo.done ? '1' : '0'}${todo.text}`).join('|') : '',
      session.planActive ? '1' : '0',
      session.team?.memberIds.length ?? 0,
      session.team?.tasks ?? 0,
      session.tokens.input,
      session.tokens.output,
      session.tokens.cacheRead,
      session.tokens.cacheWrite,
      Math.round(session.recentTokenRate ?? 0),
      Math.round((session.contextPressure ?? 0) * 1000),
      session.lastPrompt ?? '',
      session.lastResponse ?? '',
      session.openStep?.startedAt ?? 0,
      session.openStep?.turn ?? 0,
      traceCount,
    ].join('~');
  }

  function renderDetail(force = false): void {
    const session = selection != null ? snap?.sessions.find((s) => s.id === selection) ?? null : null;
    if (!session) {
      detail.hidden = true;
      overview.hidden = false;
      runNode = null;
      runStartedAt = 0;
      detailSig = '';
      return;
    }
    const sig = detailSignature(session);
    if (!force && sig === detailSig) return;
    detailSig = sig;

    detail.hidden = false;
    overview.hidden = true;

    const sectorIndex = snap?.sectors.findIndex((sector) => sector.sessionIds.includes(session.id)) ?? -1;
    const sector = sectorIndex >= 0 ? snap?.sectors[sectorIndex] ?? null : null;
    const label = sector ? sectorLabel(sector) : null;
    const domain = SHIERCI[(sectorIndex >= 0 ? sectorIndex : 0) % SHIERCI.length] ?? SHIERCI[0];
    subText.textContent = `${domain} · ${truncate(session.title || session.workspace || '无名', 14)}`;

    detail.textContent = '';

    // 返回默认态（分野总览）
    const back = el('button', { class: 'ds-back', attrs: { type: 'button' } }, [
      el('span', { class: 'ds-back-arrow', text: '←', attrs: { 'aria-hidden': 'true' } }),
      el('span', { text: '分野总览' }),
    ]);
    back.addEventListener('click', () => {
      detailSig = '';
      selection = null;
      overview.hidden = false;
      detail.hidden = true;
      runNode = null;
      runStartedAt = 0;
      subText.textContent = '分野 · 总览';
      renderOverview();
      cb.onSelect(null);
    });
    detail.appendChild(back);

    // 星名 / 标题
    detail.appendChild(
      el('div', { class: 'ds-star-head' }, [
        el('span', { class: 'ds-star-domain', text: domain }),
        el('h3', { class: 'ds-star-title', text: session.title || '无名之星' }),
        el('span', { class: 'ds-star-state', dataset: { state: session.state }, text: STATE_CN[session.state] }),
      ]),
    );

    // 身份
    const identity = el('dl', { class: 'ds-table' });
    identity.append(
      row('工作区', session.workspace || '—'),
      row('路径', shortenPath(session.cwd || '—', 30), { mono: true }),
      row('模型', session.model ?? '—'),
      row('预设', session.preset ?? '—'),
      row('思力', session.reasoningEffort ?? '—'),
    );
    if (label) identity.append(row('分野', `${domain} · ${label.name}${label.suffix ? ` · ${label.suffix}` : ''}`));
    if (session.parentId) identity.append(row('父星', truncate(session.parentId, 18), { mono: true }));
    detail.appendChild(identity);

    // 进程
    const process = el('dl', { class: 'ds-table' });
    process.append(row('轮次', formatNumber(session.turns), { mono: true }), row('步数', formatNumber(session.steps), { mono: true }));

    runNode = el('span', { class: 'ds-run' });
    const stepStartedAt = session.openStep?.startedAt ?? 0;
    if (session.openStep) {
      runStartedAt = stepStartedAt;
      setText(runNode, formatDuration(Date.now() - stepStartedAt));
      process.append(subRow('在推', runNode), row('第几轮', formatNumber(session.openStep.turn), { mono: true }));
    } else {
      runNode = null;
      runStartedAt = 0;
      process.append(row('在推', '—'));
    }
    if (session.pendingCalls.length > 0) {
      const list = el('span', { class: 'ds-list' });
      for (const call of session.pendingCalls.slice(0, 4)) {
        list.appendChild(el('span', { class: 'ds-list-item', text: call }));
      }
      process.append(subRow('候办', list));
    }
    if (session.todos && session.todos.length > 0) {
      const done = session.todos.filter((todo) => todo.done).length;
      const list = el('span', { class: 'ds-todos' });
      for (const todo of session.todos.slice(0, 4)) {
        list.appendChild(
          el('span', { class: `ds-todo${todo.done ? ' is-done' : ''}`, text: `${todo.done ? '✓' : '○'} ${todo.text}` }),
        );
      }
      process.append(row('事目', `${done}/${session.todos.length}`, { mono: true }), subRow('条目', list));
    }
    process.append(row('筹划', session.planActive ? '筹划中' : '未筹划'));
    process.append(row('团队', `${session.team.memberIds.length} 星 · ${session.team.tasks} 务`));
    detail.appendChild(process);

    // 文与卷帙
    const tokens = el('dl', { class: 'ds-table' });
    tokens.append(
      row('文 · 入', formatCompact(session.tokens.input), { mono: true }),
      row('文 · 出', formatCompact(session.tokens.output), { mono: true }),
      row('文 · 缓存读', formatCompact(session.tokens.cacheRead), { mono: true }),
      row('文 · 缓存写', formatCompact(session.tokens.cacheWrite), { mono: true }),
      row('文速', `${formatNumber(Math.round(session.recentTokenRate))} 文/秒`, { mono: true }),
    );
    const fill = el('i', { class: 'ds-bar-fill' });
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, session.contextPressure)) * 100)}%`;
    const bar = el('span', { class: 'ds-bar', attrs: { 'aria-hidden': 'true' } }, [fill]);
    const cheng = el('span', { class: 'ds-cheng', text: formatCheng(session.contextPressure) });
    tokens.append(
      el('div', { class: 'ds-row ds-row--bar' }, [
        el('dt', { text: '卷帙' }),
        el('dd', { class: 'ds-value is-mono ds-bar-cell' }, [bar, cheng]),
      ]),
    );
    detail.appendChild(tokens);

    // 最近器用（mono 小表，右对齐耗时）
    detail.appendChild(
      el('div', { class: 'ds-sec-title ds-sec-title--sub' }, [
        el('h3', { text: '器用' }),
        el('span', { class: 'ds-sec-sub', text: '最近五笔' }),
      ]),
    );
    detail.appendChild(recentTraceTable(session.id));

    // 最后一言
    const said = el('dl', { class: 'ds-table' });
    if (session.lastPrompt) {
      said.append(subRow('最后指令', el('span', { class: 'ds-quote', text: truncate(session.lastPrompt, 180) })));
    }
    if (session.lastResponse) {
      said.append(subRow('最后回话', el('span', { class: 'ds-quote', text: truncate(session.lastResponse, 180) })));
    }
    if (!session.lastPrompt && !session.lastResponse) {
      said.append(row('最后', '尚无言语'));
    }
    detail.appendChild(said);
  }

  function rerender(): void {
    renderOverview();
    if (selection != null) renderDetail(false);
  }

  function setOpenState(next: boolean): void {
    open = next;
    root.dataset.open = next ? 'true' : 'false';
    tab.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) {
      root.classList.add('is-open');
      tab.hidden = true;
      requestAnimationFrame(() => {
        root.classList.add('is-unrolled');
      });
    } else {
      root.classList.remove('is-open', 'is-unrolled');
      tab.hidden = false;
      runNode = null;
      runStartedAt = 0;
    }
  }

  function openOverview(): void {
    setOpenState(true);
    if (selection != null) {
      selection = null;
      cb.onSelect(null);
    }
    overview.hidden = false;
    detail.hidden = true;
    detailSig = '';
    runNode = null;
    runStartedAt = 0;
    subText.textContent = '分野 · 总览';
    renderOverview();
  }

  function close(): void {
    setOpenState(false);
  }

  tab.addEventListener('click', () => openOverview());

  // 分野行点击（事件委托；行可 Tab 聚焦，Enter/空格等同点击）
  sectorsBox.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement | null;
    const rowEl = target?.closest<HTMLElement>('.ds-sector');
    if (!rowEl) return;
    const id = rowEl.dataset.sector ?? null;
    if (!id) return;
    setSectorFocus(sectorFocus === id ? null : id, true);
  });

  // ── 对外 ────────────────────────────────────────────────────
  function setFleet(next: ClientFleetSnapshot): void {
    snap = next;
    sessionById = new Map(next.sessions.map((session) => [session.id, session]));
    harvestEvents(next.events);
    if (selection != null && !sessionById.has(selection)) selection = null;
    rerender();
  }

  function pushEvents(events: AstroEvent[]): void {
    if (!events || events.length === 0) return;
    harvestEvents(events);
    let changed = false;
    for (const ev of events) {
      if (ev.kind !== 'error') continue;
      if (errors.some((old) => old.id === ev.id)) continue;
      errors.push(ev);
      changed = true;
    }
    if (changed) {
      errors.sort((a, b) => b.at - a.at);
      if (errors.length > 40) errors = errors.slice(0, 40);
      renderErrors();
    }
    if (selection != null) renderDetail(false);
  }

  function setSelection(id: string | null): void {
    if (selection === id) {
      if (id != null) renderDetail(true);
      return;
    }
    selection = id;
    detailSig = '';
    if (id != null) {
      setOpenState(true);
      renderDetail(true);
    } else if (open) {
      overview.hidden = false;
      detail.hidden = true;
      subText.textContent = '分野 · 总览';
      runNode = null;
      runStartedAt = 0;
      renderOverview();
    }
  }

  function setReducedMotion(value: boolean): void {
    reduced = value;
    root.classList.toggle('is-reduced', value);
  }

  // 可见性变化时避免后台 250ms 空转
  const onVisibility = (): void => {
    if (document.hidden) {
      runNode = null;
      runStartedAt = 0;
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  rerender();

  return {
    root: wrap,
    setFleet,
    pushEvents,
    setSelection,
    setSectorFocus: (id: string | null) => setSectorFocus(id, false),
    setSourceFilter: (id: string | null) => setSourceFilter(id, false),
    setReducedMotion,
    openOverview,
    close,
    isOpen: () => open,
    dispose(): void {
      disposed = true;
      window.clearInterval(runTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      void disposed;
      void reduced;
      wrap.remove();
    },
  };
}
