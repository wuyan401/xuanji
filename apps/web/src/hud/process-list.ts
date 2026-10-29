// XUANJI · 璇玑 — 《工籍》：百工视图左下的进程名册
// 纪律（BIBLE §24.6）：行高 24px（移动 32px）、严格按 CPU 降序、每 2s 刷新；
// 无竖线 / 无斑马 / 不卡片化；数字 mono tabular 右对齐；最多 24 行（名册是摘要，不滚动）。
// 机械、精确、无感情：只用骨白 / 钢灰 / 冷白，不用暖金；行为无缓动（主题/视图切换的淡入除外）。
import { el, setText } from '../lib/dom';
import type { ProcInfo, SourceKind, SystemSnapshot } from '../state/types';
import { fmtBytes } from './system-format';

const TOP_N = 24;

export interface ProcessListOptions {
  /** 点一行 → 请求选中该进程（null = 清选） */
  onSelectProcess?(pid: number | null): void;
  /** v2.9 面板收放：true = 展开，false = 收起成 44px 胶囊 */
  onOpenChange?(open: boolean): void;
}

export interface ProcessListHandle {
  root: HTMLElement;
  /** 整机遥测（只取 procs）；null / 不可用 → 显示「进程遥测不可用」 */
  setSystem(snapshot: SystemSnapshot | null): void;
  setSource(source: SourceKind | null): void;
  setSelection(pid: number | null): void;
  /** 当前名册顺序（CPU 降序，最多 24 个 pid）——键盘 ↑↓ 用 */
  getPids(): number[];
  /** 焦点交给第一行（L 键 / 可访问性） */
  focusFirst(): boolean;
  setReducedMotion(reduced: boolean): void;
  /** v2.9：桌面端收起 / 展开（true = 收起成 44px 胶囊）；不触发 onOpenChange */
  setFolded(folded: boolean): void;
  isFolded(): boolean;
  dispose(): void;
}

interface RowRefs {
  root: HTMLButtonElement;
  band: HTMLElement;
  pid: HTMLElement;
  name: HTMLElement;
  cpu: HTMLElement;
  mem: HTMLElement;
  threads: HTMLElement;
  started: HTMLElement;
}

/** v2.6：启动时间 → 相对时间（12s / 3m / 2h / 3d）；缺失或 ≤0 → 「—」 */
export function relAge(startedAt: number | undefined, now: number = Date.now()): string {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) return '—';
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  return `${Math.floor(hour / 24)}d`;
}

/** v2.6：启动时间 → 绝对时刻 `MM-DD HH:mm`；缺失或 ≤0 → 「—」 */
export function fmtStartClock(startedAt: number | undefined): string {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) return '—';
  const d = new Date(startedAt);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** v2.7：只读 scene 调试遥测里的轨道带号（与 procs 同序；取不到返回 null，不报错）。 */
interface SceneTorrentDebug {
  chipBands?: unknown;
}

function readChipBands(): number[] | null {
  const host = window as unknown as { __astra?: { scene?: { debugProcesses?: () => unknown } } };
  try {
    const value = host.__astra?.scene?.debugProcesses?.();
    if (!value || typeof value !== 'object') return null;
    const bands = (value as SceneTorrentDebug).chipBands;
    return Array.isArray(bands) ? (bands as number[]) : null;
  } catch {
    return null;
  }
}

/** v2.7：五轨带号（0 重载 … 4 沉积）→ 数据属性；非法值返回 null（不画竖标）。 */
function bandAttr(value: unknown): string | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4 ? String(value) : null;
}

/** 三轨分轨规则（BIBLE §24.3）；《器牒》总览与档案共用。 */
export function railOf(proc: ProcInfo): 'cpu' | 'mem' | 'dormant' {
  if (proc.cpuPct >= 1) return 'cpu';
  if (proc.memBytes > 500 * 1024 * 1024) return 'mem';
  return 'dormant';
}

export const RAIL_LABEL: Record<'cpu' | 'mem' | 'dormant', string> = {
  cpu: 'CPU 轨',
  mem: '内存轨',
  dormant: '沉积轨',
};

