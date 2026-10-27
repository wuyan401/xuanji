// XUANJI · 璇玑 — 授时（开机序列，约 3.2s）
// 时间轴：0–0.5s 微光｜0.5–1.4s 三行自检｜1.4–1.9s 钟鸣（冲击波 + 40ms 微闪 + 44px「授时」）｜
// 1.9–3.2s 虹膜展开（中心圆形遮罩 140px → 全屏）+ 三环生长 + 刻度亮起。任意键/点击可越过。
// §17.5：三环 r=30%/55%/78% + 6 颗偏移珠点 + 一道 2px 扫描线；reduced-motion 600ms 内直接淡入。
import { el, setText, svgEl } from '../lib/dom';
import { cnNumber } from '../lib/format';

const STORAGE_KEY = 'xuanji.boot.v1';
const TIMELINE_MS = 3200;
const FADE_MS = 260;
const SHORT_MS = 600;

export interface BootHandle {
  root: HTMLElement | null;
  setAgents(): void;
  dispose(): void;
}

export interface BootOptions {
  reducedMotion: boolean;
  /** true = 不播开机（?boot=0） */
  skip: boolean;
  /** 首帧数据到达前为 null；不编造数字。sources = 已发现来源数（v2.0 · 诸源） */
  getAgents: () => { live: number; total: number; sources?: number } | null;
  onDone: () => void;
}

interface RingGeometry {
  x: number;
  y: number;
  r: number;
  bead: boolean;
}

const STAGE = 360;
const CENTER = STAGE / 2;

function beadPositions(): RingGeometry[] {
  const out: RingGeometry[] = [];
  const r = (STAGE * 0.55) / 2;
  for (let i = 0; i < 6; i += 1) {
    const base = (Math.PI * 2 * i) / 6 - Math.PI / 2;
    const offset = ((i % 2 === 0 ? 1 : -1) * 3 * Math.PI) / 180;
    const angle = base + offset;
    out.push({
      x: CENTER + Math.cos(angle) * r,
      y: CENTER + Math.sin(angle) * r,
      r: 3.2,
      bead: true,
    });
  }
  return out;
}

