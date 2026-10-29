// XUANJI · 璇玑 — 《机枢》：整机视图左下数值面板
// 纪律（BIBLE §19.2/§19.5）：只呈现 setSystem 给的真实帧；拿不到就写「—」；
// 遥测不可用时不显示 0 值，直接一条「遥测不可用 · 检查采样器」。
// 60 点 sparkline 的数据全部由本模块自己缓存（最近 120 帧），不依赖 store / main。
import { el, setText, svgEl } from '../lib/dom';
import type { SourceKind, SystemSnapshot } from '../state/types';
import { fmtBattery, fmtBytes, fmtPct, fmtRate, fmtUptime } from './system-format';
const HISTORY_MAX = 120;
const SPARK_POINTS = 60;
const SPARK_W = 84;
const SPARK_H = 16;

export interface SystemPanelOptions {
  /** v2.9 面板收放：true = 展开，false = 收起成 44px 胶囊 */
  onOpenChange?(open: boolean): void;
}

export interface SystemPanelHandle {
  root: HTMLElement;
  setSystem(snapshot: SystemSnapshot | null): void;
  setSource(source: SourceKind | null): void;
  setReducedMotion(reduced: boolean): void;
  /** v2.9：桌面端收起 / 展开（true = 收起成 44px 胶囊）；不触发 onOpenChange */
  setFolded(folded: boolean): void;
  isFolded(): boolean;
  dispose(): void;
}

interface SparkHandle {
  line: SVGElement;
  dot: SVGElement;
  svg: SVGElement;
  values: number[];
  /** 归一化上限：null = 固定的 0..1（CPU/内存/磁盘），数字 = 按窗口峰值 */
  peak: boolean;
}

