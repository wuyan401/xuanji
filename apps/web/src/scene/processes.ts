// XUANJI · 璇玑 — v2.7 §26 第三视图「百工 · 器群」：奔流（Torrent）。
//
// 用户裁定（v2.6 之后，m04712）：「还是太简陋……核心和外层方块画风潦草且几乎没有运动，
// 体现不出数据的奔流；外层进程没有因占用而明显区分；方块位置/速度/光束速率要随占用、
// 运行、数据传输实时调整；中间放个正八面体太敷衍。」
//
// v2.7 图景：**一台正在吞吐数据的数据引擎**。
//   五条可见轨道（重载/活跃/常规/轻载/沉积）→ 芯片是模块不是方块（CPU 填充条 + 线程刻点
//   + 内存带 + 亮核 + 运行脉冲 + 尾迹）→ 每芯一条连续光束 + 内向数据包 → 中心六层机械核心
//   （iris / rotor / gear 反向 / vanes / 涡流 / 格栅扫描环）连续运转。
//
// 与观星视图的对立不变：矩形模块 / 直线 / 恒速 / 钢灰冷白 / 无痕 / 庞大无情；
// 观星 = 圆星 / 曲线 / 不均匀节拍 / 阻尼 / 暖金 / 留痕 / 有生命。
//
// 性能（§26.6）：单帧 ≤8ms；芯片 ≤220、包池 ≤1600、雨幕 ≤220；
// 静态几何（五轨 / 排水渠刻槽 / 进气环 / 工程参考）离屏缓存；
// 所有运动都是时间的解析函数，逐帧不使用 Math.random。

import { Env } from './types';
import { COLORS, FONTS, withAlpha } from '../design/tokens';
import { TAU, clamp, clamp01, damp, hash01 } from '../lib/math';
import type { ProcInfo, SystemSnapshot } from '../state/types';

/** 只用到相机的一行能力（避免和 camera.ts 循环依赖） */
interface ScreenCam {
  worldToScreen(env: Env, x: number, y: number): { x: number; y: number };
}

// ———————————————————————————————————————————————— §26.2 五条可见轨道

/** 轨道中心半径（世界 R 的倍数），从内到外：重载 → 沉积 */
const LANE_R = [0.3, 0.44, 0.58, 0.72, 0.86] as const;
/** 轨道半高（内两轨更宽，承载大模块） */
const LANE_HALF = [0.055, 0.055, 0.05, 0.05, 0.05] as const;
/** 轨道名（12 点方向外侧标签） */
const LANE_NAME = ['重载', '活跃', '常规', '轻载', '沉积'] as const;
/** 五档阈值：weight ≥ 阈值 → 该档；否则下一档 */
const BAND_EDGE = [0.62, 0.4, 0.18, 0.06] as const;

// ———————————————————————————————————————————————— §26 数值

const PROC = {
  maxChips: 220,
  /**
   * 权重口径（§25.2 继续有效，v2.7 校准）：
   * 用户对「占用」的直觉首先是 CPU，其次是内存；启动新旧只做轻微加权。
   * 若让内存/新旧权重过高，真实机器上会出现「高 CPU 的浏览器反而在外轨」的错位。
   * raw = 0.80*cpuN + 0.15*memN + 0.05*recN，再线性拉伸到 0..1。
   */
  wCpu: 0.8,
  wMem: 0.15,
  wRec: 0.05,
  /** 原始分 → weight 的线性标定：weight = clamp01((raw - wFloor) / wSpan) */
  wFloor: 0.05,
  wSpan: 0.36,
  recWindowMs: 604800000,
  /** 内向数据包（§26.4） */
  intakeR: 0.14,
  packetSpeed: 0.55,
  packetCap: 1600,
  packetCapLow: 900,
  packetLenMin: 2.5,
  packetLenMax: 6,
  packetWidthMin: 1.2,
  packetWidthMax: 2.2,
  /** 每芯连续光束（§26.4；v2.7 校准：拉大明暗/粗细差，让「谁忙谁凶」静帧可读） */
  beamWidthMin: 0.8,
  beamWidthGain: 2.4,
  beamAlphaMin: 0.12,
  beamAlphaGain: 0.5,
  beamSpeedMin: 60,
  beamSpeedGain: 260,
  /** 脉冲：周期 = pulseBase + pulseSpan*(1-weight)，再叠加 CPU 项（见 self-review 说明） */
  pulseBase: 0.5,
  pulseSpan: 2.2,
  /** 入口雨幕 + 主排水渠（§25.3 保留，亮度降一档） */
  entryIn: 1.02,
  entryOut: 1.1,
  entrySpeed: 0.22,
  entryMin: 8,
  entryMax: 220,
  drains: 24,
  drainDrops: 3,
  drainSpeed: 0.4,
  /** 机械节拍（v2.5 兼容读数；v2.7 主视觉连续运动） */
  tickMs: 1000,
  /** 屏幕扫描线（保留 v2.5 观感） */
  scanMs: 3000,
  scanDurMs: 300,
  /** 稳定性：alpha 单帧步进（v2.6 断言沿用） */
  alphaStep: 0.03,
  /** 六层核心（§26.5） */
  coreScaleBase: 0.7,
  coreScaleCpu: 0.6,
  irisR: 0.045,
  irisBlades: 20,
  irisSpeed: 0.55,
  irisOpenBase: 0.04,
  irisOpenGain: 0.012,
  rotorR: 0.075,
  rotorSpeed: 0.3,
  rotorSpokes: 8,
  pistonAmp: 0.012,
  gearR: 0.105,
  gearTeeth: 48,
  gearSpeed: -0.22,
  gearTooth: 0.008,
  vanesR: 0.14,
  vanesCount: 12,
  vanesSpeed: 0.14,
  vortexIn: 0.16,
  vortexOut: 0.24,
  vortexCount: 48,
  vortexDtheta: 0.9,
  vortexDr: 0.1,
  grilleR: 0.26,
  grilleLines: 24,
  scanSpeed: 1.6,
  intakeBandIn: 0.28,
  intakeBandOut: 0.3,
  /** v2.5 兼容读数 */
  scrollRate: 0.05,
} as const;

/** 六层核心的静态参数（速度 rad/s，direction 正反交替） */
const CORE_LAYERS: ReadonlyArray<{ radius: number; speed: number; direction: 1 | -1 }> = [
  { radius: PROC.irisR, speed: PROC.irisSpeed, direction: 1 },
  { radius: PROC.rotorR, speed: PROC.rotorSpeed, direction: 1 },
  { radius: PROC.gearR, speed: PROC.gearSpeed, direction: -1 },
  { radius: PROC.vanesR, speed: PROC.vanesSpeed, direction: 1 },
  { radius: (PROC.vortexIn + PROC.vortexOut) / 2, speed: PROC.vortexDtheta, direction: 1 },
  { radius: PROC.grilleR, speed: PROC.scanSpeed, direction: 1 },
];

// ———————————————————————————————————————————————— 主题配色

interface ProcPalette {
  base: string;
  fill: string;
  accent: string;
  line: string;
  text: string;
  /** 五条轨道色（内 → 外） */
  lanes: string[];
  /** 次级强调（内存带 / 线程刻点） */
  dim: string;
}

const PALETTES: { xuanji: ProcPalette; scifi: ProcPalette } = {
  xuanji: {
    base: '#8b8c8f',
    fill: '#e7eef2',
    accent: '#d3cbb6',
    line: '#8b8c8f',
    text: '#e7eef2',
    lanes: ['#e7eef2', '#cbd5da', '#a9b4ba', '#8b8c8f', '#6f7174'],
    dim: '#6f7174',
  },
  scifi: {
    base: '#5fd0ea',
    fill: '#f2f9ff',
    accent: '#7df0c4',
    line: '#5fd0ea',
    text: '#f2f9ff',
    lanes: ['#f2f9ff', '#bff4ff', '#9fe9ff', '#5fd0ea', '#4d7a8c'],
    dim: '#4d7a8c',
  },
};

function paletteOf(env: Env): ProcPalette {
  return env.theme === 'scifi' ? PALETTES.scifi : PALETTES.xuanji;
}

