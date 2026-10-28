// XUANJI · 璇玑 — 《器牒》：百工视图右侧的进程档案（总览 / 单进程）
// 纪律（BIBLE §24.6）：未选中 = 总览（进程数 / CPU 总负载 / 内存占用 / 线程总数 / 三轨各多少枚）；
// 选中 = 单进程档案（PID / 名称 / CPU% / 内存 / 线程 / 所属轨）+「← 进程总览」返回行。
// 机械、精确、无感情：骨白 / 钢灰 / 冷白；无呼吸、无缓动（主题/视图切换淡入除外）；不显示 0 值假数据。
import { el, setText } from '../lib/dom';
import { formatNumber } from '../lib/format';
import type { ProcInfo, SourceKind, SystemSnapshot } from '../state/types';
import { fmtBytes, fmtPct } from './system-format';
import { RAIL_LABEL, fmtStartClock, railOf, relAge } from './process-list';
import { makeCloseButton } from './ui';

export interface ProcessDetailOptions {
  /** 点「← 进程总览」清选；行内点选由《工籍》负责 */
  onSelectProcess?(pid: number | null): void;
  /** 收起（移动端 sheet 的 ✕） */
  onRequestClose?(): void;
}

export interface ProcessDetailHandle {
  root: HTMLElement;
  setSystem(snapshot: SystemSnapshot | null): void;
  setSource(source: SourceKind | null): void;
  setSelection(pid: number | null): void;
  /** 移动端：展开为 bottom sheet / 收起 */
  open(): void;
  close(): void;
  isOpen(): boolean;
  setReducedMotion(reduced: boolean): void;
  dispose(): void;
}

/** v2.7 五条轨道（BIBLE §26.2）：0 重载（最内最亮）… 4 沉积（最外最暗） */
const BAND_LABEL = ['重载', '活跃', '常规', '轻载', '沉积'] as const;

interface Aggregates {
  count: number;
  cpuSum: number;
  cpuAvg: number;
  memSum: number;
  memPct: number | null;
  threadsSum: number;
  rails: { cpu: number; mem: number; dormant: number };
}

const EMPTY_AGG: Aggregates = {
  count: 0,
  cpuSum: 0,
  cpuAvg: 0,
  memSum: 0,
  memPct: null,
  threadsSum: 0,
  rails: { cpu: 0, mem: 0, dormant: 0 },
};

/** O(n) 聚合：每次遥测（2s 一帧）算一次，不逐帧。 */
function aggregate(snapshot: SystemSnapshot | null): Aggregates {
  if (!snapshot || !snapshot.available || snapshot.procs.length === 0) return { ...EMPTY_AGG, rails: { cpu: 0, mem: 0, dormant: 0 } };
  let cpuSum = 0;
  let memSum = 0;
  let threadsSum = 0;
  const rails = { cpu: 0, mem: 0, dormant: 0 };
  for (const proc of snapshot.procs) {
    cpuSum += proc.cpuPct;
    memSum += proc.memBytes;
    threadsSum += typeof proc.threads === 'number' ? proc.threads : 0;
    rails[railOf(proc)] += 1;
  }
  const count = snapshot.procs.length;
  const totalMem = snapshot.mem.totalBytes;
  return {
    count,
    cpuSum,
    cpuAvg: cpuSum / count,
    memSum,
    memPct: totalMem > 0 ? memSum / totalMem : null,
    threadsSum,
    rails,
  };
}

function infoRow(label: string, extraClass = ''): { row: HTMLElement; value: HTMLElement } {
  const value = el('dd', { class: `pd-value ${extraClass}`.trim(), text: '—' });
  const row = el('div', { class: 'pd-row' }, [el('dt', { class: 'pd-label', text: label }), value]);
  return { row, value };
}

/** v2.6：只读 scene 调试遥测（入口流量 / 在途包）；v2.7 追加轨道带号/角速度/光束频率。
 *  取不到一律 null / 缺字段「—」，不报错、不发假值。 */
interface SceneProcessesDebug {
  packets?: number;
  entryFlow?: number;
  chipBands?: number[];
  chipSpeeds?: number[];
  beamRates?: number[];
}

function readProcessesDebug(): SceneProcessesDebug | null {
  const host = window as unknown as { __astra?: { scene?: { debugProcesses?: () => unknown } } };
  try {
    const value = host.__astra?.scene?.debugProcesses?.();
    return value && typeof value === 'object' ? (value as SceneProcessesDebug) : null;
  } catch {
    return null;
  }
}