export function createBoot(parent: HTMLElement, opts: BootOptions): BootHandle {
  // 直接跳过：不建 DOM，不阻塞首帧
  if (opts.skip) {
    opts.onDone();
    return { root: null, setAgents: () => undefined, dispose: () => undefined };
  }

  const timers = new Set<number>();
  let done = false;
  let disposed = false;
  let seen = false;
  try {
    seen = window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    seen = false;
  }

  const root = el('div', {
    class: 'boot',
    attrs: {
      role: 'presentation',
      'aria-label': '璇玑 · 授时',
    },
  });
  root.dataset.phase = 'glow';

  const black = el('div', { class: 'boot-black', attrs: { 'aria-hidden': 'true' } });
  const stage = el('div', { class: 'boot-stage' });

  // ── 自检三行 ────────────────────────────────────────────────
  function checkLine(label: string, status: string): HTMLElement {
    const statusNode = el('span', { class: 'boot-check-status', text: status });
    const node = el('div', { class: 'boot-check-line' }, [
      el('span', { class: 'boot-check-label', text: label }),
      el('span', { class: 'boot-check-leader', attrs: { 'aria-hidden': 'true' } }),
      statusNode,
    ]);
    return node;
  }
  const agentsNum = el('span', { class: 'boot-num', text: '…' });
  const sourcesNum = el('span', { class: 'boot-num', text: '…' });
  const lineAgentsLabel = el('span', { class: 'boot-check-label' }, [
    el('span', { text: '观星 · 本机智能体 ' }),
    agentsNum,
    el('span', { text: ' 位 · 诸源 ' }),
    sourcesNum,
    el('span', { text: ' 源' }),
  ]);
  const lineAgents = el('div', { class: 'boot-check-line' }, [
    lineAgentsLabel,
    el('span', { class: 'boot-check-leader', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'boot-check-status', text: '候' }),
  ]);
  const check = el('div', { class: 'boot-check' }, [
    checkLine('校历 · 二十八宿', '定'),
    checkLine('候漏 · 节拍', '定'),
    lineAgents,
  ]);

  // ── 钟鸣 ────────────────────────────────────────────────────
  const shock = el('span', { class: 'boot-shock', attrs: { 'aria-hidden': 'true' } });
  const title = el('div', { class: 'boot-title', text: '授时' });
  const bell = el('div', { class: 'boot-bell', attrs: { 'aria-hidden': 'true' } }, [shock, title]);

  // ── 虹膜：三环 + 六珠 + 扫描线 ──────────────────────────────
  const svg = svgEl('svg', {
    class: 'boot-iris',
    viewBox: `0 0 ${STAGE} ${STAGE}`,
    'aria-hidden': 'true',
  });
  const ringR = [0.3, 0.55, 0.78];
  const rings: SVGElement[] = ringR.map((ratio, index) => {
    const circle = svgEl('circle', {
      class: 'boot-ring',
      cx: CENTER,
      cy: CENTER,
      r: (STAGE * ratio) / 2,
      fill: 'none',
      stroke: 'var(--gold-200)',
      'stroke-width': index === 0 ? 1.4 : 1.1,
      'stroke-opacity': index === 0 ? 1 : index === 1 ? 0.8 : 0.7,
    });
    svg.appendChild(circle);
    return circle;
  });
  const tickRing = svgEl('circle', {
    class: 'boot-ticks',
    cx: CENTER,
    cy: CENTER,
    r: (STAGE * 0.78) / 2 + 7,
    fill: 'none',
    stroke: 'var(--gold-400)',
    'stroke-width': 3,
    'stroke-opacity': 0.7,
    'stroke-dasharray': '1 7',
  });
  svg.appendChild(tickRing);

  const beadNodes: SVGElement[] = beadPositions().map((bead) => {
    const node = svgEl('circle', {
      class: 'boot-bead',
      cx: bead.x.toFixed(2),
      cy: bead.y.toFixed(2),
      r: bead.r,
      fill: 'var(--ink-void)',
      stroke: 'var(--bone-200)',
      'stroke-width': 1,
      'stroke-opacity': 0.75,
    });
    svg.appendChild(node);
    return node;
  });

  const scan = el('span', { class: 'boot-scan', attrs: { 'aria-hidden': 'true' } });

  const skipHint = el('button', {
    class: 'boot-skip',
    attrs: { type: 'button', 'aria-label': '按任意键以越过授时' },
  });
  skipHint.textContent = '按任意键以越过';

  const sr = el('p', { class: 'sr-only', text: '正在授时，按任意键越过。' });

  stage.append(check, bell, svg, scan, skipHint, sr);
  root.append(black, stage);
  parent.appendChild(root);

  // ── 珠点：live 数 / 总数 的比例（真实比例，不编造），金实心=在行 ──
  function paintBeads(): void {
    const info = opts.getAgents();
    if (!info || info.total <= 0) {
      for (const bead of beadNodes) {
        bead.setAttribute('fill', 'var(--ink-void)');
        bead.setAttribute('stroke', 'var(--bone-200)');
        bead.setAttribute('stroke-opacity', '0.75');
      }
      return;
    }
    const filled = Math.max(0, Math.min(beadNodes.length, Math.round((info.live / info.total) * beadNodes.length)));
    beadNodes.forEach((bead, index) => {
      if (index < filled) {
        bead.setAttribute('fill', 'var(--state-live)');
        bead.setAttribute('stroke', 'var(--gold-200)');
        bead.setAttribute('stroke-opacity', '0.9');
      } else {
        bead.setAttribute('fill', 'var(--ink-void)');
        bead.setAttribute('stroke', 'var(--bone-200)');
        bead.setAttribute('stroke-opacity', '0.75');
      }
    });
  }

  function agentText(): string {
    const info = opts.getAgents();
    if (!info) return '…';
    return cnNumber(info.live);
  }
  function sourcesText(): string {
    const info = opts.getAgents();
    if (!info || info.sources == null) return '…';
    return cnNumber(info.sources);
  }
  setText(agentsNum, agentText());
  setText(sourcesNum, sourcesText());
  paintBeads();

  function later(fn: () => void, ms: number): void {
    const id = window.setTimeout(() => {
      timers.delete(id);
      if (!disposed) fn();
    }, ms);
    timers.add(id);
  }

  function finish(immediate: boolean): void {
    if (done) return;
    done = true;
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* 隐私模式下忽略 */
    }
    window.removeEventListener('keydown', onAnyKey, true);
    window.removeEventListener('pointerdown', onAnyPointer, true);
    root.classList.remove('is-short');
    root.classList.add('is-out');
    const wait = immediate ? 0 : FADE_MS;
    later(() => {
      root.remove();
      if (!disposed) opts.onDone();
    }, wait);
  }

  function onAnyKey(ev: KeyboardEvent): void {
    // 不吞掉按键本身（main 仍会收到），只负责结束开机
    if (ev.key === 'Tab') return;
    finish(false);
  }
  function onAnyPointer(): void {
    finish(false);
  }

  skipHint.addEventListener('click', () => finish(false));

  // ── 时间轴 ──────────────────────────────────────────────────
  if (opts.reducedMotion || seen) {
    // 短序列：600ms 内三环与珠点同时淡入，不扫线、不播钟鸣
    root.classList.add('is-short');
    root.dataset.phase = 'iris';
    for (const ring of rings) ring.classList.add('is-in');
    tickRing.classList.add('is-in');
    for (const bead of beadNodes) bead.classList.add('is-in');
    later(() => finish(false), SHORT_MS);
  } else {
    later(() => {
      root.dataset.phase = 'check';
      const lines = check.querySelectorAll<HTMLElement>('.boot-check-line');
      lines.forEach((line, index) => later(() => line.classList.add('is-in'), index * 300));
    }, 500);
    later(() => {
      root.dataset.phase = 'bell';
      setText(agentsNum, agentText());
      check.classList.add('is-out');
      bell.classList.add('is-in');
    }, 1400);
    later(() => {
      root.dataset.phase = 'iris';
      bell.classList.add('is-out');
      root.classList.add('is-iris');
      for (const ring of rings) ring.classList.add('is-in');
      tickRing.classList.add('is-in');
      for (const bead of beadNodes) bead.classList.add('is-in');
      skipHint.classList.add('is-in');
    }, 1900);
    later(() => paintBeads(), 2000);
    later(() => finish(false), TIMELINE_MS);
  }

  window.addEventListener('keydown', onAnyKey, true);
  window.addEventListener('pointerdown', onAnyPointer, true);

  return {
    root,
    setAgents(): void {
      if (disposed) return;
      setText(agentsNum, agentText());
      if (root.dataset.phase === 'iris' || root.dataset.phase === 'bell') paintBeads();
    },
    dispose(): void {
      disposed = true;
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      window.removeEventListener('keydown', onAnyKey, true);
      window.removeEventListener('pointerdown', onAnyPointer, true);
      root.remove();
    },
  };
}
