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
  dispose(): void;
}

interface RowRefs {
  root: HTMLButtonElement;
  pid: HTMLElement;
  name: HTMLElement;
  cpu: HTMLElement;
  mem: HTMLElement;
  threads: HTMLElement;
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
  const stamp = el('span', { class: 'pg-stamp', text: '工籍', attrs: { 'aria-hidden': 'true' } });
  const head = el('header', { class: 'pg-head' }, [
    stamp,
    el('div', { class: 'pg-head-text' }, [
      el('h2', { class: 'pg-title', text: '工籍' }),
      el('span', { class: 'pg-sub', text: '器群名册 · 按 CPU 降序' }),
    ]),
    meta,
  ]);

  const headerRow = el('div', { class: 'pg-head-row', attrs: { role: 'row' } }, [
    el('span', { class: 'pg-th pg-pid', text: 'PID', attrs: { role: 'columnheader' } }),
    el('span', { class: 'pg-th pg-name', text: '进程', attrs: { role: 'columnheader' } }),
    el('span', { class: 'pg-th pg-cpu', text: 'CPU', attrs: { role: 'columnheader' } }),
    el('span', { class: 'pg-th pg-mem', text: '内存', attrs: { role: 'columnheader' } }),
    el('span', { class: 'pg-th pg-threads', text: '线程', attrs: { role: 'columnheader' } }),
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

  function makeRow(pid: number): RowRefs {
    const pidNode = el('span', { class: 'pg-cell pg-pid', text: String(pid) });
    const nameNode = el('span', { class: 'pg-cell pg-name' });
    const cpuNode = el('span', { class: 'pg-cell pg-cpu' });
    const memNode = el('span', { class: 'pg-cell pg-mem' });
    const threadsNode = el('span', { class: 'pg-cell pg-threads' });
    const row = el(
      'button',
      {
        class: 'pg-row',
        attrs: { type: 'button', 'data-pid': String(pid), 'aria-pressed': 'false' },
      },
      [pidNode, nameNode, cpuNode, memNode, threadsNode],
    );
    row.addEventListener('click', () => {
      selected = pid;
      syncPressed();
      opts.onSelectProcess?.(pid);
    });
    return { root: row, pid: pidNode, name: nameNode, cpu: cpuNode, mem: memNode, threads: threadsNode };
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
  }

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
      const title = `PID ${pid} · ${proc.name} · CPU ${proc.cpuPct.toFixed(1)}% · 内存 ${fmtBytes(proc.memBytes)}${
        typeof proc.threads === 'number' ? ` · 线程 ${proc.threads}` : ''
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
    dispose(): void {
      rows.clear();
      root.remove();
    },
  };
}