function createSpark(peak: boolean, tint: string): SparkHandle {
  const svg = svgEl('svg', {
    class: 'sys-spark',
    viewBox: `0 0 ${SPARK_W} ${SPARK_H}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
  });
  svg.appendChild(
    svgEl('line', {
      x1: 0,
      y1: SPARK_H - 1,
      x2: SPARK_W,
      y2: SPARK_H - 1,
      stroke: 'rgba(200,182,142,0.14)',
      'stroke-width': 1,
    }),
  );
  const line = svgEl('polyline', {
    fill: 'none',
    stroke: tint,
    'stroke-width': 1,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
    points: '',
  });
  const dot = svgEl('circle', {
    class: 'sys-spark-dot',
    cx: SPARK_W,
    cy: SPARK_H - 2,
    r: 1.4,
    fill: tint,
    'fill-opacity': 0.9,
  });
  svg.append(line, dot);
  return { line, dot, svg, values: [], peak };
}

function paintSpark(spark: SparkHandle): void {
  const list = spark.values.slice(-SPARK_POINTS);
  if (list.length === 0) {
    spark.line.setAttribute('points', '');
    spark.dot.setAttribute('opacity', '0');
    return;
  }
  const max = spark.peak ? Math.max(1, ...list) : 1;
  const step = list.length <= 1 ? SPARK_W : SPARK_W / (list.length - 1);
  const points: string[] = [];
  list.forEach((value, index) => {
    const ratio = Math.max(0, Math.min(1, value / max));
    const x = list.length <= 1 ? SPARK_W : index * step;
    const y = SPARK_H - 2 - ratio * (SPARK_H - 3);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  spark.line.setAttribute('points', points.join(' '));
  const last = points[points.length - 1]?.split(',') ?? [];
  spark.dot.setAttribute('cx', last[0] ?? SPARK_W);
  spark.dot.setAttribute('cy', last[1] ?? SPARK_H - 2);
  spark.dot.setAttribute('opacity', '1');
}

interface RowRefs {
  value: HTMLElement;
  sub: HTMLElement;
}

export function createSystemPanel(parent: HTMLElement, opts: SystemPanelOptions = {}): SystemPanelHandle {
  const grip = el('button', {
    class: 'sys-grip',
    attrs: { type: 'button', 'aria-label': '展开《机枢》', 'aria-expanded': 'false' },
  });
  grip.append(el('span', { class: 'sys-grip-line', attrs: { 'aria-hidden': 'true' } }));

  const meta = el('span', { class: 'sys-meta', text: '候帧……' });
  // v2.9 面板收放：收起成 44px 胶囊（标题 + CPU/内存摘要 + ▸）
  const foldSummary = el('span', { class: 'sys-fold-summary', text: '候帧……' });
  const foldBtn = el('button', {
    class: 'panel-fold sys-fold',
    attrs: {
      type: 'button',
      'data-hud': 'system-collapse',
      'aria-label': '收起《机枢》',
      'aria-expanded': 'true',
    },
  });
  foldBtn.textContent = '—';
  const head = el('header', { class: 'sys-head' }, [
    el('span', { class: 'sys-stamp', text: '机枢', attrs: { 'aria-hidden': 'true' } }),
    el('div', { class: 'sys-head-text' }, [
      el('h2', { class: 'sys-title', text: '机枢' }),
      el('span', { class: 'sys-sub', text: '整机仪象 · 处理器 / 内存 / 显存 / 磁盘 / 网络' }),
    ]),
    meta,
    foldSummary,
    foldBtn,
  ]);

  const unavailable = el('p', { class: 'sys-unavailable', text: '遥测不可用 · 检查采样器' });
  unavailable.hidden = true;

  const body = el('div', { class: 'sys-body' });

  function makeRow(
    label: string,
    peak: boolean,
    title: string,
    tint: string,
  ): { row: HTMLElement; refs: RowRefs; spark: SparkHandle } {
    const value = el('span', { class: 'sys-value', text: '—' });
    const sub = el('span', { class: 'sys-row-sub', text: '' });
    const spark = createSpark(peak, tint);
    const row = el('div', { class: 'sys-row', attrs: { role: 'group' }, title }, [
      el('span', { class: 'sys-label', text: label }),
      value,
      spark.svg as unknown as HTMLElement,
      sub,
    ]);
    return { row, refs: { value, sub }, spark };
  }

  const cpuRow = makeRow('处理器', false, '整机 CPU 使用率（0–100%）', 'var(--gold-300)');
  const memRow = makeRow('内存', false, '物理内存占用', 'var(--gold-200)');
  const diskCRow = makeRow('磁盘 C:', false, '系统盘占用', 'var(--gold-400)');
  const diskDRow = makeRow('磁盘 D:', false, '数据盘占用', 'var(--gold-400)');
  const rxRow = makeRow('网络 ↓', true, '下行速率（近 2s 采样）', 'var(--cold-300)');
  const txRow = makeRow('网络 ↑', true, '上行速率（近 2s 采样）', 'var(--indigo-400)');

  // v2.8：显存 / GPU 两行。外层 data-hud="system-gpu" 供 QA；
  // gpu 为 null 时显示「显存不可用 / GPU 不可用」，数值位「—」，绝不写 0。
  const vramRow = makeRow('显存', false, '显存占用（GPU 专用显存）', 'var(--patina-300)');
  const gpuRow = makeRow('GPU', false, 'GPU 利用率 / 温度 / 型号', 'var(--theme-signal)');
  gpuRow.row.classList.add('sys-row--gpu');
  gpuRow.spark.svg.style.display = 'none';
  const gpuSection = el('div', { class: 'sys-gpu', attrs: { 'data-hud': 'system-gpu', 'aria-label': '显存与 GPU' } }, [
    vramRow.row,
    gpuRow.row,
  ]);

  for (const item of [cpuRow, memRow, diskCRow, diskDRow, rxRow, txRow]) body.append(item.row);
  body.append(gpuSection);

  const foot = el('footer', { class: 'sys-foot', text: '已行 —' });
  const root = el('aside', {
    class: 'sys-panel',
    attrs: {
      'aria-label': '机枢 · 整机运行数据',
      'data-hud': 'system-panel',
      'data-expanded': 'false',
    },
  });
  root.append(grip, head, unavailable, body, foot);
  parent.appendChild(root);

  let system: SystemSnapshot | null = null;
  let source: SourceKind | null = null;
  let reduced = false;
  let frames = 0;
  /** v2.9：桌面端收起成 44px 胶囊 */
  let folded = false;

  function pushSpark(spark: SparkHandle, value: number | null): void {
    if (value != null && Number.isFinite(value)) spark.values.push(value);
    else spark.values.push(spark.values.length > 0 ? spark.values[spark.values.length - 1] : 0);
    if (spark.values.length > HISTORY_MAX) spark.values.shift();
    paintSpark(spark);
  }

  function setUnavailable(): void {
    unavailable.hidden = false;
    body.hidden = true;
    foot.hidden = true;
    setText(meta, source === 'demo' ? '演练 · 演' : '遥测不可用');
    setText(foldSummary, '遥测不可用');
    grip.setAttribute('aria-label', '展开《机枢》');
  }

  function setSystem(snapshot: SystemSnapshot | null): void {
    system = snapshot;
    if (!snapshot || !snapshot.available) {
      setUnavailable();
      return;
    }
    frames += 1;
    unavailable.hidden = true;
    body.hidden = false;
    foot.hidden = false;

    const cpuPct = snapshot.cpu.usage;
    const memPct = snapshot.mem.usedPct;
    const diskC = snapshot.disks.find((item) => /^c:/i.test(item.name)) ?? snapshot.disks[0] ?? null;
    const diskD = snapshot.disks.find((item) => /^d:/i.test(item.name)) ?? snapshot.disks[1] ?? null;

    setText(cpuRow.refs.value, fmtPct(cpuPct));
    const perCore = snapshot.cpu.perCore;
    if (perCore.length > 0) {
      const peak = Math.max(...perCore);
      setText(cpuRow.refs.sub, `${perCore.length} 核 · 峰值 ${fmtPct(peak)}`);
    } else {
      setText(cpuRow.refs.sub, '整机合计');
    }
    pushSpark(cpuRow.spark, Number.isFinite(cpuPct) ? cpuPct : null);

    setText(memRow.refs.value, fmtPct(memPct));
    setText(
      memRow.refs.sub,
      `${fmtBytes(snapshot.mem.usedBytes)} / ${fmtBytes(snapshot.mem.totalBytes)}`,
    );
    pushSpark(memRow.spark, Number.isFinite(memPct) ? memPct : null);

    if (diskC) {
      setText(diskCRow.refs.value, fmtPct(diskC.usedPct));
      setText(diskCRow.refs.sub, `剩 ${fmtBytes(diskC.freeBytes)} / 共 ${fmtBytes(diskC.totalBytes)}`);
      pushSpark(diskCRow.spark, diskC.usedPct);
    } else {
      setText(diskCRow.refs.value, '—');
      setText(diskCRow.refs.sub, '未报告');
      pushSpark(diskCRow.spark, null);
    }
    if (diskD) {
      diskDRow.row.hidden = false;
      setText(diskDRow.refs.value, fmtPct(diskD.usedPct));
      setText(diskDRow.refs.sub, `剩 ${fmtBytes(diskD.freeBytes)} / 共 ${fmtBytes(diskD.totalBytes)}`);
      pushSpark(diskDRow.spark, diskD.usedPct);
    } else {
      diskDRow.row.hidden = true;
      pushSpark(diskDRow.spark, null);
    }

    setText(rxRow.refs.value, fmtRate(snapshot.net.rxBps));
    setText(rxRow.refs.sub, `累计 ${fmtBytes(snapshot.net.totalRxBytes)}`);
    pushSpark(rxRow.spark, snapshot.net.rxBps);
    setText(txRow.refs.value, fmtRate(snapshot.net.txBps));
    setText(txRow.refs.sub, `累计 ${fmtBytes(snapshot.net.totalTxBytes)}`);
    pushSpark(txRow.spark, snapshot.net.txBps);

    // v2.8：显存 / GPU（null = 显存不可用，不写 0）
    const gpu = snapshot.gpu;
    if (gpu && gpu.memTotalBytes > 0) {
      setText(vramRow.refs.value, fmtPct(gpu.memPct));
      setText(vramRow.refs.sub, `${fmtBytes(gpu.memUsedBytes)} / ${fmtBytes(gpu.memTotalBytes)}`);
      pushSpark(vramRow.spark, Number.isFinite(gpu.memPct) ? gpu.memPct : null);
      setText(
        gpuRow.refs.value,
        `利用率 ${fmtPct(gpu.utilPct)} · ${Math.round(gpu.tempC)}°C`,
      );
      setText(gpuRow.refs.sub, gpu.name || 'GPU');
      gpuRow.row.title = `${gpu.name || 'GPU'} · 显存 ${fmtBytes(gpu.memUsedBytes)} / ${fmtBytes(gpu.memTotalBytes)} · 利用率 ${fmtPct(gpu.utilPct)} · ${Math.round(gpu.tempC)}°C（${gpu.source || 'nvidia-smi'}）`;
      vramRow.spark.svg.style.display = '';
    } else {
      setText(vramRow.refs.value, '—');
      setText(vramRow.refs.sub, '显存不可用');
      pushSpark(vramRow.spark, null);
      setText(gpuRow.refs.value, '—');
      setText(gpuRow.refs.sub, 'GPU 不可用');
      gpuRow.row.title = '未检测到 NVIDIA GPU 或 nvidia-smi 不可用';
      vramRow.spark.svg.style.display = 'none';
    }

    const battery = fmtBattery(snapshot);
    setText(
      foot,
      [`已行 ${fmtUptime(snapshot.uptimeSec)}`, battery ? `电池 ${battery}` : '', source === 'demo' ? '演' : '']
        .filter(Boolean)
        .join(' · '),
    );
    setText(meta, `采样 2s · 第 ${frames} 帧`);
    setText(foldSummary, `CPU ${fmtPct(cpuPct)} · 内存 ${fmtPct(memPct)}`);
  }

  // ── v2.9 面板收放（BIBLE §28）：收起成 44px 胶囊，内容不参与点击/读屏 ──
  function setFolded(next: boolean): void {
    folded = next;
    root.dataset.folded = next ? 'true' : 'false';
    foldBtn.textContent = next ? '▸' : '—';
    foldBtn.setAttribute('aria-expanded', next ? 'false' : 'true');
    foldBtn.setAttribute('aria-label', next ? '展开《机枢》' : '收起《机枢》');
    body.setAttribute('aria-hidden', next ? 'true' : 'false');
    foot.setAttribute('aria-hidden', next ? 'true' : 'false');
    if (!next) return;
    root.dataset.expanded = 'false';
    grip.setAttribute('aria-expanded', 'false');
  }
  foldBtn.addEventListener('click', () => {
    setFolded(root.dataset.folded !== 'true');
    opts.onOpenChange?.(!folded);
  });

  grip.addEventListener('click', () => {
    const expanded = root.dataset.expanded === 'true';
    root.dataset.expanded = expanded ? 'false' : 'true';
    grip.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    grip.setAttribute('aria-label', expanded ? '展开《机枢》' : '收起《机枢》');
  });

  return {
    root,
    setSystem,
    setSource(next: SourceKind | null): void {
      source = next;
      if (system && system.available) {
        const battery = fmtBattery(system);
        setText(
          foot,
          [`已行 ${fmtUptime(system.uptimeSec)}`, battery ? `电池 ${battery}` : '', source === 'demo' ? '演' : '']
            .filter(Boolean)
            .join(' · '),
        );
      } else if (!system || !system.available) {
        setText(meta, source === 'demo' ? '演练 · 演' : '遥测不可用');
      }
    },
    setReducedMotion(reducedValue: boolean): void {
      reduced = reducedValue;
      root.classList.toggle('is-reduced', reduced);
    },
    setFolded,
    isFolded: () => folded,
    dispose(): void {
      root.remove();
    },
  };
}