export function createProcessList(parent: HTMLElement, opts: ProcessListOptions = {}): ProcessListHandle {
  const grip = el('button', {
    class: 'pg-grip',
    attrs: { type: 'button', 'aria-label': '展开《工籍》进程名册', 'aria-expanded': 'false' },
  });
  grip.append(el('span', { class: 'pg-grip-line', attrs: { 'aria-hidden': 'true' } }));

  const meta = el('span', { class: 'pg-meta', text: '候帧……' });
  // v2.9 面板收放：收起成 44px 胶囊（标题 + N 进程 + ▸），桌面可见、移动端隐藏
  const foldSummary = el('span', { class: 'pg-fold-summary', text: '候帧' });
  const foldBtn = el('button', {
    class: 'panel-fold pg-fold',
    attrs: {
      type: 'button',
      'data-hud': 'worklist-collapse',
      'aria-label': '收起《工籍》',
      'aria-expanded': 'true',
    },
  });
  foldBtn.textContent = '—';
  const stamp = el('span', { class: 'pg-stamp', text: '工籍', attrs: { 'aria-hidden': 'true' } });
  const head = el('header', { class: 'pg-head' }, [
    stamp,
    el('div', { class: 'pg-head-text' }, [
      el('h2', { class: 'pg-title', text: '工籍' }),
      el('span', { class: 'pg-sub', text: '器群名册 · 按 CPU 降序' }),
    ]),
    meta,
    foldSummary,
    foldBtn,
  ]);

  const headerRow = el('div', { class: 'pg-head-row', attrs: { role: 'row' } }, [
    el('span', { class: 'pg-th pg-pid', text: 'PID', attrs: { role: 'columnheader' } }),
    el('span', { class: 'pg-th pg-name', text: '进程', attrs: { role: 'columnheader' } }),
    el('span', { class: 'pg-th pg-cpu', text: 'CPU', attrs: { role: 'columnheader' } }),
    el('span', { class: 'pg-th pg-mem', text: '内存', attrs: { role: 'columnheader' } }),
    el('span', { class: 'pg-th pg-threads', text: '线程', attrs: { role: 'columnheader' } }),
    el('span', { class: 'pg-th pg-started', text: '启动', attrs: { role: 'columnheader' } }),
  ]);
  const body = el('div', { class: 'pg-body', attrs: { role: 'rowgroup' } });
  const table = el('div', { class: 'pg-table', attrs: { role: 'table', 'aria-label': '进程名册，按 CPU 降序' } }, [
    headerRow,
    body,
  ]);
  const empty = el('p', { class: 'pg-empty', text: '进程遥测不可用 · 检查采样器' });
  empty.hidden = true;

  const root = el(
    'aside',
    {
      class: 'pg-panel',
      attrs: {
        'aria-label': '工籍 · 进程名册',
        'data-hud': 'process-list',
        'data-expanded': 'false',
      },
    },
    [grip, head, table, empty],
  );
  parent.appendChild(root);

  const rows = new Map<number, RowRefs>();
  let order: number[] = [];
  let byPid = new Map<number, ProcInfo>();
  let selected: number | null = null;
  let source: SourceKind | null = null;
  let reduced = false;
  let expanded = false;
  /** v2.9：桌面端收起成 44px 胶囊 */
  let folded = false;

  function makeRow(pid: number): RowRefs {
    // v2.7：PID 左侧 3px 轨道色小竖标（scene 未就绪时整条隐藏，不画假色）
    const bandNode = el('span', { class: 'pg-band', attrs: { 'aria-hidden': 'true' } });
    bandNode.hidden = true;
    const pidNode = el('span', { class: 'pg-cell pg-pid', text: String(pid) });
    const nameNode = el('span', { class: 'pg-cell pg-name' });
    const cpuNode = el('span', { class: 'pg-cell pg-cpu' });
    const memNode = el('span', { class: 'pg-cell pg-mem' });
    const threadsNode = el('span', { class: 'pg-cell pg-threads' });
    const startedNode = el('span', { class: 'pg-cell pg-started' });
    const row = el(
      'button',
      {
        class: 'pg-row',
        attrs: { type: 'button', 'data-pid': String(pid), 'aria-pressed': 'false' },
      },
      [bandNode, pidNode, nameNode, cpuNode, memNode, threadsNode, startedNode],
    );
    row.addEventListener('click', () => {
      selected = pid;
      syncPressed();
      opts.onSelectProcess?.(pid);
    });
    return {
      root: row,
      band: bandNode,
      pid: pidNode,
      name: nameNode,
      cpu: cpuNode,
      mem: memNode,
      threads: threadsNode,
      started: startedNode,
    };
  }

  function syncPressed(): void {
    for (const [pid, refs] of rows) {
      refs.root.setAttribute('aria-pressed', selected === pid ? 'true' : 'false');
    }
  }

  function prune(keep: Set<number>): void {
    for (const [pid, refs] of rows) {
      if (!keep.has(pid)) {
        refs.root.remove();
        rows.delete(pid);
      }
    }
    if (selected != null && !keep.has(selected)) selected = null;
  }

  function writeMeta(): void {
    const suffix = source === 'demo' ? ' · 演' : '';
    setText(meta, order.length > 0 ? `${order.length} 行 · 2s${suffix}` : source === 'demo' ? `演练${suffix}` : '候帧');
    setText(foldSummary, order.length > 0 ? `${order.length} 进程` : '候帧');
  }

  // ── v2.9 面板收放（BIBLE §28）：收起成 44px 胶囊，表体不参与点击/读屏 ──
  function setFolded(next: boolean): void {
    folded = next;
    root.dataset.folded = next ? 'true' : 'false';
    foldBtn.textContent = next ? '▸' : '—';
    foldBtn.setAttribute('aria-expanded', next ? 'false' : 'true');
    foldBtn.setAttribute('aria-label', next ? '展开《工籍》' : '收起《工籍》');
    table.setAttribute('aria-hidden', next ? 'true' : 'false');
    empty.setAttribute('aria-hidden', next ? 'true' : 'false');
    if (!next) return;
    root.dataset.expanded = 'false';
    grip.setAttribute('aria-expanded', 'false');
  }
  foldBtn.addEventListener('click', () => {
    setFolded(root.dataset.folded !== 'true');
    opts.onOpenChange?.(!folded);
  });

  function setSystem(snapshot: SystemSnapshot | null): void {
    const available = !!snapshot && snapshot.available;
    const procs = available ? snapshot?.procs ?? [] : [];
    if (!available || procs.length === 0) {
      empty.hidden = false;
      table.hidden = true;
      setText(meta, available ? '暂无进程' : source === 'demo' ? '演练 · 演' : '遥测不可用');
      return;
    }
    empty.hidden = true;
    table.hidden = false;

    byPid = new Map(procs.map((proc) => [proc.pid, proc]));
    // v2.7：轨道带号按 procs 同序对齐（scene 未就绪 → null，行内不画竖标）
    const bands = readChipBands();
    const procIndex = new Map<number, number>();
    if (bands) procs.forEach((proc, index) => procIndex.set(proc.pid, index));
    // 严格按当前 CPU 降序：每次遥测（2s 一帧）都重排，不留 8s 保序窗口
    order = procs
      .slice()
      .sort((a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes || a.pid - b.pid)
      .slice(0, TOP_N)
      .map((proc) => proc.pid);
    // 行节点只保留在榜的 TOP_N 个（否则进出榜会让 DOM 无限增长）
    prune(new Set(order));

    // 只为名册内的进程保留行节点；已存在节点复用，仅更新文本，避免每帧重建
    for (const pid of order) {
      const proc = byPid.get(pid);
      if (!proc) continue;
      let refs = rows.get(pid);
      if (!refs) {
        refs = makeRow(pid);
        rows.set(pid, refs);
      }
      setText(refs.name, proc.name);
      setText(refs.cpu, `${proc.cpuPct.toFixed(1)}%`);
      setText(refs.mem, fmtBytes(proc.memBytes));
      setText(refs.threads, typeof proc.threads === 'number' ? String(proc.threads) : '—');
      setText(refs.started, relAge(proc.startedAt));
      // v2.7：行内轨道色竖标（band 0–4；scene 未就绪或越界 → 隐藏，不画假色）
      const band = bands ? bandAttr(bands[procIndex.get(pid) ?? -1]) : null;
      refs.band.hidden = band == null;
      if (band == null) delete refs.band.dataset.band;
      else refs.band.dataset.band = band;
      const title = `PID ${pid} · ${proc.name} · CPU ${proc.cpuPct.toFixed(1)}% · 内存 ${fmtBytes(proc.memBytes)}${
        typeof proc.threads === 'number' ? ` · 线程 ${proc.threads}` : ''
      }${proc.startedAt && proc.startedAt > 0 ? ` · 启动 ${fmtStartClock(proc.startedAt)}（${relAge(proc.startedAt)}）` : ''}${
        band != null ? ` · 轨道 L${band}` : ''
      }`;
      refs.root.title = title;
      refs.root.setAttribute('aria-label', title);
      refs.root.setAttribute('aria-pressed', selected === pid ? 'true' : 'false');
      body.appendChild(refs.root);
    }
    writeMeta();
  }

  function setSelection(pid: number | null): void {
    selected = pid;
    syncPressed();
    if (pid != null) {
      const refs = rows.get(pid);
      if (refs && typeof refs.root.scrollIntoView === 'function') {
        refs.root.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function setExpanded(next: boolean): void {
    expanded = next;
    root.dataset.expanded = next ? 'true' : 'false';
    grip.setAttribute('aria-expanded', next ? 'true' : 'false');
  }
  grip.addEventListener('click', () => setExpanded(!expanded));

  return {
    root,
    setSystem,
    setSource(next: SourceKind | null): void {
      source = next;
      writeMeta();
    },
    setSelection,
    getPids: () => order.slice(),
    focusFirst(): boolean {
      const first = order.length ? rows.get(order[0]) : null;
      if (first) {
        first.root.focus();
        return true;
      }
      return false;
    },
    setReducedMotion(value: boolean): void {
      reduced = value;
      root.classList.toggle('is-reduced', reduced);
      void reduced;
    },
    setFolded,
    isFolded: () => folded,
    dispose(): void {
      rows.clear();
      root.remove();
    },
  };
}