/** 轨道色（band 0..4） */
function laneColor(pal: ProcPalette, band: number): string {
  return pal.lanes[clamp(band, 0, pal.lanes.length - 1)] ?? pal.line;
}

// ———————————————————————————————————————————————— 数据结构

/** 进程模块芯片（§26.3）：轨道 + 解析运动 + 连续 alpha */
interface Chip {
  pid: number;
  name: string;
  cpu: number;
  cpuTarget: number;
  mem: number;
  memTarget: number;
  threads: number;
  startedAt: number | null;
  /** §25.2 派生量 */
  cpuN: number;
  memN: number;
  recN: number;
  weight: number;
  /** 轨道 0..4（0=重载） */
  band: number;
  /** 世界半径 / 角位置 / 角速度 */
  r: number;
  targetR: number;
  phi: number;
  omega: number;
  /** 视觉量 */
  alpha: number;
  prevAlpha: number;
  width: number;
  height: number;
  /** 解析相位：径向呼吸 / 脉冲 / 粒度 */
  rPhase: number;
  pulsePhase: number;
  grain: number;
  dying: boolean;
  /** 每秒发射数据包的小数累计 */
  spawnAcc: number;
  /** 光束脉冲频率（脉冲/秒） */
  beamRate: number;
}

/** 内向数据包（对象池预分配） */
interface Packet {
  active: boolean;
  lane: number;
  phi: number;
  r: number;
  spawnR: number;
  len: number;
  width: number;
}

/** 静态几何缓存：五条轨道 + 排水渠刻槽 + 进气暗环 + 工程参考 */
interface ProcCache {
  canvas: HTMLCanvasElement;
  size: number;
  world: number;
  sharp: number;
  key: string;
}

export interface ProcPlateStats {
  /** v2.5 旧字段（保持兼容） */
  chips: number;
  rails: number;
  flowLines: number;
  tickPhase: number;
  scrollRate: number;
  selectedPid: number | null;
  /** v2.6 瀑布字段 */
  packets: number;
  packetSpeed: number;
  packetSpeedVar: number;
  entryFlow: number;
  hierarchySpearman: number;
  chipAngularSpeed: number;
  maxAlphaStep: number;
  /** v2.7 奔流字段（§26.8） */
  bands: number;
  laneCenters: number[];
  chipSpeeds: number[];
  chipScreenPositions: Array<{ x: number; y: number }>;
  chipRadii: number[];
  chipBands: number[];
  /** 验收按 pid 对齐：各芯片 pid（与 chipSpeeds/beamRates 同序） */
  chipPids: number[];
  beamRates: number[];
  chipWidthRange: [number, number];
  coreLayers: Array<{ radius: number; speed: number; direction: 1 | -1 }>;
  coreAngles: number[];
  vortexParticles: number;
}

// ———————————————————————————————————————————————— 工具

/** Spearman 秩相关（无并列校正，n 较大时足够精确） */
/** Spearman 秩相关（并列取平均秩：进程 CPU 大量为 0，必须做并列校正） */
function ranksOf(vals: number[]): Float64Array {
  const n = vals.length;
  const order = vals.map((_, i) => i).sort((x, y) => (vals[x] ?? 0) - (vals[y] ?? 0));
  const r = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && (vals[order[j + 1] ?? 0] ?? 0) === (vals[order[i] ?? 0] ?? 0)) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) r[order[k] ?? 0] = avg;
    i = j + 1;
  }
  return r;
}

