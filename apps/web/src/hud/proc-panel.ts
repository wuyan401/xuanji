// XUANJI · 璇玑 — 《器录》：整机视图右侧进程表
// 纪律（BIBLE §19.3/§17.3）：表头 11px +0.06em；行高 28–32px；无竖线、无斑马、不卡片化；
// 数字 JetBrains Mono tabular-nums 右对齐；排序按 CPU，但 8s 内保持行序稳定，避免肉眼跳动。
import { el, setText } from '../lib/dom';
import type { SourceKind, SystemSnapshot } from '../state/types';
import { fmtBytes } from './system-format';
import { makeCloseButton } from './ui';

const TOP_N = 20;
const RESORT_MS = 8000;

export interface ProcPanelOptions {
  onRequestClose?: () => void;
}

export interface ProcPanelHandle {
  root: HTMLElement;
  setSystem(snapshot: SystemSnapshot | null): void;
  setSource(source: SourceKind | null): void;
  setReducedMotion(reduced: boolean): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

interface RowRefs {
  root: HTMLButtonElement;
  pid: HTMLElement;
  name: HTMLElement;
  cpu: HTMLElement;
  mem: HTMLElement;
}

export function createProcPanel(parent: HTMLElement, opts: ProcPanelOptions = {}): ProcPanelHandle {
  const tab = el('button', {
    class: 'pr-tab',
    attrs: { type: 'button', 'aria-label': '展开《器录》· 进程表', 'aria-expanded': 'false' },
  });
  tab.append(el('span', { class: 'pr-tab-text', text: '器录' }));

  const meta = el('span', { class: 'pr-meta', text: '候帧……' });
  const closeBtn = makeCloseButton('收起器录', () => opts.onRequestClose?.());
  const head = el('header', { class: 'pr-head' }, [
    el('span', { class: 'pr-stamp', text: '器录', attrs: { 'aria-hidden': 'true' } }),
    el('div', { class: 'pr-head-text' }, [
      el('h2', { class: 'pr-title', text: '器录' }),
      el('span', { class: 'pr-sub', text: '进程 · 按 CPU 序' }),
    ]),
    meta,
    closeBtn,
  ]);

  const headerRow = el('div', { class: 'pr-head-row', attrs: { role: 'row' } }, [
    el('span', { class: 'pr-th pr-pid', text: 'PID', attrs: { role: 'columnheader' } }),
    el('span', { class: 'pr-th pr-name', text: '进程', attrs: { role: 'columnheader' } }),
    el('span', { class: 'pr-th pr-cpu', text: 'CPU', attrs: { role: 'columnheader' } }),
    el('span', { class: 'pr-th pr-mem', text: '内存', attrs: { role: 'columnheader' } }),
  ]);
  const body = el('div', { class: 'pr-body', attrs: { role: 'rowgroup' } });
  const table = el('div', { class: 'pr-table', attrs: { role: 'table', 'aria-label': '进程表，按 CPU 排序' } }, [
    headerRow,
    body,
  ]);
  const empty = el('p', { class: 'pr-empty', text: '遥测不可用 · 检查采样器' });
  empty.hidden = true;

  const root = el('aside', {
    class: 'proc-panel',
    attrs: {
      'aria-label': '器录 · 进程表',
      'data-hud': 'proc-table',
      'data-open': 'false',
    },
  });
  root.append(head, table, empty);

  const wrap = el('div', { class: 'pr-wrap' });
  wrap.append(tab, root);
  parent.appendChild(wrap);

  const rows = new Map<number, RowRefs>();
  let order: number[] = [];
  let lastSort = 0;
  let selected: number | null = null;
  let source: SourceKind | null = null;
  let open = false;

  function makeRow(pid: number): RowRefs {
    const pidNode = el('span', { class: 'pr-cell pr-pid', text: String(pid) });
    const nameNode = el('span', { class: 'pr-cell pr-name' });
    const cpuNode = el('span', { class: 'pr-cell pr-cpu' });
    const memNode = el('span', { class: 'pr-cell pr-mem' });
    const row = el(
      'button',
      {
        class: 'pr-row',
        attrs: {
          type: 'button',
          'data-pid': String(pid),
          'aria-pressed': 'false',
        },
      },
      [pidNode, nameNode, cpuNode, memNode],
    );
    row.addEventListener('click', () => {
      selected = selected === pid ? null : pid;
      for (const [otherPid, refs] of rows) {
        refs.root.setAttribute('aria-pressed', selected === otherPid ? 'true' : 'false');
      }
    });
    return { root: row, pid: pidNode, name: nameNode, cpu: cpuNode, mem: memNode };
  }

  function prune(byPid: Map<number, { pid: number; name: string; cpuPct: number; memBytes: number }>): void {
    order = order.filter((pid) => byPid.has(pid));
    for (const [pid, refs] of rows) {
      if (!byPid.has(pid)) {
        refs.root.remove();
        rows.delete(pid);
      }
    }
    if (selected != null && !byPid.has(selected)) selected = null;
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

    const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
    const now = Date.now();
    const needSort = order.length === 0 || now - lastSort > RESORT_MS;
    if (needSort) {
      order = procs
        .slice()
        .sort((a, b) => b.cpuPct - a.cpuPct)
        .slice(0, TOP_N)
        .map((proc) => proc.pid);
      lastSort = now;
    }
    prune(byPid);

    // 8s 稳定期内只更新数值；新出现的进程按 CPU 从高到低补进尾部
    if (order.length < TOP_N) {
      for (const proc of procs.slice().sort((a, b) => b.cpuPct - a.cpuPct)) {
        if (order.length >= TOP_N) break;
        if (!order.includes(proc.pid)) order.push(proc.pid);
      }
    }

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
      refs.root.setAttribute('aria-pressed', selected === pid ? 'true' : 'false');
      body.appendChild(refs.root);
    }

    setText(meta, `${order.length} 进程 · Top ${TOP_N} · 2s${source === 'demo' ? ' · 演' : ''}`);
  }

  function setOpen(next: boolean): void {
    open = next;
    root.dataset.open = next ? 'true' : 'false';
    tab.setAttribute('aria-expanded', next ? 'true' : 'false');
    tab.hidden = next;
    if (next) {
      root.classList.add('is-open');
      requestAnimationFrame(() => root.classList.add('is-unrolled'));
    } else {
      root.classList.remove('is-open', 'is-unrolled');
    }
  }

  tab.addEventListener('click', () => setOpen(true));

  return {
    root: wrap,
    setSystem,
    setSource(next: SourceKind | null): void {
      source = next;
      if (!table.hidden) setText(meta, `${order.length} 进程 · Top ${TOP_N} · 2s${source === 'demo' ? ' · 演' : ''}`);
      else if (source === 'demo') setText(meta, '演练 · 演');
    },
    setReducedMotion(reducedValue: boolean): void {
      root.classList.toggle('is-reduced', reducedValue);
    },
    open(): void {
      setOpen(true);
    },
    close(): void {
      setOpen(false);
    },
    isOpen: () => open,
    dispose(): void {
      wrap.remove();
    },
  };
}