export function createProcessDetail(parent: HTMLElement, opts: ProcessDetailOptions = {}): ProcessDetailHandle {
  const tab = el('button', {
    class: 'pd-tab',
    attrs: { type: 'button', 'aria-label': '展开《器牒》· 进程档案', 'aria-expanded': 'false' },
  });
  tab.append(el('span', { class: 'pd-tab-text', text: '器牒' }));

  const meta = el('span', { class: 'pd-meta', text: '候帧……' });
  const subText = el('span', { class: 'pd-sub', text: '进程总览' });
  const closeBtn = makeCloseButton('收起器牒', () => opts.onRequestClose?.());

  const head = el('header', { class: 'pd-head' }, [
    el('span', { class: 'pd-stamp', text: '器牒', attrs: { 'aria-hidden': 'true' } }),
    el('div', { class: 'pd-head-text' }, [el('h2', { class: 'pd-title', text: '器牒' }), subText]),
    meta,
    closeBtn,
  ]);

  // ── 总览 ────────────────────────────────────────────────────
  const overviewTitle = el('div', { class: 'pd-sec-title' }, [
    el('h3', { class: 'pd-sec-heading', text: '总览' }),
    el('span', { class: 'pd-sec-note', text: '全机 · 2s' }),
  ]);
  const countRow = infoRow('进程数');
  const cpuRow = infoRow('CPU 总负载');
  const memRow = infoRow('内存占用');
  const threadsRow = infoRow('线程总数');
  // v2.8 总览新增：显存（整机 GPU 显存，null 显示「—」；不做单进程显存）
  const gpuRow = infoRow('显存');
  // v2.6 总览新增：入口流量 / 在途包（scene 调试遥测，防御式取值）
  const entryFlowRow = infoRow('入口流量');
  const packetsRow = infoRow('在途包');
  const table = el('dl', { class: 'pd-table' }, [
    countRow.row,
    cpuRow.row,
    memRow.row,
    threadsRow.row,
    gpuRow.row,
    entryFlowRow.row,
    packetsRow.row,
  ]);

  const railTitle = el('div', { class: 'pd-sec-title pd-sec-title--rails' }, [
    el('h3', { class: 'pd-sec-heading', text: '三轨' }),
    el('span', { class: 'pd-sec-note', text: 'CPU / 内存 / 沉积' }),
  ]);
  const railCpuValue = el('b', { class: 'pd-rail-count', text: '—' });
  const railMemValue = el('b', { class: 'pd-rail-count', text: '—' });
  const railDormantValue = el('b', { class: 'pd-rail-count', text: '—' });
  function railRow(key: 'cpu' | 'mem' | 'dormant', count: HTMLElement): HTMLElement {
    return el('div', { class: 'pd-rail', dataset: { rail: key } }, [
      el('span', { class: 'pd-rail-mark', attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'pd-rail-label', text: RAIL_LABEL[key] }),
      count,
      el('span', { class: 'pd-rail-unit', text: '枚' }),
    ]);
  }
  const rails = el('div', { class: 'pd-rails' }, [
    railRow('cpu', railCpuValue),
    railRow('mem', railMemValue),
    railRow('dormant', railDormantValue),
  ]);
  const overview = el('section', { class: 'pd-overview', attrs: { 'aria-label': '进程总览' } }, [
    overviewTitle,
    table,
    railTitle,
    rails,
  ]);

  // ── 档案 ────────────────────────────────────────────────────
  const back = el('button', {
    class: 'pd-back',
    attrs: { type: 'button', title: '返回进程总览（Esc 也可清选）' },
  });
  back.append(el('span', { class: 'pd-back-arrow', text: '←', attrs: { 'aria-hidden': 'true' } }), el('span', { text: '进程总览' }));
  back.addEventListener('click', () => opts.onSelectProcess?.(null));

  const pidRow = infoRow('PID', 'is-mono');
  const nameRow = infoRow('名称', 'is-wide');
  const dCpuRow = infoRow('CPU', 'is-mono');
  const dMemRow = infoRow('内存', 'is-mono');
  const dThreadsRow = infoRow('线程', 'is-mono');
  // v2.6 档案新增：启动于（绝对 MM-DD HH:mm + 距今）
  const dStartedRow = infoRow('启动于', 'is-mono is-wide');
  const railValue = el('dd', { class: 'pd-value pd-rail-tag' });
  const railValueRow = el('div', { class: 'pd-row' }, [el('dt', { class: 'pd-label', text: '所属轨' }), railValue]);
  // v2.7 档案新增（在「所属轨」之后）：轨道 / 轨道速度 / 光束频率（scene 遥测，按 procs 同序）
  const dBandRow = infoRow('轨道', 'is-mono is-wide');
  const dLaneSpeedRow = infoRow('轨道速度', 'is-mono is-wide');
  const dBeamRow = infoRow('光束频率', 'is-mono is-wide');
  const info = el('dl', { class: 'pd-table pd-table--detail' }, [
    pidRow.row,
    nameRow.row,
    dCpuRow.row,
    dMemRow.row,
    dThreadsRow.row,
    dStartedRow.row,
    railValueRow,
    dBandRow.row,
    dLaneSpeedRow.row,
    dBeamRow.row,
  ]);
  const detailTitle = el('div', { class: 'pd-sec-title' }, [
    el('h3', { class: 'pd-sec-heading', text: '档案' }),
    el('span', { class: 'pd-sec-note', text: '单进程' }),
  ]);
  const detail = el('section', { class: 'pd-detail', attrs: { 'aria-label': '单进程档案' } }, [back, detailTitle, info]);
  detail.hidden = true;

  const empty = el('p', { class: 'pd-empty', text: '进程遥测不可用 · 检查采样器' });
  empty.hidden = true;

  const root = el(
    'aside',
    {
      class: 'pd-panel',
      attrs: {
        'aria-label': '器牒 · 进程档案',
        'data-hud': 'process-detail',
        'data-open': 'false',
      },
    },
    [head, overview, detail, empty],
  );

  const wrap = el('div', { class: 'pd-wrap' }, [tab, root]);
  parent.appendChild(wrap);

  let agg: Aggregates = { ...EMPTY_AGG, rails: { cpu: 0, mem: 0, dormant: 0 } };
  let snapshot: SystemSnapshot | null = null;
  let byPid = new Map<number, ProcInfo>();
  let selected: number | null = null;
  let source: SourceKind | null = null;
  let open = false;
  let available = false;

  function writeMeta(): void {
    const suffix = source === 'demo' ? ' · 演' : '';
    if (!available) {
      setText(meta, source === 'demo' ? `演练${suffix}` : '遥测不可用');
      return;
    }
    setText(meta, `${agg.count} 进程 · 2s${suffix}`);
  }

  function renderOverview(): void {
    setText(countRow.value, String(agg.count));
    countRow.value.dataset.state = agg.count > 0 ? 'ok' : 'empty';
    setText(cpuRow.value, agg.count > 0 ? `${agg.cpuSum.toFixed(1)}%` : '—');
    cpuRow.value.title = agg.count > 0 ? '所有进程 CPU 占比之和（可超过 100%）' : '';
    setText(memRow.value, agg.count > 0 ? fmtBytes(agg.memSum) : '—');
    const totalMem = snapshot?.mem.totalBytes ?? 0;
    if (agg.count > 0 && totalMem > 0) {
      memRow.value.title = `占物理内存 ${fmtPct(agg.memPct ?? 0)} · 共 ${fmtBytes(totalMem)}`;
    }
    setText(threadsRow.value, agg.count > 0 ? String(agg.threadsSum) : '—');
    // v2.8：显存（整机 GPU；null 不写 0）
    const gpu = snapshot?.gpu ?? null;
    if (gpu && gpu.memTotalBytes > 0) {
      setText(gpuRow.value, `${fmtBytes(gpu.memUsedBytes)} / ${fmtBytes(gpu.memTotalBytes)} · ${fmtPct(gpu.memPct)}`);
      gpuRow.value.title = `${gpu.name || 'GPU'} · 利用率 ${fmtPct(gpu.utilPct)} · ${Math.round(gpu.tempC)}°C`;
    } else {
      setText(gpuRow.value, '—');
      gpuRow.value.title = '显存不可用（未检测到 NVIDIA GPU 或 nvidia-smi 不可用）';
    }
    // v2.6：入口流量 / 在途包来自 scene 调试遥测（2s 帧节流，取不到显示「—」）
    const debug = readProcessesDebug();
    const entryFlow = debug && typeof debug.entryFlow === 'number' ? debug.entryFlow : null;
    const packets = debug && typeof debug.packets === 'number' ? debug.packets : null;
    setText(entryFlowRow.value, entryFlow != null ? `${formatNumber(entryFlow)} 条` : '—');
    setText(packetsRow.value, packets != null ? `${formatNumber(packets)} 个` : '—');
    entryFlowRow.value.title = entryFlow != null ? '外圈入口雨幕的流线条数（scene 遥测）' : 'scene 遥测暂不可用';
    packetsRow.value.title = packets != null ? '瀑布在途数据包数量（scene 遥测）' : 'scene 遥测暂不可用';
    setText(railCpuValue, String(agg.rails.cpu));
    setText(railMemValue, String(agg.rails.mem));
    setText(railDormantValue, String(agg.rails.dormant));
  }

  function renderDetail(): void {
    const proc = selected != null ? byPid.get(selected) : undefined;
    const has = !!proc && available;
    overview.hidden = has;
    detail.hidden = !has;
    setText(subText, has ? '单进程档案' : '进程总览');
    if (!has) {
      if (selected != null && !available) {
        // 遥测中断：保留总览，显示不可用提示
        overview.hidden = true;
        detail.hidden = true;
      }
      return;
    }
    if (!proc) return;
    setText(pidRow.value, String(proc.pid));
    setText(nameRow.value, proc.name);
    nameRow.value.title = proc.name;
    setText(dCpuRow.value, `${proc.cpuPct.toFixed(1)}%`);
    setText(dMemRow.value, fmtBytes(proc.memBytes));
    setText(dThreadsRow.value, typeof proc.threads === 'number' ? String(proc.threads) : '—');
    setText(
      dStartedRow.value,
      typeof proc.startedAt === 'number' && proc.startedAt > 0 ? `${fmtStartClock(proc.startedAt)} · ${relAge(proc.startedAt)}` : '—',
    );
    dStartedRow.value.title =
      typeof proc.startedAt === 'number' && proc.startedAt > 0 ? new Date(proc.startedAt).toLocaleString('zh-CN') : '';
    const rail = railOf(proc);
    railValue.dataset.rail = rail;
    railValue.textContent = '';
    railValue.append(
      el('span', { class: 'pd-rail-mark', attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'pd-rail-label', text: RAIL_LABEL[rail] }),
    );

    // v2.7：《器牒》档案新增三行——轨道 / 轨道速度 / 光束频率。
    // 数据来源：scene.debugProcesses() 的 chipBands/chipSpeeds/beamRates（与 procs 同序），
    // 用本地快照的 procs 顺序找 pid 下标对齐；scene 未就绪或下标越界时一律「—」，不发假值。
    const debug = readProcessesDebug();
    const procs = snapshot?.procs ?? [];
    const procIdx = procs.findIndex((entry) => entry.pid === proc.pid);
    const band = procIdx >= 0 && debug && Array.isArray(debug.chipBands) ? debug.chipBands[procIdx] : undefined;
    const speed = procIdx >= 0 && debug && Array.isArray(debug.chipSpeeds) ? debug.chipSpeeds[procIdx] : undefined;
    const beam = procIdx >= 0 && debug && Array.isArray(debug.beamRates) ? debug.beamRates[procIdx] : undefined;
    const bandOk = typeof band === 'number' && Number.isInteger(band) && band >= 0 && band < BAND_LABEL.length;
    setText(dBandRow.value, bandOk ? `${band} ${BAND_LABEL[band as number]}` : '—');
    if (bandOk) dBandRow.value.dataset.band = String(band);
    else delete dBandRow.value.dataset.band;
    dBandRow.value.title = bandOk
      ? `五轨之一：L${band} ${BAND_LABEL[band as number]}（scene 盘面同色）`
      : 'scene 轨道遥测暂不可用';
    setText(
      dLaneSpeedRow.value,
      typeof speed === 'number' && Number.isFinite(speed) ? `${speed.toFixed(3)} rad/s` : '—',
    );
    dLaneSpeedRow.value.title =
      typeof speed === 'number' && Number.isFinite(speed) ? '芯片角速度（rad/s，scene 按权重解析生成）' : 'scene 轨道遥测暂不可用';
    setText(dBeamRow.value, typeof beam === 'number' && Number.isFinite(beam) ? `${beam.toFixed(1)} 次/秒` : '—');
    dBeamRow.value.title =
      typeof beam === 'number' && Number.isFinite(beam) ? '该芯光束脉冲发射速率（次/秒）' : 'scene 轨道遥测暂不可用';
  }

  function setOpen(next: boolean): void {
    open = next;
    root.dataset.open = next ? 'true' : 'false';
    tab.setAttribute('aria-expanded', next ? 'true' : 'false');
    tab.hidden = next;
    root.classList.toggle('is-open', next);
    root.classList.toggle('is-unrolled', next);
  }
  tab.addEventListener('click', () => setOpen(true));
  closeBtn.addEventListener('click', () => {
    setOpen(false);
    opts.onRequestClose?.();
  });

  function setSystem(next: SystemSnapshot | null): void {
    snapshot = next;
    available = !!next && next.available;
    byPid = new Map((available ? next?.procs ?? [] : []).map((proc) => [proc.pid, proc]));
    agg = aggregate(next);
    empty.hidden = available;
    if (!available) {
      overview.hidden = true;
      detail.hidden = true;
      renderDetail();
      writeMeta();
      return;
    }
    if (selected != null && !byPid.has(selected)) selected = null;
    renderOverview();
    renderDetail();
    writeMeta();
  }

  function setSelection(pid: number | null): void {
    selected = pid;
    renderDetail();
  }

  return {
    root: wrap,
    setSystem,
    setSource(next: SourceKind | null): void {
      source = next;
      writeMeta();
    },
    setSelection,
    open(): void {
      setOpen(true);
    },
    close(): void {
      setOpen(false);
    },
    isOpen: () => open,
    setReducedMotion(value: boolean): void {
      root.classList.toggle('is-reduced', value);
    },
    dispose(): void {
      wrap.remove();
    },
  };
}