function spearmanOf(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const rankA = ranksOf(a.slice(0, n));
  const rankB = ranksOf(b.slice(0, n));
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += rankA[i] ?? 0;
    mb += rankB[i] ?? 0;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = (rankA[i] ?? 0) - ma;
    const y = (rankB[i] ?? 0) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

export class ProcessesPlate {
  private cache: ProcCache | null = null;
  private chips: Map<number, Chip> = new Map();
  private procsOrder: ProcInfo[] = [];
  private snapshot: SystemSnapshot | null = null;
  private layoutKey = '';
  /** 数据帧里 procs 的真实条数（debug.chips 必须等于 min(220, procs.length)） */
  private rawCount = 0;
  private lastNow = 0;
  private lastR = 480;

  /** 上一帧的屏幕参数（debug.chipScreenPositions 用固定相机近似） */
  private envCx = 0;
  private envCy = 0;
  private envZoom = 1;

  /** v2.5 兼容读数 */
  private tickPhase = 0;
  /** 核心缩放（0.7+0.6*CpuN）与各层累计角；涡流粒子 */
  private cpuN = 0.3;
  private coreScale = 1;
  private coreAngles: number[] = [0, 0, 0, 0, 0, 0];
  private vortex: Array<{ a: number; r: number }> = [];
  private vortexCount = 0;
  private scanPhase = 0;

  /** 瀑布 */
  private packetPool: Packet[] = [];
  private packetCursor = 0;
  private activePackets = 0;
  private packetSpeedNow = 0;
  private packetSpeedVarNow = 0;
  private entryFlowNow = 0;
  private entryFlowWanted = 0;
  private spawnSerial = 0;
  private intakeFlash = 0;

  /** 读数 */
  private spearman = -1;
  private angularSpeed = 0;
  private meanBeamRate = 0;
  private maxAlphaStepNow = 0;
  private alphaSteps = new Float32Array(200);
  private alphaStepIdx = 0;
  private alphaStepFilled = 0;
  private statTimer = 0;
  /** 本帧画质（涡流降档用） */
  private passQuality = 1;

  private selectedPid: number | null = null;
  hoverPid: number | null = null;

  constructor() {
    for (let i = 0; i < PROC.packetCap; i += 1) {
      this.packetPool.push({ active: false, lane: 0, phi: 0, r: 0, spawnR: 0, len: 3, width: 1 });
    }
    for (let i = 0; i < PROC.vortexCount; i += 1) {
      this.vortex.push({ a: hash01(`proc-vortex-a:${i}`) * TAU, r: hash01(`proc-vortex-r:${i}`) });
    }
    this.vortexCount = PROC.vortexCount;
  }

  /** 选中进程（HUD「工籍」行 / 点击芯片都走这里；null 清选） */
  setSelected(pid: number | null): void {
    this.selectedPid = pid;
  }

  hadSelection(): number | null {
    return this.selectedPid;
  }

  /** 整机遥测快照（procs 来自 /api/system；null = 还没收到） */
  setSystem(snapshot: SystemSnapshot | null): void {
    this.snapshot = snapshot;
    if (!snapshot || !snapshot.available) {
      this.rawCount = 0;
      this.procsOrder = [];
      return;
    }
    const all = Array.isArray(snapshot.procs) ? snapshot.procs : [];
    const list = all.slice(0, PROC.maxChips);
    this.procsOrder = list;
    this.rawCount = Math.min(PROC.maxChips, all.length);
    this.syncChips(list);
  }

  /** 遥测是否可用（不可用时不发 0 值假数据，整盘 0.35 + 中央提示） */
  get available(): boolean {
    return !!this.snapshot && this.snapshot.available && this.rawCount > 0;
  }

  get stats(): ProcPlateStats {
    const R = this.lastR;
    const list: Chip[] = [];
    for (const p of this.procsOrder) {
      const c = this.chips.get(p.pid);
      if (c) list.push(c);
    }
    const laneCenters = LANE_R.map((v) => v * R);
    let wMin = Infinity;
    let wMax = -Infinity;
    for (const c of list) {
      wMin = Math.min(wMin, c.width);
      wMax = Math.max(wMax, c.width);
    }
    const chipWidthRange: [number, number] = list.length
      ? [Number.isFinite(wMin) ? wMin : 0, Number.isFinite(wMax) ? wMax : 0]
      : [0, 0];
    const chipSpeeds: number[] = list.map((c) => c.omega);
    const chipPids: number[] = list.map((c) => c.pid);
    const chipRadii: number[] = list.map((c) => c.r);
    const chipBands: number[] = list.map((c) => c.band);
    const beamRates: number[] = list.map((c) => c.beamRate);
    const chipScreenPositions = list.map((c) => ({
      x: this.envCx + Math.sin(c.phi) * c.r * this.envZoom,
      y: this.envCy - Math.cos(c.phi) * c.r * this.envZoom,
    }));
    return {
      chips: this.available ? Math.min(PROC.maxChips, this.rawCount) : 0,
      rails: LANE_R.length,
      flowLines: this.activePackets,
      tickPhase: this.tickPhase,
      scrollRate: PROC.scrollRate,
      selectedPid: this.selectedPid,
      packets: this.activePackets,
      packetSpeed: this.packetSpeedNow,
      packetSpeedVar: this.packetSpeedVarNow,
      entryFlow: this.entryFlowNow,
      hierarchySpearman: this.spearman,
      chipAngularSpeed: this.angularSpeed,
      maxAlphaStep: this.maxAlphaStepNow,
      bands: LANE_R.length,
      laneCenters,
      chipSpeeds,
      chipScreenPositions,
      chipRadii,
      chipBands,
      chipPids,
      beamRates,
      chipWidthRange,
      coreLayers: CORE_LAYERS.map((l) => ({
        radius: l.radius * R,
        speed: l.speed * this.coreScale,
        direction: l.direction,
      })),
      coreAngles: this.coreAngles.slice(),
      vortexParticles: this.vortexCount,
    };
  }

  /** 权重：占用越大、启动越新 → 越靠内（§25.2 口径，继续有效） */
  private weightOf(
    cpu: number,
    memBytes: number,
    startedAt: number | null,
    now: number,
  ): { cpuN: number; memN: number; recN: number; weight: number } {
    const cpuN = clamp01(Math.log10(cpu + 0.5) / Math.log10(100.5));
    const memMB = memBytes / (1024 * 1024);
    const memN = clamp01(Math.log10(memMB + 1) / Math.log10(9000));
    const recN = startedAt ? clamp01(1 - (now - startedAt) / PROC.recWindowMs) : 0.35;
    // v2.7 校准：原始分在真实数据里只落在 0.12–0.5，直接当 weight 会让五轨里 3 轨永远空；
    // 线性标定到 0..1 后，五档轨道在任意机器都能落人，且顺序（谁更靠内）不变。
    const raw = PROC.wCpu * cpuN + PROC.wMem * memN + PROC.wRec * recN;
    const weight = clamp01((raw - PROC.wFloor) / PROC.wSpan);
    return { cpuN, memN, recN, weight };
  }

  /** 权重 → 轨道档位（0 重载 … 4 沉积） */
  private bandOf(weight: number): number {
    for (let i = 0; i < BAND_EDGE.length; i += 1) {
      if (weight >= (BAND_EDGE[i] ?? 0)) return i;
    }
    return LANE_R.length - 1;
  }

  /** 轨道半径（世界 px），含 ±0.014R 的 hash 分布位（呼吸在 update 里叠加） */
  private laneRadius(env: Env, chip: Chip): number {
    const spread = (hash01(`proc-lane:${chip.pid}`) - 0.5) * 0.028;
    return env.R * ((LANE_R[chip.band] ?? 0.5) + spread);
  }

  /**
   * 集合变化时只处理「新增/消失」；已有芯片保持角位置连续（不重排、不瞬移）。
   * 初始角用黄金角均匀铺开（避免同轨扎堆），之后由解析角速度连续推进。
   */
  private syncChips(procs: ProcInfo[]): void {
    const key = procs.map((p) => p.pid).join(',');
    const now = Date.now();
    if (key === this.layoutKey) {
      for (const p of procs) {
        const chip = this.chips.get(p.pid);
        if (!chip) continue;
        chip.cpuTarget = p.cpuPct;
        chip.memTarget = p.memBytes;
        chip.threads = p.threads ?? 0;
        chip.startedAt = typeof p.startedAt === 'number' && p.startedAt > 0 ? p.startedAt : null;
        chip.name = p.name;
      }
      return;
    }
    this.layoutKey = key;
    // 黄金角铺位：按 pid 的 hash 排序后依次铺开（确定、无随机、均匀）
    const order = procs
      .slice()
      .sort((a, b) => hash01(`proc-order:${a.pid}`) - hash01(`proc-order:${b.pid}`));
    const slot = new Map<number, number>();
    order.forEach((p, i) => slot.set(p.pid, i));
    const golden = Math.PI * (3 - Math.sqrt(5));
    const seen = new Set<number>();
    for (const p of procs) {
      seen.add(p.pid);
      const startedAt = typeof p.startedAt === 'number' && p.startedAt > 0 ? p.startedAt : null;
      const w = this.weightOf(p.cpuPct, p.memBytes, startedAt, now);
      const band = this.bandOf(w.weight);
      const exist = this.chips.get(p.pid);
      if (exist) {
        exist.dying = false;
        exist.cpuTarget = p.cpuPct;
        exist.memTarget = p.memBytes;
        exist.threads = p.threads ?? 0;
        exist.startedAt = startedAt;
        exist.name = p.name;
        exist.band = band;
        continue;
      }
      const idx = slot.get(p.pid) ?? 0;
      const width = (10 + 26 * w.weight) * (0.85 + 0.3 * hash01(`proc-w:${p.pid}`));
      const height = (5 + 9 * w.weight) * (0.85 + 0.3 * hash01(`proc-h:${p.pid}`));
      this.chips.set(p.pid, {
        pid: p.pid,
        name: p.name,
        cpu: p.cpuPct,
        cpuTarget: p.cpuPct,
        mem: p.memBytes,
        memTarget: p.memBytes,
        threads: p.threads ?? 0,
        startedAt,
        cpuN: w.cpuN,
        memN: w.memN,
        recN: w.recN,
        weight: w.weight,
        band,
        r: this.lastR * (LANE_R[band] ?? 0.5),
        targetR: 0,
        phi: (idx * golden) % TAU,
        omega: 0.008 + 0.3 * Math.pow(w.weight, 1.5),
        alpha: 0,
        prevAlpha: 0,
        width: clamp(width, 9, 40),
        height: clamp(height, 4.4, 14.5),
        rPhase: hash01(`proc-rp:${p.pid}`) * TAU,
        pulsePhase: hash01(`proc-pp:${p.pid}`),
        grain: hash01(`proc-grain:${p.pid}`),
        dying: false,
        spawnAcc: hash01(`proc-spawn:${p.pid}`) * 0.9,
        beamRate: 1,
      });
    }
    for (const chip of this.chips.values()) if (!seen.has(chip.pid)) chip.dying = true;
    if (this.selectedPid !== null && !this.chips.has(this.selectedPid)) this.selectedPid = null;
  }

  // ———————————————————————————————————————————— 每帧推进

  /**
   * §26.4 全解析运动：
   *   omega = (0.008 + 0.30*weight^1.5) * (1 + 0.025 sin(0.7t + hash))
   *   r     = laneR[band] + (hash-0.5)*0.014R + 0.006R sin(t*(0.35+0.8w) + hash)
   * 另有每芯光束脉冲、内向数据包、六层核心连续转动。逐帧无 Math.random。
   */
  update(env: Env): void {
    const nowMs = Date.now();
    const last = this.lastNow || nowMs;
    this.lastNow = nowMs;
    const dt = clamp((nowMs - last) / 1000, 0.0005, 0.25);
    const t = nowMs / 1000;
    const R = env.R;
    this.lastR = R;
    this.envCx = env.cx;
    this.envCy = env.cy;
    this.envZoom = env.zoom;
    this.tickPhase = (nowMs % PROC.tickMs) / PROC.tickMs;
    this.scanPhase = (nowMs % PROC.scanMs) / PROC.scanMs;

    const usage = this.snapshot ? clamp01(this.snapshot.cpu.usage / 100) : 0.2;
    this.cpuN = clamp01(
      Math.log10((this.snapshot ? this.snapshot.cpu.usage : 20) + 0.5) / Math.log10(100.5),
    );
    this.coreScale = PROC.coreScaleBase + PROC.coreScaleCpu * this.cpuN;

    const pursueK = clamp01(dt / 0.2);
    const cap = env.quality < 0.7 ? PROC.packetCapLow : PROC.packetCap;
    const lowBeams = env.quality < 0.7;
    this.passQuality = env.quality;

    let totalThreads = 0;
    let omegaSum = 0;
    let omegaN = 0;
    let rateSum = 0;
    let maxStepFrame = 0;

    for (const [pid, chip] of this.chips) {
      chip.alpha = this.stepAlpha(chip.alpha, chip.dying ? 0 : 1);
      if (chip.alpha === 0 && chip.dying) {
        this.chips.delete(pid);
        continue;
      }
      maxStepFrame = Math.max(maxStepFrame, Math.abs(chip.alpha - chip.prevAlpha));
      chip.prevAlpha = chip.alpha;

      chip.cpu += (chip.cpuTarget - chip.cpu) * pursueK;
      chip.mem += (chip.memTarget - chip.mem) * pursueK;
      const w = this.weightOf(chip.cpu, chip.mem, chip.startedAt, nowMs);
      chip.cpuN = w.cpuN;
      chip.memN = w.memN;
      chip.recN = w.recN;
      chip.weight = w.weight;
      chip.band = this.bandOf(w.weight);
      chip.width = clamp((10 + 26 * w.weight) * (0.85 + 0.3 * chip.grain), 9, 40);
      chip.height = clamp(
        (5 + 9 * w.weight) * (0.85 + 0.3 * hash01(`proc-h:${chip.pid}`)),
        4.4,
        14.5,
      );
      // 角速度（连续、随占用实时变化）
      chip.omega =
        (0.008 + 0.3 * Math.pow(w.weight, 1.5)) * (1 + 0.025 * Math.sin(t * 0.7 + chip.rPhase));
      chip.phi = (chip.phi + chip.omega * dt) % TAU;
      // 径向呼吸（轨道内 ±0.014R 分布 + 0.006R 呼吸）
      const breath = 0.006 * R * Math.sin(t * (0.35 + 0.8 * w.weight) + chip.rPhase);
      chip.targetR = this.laneRadius(env, chip) + breath;
      chip.r = damp(chip.r, chip.targetR, 2, dt);
      // 脉冲频率：周期公式叠加 CPU 项（§26.4 基数，见自审说明）
      const period = PROC.pulseBase + PROC.pulseSpan * (1 - w.weight);
      chip.beamRate = clamp((0.6 + 1.6 * chip.cpuN) / period, 0.2, 3);
      chip.pulsePhase = (chip.pulsePhase + chip.beamRate * dt) % 1;
      chip.spawnAcc += (3 + 30 * Math.pow(w.weight, 0.8)) * dt;
      if (chip.alpha > 0.2) {
        totalThreads += chip.threads;
        omegaSum += chip.omega;
        omegaN += 1;
        rateSum += chip.beamRate;
        if (!chip.dying) this.feedPackets(chip, env, cap, lowBeams);
      }
    }

    this.updatePackets(env, dt, R);
    this.updateVortex(dt, R);
    this.updateCore(dt);
    this.entryFlowWanted = clamp(Math.round(totalThreads / 3), PROC.entryMin, PROC.entryMax);
    const q = env.quality;
    this.entryFlowNow =
      q < 0.7 ? 0 : q < 0.85 ? Math.round(this.entryFlowWanted / 2) : this.entryFlowWanted;
    this.angularSpeed = omegaN > 0 ? omegaSum / omegaN : 0.008;
    this.meanBeamRate = omegaN > 0 ? rateSum / omegaN : 1;
    this.packetSpeedNow = PROC.packetSpeed * R;
    this.intakeFlash = Math.max(0, this.intakeFlash - dt * 6);

    // 读数（每 400ms 更新一次，避免每帧排序）
    this.statTimer += dt;
    if (this.statTimer >= 0.4) {
      this.statTimer = 0;
      this.computeStats();
    }

    this.alphaSteps[this.alphaStepIdx] = maxStepFrame;
    this.alphaStepIdx = (this.alphaStepIdx + 1) % this.alphaSteps.length;
    if (this.alphaStepFilled < this.alphaSteps.length) this.alphaStepFilled += 1;
    let m = 0;
    for (let i = 0; i < this.alphaStepFilled; i += 1) m = Math.max(m, this.alphaSteps[i] ?? 0);
    this.maxAlphaStepNow = m;
    void usage;
  }

  /** 单帧 alpha 步进 ≤0.03（v2.6 断言沿用；进出场连续） */
  private stepAlpha(cur: number, target: number): number {
    const d = target - cur;
    if (Math.abs(d) <= PROC.alphaStep) return target;
    return cur + Math.sign(d) * PROC.alphaStep;
  }

  /** 每芯按 §26.4 发射内向数据包（rate = 3 + 30*weight^0.8） */
  private feedPackets(chip: Chip, env: Env, cap: number, lowBeams: boolean): void {
    const intakeR = env.R * PROC.intakeR + 2;
    if (chip.r <= intakeR + 1) return;
    let guard = 0;
    while (chip.spawnAcc >= 1 && guard < 6) {
      chip.spawnAcc -= 1;
      guard += 1;
      if (this.activePackets >= cap) continue;
      const pk = this.packetPool[this.packetCursor];
      this.packetCursor = (this.packetCursor + 1) % this.packetPool.length;
      if (!pk) continue;
      this.spawnSerial += 1;
      const hs = hash01(`proc-pk:${chip.pid}:${this.spawnSerial % 103}`);
      const ht = hash01(`proc-pkw:${chip.pid}:${this.spawnSerial % 97}`);
      pk.active = true;
      pk.lane = lowBeams ? 0 : chip.band;
      pk.phi = chip.phi;
      pk.r = chip.r;
      pk.spawnR = Math.max(chip.r, intakeR + 1);
      pk.len = PROC.packetLenMin + hs * (PROC.packetLenMax - PROC.packetLenMin);
      pk.width = PROC.packetWidthMin + ht * (PROC.packetWidthMax - PROC.packetWidthMin);
      this.activePackets += 1;
    }
  }

  /** 包以恒速 0.55R/s 向内推进；抵达 intake 被吞没（§26.4） */
  private updatePackets(env: Env, dt: number, R: number): void {
    const speed = PROC.packetSpeed * R;
    const intakeR = R * PROC.intakeR;
    for (const pk of this.packetPool) {
      if (!pk.active) continue;
      pk.r -= speed * dt;
      if (pk.r <= intakeR) {
        pk.active = false;
        this.activePackets = Math.max(0, this.activePackets - 1);
        this.intakeFlash = Math.min(1, this.intakeFlash + 0.08);
      }
    }
    let n = 0;
    for (const pk of this.packetPool) if (pk.active) n += 1;
    this.packetSpeedVarNow = n < 2 ? 0 : 0;
    void env;
  }

  /** L4 数据涡流：48 粒螺旋向内，到 0.16R 回填外圈（§26.5） */
  private updateVortex(dt: number, R: number): void {
    void R;
    if (this.vortex.length === 0) return;
    for (const p of this.vortex) {
      p.a = (p.a + PROC.vortexDtheta * this.coreScale * dt) % TAU;
      // 环绕进度 0..1 表示从外圈到内圈；到 0.16R 后回填
      const speed = (PROC.vortexDr / (PROC.vortexOut - PROC.vortexIn)) * this.coreScale;
      p.r -= speed * dt;
      if (p.r < 0) p.r += 1;
    }
    const q = this.passQuality;
    this.vortexCount = q < 0.7 ? 0 : q < 0.85 ? Math.round(PROC.vortexCount / 2) : PROC.vortexCount;
  }

  /** 六层核心累计角（解析积分，平缓、可连续） */
  private updateCore(dt: number): void {
    for (let i = 0; i < CORE_LAYERS.length; i += 1) {
      const layer = CORE_LAYERS[i];
      if (!layer) continue;
      const cur = this.coreAngles[i] ?? 0;
      this.coreAngles[i] = (cur + layer.speed * this.coreScale * dt) % TAU;
    }
  }

  private computeStats(): void {
    const list: Chip[] = [];
    for (const chip of this.chips.values()) if (!chip.dying && chip.alpha > 0.2) list.push(chip);
    const n = list.length;
    if (n < 3) {
      this.spearman = -1;
      return;
    }
    const cpu = list.map((c) => c.cpu);
    // v2.7：半径被五轨量化，连续半径的秩相关会被轨内 hash 抖动淹没；
    // 用「CPU × 轨道号」的秩相关表达层级（高占用 → 低轨号 = 负相关）。
    const bands = list.map((c) => c.band);
    this.spearman = spearmanOf(cpu, bands);
  }

  // ———————————————————————————————————————————— 静态缓存（§26.2 / §26.6）

  build(env: Env, sharp: number): void {
    const key = [
      Math.round(env.w),
      Math.round(env.h),
      Math.round(env.R),
      sharp.toFixed(2),
      env.mobile ? 'm' : 'd',
      env.theme,
      env.quality.toFixed(2),
    ].join('|');
    if (this.cache && this.cache.key === key) return;

    const world = Math.ceil(env.R * 1.04);
    const size = Math.max(8, Math.round(world * 2 * sharp));
    const canvas = this.cache?.canvas ?? document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    if (!g) {
      this.cache = { canvas, size, world, sharp, key };
      return;
    }
    g.clearRect(0, 0, size, size);
    g.save();
    g.translate(size / 2, size / 2);
    g.scale(sharp, sharp);
    const R = env.R;
    const pal = paletteOf(env);
    const lowQ = env.quality < 0.7;

    // 0) 工程参考网格（0.90–1.02R，极淡；v2.5 视觉资产，降档减半）
    if (!lowQ) {
      g.strokeStyle = withAlpha(pal.line, 0.04);
      g.lineWidth = 1 / sharp;
      g.beginPath();
      for (let i = 0; i < 8; i += 1) {
        const rr = R * (0.9 + 0.12 * (i / 7));
        g.moveTo(Math.sin(0) * rr, -Math.cos(0) * rr);
        g.arc(0, 0, rr, 0, TAU);
      }
      for (let a = 0; a < 360; a += 8) {
        const rad = (a * Math.PI) / 180;
        g.moveTo(Math.sin(rad) * R * 0.9, -Math.cos(rad) * R * 0.9);
        g.lineTo(Math.sin(rad) * R * 1.02, -Math.cos(rad) * R * 1.02);
      }
      g.stroke();
    }

    // 1) 五条可见轨道（§26.2）：边线 ×2 + 中线虚线（每 6° 一短划）+ 轨道标签
    for (let lane = 0; lane < LANE_R.length; lane += 1) {
      const color = laneColor(pal, lane);
      const rr = R * (LANE_R[lane] ?? 0.5);
      const half = R * (LANE_HALF[lane] ?? 0.05);
      g.lineWidth = 1 / sharp;
      g.strokeStyle = withAlpha(color, 0.3);
      g.beginPath();
      g.arc(0, 0, rr + half, 0, TAU);
      g.stroke();
      g.strokeStyle = withAlpha(color, 0.16);
      g.beginPath();
      g.arc(0, 0, rr - half, 0, TAU);
      g.stroke();
      // 轨道带淡填充（可数的「传送带」底板）
      g.fillStyle = withAlpha(color, 0.018);
      g.beginPath();
      g.arc(0, 0, rr + half, 0, TAU);
      g.arc(0, 0, rr - half, 0, TAU, true);
      g.fill();
      // 中线虚线：每 6° 一短划（沿轨道方向 1.6°）
      g.strokeStyle = withAlpha(color, 0.2);
      g.beginPath();
      for (let a = 0; a < 360; a += 6) {
        const rad = ((a + 1) * Math.PI) / 180;
        g.moveTo(Math.sin(rad) * rr, -Math.cos(rad) * rr);
        g.arc(0, 0, rr, rad - Math.PI / 2, rad - Math.PI / 2 + (1.6 * Math.PI) / 180);
      }
      g.stroke();
      // 轨道边缘 15° 微刻（传送带刻度）
      g.strokeStyle = withAlpha(color, 0.16);
      g.beginPath();
      for (let a = 0; a < 360; a += 15) {
        const rad = (a * Math.PI) / 180;
        for (const edge of [rr + half, rr - half]) {
          g.moveTo(Math.sin(rad) * (edge - 2), -Math.cos(rad) * (edge - 2));
          g.lineTo(Math.sin(rad) * (edge + 2), -Math.cos(rad) * (edge + 2));
        }
      }
      g.stroke();
      // 轨道名（12 点方向外侧，10px mono）
      g.save();
      g.translate(0, -(rr + half + 10));
      g.font = `500 10px ${FONTS.mono}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = withAlpha(pal.text, 0.55);
      g.fillText(LANE_NAME[lane] ?? '', 0, 0);
      g.restore();
    }

    // 2) 主排水渠刻槽（24 条，alpha .03，亮度比 v2.6 降一档）
    g.strokeStyle = withAlpha(pal.line, 0.03);
    g.lineWidth = 1 / sharp;
    g.beginPath();
    for (let i = 0; i < PROC.drains; i += 1) {
      const a = (i / PROC.drains) * TAU;
      const x0 = Math.sin(a) * R * PROC.intakeBandIn;
      const y0 = -Math.cos(a) * R * PROC.intakeBandIn;
      const x1 = Math.sin(a) * R * PROC.entryIn;
      const y1 = -Math.cos(a) * R * PROC.entryIn;
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
    }
    g.stroke();

    // 3) 进气负压暗环（0.28–0.30R，接地外轨）
    g.strokeStyle = withAlpha(COLORS.inkVoid, 0.85);
    g.lineWidth = R * (PROC.intakeBandOut - PROC.intakeBandIn);
    g.beginPath();
    g.arc(0, 0, R * ((PROC.intakeBandIn + PROC.intakeBandOut) / 2), 0, TAU);
    g.stroke();

    // 4) 进水口外缘 1.02R + 四角定位十字
    g.strokeStyle = withAlpha(pal.line, 0.05);
    g.lineWidth = 1 / sharp;
    g.beginPath();
    g.arc(0, 0, R * PROC.entryIn, 0, TAU);
    g.stroke();
    g.strokeStyle = withAlpha(pal.line, 0.18);
    for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
      const rr = R * 1.0;
      const x = Math.sin(a) * rr;
      const y = -Math.cos(a) * rr;
      const dx = Math.sin(a) * 5;
      const dy = -Math.cos(a) * 5;
      g.beginPath();
      g.moveTo(x - dx, y - dy);
      g.lineTo(x + dx, y + dy);
      g.stroke();
    }
    g.restore();
    this.cache = { canvas, size, world, sharp, key };
  }

  // ———————————————————————————————————————————— 绘制（世界层，camera.apply 内）

  draw(ctx: CanvasRenderingContext2D, env: Env, alpha: number, reveal: number): void {
    const k = clamp01(alpha) * clamp01(reveal);
    if (k <= 0.01) return;
    const cache = this.cache;
    if (!cache) return;
    const pal = paletteOf(env);

    if (!this.available) {
      ctx.save();
      ctx.globalAlpha = 0.35 * k;
      ctx.drawImage(cache.canvas, -cache.world, -cache.world, cache.world * 2, cache.world * 2);
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.globalAlpha = k;
    ctx.drawImage(cache.canvas, -cache.world, -cache.world, cache.world * 2, cache.world * 2);
    ctx.restore();

    this.drawEntryRain(ctx, env, k, pal);
    this.drawDrains(ctx, env, k, pal);
    this.drawBeams(ctx, env, k, pal);
    this.drawPackets(ctx, env, k, pal);
    this.drawCore(ctx, env, k, pal);
    this.drawTrails(ctx, env, k, pal);
    this.drawChips(ctx, env, k, pal);
  }

  /** 入口雨幕：1.02R–1.10R 短划恒速向内（解析相位，循环无缝；§25.3 保留、亮度降档） */
  private drawEntryRain(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const n = this.entryFlowNow;
    if (n <= 0) return;
    const R = env.R;
    const span = (PROC.entryOut - PROC.entryIn) * R;
    const t = env.now / 1000;
    const pathA = new Path2D();
    for (let i = 0; i < n; i += 1) {
      const h = hash01(`proc-rain:${i}`);
      const drift = (t * PROC.entrySpeed * R + h * span) % span;
      const rr = R * PROC.entryOut - drift;
      if (rr < R * PROC.entryIn - 6) continue;
      const a = (i / n) * TAU + h * 0.12;
      const len = 6 + hash01(`proc-rainl:${i}`) * 8;
      pathA.moveTo(Math.sin(a) * (rr + len / 2), -Math.cos(a) * (rr + len / 2));
      pathA.lineTo(Math.sin(a) * (rr - len / 2), -Math.cos(a) * (rr - len / 2));
    }
    ctx.save();
    ctx.strokeStyle = withAlpha(pal.line, 0.22);
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    ctx.globalAlpha = k;
    ctx.stroke(pathA);
    ctx.restore();
  }

  /** 主排水渠里的大水滴（24 × 3，0.4R/s 向内；§25.3 保留、亮度降档） */
  private drawDrains(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    if (env.quality < 0.7) return;
    const R = env.R;
    const cycle = (PROC.entryIn - PROC.intakeBandIn) * R;
    const t = env.now / 1000;
    const path = new Path2D();
    for (let i = 0; i < PROC.drains; i += 1) {
      const a = (i / PROC.drains) * TAU;
      for (let j = 0; j < PROC.drainDrops; j += 1) {
        const h = hash01(`proc-drop:${i}:${j}`);
        const pos = (t * PROC.drainSpeed * R + h * cycle) % cycle;
        const rr = R * PROC.entryIn - pos;
        if (rr < R * PROC.intakeBandIn + 2) continue;
        const len = 8 + hash01(`proc-dropl:${i}:${j}`) * 10;
        path.moveTo(Math.sin(a) * (rr + len / 2), -Math.cos(a) * (rr + len / 2));
        path.lineTo(Math.sin(a) * (rr - len / 2), -Math.cos(a) * (rr - len / 2));
      }
    }
    ctx.save();
    ctx.strokeStyle = withAlpha(pal.dim, 0.16);
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'butt';
    ctx.globalAlpha = k;
    ctx.stroke(path);
    ctx.restore();
  }

  /**
   * §26.4 每芯连续光束：内指细线，宽度/透明度随 weight，线上 dash 恒速流动；
   * 脉冲：每芯一个解析相位的亮段沿光束向内行进（宽度 ×1.8）。
   */
  private drawBeams(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const R = env.R;
    const intakeR = R * PROC.intakeR;
    const t = env.now / 1000;
    const lowQ = env.quality < 0.7;
    // 按「权重分桶 × 轨道」批量描边：高占用芯片的光束更粗更亮、dash 流得更快，
    // 让「谁忙谁的光束凶」在静帧也能读出来（v2.7 校准：原实现只分 3 档 tier，视觉上拉不开）。
    const WB = 8;
    const BUCKETS = LANE_R.length * WB;
    const paths: Path2D[] = new Array(BUCKETS);
    const counts = new Uint16Array(BUCKETS);
    const wMids = new Float32Array(BUCKETS);
    for (let i = 0; i < BUCKETS; i += 1) paths[i] = new Path2D();
    const pulsePaths: Path2D[] = new Array(LANE_R.length * 2);
    for (let i = 0; i < pulsePaths.length; i += 1) pulsePaths[i] = new Path2D();
    const pulseCounts = new Uint16Array(LANE_R.length * 2);

    for (const chip of this.chips.values()) {
      if (chip.dying || chip.alpha <= 0.2) continue;
      if (lowQ && chip.band > 2) continue; // 降档：只画 L0–L2 的光束
      const wb = Math.min(WB - 1, Math.max(0, Math.floor(chip.weight * WB)));
      const idx = chip.band * WB + wb;
      const path = paths[idx];
      if (!path) continue;
      const r0 = Math.max(intakeR + 2, chip.r - chip.height * 0.4);
      if (r0 <= intakeR + 1) continue;
      path.moveTo(Math.sin(chip.phi) * r0, -Math.cos(chip.phi) * r0);
      path.lineTo(Math.sin(chip.phi) * intakeR, -Math.cos(chip.phi) * intakeR);
      counts[idx] += 1;
      wMids[idx] = (wb + 0.5) / WB;

      // 脉冲亮段（沿光束向内行进，频率 ∝ beamRate）
      const pp = chip.pulsePhase;
      const rr = r0 + (intakeR - r0) * pp;
      const plen = 4 + chip.height * 0.9;
      const pIdx = chip.band * 2 + (chip.weight >= 0.5 ? 0 : 1);
      const p1 = pulsePaths[pIdx];
      if (p1) {
        const a = Math.min(r0, rr + plen);
        const b = Math.max(intakeR, rr - plen);
        if (a > b) {
          p1.moveTo(Math.sin(chip.phi) * a, -Math.cos(chip.phi) * a);
          p1.lineTo(Math.sin(chip.phi) * b, -Math.cos(chip.phi) * b);
          pulseCounts[pIdx] += 1;
        }
      }
    }

    ctx.save();
    ctx.lineCap = 'butt';
    for (let idx = 0; idx < BUCKETS; idx += 1) {
      if (counts[idx] === 0) continue;
      const lane = Math.floor(idx / WB);
      const w = wMids[idx] || 0.1;
      const width = PROC.beamWidthMin + PROC.beamWidthGain * w;
      const alpha = PROC.beamAlphaMin + PROC.beamAlphaGain * w;
      const speed = PROC.beamSpeedMin + PROC.beamSpeedGain * w;
      const path = paths[idx];
      ctx.globalAlpha = clamp01(k * alpha * 1.1);
      ctx.strokeStyle = withAlpha(laneColor(pal, lane), 1);
      ctx.lineWidth = width;
      ctx.setLineDash([3, 4]);
      ctx.lineDashOffset = -((t * speed) % 1000);
      if (path) ctx.stroke(path);
    }
    ctx.setLineDash([]);
    // 脉冲亮段：高权重更宽更亮（宽 ×1.8）
    for (let pIdx = 0; pIdx < pulsePaths.length; pIdx += 1) {
      if (pulseCounts[pIdx] === 0) continue;
      const lane = Math.floor(pIdx / 2);
      const heavy = pIdx % 2 === 0;
      const path = pulsePaths[pIdx];
      if (!path) continue;
      ctx.globalAlpha = clamp01(k * (heavy ? 0.82 : 0.5));
      ctx.strokeStyle = withAlpha(laneColor(pal, lane), 1);
      ctx.lineWidth = heavy ? 3.2 : 2.0;
      ctx.stroke(path);
    }
    ctx.restore();
  }

  /** §26.4 内向数据包：按轨道 × 进度带批量描边 */
  private drawPackets(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const intakeR = env.R * PROC.intakeR;
    const BUCKETS = LANE_R.length * 3;
    const paths: Path2D[] = new Array(BUCKETS);
    for (let i = 0; i < BUCKETS; i += 1) paths[i] = new Path2D();
    const counts = new Uint16Array(BUCKETS);
    for (const pk of this.packetPool) {
      if (!pk.active) continue;
      const span = Math.max(1, pk.spawnR - intakeR);
      const progress = clamp01((pk.spawnR - pk.r) / span);
      const pband = progress < 0.34 ? 0 : progress < 0.67 ? 1 : 2;
      const idx = pk.lane * 3 + pband;
      const path = paths[idx];
      if (!path) continue;
      path.moveTo(Math.sin(pk.phi) * (pk.r + pk.len / 2), -Math.cos(pk.phi) * (pk.r + pk.len / 2));
      path.lineTo(Math.sin(pk.phi) * (pk.r - pk.len / 2), -Math.cos(pk.phi) * (pk.r - pk.len / 2));
      counts[idx] += 1;
    }
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineWidth = 2;
    for (let idx = 0; idx < BUCKETS; idx += 1) {
      if (counts[idx] === 0) continue;
      const lane = Math.floor(idx / 3);
      const pband = idx % 3;
      ctx.globalAlpha = clamp01(k * (0.7 - 0.4 * ((pband + 0.5) / 3)));
      ctx.strokeStyle = withAlpha(laneColor(pal, lane), 1);
      const path = paths[idx];
      if (path) ctx.stroke(path);
    }
    ctx.restore();
  }

  // ———————————————————————————————————————————— 六层核心（§26.5）

  private drawCore(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const R = env.R;
    const t = env.now / 1000;
    const usage = this.snapshot ? clamp01(this.snapshot.cpu.usage / 100) : 0.2;
    ctx.save();
    ctx.globalAlpha = k;
    ctx.lineCap = 'butt';

    // L0 进气口 iris：20 片叶片，开合半径 0.040+0.012*CpuN，+0.55rad/s
    const irisR = R * PROC.irisR;
    const openR = R * (PROC.irisOpenBase + PROC.irisOpenGain * this.cpuN);
    const irisAng = this.coreAngles[0] ?? 0;
    ctx.strokeStyle = withAlpha(pal.fill, 0.62);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, irisR * 0.98, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = withAlpha(pal.fill, 0.48 + 0.24 * this.intakeFlash);
    ctx.beginPath();
    for (let i = 0; i < PROC.irisBlades; i += 1) {
      const a = irisAng + (i / PROC.irisBlades) * TAU;
      const a2 = a + 0.14;
      ctx.moveTo(Math.sin(a) * openR, -Math.cos(a) * openR);
      ctx.lineTo(Math.sin(a2) * irisR, -Math.cos(a2) * irisR);
    }
    ctx.stroke();

    // L1 主轴 rotor：八边形骨架 + 8 辐条 + 8 活塞，+0.30rad/s；轴心亮核 ∝ CPU
    const rotorR = R * PROC.rotorR;
    const rotorAng = this.coreAngles[1] ?? 0;
    ctx.save();
    ctx.rotate(rotorAng);
    ctx.strokeStyle = withAlpha(pal.accent, 0.88);
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    for (let i = 0; i < PROC.rotorSpokes; i += 1) {
      const a = (i / PROC.rotorSpokes) * TAU;
      const x = Math.sin(a) * rotorR;
      const y = -Math.cos(a) * rotorR;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = withAlpha(pal.line, 0.58);
    ctx.beginPath();
    for (let i = 0; i < PROC.rotorSpokes; i += 1) {
      const a = (i / PROC.rotorSpokes) * TAU;
      const piston = Math.sin(t * 1.2 + a) * R * PROC.pistonAmp;
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.sin(a) * (rotorR * 0.9 + piston), -Math.cos(a) * (rotorR * 0.9 + piston));
    }
    ctx.stroke();
    ctx.restore();
    const coreGlow = 0.22 + 0.68 * usage;
    ctx.fillStyle = withAlpha(pal.fill, clamp01(0.16 + 0.5 * coreGlow));
    const cr = Math.max(1.6, R * 0.012);
    ctx.beginPath();
    ctx.arc(0, 0, cr, 0, TAU);
    ctx.fill();

    // L2 齿环 gear：48 齿，高 0.008R，反向 −0.22rad/s
    const gearR = R * PROC.gearR;
    const gearAng = this.coreAngles[2] ?? 0;
    ctx.strokeStyle = withAlpha(pal.line, 0.78);
    ctx.lineWidth = 1.15;
    ctx.beginPath();
    ctx.arc(0, 0, gearR, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < PROC.gearTeeth; i += 1) {
      const a = gearAng + (i / PROC.gearTeeth) * TAU;
      ctx.moveTo(Math.sin(a) * gearR, -Math.cos(a) * gearR);
      ctx.lineTo(
        Math.sin(a) * (gearR + R * PROC.gearTooth),
        -Math.cos(a) * (gearR + R * PROC.gearTooth),
      );
    }
    ctx.stroke();

    // L3 涡轮 vanes：12 片弧叶，+0.14rad/s，叶片间隙透光
    const vanesR = R * PROC.vanesR;
    const vanesAng = this.coreAngles[3] ?? 0;
    ctx.strokeStyle = withAlpha(pal.fill, 0.68);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < PROC.vanesCount; i += 1) {
      const a0 = vanesAng + (i / PROC.vanesCount) * TAU;
      ctx.arc(0, 0, vanesR, a0 - Math.PI / 2, a0 - Math.PI / 2 + TAU / PROC.vanesCount - 0.1);
    }
    ctx.stroke();
    ctx.strokeStyle = withAlpha(pal.line, 0.42);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, vanesR, 0, TAU);
    ctx.stroke();

    // L4 数据涡流：48 粒螺旋向内（dθ +0.9、dr −0.10R/s，到 0.16R 回填）
    const vIn = R * PROC.vortexIn;
    const vOut = R * PROC.vortexOut;
    const vspan = vOut - vIn;
    const vDots = new Path2D();
    for (const p of this.vortex) {
      const rr = vOut - clamp01(p.r) * vspan;
      const size = 1.4 + 1.4 * (1 - clamp01(p.r));
      vDots.moveTo(Math.sin(p.a) * (rr + size), -Math.cos(p.a) * (rr + size));
      vDots.arc(Math.sin(p.a) * rr, -Math.cos(p.a) * rr, size, 0, TAU);
    }
    if (this.vortexCount > 0) {
      ctx.fillStyle = withAlpha(pal.fill, 0.62);
      ctx.fill(vDots);
    }
    ctx.strokeStyle = withAlpha(pal.accent, 0.4);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, vIn, 0, TAU);
    ctx.stroke();

    // L5 散热格栅 + 扫描环：24 条辐射格栅（0.26R）；每 3s 一道扫描环 0.02R→0.30R / 300ms
    const grillR = R * PROC.grilleR;
    ctx.strokeStyle = withAlpha(pal.line, 0.34);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < PROC.grilleLines; i += 1) {
      const a = (i / PROC.grilleLines) * TAU;
      ctx.moveTo(Math.sin(a) * (grillR - R * 0.012), -Math.cos(a) * (grillR - R * 0.012));
      ctx.lineTo(Math.sin(a) * (grillR + R * 0.012), -Math.cos(a) * (grillR + R * 0.012));
    }
    ctx.stroke();
    const scanT = env.now % PROC.scanMs;
    if (scanT < PROC.scanDurMs) {
      const sp = scanT / PROC.scanDurMs;
      const rr = R * (0.02 + sp * 0.28);
      ctx.globalAlpha = clamp01(k * 0.85 * (1 - sp));
      ctx.strokeStyle = withAlpha(pal.fill, 1);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = k;
    }
    ctx.restore();
  }

  // ———————————————————————————————————————————— 芯片（§26.3）

  /** 尾迹：沿运动反方向 6° 渐隐弧，宽 = 芯片高，alpha .18 → 0 */
  private drawTrails(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const lowQ = env.quality < 0.85;
    const SEGS = lowQ ? 3 : 6;
    const BUCKETS = LANE_R.length * SEGS;
    const paths: Path2D[] = new Array(BUCKETS);
    for (let i = 0; i < BUCKETS; i += 1) paths[i] = new Path2D();
    const counts = new Uint16Array(BUCKETS);
    for (const chip of this.chips.values()) {
      if (chip.dying || chip.alpha <= 0.2) continue;
      const r = Math.max(1, chip.r);
      for (let s = 0; s < SEGS; s += 1) {
        const a1 = chip.phi - (0.105 * s) / SEGS;
        const a0 = chip.phi - (0.105 * (s + 1)) / SEGS;
        const path = paths[chip.band * SEGS + s];
        if (!path) continue;
        path.moveTo(Math.sin(a0) * r, -Math.cos(a0) * r);
        path.arc(0, 0, r, a0 - Math.PI / 2, a1 - Math.PI / 2);
        counts[chip.band * SEGS + s] += 1;
      }
    }
    ctx.save();
    ctx.lineCap = 'butt';
    for (let idx = 0; idx < BUCKETS; idx += 1) {
      if (counts[idx] === 0) continue;
      const band = Math.floor(idx / SEGS);
      const s = idx % SEGS;
      const path = paths[idx];
      if (!path) continue;
      ctx.globalAlpha = clamp01(k * 0.18 * (1 - s / SEGS));
      ctx.strokeStyle = withAlpha(laneColor(pal, band), 1);
      ctx.lineWidth = 4;
      ctx.stroke(path);
    }
    ctx.restore();
  }

  /** 模块芯片：外框 / CPU 填充条 / 线程刻点 / 内存带 / 亮核 / 运行脉冲；选中白描边 */
  private drawChips(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const zoom = Math.max(0.3, env.zoom);
    const attn = zoom <= 2 ? 1 : Math.pow(zoom / 2, -0.25);
    const t = env.now / 1000;
    for (const chip of this.chips.values()) {
      if (chip.alpha <= 0.01) continue;
      const laneC = laneColor(pal, chip.band);
      const x = Math.sin(chip.phi) * chip.r;
      const y = -Math.cos(chip.phi) * chip.r;
      const w = Math.max(4, chip.width * attn);
      const h = Math.max(2.4, chip.height * attn);
      const cpuK = clamp01(chip.cpu / 100);
      ctx.save();
      ctx.globalAlpha = clamp01(k) * chip.alpha;
      ctx.translate(x, y);
      ctx.rotate(chip.phi);
      // 外框（轨道色 alpha .7）
      ctx.fillStyle = withAlpha(pal.base, 0.42);
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = withAlpha(laneC, 0.7);
      ctx.lineWidth = 1;
      ctx.strokeRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1);
      // CPU 填充条（宽 = 0.6w*cpuPct/100，轨道色 alpha .85）
      if (cpuK > 0.01) {
        ctx.fillStyle = withAlpha(laneC, 0.85);
        ctx.fillRect(-w / 2 + 1, -h / 2 + 1, Math.max(1, 0.6 * w * cpuK), h - 2);
      }
      // 右侧线程刻点：min(8, ceil(threads/8)) 个 1×h*0.5 竖点，间隔 1px
      if (chip.threads > 0) {
        const n = Math.min(8, Math.max(1, Math.ceil(chip.threads / 8)));
        const dotH = Math.max(1.2, h * 0.5);
        ctx.fillStyle = withAlpha(pal.text, 0.7);
        const startX = w / 2 - 2 - (n - 1) * 2;
        for (let i = 0; i < n; i += 1) {
          ctx.fillRect(startX + i * 2, -dotH / 2, 1, dotH);
        }
      }
      // 底边内存带（长 = w*memN，1px 冷白 alpha .5）
      const memN = chip.memN;
      if (memN > 0.02) {
        ctx.fillStyle = withAlpha(pal.fill, 0.5);
        ctx.fillRect(-w / 2 + 1, h / 2 - 1.5, Math.max(0.5, (w - 2) * memN), 1);
      }
      // 运行脉冲：沿长边扫过（周期已按 weight/CPU 调制），扫过处亮度 +25%
      const pulse = Math.pow(Math.max(0, Math.cos(chip.pulsePhase * TAU)), 12);
      if (pulse > 0.05) {
        const px = -w / 2 + w * ((t * 0.35 + chip.grain) % 1);
        ctx.fillStyle = withAlpha(pal.fill, clamp01(0.22 * pulse));
        ctx.fillRect(px - w * 0.12, -h / 2, w * 0.24, h);
      }
      // 中心亮核 2px（活跃度 ≥0.4 才画）
      const active = clamp01(chip.cpuN * 0.7 + chip.recN * 0.3);
      if (active >= 0.4) {
        ctx.fillStyle = withAlpha(pal.fill, 0.8 * active);
        ctx.fillRect(-1, -1, 2, 2);
      }
      // hover：外扩 1px
      if (this.hoverPid === chip.pid) {
        ctx.strokeStyle = withAlpha(pal.text, 0.5);
        ctx.strokeRect(-w / 2 - 1, -h / 2 - 1, w + 2, h + 2);
      }
      ctx.restore();
    }
    // 选中：2px 白描边 + 四角刻
    const sel = this.selectedPid !== null ? this.chips.get(this.selectedPid) : null;
    if (sel && sel.alpha > 0.05) {
      const x = Math.sin(sel.phi) * sel.r;
      const y = -Math.cos(sel.phi) * sel.r;
      const w = Math.max(4, sel.width * attn);
      const h = Math.max(2.4, sel.height * attn);
      ctx.save();
      ctx.globalAlpha = clamp01(k) * sel.alpha;
      ctx.translate(x, y);
      ctx.rotate(sel.phi);
      ctx.strokeStyle = withAlpha(pal.fill, 0.98);
      ctx.lineWidth = 2;
      ctx.strokeRect(-w / 2 - 2.5, -h / 2 - 2.5, w + 5, h + 5);
      ctx.lineWidth = 1.2;
      const cx = w / 2 + 6;
      const cy = h / 2 + 6;
      const sz = 3.5;
      ctx.beginPath();
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          ctx.moveTo(sx * cx - sx * sz, sy * cy);
          ctx.lineTo(sx * cx, sy * cy);
          ctx.lineTo(sx * cx, sy * cy - sy * sz);
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // ———————————————————————————————————————————— 屏幕层

  /** 扫描线 / 无遥测提示（屏幕空间） */
  drawScan(ctx: CanvasRenderingContext2D, env: Env, alpha: number, reveal: number): void {
    const k = clamp01(alpha) * clamp01(reveal);
    if (k <= 0.01) return;
    const pal = paletteOf(env);
    if (!env.reducedMotion && this.available) {
      const p = (Date.now() % PROC.scanMs) / PROC.scanMs;
      const y = p * env.h;
      ctx.save();
      ctx.globalAlpha = 0.04 * k;
      ctx.strokeStyle = withAlpha(pal.line, 1);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(env.w, y + 0.5);
      ctx.stroke();
      ctx.restore();
    }
    if (!this.available) {
      ctx.save();
      ctx.globalAlpha = clamp01(0.55 * k);
      ctx.fillStyle = withAlpha(COLORS.bone300, 1);
      ctx.font = `500 12px ${FONTS.mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('进程遥测不可用 · 检查采样器', env.w / 2, env.h / 2 + env.R * 0.02);
      ctx.restore();
    }
  }

  /** 世界内标注（屏幕空间）：hover / 选中进程一行等宽字 */
  drawLabels(ctx: CanvasRenderingContext2D, env: Env, cam: ScreenCam): void {
    const pid = this.hoverPid ?? this.selectedPid;
    if (pid === null) return;
    const chip = this.chips.get(pid);
    if (!chip || chip.alpha <= 0.1) return;
    const x = Math.sin(chip.phi) * chip.r;
    const y = -Math.cos(chip.phi) * chip.r;
    const p = cam.worldToScreen(env, x, y);
    const pal = paletteOf(env);
    const laneName = LANE_NAME[chip.band] ?? '';
    const label = `${chip.name} · ${laneName} · PID ${chip.pid}`;
    ctx.save();
    ctx.font = `500 10px ${FONTS.mono}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(label).width;
    const lx = clamp(p.x + 10, 6, env.w - w - 8);
    const ly = clamp(p.y - 10, 12, env.h - 10);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = withAlpha(COLORS.inkVoid, 0.72);
    ctx.fillRect(lx - 4, ly - 8, w + 8, 16);
    ctx.fillStyle = withAlpha(pal.text, 0.95);
    ctx.fillText(label, lx, ly);
    ctx.strokeStyle = withAlpha(pal.line, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x + 4, p.y - 4);
    ctx.lineTo(lx - 4, ly);
    ctx.stroke();
    ctx.restore();
  }

  /** 命中（屏幕距离 + 8px 宽容；返回 pid） */
  pick(env: Env, cam: ScreenCam, sx: number, sy: number): number | null {
    let best: number | null = null;
    let bestD = Infinity;
    const zoom = Math.max(0.3, env.zoom);
    const attn = zoom <= 2 ? 1 : Math.pow(zoom / 2, -0.25);
    for (const chip of this.chips.values()) {
      if (chip.alpha < 0.35) continue;
      const x = Math.sin(chip.phi) * chip.r;
      const y = -Math.cos(chip.phi) * chip.r;
      const p = cam.worldToScreen(env, x, y);
      const radius = (Math.max(chip.width * attn, env.mobile ? 7 : 5) * zoom) / 2 + 8;
      const dx = sx - p.x;
      const dy = sy - p.y;
      const d = Math.hypot(dx, dy);
      if (d <= radius && d < bestD) {
        bestD = d;
        best = chip.pid;
      }
    }
    return best;
  }

  hoverAt(env: Env, cam: ScreenCam, sx: number, sy: number): { pid: number } | null {
    this.hoverPid = this.pick(env, cam, sx, sy);
    return this.hoverPid === null ? null : { pid: this.hoverPid };
  }

  get chipCount(): number {
    return this.chips.size;
  }
}
