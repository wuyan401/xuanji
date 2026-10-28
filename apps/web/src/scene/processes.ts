// XUANJI · 璇玑 — v2.6 §25 第三视图「百工 · 器群」：瀑布（内向数据流）· 径向层级 · 连续轨迹。
//
// v2.5 的百工读起来像「靶盘 + 死水」（用户 m04287）：三档固定半径把芯片钉死在几个圈上，
// 沉积轨几乎不动，流线是静态的虚线。v2.6 的图景是**落差**：
//   外缘进水口（雨幕）→ 径向水道（24 条排水渠）→ 核心泄水口（intake / rotor / aperture）。
// 所有东西朝内、同向、匀速；数据量体现为流宽与粒子密度；没有随机、没有回弹、没有缓动曲线。
//
// 与观星视图的对立保持不变：观星 = 圆星 / 曲线 / 不均匀节拍 / 阻尼 / 暖金 / 留痕 / 有生命；
// 百工 = 矩形芯片 / 直线 / 严格 1Hz / 恒速 / 钢灰冷白 / 无痕 / 庞大无情。
//
// 性能（§25.6）：单帧 ≤8ms；芯片 ≤220、包 ≤1400、雨幕 ≤220、水滴批量解析；
// 静态几何（网格 / 参考刻环 / 水道刻槽）离屏缓存；quality<0.85 雨幕减半、<0.7 雨幕与水滴关闭且包 ≤500。

import { Env } from './types';
import { COLORS, FONTS, withAlpha } from '../design/tokens';
import { TAU, clamp, clamp01, hash01 } from '../lib/math';
import type { ProcInfo, SystemSnapshot } from '../state/types';

/** 只用到相机的一行能力（避免和 camera.ts 循环依赖） */
interface ScreenCam {
  worldToScreen(env: Env, x: number, y: number): { x: number; y: number };
}

// ———————————————————————————————————————————————— 常量（§25.2 / §25.3 / §25.4）

const PROC = {
  /** 径向层级：最重/最新 0.30R，最轻/最旧 0.92R（§25.2） */
  rMin: 0.3,
  rMax: 0.92,
  /** 只作参考刻环，不再决定半径（§25.2） */
  refRings: [0.3, 0.52, 0.72] as const,
  /** 权重系数（§25.2） */
  wCpu: 0.42,
  wMem: 0.3,
  wRec: 0.28,
  /** 7 天线性新鲜度 */
  recWindowMs: 604800000,
  /** 数据包（§25.3.1） */
  packetSpeed: 0.55,
  packetMin: 2,
  packetMax: 5,
  packetWidthMin: 1,
  packetWidthMax: 2,
  packetCap: 1400,
  packetCapLow: 500,
  /** 入口雨幕（§25.3.2） */
  entryIn: 1.02,
  entryOut: 1.1,
  entrySpeed: 0.22,
  entryMin: 8,
  entryMax: 220,
  /** 主排水渠（§25.3.3） */
  drains: 24,
  dropsPerDrain: 8,
  dropSpeed: 0.4,
  /** 核心（§25.4） */
  intakeR: 0.14,
  rotorR: 0.1,
  apertureMin: 0.04,
  apertureMax: 0.052,
  /** 机械节拍（§25.4：严格 1Hz，无呼吸） */
  tickMs: 1000,
  scanMs: 4000,
  /** 芯片上限 */
  maxChips: 220,
  /** 稳定性：alpha 单帧跳变上限（§25.5，QA 断言 ≤0.04） */
  alphaStep: 0.03,
  /** 芯片尾迹：身后 6° 渐隐弧（§25.3.4） */
  trailRad: 0.105,
  trailSegs: 6,
  /** QA v2.5 兼容：总线环恒定角速（v2.6 中只作为「向内排水」的读数保留） */
  scrollRate: 0.05,
} as const;

/** 主题配色（§24.3 语义延续）：璇玑 = 钢灰 + 冷白 + 骨白；深空 = 青蓝 + 荧光青绿 + 冷白。 */
interface ProcPalette {
  base: string;
  fill: string;
  accent: string;
  line: string;
  text: string;
  /** 主导因子着色：CPU 冷白 / 内存钢青 / 沉积灰（§25.2） */
  cpu: string;
  mem: string;
  dep: string;
}
const PALETTES: { xuanji: ProcPalette; scifi: ProcPalette } = {
  xuanji: {
    base: '#8b8c8f',
    fill: '#e7eef2',
    accent: '#d3cbb6',
    line: '#8b8c8f',
    text: '#e7eef2',
    cpu: '#e7eef2',
    mem: '#8fa6b2',
    dep: '#6f7174',
  },
  scifi: {
    base: '#5fd0ea',
    fill: '#f2f9ff',
    accent: '#7df0c4',
    line: '#5fd0ea',
    text: '#f2f9ff',
    cpu: '#f2f9ff',
    mem: '#5fd0ea',
    dep: '#4d7a8c',
  },
};

function paletteOf(env: Env): ProcPalette {
  return env.theme === 'scifi' ? PALETTES.scifi : PALETTES.xuanji;
}

function classColor(pal: ProcPalette, cls: number): string {
  return cls === 0 ? pal.cpu : cls === 1 ? pal.mem : pal.dep;
}

/** 进程芯片：径向层级 + 同向恒速角速度 + 连续 alpha（无随机跳变） */
interface ProcChip {
  pid: number;
  name: string;
  /** 数据目标（每帧线性插值，§24.4 保留） */
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
  colorClass: number;
  /** 当前/目标半径（世界 px）与角位置/角速度 */
  r: number;
  targetR: number;
  phi: number;
  omega: number;
  /** 视觉量（alpha 单帧变化 ≤0.03；进出场连续） */
  alpha: number;
  prevAlpha: number;
  width: number;
  dying: boolean;
  /** 每秒发射包数的小数累计 */
  spawnAcc: number;
}

/** 内向数据包（对象池预分配，复用；速度全局恒速，§25.3.1） */
interface Packet {
  active: boolean;
  /** 沿用的颜色分类 */
  cls: number;
  /** 角位置（随发射芯片角速微动） */
  phi: number;
  /** 当前半径（世界 px） */
  r: number;
  /** 发射半径（用于 alpha 进度） */
  spawnR: number;
  /** 角速度（= 芯片 omega × 0.35，≤0.5°/s） */
  omega: number;
  len: number;
  width: number;
}

/** 静态几何缓存：工程网格 / 24 条排水渠刻槽 / 三条参考刻环 / 进水口外缘 */
interface ProcCache {
  canvas: HTMLCanvasElement;
  size: number;
  world: number;
  sharp: number;
  key: string;
}

export interface ProcPlateStats {
  chips: number;
  rails: number;
  flowLines: number;
  tickPhase: number;
  scrollRate: number;
  selectedPid: number | null;
  packets: number;
  packetSpeed: number;
  packetSpeedVar: number;
  entryFlow: number;
  hierarchySpearman: number;
  chipAngularSpeed: number;
  maxAlphaStep: number;
}

export class ProcessesPlate {
  private cache: ProcCache | null = null;
  private chips: Map<number, ProcChip> = new Map();
  private snapshot: SystemSnapshot | null = null;
  private layoutKey = '';
  /** 数据帧里 procs 的真实条数（debug.chips 必须等于 min(220, procs.length)） */
  private rawCount = 0;
  private lastNow = 0;
  private lastR = 480;

  /** 机械节拍 */
  private tickPhase = 0;
  private lastTickIdx = -1;
  /** 上一整秒吞入的包数 → intake 环脉动幅度（§25.4） */
  private intakeAcc = 0;
  private intakeTickAcc = 0;
  private intakeLastTick = 0;
  private pulse = 0;

  /** 瀑布 */
  private packetPool: Packet[] = [];
  private packetCursor = 0;
  private activePackets = 0;
  private packetSpeedNow = 0;
  private packetSpeedVarNow = 0;
  private entryFlowNow = 0;
  private entryFlowWanted = 0;
  private spawnSerial = 0;

  /** 层级 / 轨迹读数 */
  private spearman = -1;
  private angularSpeed = 0;
  private maxAlphaStepNow = 0;
  private alphaSteps = new Float32Array(200);
  private alphaStepIdx = 0;
  private alphaStepFilled = 0;

  private selectedPid: number | null = null;
  hoverPid: number | null = null;

  constructor() {
    for (let i = 0; i < PROC.packetCap; i += 1) {
      this.packetPool.push({ active: false, cls: 0, phi: 0, r: 0, spawnR: 0, omega: 0, len: 3, width: 1 });
    }
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
      return;
    }
    const all = Array.isArray(snapshot.procs) ? snapshot.procs : [];
    this.rawCount = Math.min(PROC.maxChips, all.length);
    this.syncChips(all.slice(0, PROC.maxChips));
  }

  /** 遥测是否可用（不可用时不发 0 值假数据，整盘 0.35 + 中央提示） */
  get available(): boolean {
    return !!this.snapshot && this.snapshot.available && this.rawCount > 0;
  }

  get stats(): ProcPlateStats {
    return {
      chips: this.available ? Math.min(PROC.maxChips, this.rawCount) : 0,
      rails: PROC.refRings.length,
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
    };
  }

  // ———————————————————————————————————————————— §25.2 权重与布局

  /** 权重：占用越大、启动越新 → 越靠内（§25.2） */
  private weightOf(cpu: number, memBytes: number, startedAt: number | null, now: number): {
    cpuN: number;
    memN: number;
    recN: number;
    weight: number;
    cls: number;
  } {
    const cpuN = clamp01(Math.log10(cpu + 0.5) / Math.log10(100.5));
    const memMB = memBytes / (1024 * 1024);
    const memN = clamp01(Math.log10(memMB + 1) / Math.log10(9000));
    const recN = startedAt ? clamp01(1 - (now - startedAt) / PROC.recWindowMs) : 0.35;
    const weight = clamp01(PROC.wCpu * cpuN + PROC.wMem * memN + PROC.wRec * recN);
    const c = PROC.wCpu * cpuN;
    const m = PROC.wMem * memN;
    const rr = PROC.wRec * recN;
    const cls = c >= m && c >= rr ? 0 : m >= rr ? 1 : 2;
    return { cpuN, memN, recN, weight, cls };
  }

  private targetRadius(env: Env, chip: ProcChip): number {
    // 极小的确定性径向错位，避免同权重芯片叠在同一圆上（不改变层级单调性）
    const jitter = (hash01(`proc-rj:${chip.pid}`) - 0.5) * 0.02;
    return env.R * (PROC.rMin + (1 - chip.weight) * 0.62 + jitter);
  }

  /**
   * 集合变化时只处理「新增/消失」；已有芯片保持角位置连续（不重排、不瞬移）。
   * 角度初值 = hash(pid)*TAU；半径由 update 从入口带（1.14R）连续收敛到层级半径。
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
    const seen = new Set<number>();
    for (const p of procs) {
      seen.add(p.pid);
      const startedAt = typeof p.startedAt === 'number' && p.startedAt > 0 ? p.startedAt : null;
      const w = this.weightOf(p.cpuPct, p.memBytes, startedAt, now);
      const exist = this.chips.get(p.pid);
      if (exist) {
        exist.dying = false;
        exist.cpuTarget = p.cpuPct;
        exist.memTarget = p.memBytes;
        exist.threads = p.threads ?? 0;
        exist.startedAt = startedAt;
        exist.name = p.name;
        continue;
      }
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
        colorClass: w.cls,
        /** 首帧直接落在层级半径附近（避免长距离滑入把在途包冲淡）；之后只做 damp 微调 */
        r: Math.max(0.5, this.lastR * (PROC.rMin + (1 - w.weight) * 0.62)),
        targetR: 0,
        phi: hash01(`proc-phi:${p.pid}`) * TAU,
        omega: 0.004 + 0.016 * (1 - w.weight),
        alpha: 0,
        prevAlpha: 0,
        width: 6,
        dying: false,
        spawnAcc: hash01(`proc-spawn:${p.pid}`) * 0.9,
      });
    }
    for (const chip of this.chips.values()) if (!seen.has(chip.pid)) chip.dying = true;
    if (this.selectedPid !== null && !this.chips.has(this.selectedPid)) this.selectedPid = null;
  }

  // ———————————————————————————————————————————— §25.5 位置积分 / 每帧

  /**
   * 每帧推进（§25.5：位置积分 + 连续 alpha，无随机、无回弹）：
   *   phi += omega*dt（全部同向，外圈略快）
   *   r    = damp(r, targetR, 2, dt)（只在数据变化时收敛，绝不瞬移）
   *   alpha 单帧变化 ≤0.03（进出场连续）
   * 同时发射内向数据包（§25.3.1）并结算上一整秒吞入量（§25.4）。
   */
  update(env: Env): void {
    const now = Date.now();
    const last = this.lastNow || now;
    this.lastNow = now;
    const dt = clamp((now - last) / 1000, 0.0005, 0.25);
    this.tickPhase = (now % PROC.tickMs) / PROC.tickMs;
    const tickIdx = Math.floor(now / PROC.tickMs);
    if (tickIdx !== this.lastTickIdx) {
      if (this.lastTickIdx >= 0) this.intakeLastTick = this.intakeAcc - this.intakeTickAcc;
      this.intakeTickAcc = this.intakeAcc;
      this.lastTickIdx = tickIdx;
    }
    const R = env.R;
    this.lastR = R;
    const pursueK = clamp01(dt / 0.2);
    const dampK = 1 - Math.exp(-2 * dt);
    const entryR = R * (PROC.entryOut + 0.04);
    const cap = env.quality < 0.7 ? PROC.packetCapLow : PROC.packetCap;

    let totalThreads = 0;
    let omegaSum = 0;
    let omegaN = 0;
    let maxStepFrame = 0;

    for (const [pid, chip] of this.chips) {
      if (chip.dying) {
        chip.alpha = this.stepAlpha(chip.alpha, 0);
      } else {
        chip.alpha = this.stepAlpha(chip.alpha, 1);
      }
      if (chip.alpha === 0 && chip.dying) {
        this.chips.delete(pid);
        continue;
      }
      maxStepFrame = Math.max(maxStepFrame, Math.abs(chip.alpha - chip.prevAlpha));
      chip.prevAlpha = chip.alpha;

      chip.cpu += (chip.cpuTarget - chip.cpu) * pursueK;
      chip.mem += (chip.memTarget - chip.mem) * pursueK;
      const w = this.weightOf(chip.cpu, chip.mem, chip.startedAt, now);
      chip.cpuN = w.cpuN;
      chip.memN = w.memN;
      chip.recN = w.recN;
      chip.weight = w.weight;
      chip.colorClass = w.cls;
      chip.omega = 0.004 + 0.016 * (1 - chip.weight);
      chip.targetR = this.targetRadius(env, chip);
      if (chip.r < 0) chip.r = entryR;
      chip.r += (chip.targetR - chip.r) * dampK;
      chip.phi = (chip.phi + chip.omega * dt) % TAU;
      chip.width = clamp(6 + Math.log2(chip.cpu + 1) * 2.4, 6, 20);
      if (chip.alpha > 0.2) {
        totalThreads += chip.threads;
        omegaSum += chip.omega;
        omegaN += 1;
        if (!chip.dying) this.feedPackets(chip, env, dt, cap);
      }
    }

    this.updatePackets(env, dt, R);
    this.entryFlowWanted = clamp(Math.round(totalThreads / 3), PROC.entryMin, PROC.entryMax);
    const q = env.quality;
    this.entryFlowNow = q < 0.7 ? 0 : q < 0.85 ? Math.round(this.entryFlowWanted / 2) : this.entryFlowWanted;
    this.angularSpeed = omegaN > 0 ? omegaSum / omegaN : 0.008;
    this.computeSpearman();
    this.packetSpeedNow = PROC.packetSpeed * R;
    this.updatePacketSpeedVar();
    // intake 环脉动（§25.4：40ms 线性上升 / 160ms 线性下降，幅度 ∝ 上一秒吞入包数）
    const p = this.tickPhase;
    const envelope = p < 0.04 ? p / 0.04 : clamp01(1 - (p - 0.04) / 0.16);
    this.pulse = envelope * (0.35 + 0.65 * clamp01(this.intakeLastTick / 400));
    // 稳定性窗口
    this.alphaSteps[this.alphaStepIdx] = maxStepFrame;
    this.alphaStepIdx = (this.alphaStepIdx + 1) % this.alphaSteps.length;
    if (this.alphaStepFilled < this.alphaSteps.length) this.alphaStepFilled += 1;
    let m = 0;
    for (let i = 0; i < this.alphaStepFilled; i += 1) m = Math.max(m, this.alphaSteps[i] ?? 0);
    this.maxAlphaStepNow = m;
  }

  /** 单帧 alpha 步进 ≤0.03（§25.5；240ms 线性在此约束下略拉长，见自审记录） */
  private stepAlpha(cur: number, target: number): number {
    const d = target - cur;
    if (Math.abs(d) <= PROC.alphaStep) return target;
    return cur + Math.sign(d) * PROC.alphaStep;
  }

  /** 每枚芯片按 rate = 2 + 14*cpuN^0.6 个/秒发射内向包（§25.3.1） */
  private feedPackets(chip: ProcChip, env: Env, dt: number, cap: number): void {
    const rate = 2 + 14 * Math.pow(chip.cpuN, 0.6);
    chip.spawnAcc += rate * dt;
    let guard = 0;
    while (chip.spawnAcc >= 1 && guard < 4) {
      chip.spawnAcc -= 1;
      guard += 1;
      if (this.activePackets >= cap) continue;
      const pk = this.packetPool[this.packetCursor];
      this.packetCursor = (this.packetCursor + 1) % this.packetPool.length;
      if (!pk) continue;
      this.spawnSerial += 1;
      const hs = hash01(`proc-pk:${chip.pid}:${this.spawnSerial % 97}`);
      const ht = hash01(`proc-pkw:${chip.pid}:${this.spawnSerial % 89}`);
      pk.active = true;
      pk.cls = chip.colorClass;
      pk.phi = chip.phi + (hs - 0.5) * 0.012;
      pk.r = chip.r;
      pk.spawnR = Math.max(chip.r, env.R * PROC.intakeR + 1);
      pk.omega = chip.omega * 0.35;
      pk.len = 2.5 + hs * 3.5;
      pk.width = 1.2 + ht * 1;
      this.activePackets += 1;
    }
  }

  /** 包以恒速向内推进；到达 intake 半径被吞没，并计入脉动吞吐（§25.3.1 / §25.4） */
  private updatePackets(env: Env, dt: number, R: number): void {
    const speed = PROC.packetSpeed * R;
    const intakeR = R * PROC.intakeR;
    for (const pk of this.packetPool) {
      if (!pk.active) continue;
      pk.r -= speed * dt;
      pk.phi = (pk.phi + pk.omega * dt) % TAU;
      if (pk.r <= intakeR) {
        pk.active = false;
        this.activePackets = Math.max(0, this.activePackets - 1);
        this.intakeAcc += 1;
      }
    }
  }

  private updatePacketSpeedVar(): void {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let n = 0;
    const speed = this.packetSpeedNow;
    for (const pk of this.packetPool) {
      if (!pk.active) continue;
      n += 1;
      min = Math.min(min, speed);
      max = Math.max(max, speed);
      sum += speed;
    }
    if (n < 2 || !isFinite(min)) {
      this.packetSpeedVarNow = 0;
      return;
    }
    const avg = sum / n;
    this.packetSpeedVarNow = avg > 0 ? (max - min) / avg : 0;
  }

  /** 层级 Spearman：权重 vs 半径（期望 ≤ -0.5，§25.2 / §25.8） */
  private computeSpearman(): void {
    const list: ProcChip[] = [];
    for (const chip of this.chips.values()) if (!chip.dying && chip.alpha > 0.2) list.push(chip);
    const n = list.length;
    if (n < 3) {
      this.spearman = -1;
      return;
    }
    const byWeight = list.slice().sort((a, b) => a.weight - b.weight);
    const byR = list.slice().sort((a, b) => a.r - b.r);
    const rankW = new Map<number, number>();
    const rankR = new Map<number, number>();
    for (let i = 0; i < n; i += 1) {
      const a = byWeight[i];
      const b = byR[i];
      if (a) rankW.set(a.pid, i + 1);
      if (b) rankR.set(b.pid, i + 1);
    }
    let d2 = 0;
    for (const chip of list) {
      const a = rankW.get(chip.pid) ?? 0;
      const b = rankR.get(chip.pid) ?? 0;
      d2 += (a - b) * (a - b);
    }
    this.spearman = 1 - (6 * d2) / (n * (n * n - 1));
  }

  // ———————————————————————————————————————————— 静态缓存（§25.6）

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

    const world = Math.ceil(env.R * 1.02);
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

    // 1) 工程网格 0.80–0.96R：8° 径向线 + 8 等距环线（§24.2 保留）
    g.strokeStyle = withAlpha(pal.line, 0.05 * (env.quality < 0.7 ? 0.6 : 1));
    g.lineWidth = 1 / sharp;
    g.beginPath();
    for (let i = 0; i < 8; i += 1) {
      const r = R * (0.8 + (0.96 - 0.8) * (i / 7));
      g.moveTo(Math.sin(0) * r, -Math.cos(0) * r);
      g.arc(0, 0, r, 0, TAU);
    }
    for (let a = 0; a < 360; a += 8) {
      const rad = (a * Math.PI) / 180;
      g.moveTo(Math.sin(rad) * R * 0.8, -Math.cos(rad) * R * 0.8);
      g.lineTo(Math.sin(rad) * R * 0.96, -Math.cos(rad) * R * 0.96);
    }
    g.stroke();

    // 2) 24 条主排水渠刻槽（alpha .04，由内到外贯穿）
    g.strokeStyle = withAlpha(pal.line, 0.04);
    g.lineWidth = 1 / sharp;
    g.beginPath();
    for (let i = 0; i < PROC.drains; i += 1) {
      const a = (i / PROC.drains) * TAU;
      const x0 = Math.sin(a) * R * PROC.intakeR;
      const y0 = -Math.cos(a) * R * PROC.intakeR;
      const x1 = Math.sin(a) * R * PROC.entryIn;
      const y1 = -Math.cos(a) * R * PROC.entryIn;
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
    }
    g.stroke();

    // 3) 三条参考刻环（0.30/0.52/0.72R，alpha .05 + 每 15° 微刻）
    g.strokeStyle = withAlpha(pal.line, 0.05);
    g.beginPath();
    for (const ringR of PROC.refRings) {
      g.arc(0, 0, R * ringR, 0, TAU);
    }
    g.stroke();
    g.strokeStyle = withAlpha(pal.line, 0.07);
    g.beginPath();
    for (const ringR of PROC.refRings) {
      for (let a = 0; a < 360; a += 15) {
        const rad = (a * Math.PI) / 180;
        const r0 = R * ringR - 1.4;
        const r1 = R * ringR + 1.4;
        g.moveTo(Math.sin(rad) * r0, -Math.cos(rad) * r0);
        g.lineTo(Math.sin(rad) * r1, -Math.cos(rad) * r1);
      }
    }
    g.stroke();

    // 4) 进水口外缘 1.02R（雨幕下界）+ 0.96R 四角定位十字
    g.strokeStyle = withAlpha(pal.line, 0.06);
    g.beginPath();
    g.arc(0, 0, R * PROC.entryIn, 0, TAU);
    g.stroke();
    g.strokeStyle = withAlpha(pal.line, 0.22);
    for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
      const r = R * 0.96;
      const x = Math.sin(a) * r;
      const y = -Math.cos(a) * r;
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

  // ———————————————————————————————————————————— 绘制

  /** 盘面（世界层：在 camera.apply 内调用）。core → 瀑布 → 芯片 → 尾迹。 */
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

    // 静态层：一次 drawImage
    ctx.save();
    ctx.globalAlpha = k;
    ctx.drawImage(cache.canvas, -cache.world, -cache.world, cache.world * 2, cache.world * 2);
    ctx.restore();

    this.drawIntakeRain(ctx, env, k, pal);
    this.drawDrains(ctx, env, k, pal);
    this.drawStrands(ctx, env, k, pal);
    this.drawPackets(ctx, env, k, pal);
    this.drawCore(ctx, env, k, pal);
    this.drawTrails(ctx, env, k, pal);
    this.drawChips(ctx, env, k, pal);
  }

  /**
   * 瀑布的「水身」：每枚有分量的芯片一条极淡径向水线（α .05–.10），
   * 数据包在这条水线上向内奔流——静止时也能读出「73 股水汇入一个泄水口」。
   */
  private drawStrands(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const R = env.R;
    const intakeR = R * PROC.intakeR;
    const paths: Path2D[] = [new Path2D(), new Path2D(), new Path2D()];
    for (const chip of this.chips.values()) {
      if (chip.dying || chip.alpha <= 0.2) continue;
      if (chip.weight < 0.18) continue;
      const path = paths[chip.colorClass];
      if (!path) continue;
      const r0 = Math.max(intakeR + 2, chip.r - 6);
      if (r0 <= intakeR + 1) continue;
      path.moveTo(Math.sin(chip.phi) * r0, -Math.cos(chip.phi) * r0);
      path.lineTo(Math.sin(chip.phi) * intakeR, -Math.cos(chip.phi) * intakeR);
    }
    ctx.save();
    ctx.globalAlpha = clamp01(k * 0.26);
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    for (let cls = 0; cls < 3; cls += 1) {
      const path = paths[cls];
      if (!path) continue;
      ctx.strokeStyle = withAlpha(classColor(pal, cls), 1);
      ctx.stroke(path);
    }
    ctx.restore();
  }

  /** §25.3.2 入口雨幕：1.02R–1.10R 短划恒速向内，相位解析、循环无缝 */
  private drawIntakeRain(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const n = this.entryFlowNow;
    if (n <= 0) return;
    const R = env.R;
    const span = (PROC.entryOut - PROC.entryIn) * R;
    const t = env.now / 1000;
    const pathA = new Path2D();
    const pathB = new Path2D();
    for (let i = 0; i < n; i += 1) {
      const h = hash01(`proc-rain:${i}`);
      const drift = (t * PROC.entrySpeed * R + h * span) % span;
      const r = R * PROC.entryOut - drift;
      if (r < R * PROC.entryIn - 6) continue;
      const a = (i / n) * TAU + h * 0.12;
      const len = 6 + hash01(`proc-rainl:${i}`) * 8;
      const x0 = Math.sin(a) * (r + len / 2);
      const y0 = -Math.cos(a) * (r + len / 2);
      const x1 = Math.sin(a) * (r - len / 2);
      const y1 = -Math.cos(a) * (r - len / 2);
      const path = len > 10 ? pathA : pathB;
      path.moveTo(x0, y0);
      path.lineTo(x1, y1);
    }
    ctx.save();
    ctx.strokeStyle = withAlpha(pal.line, 0.2);
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    ctx.globalAlpha = k;
    ctx.stroke(pathA);
    ctx.globalAlpha = k * 0.72;
    ctx.stroke(pathB);
    ctx.restore();
  }

  /** §25.3.3 主排水渠里的大水滴（8–18px，0.4R/s 向内），全部解析计算 */
  private drawDrains(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    if (env.quality < 0.7) return;
    const R = env.R;
    const cycle = (PROC.entryIn - PROC.intakeR) * R;
    const t = env.now / 1000;
    const fast = new Path2D();
    const slow = new Path2D();
    for (let i = 0; i < PROC.drains; i += 1) {
      const a = (i / PROC.drains) * TAU;
      for (let j = 0; j < PROC.dropsPerDrain; j += 1) {
        const h = hash01(`proc-drop:${i}:${j}`);
        const pos = (t * PROC.dropSpeed * R + h * cycle) % cycle;
        const r = R * PROC.entryIn - pos;
        if (r < R * PROC.intakeR + 2) continue;
        const len = 8 + hash01(`proc-dropl:${i}:${j}`) * 10;
        const x0 = Math.sin(a) * (r + len / 2);
        const y0 = -Math.cos(a) * (r + len / 2);
        const x1 = Math.sin(a) * (r - len / 2);
        const y1 = -Math.cos(a) * (r - len / 2);
        const path = h > 0.5 ? fast : slow;
        path.moveTo(x0, y0);
        path.lineTo(x1, y1);
      }
    }
    ctx.save();
    ctx.strokeStyle = withAlpha(pal.mem, 0.2);
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'butt';
    ctx.globalAlpha = k;
    ctx.stroke(fast);
    ctx.globalAlpha = k * 0.6;
    ctx.stroke(slow);
    ctx.restore();
  }

  /** §25.3.1 内向数据包：按颜色 × alpha 带 × 宽度带批量 Path2D 描边 */
  private drawPackets(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const R = env.R;
    const intakeR = R * PROC.intakeR;
    const paths: Path2D[] = new Array(18);
    for (let i = 0; i < 18; i += 1) paths[i] = new Path2D();
    const counts = new Uint16Array(18);
    let alive = 0;
    for (const pk of this.packetPool) {
      if (!pk.active) continue;
      alive += 1;
      const span = Math.max(1, pk.spawnR - intakeR);
      const progress = clamp01((pk.spawnR - pk.r) / span);
      const band = progress < 0.34 ? 0 : progress < 0.67 ? 1 : 2;
      const wBand = pk.width < 1.5 ? 0 : 1;
      const idx = pk.cls * 6 + band * 2 + wBand;
      const path = paths[idx];
      if (!path) continue;
      const x0 = Math.sin(pk.phi) * (pk.r + pk.len / 2);
      const y0 = -Math.cos(pk.phi) * (pk.r + pk.len / 2);
      const x1 = Math.sin(pk.phi) * (pk.r - pk.len / 2);
      const y1 = -Math.cos(pk.phi) * (pk.r - pk.len / 2);
      path.moveTo(x0, y0);
      path.lineTo(x1, y1);
      counts[idx] += 1;
    }
    ctx.save();
    ctx.lineCap = 'butt';
    for (let idx = 0; idx < 18; idx += 1) {
      if (counts[idx] === 0) continue;
      const cls = Math.floor(idx / 6);
      const band = Math.floor((idx % 6) / 2);
      const wBand = idx % 2;
      const alphaMid = 0.55 - 0.37 * ((band + 0.5) / 3);
      ctx.globalAlpha = clamp01(k * alphaMid);
      ctx.strokeStyle = withAlpha(classColor(pal, cls), 1);
      ctx.lineWidth = wBand === 0 ? 1 : 1.7;
      const path = paths[idx];
      if (path) ctx.stroke(path);
    }
    ctx.restore();
    void alive;
  }

  /** §25.4 机械核心（泄水口 / 涡轮）：intake 环 24 齿、rotor 八边形、aperture 暗环 */
  private drawCore(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const R = env.R;
    const tickIdx = Math.floor(Date.now() / PROC.tickMs);
    const intakeR = R * PROC.intakeR;
    const rotorR = R * PROC.rotorR;
    const intakeRot = ((tickIdx % 120) * 3 * Math.PI) / 180;
    const rotorRot = ((tickIdx % 60) * 6 * Math.PI) / 180;
    const pulse = this.pulse;
    ctx.save();
    ctx.globalAlpha = k;
    // intake 环：24 齿（每 tick 转 3°）+ 吞吐亮度脉动
    ctx.strokeStyle = withAlpha(pal.line, 0.32 + 0.5 * pulse);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, intakeR, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 24; i += 1) {
      const a = intakeRot + (i / 24) * TAU;
      const r0 = intakeR - R * 0.007;
      const r1 = intakeR + R * 0.007;
      ctx.moveTo(Math.sin(a) * r0, -Math.cos(a) * r0);
      ctx.lineTo(Math.sin(a) * r1, -Math.cos(a) * r1);
    }
    ctx.stroke();
    // rotor 八边形（每 tick 6°）
    ctx.save();
    ctx.rotate(rotorRot);
    ctx.strokeStyle = withAlpha(pal.accent, 0.82);
    ctx.beginPath();
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * TAU;
      const x = Math.sin(a) * rotorR;
      const y = -Math.cos(a) * rotorR;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = withAlpha(pal.line, 0.5);
    ctx.beginPath();
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * TAU;
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.sin(a) * rotorR * 0.92, -Math.cos(a) * rotorR * 0.92);
    }
    ctx.stroke();
    ctx.restore();
    // aperture 暗环：CPU 总量映射半径 0.040–0.052R，外缘 1px 冷白
    const usage = this.snapshot ? clamp01(this.snapshot.cpu.usage / 100) : 0;
    const apR = R * (PROC.apertureMin + (PROC.apertureMax - PROC.apertureMin) * usage);
    ctx.fillStyle = withAlpha(COLORS.inkVoid, 0.92);
    ctx.beginPath();
    ctx.arc(0, 0, apR, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = withAlpha(pal.fill, 0.8);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, apR, 0, TAU);
    ctx.stroke();
    // 中心小十字（无辉光）
    const s = Math.max(1.4, R * 0.008);
    ctx.fillStyle = withAlpha(pal.fill, 0.85);
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.restore();
  }

  /** §25.3.4 芯片尾迹：身后 6° 渐隐弧（alpha .10 → 0），保证「有轨迹」而不闪烁 */
  private drawTrails(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const segs = PROC.trailSegs;
    const paths: Path2D[] = new Array(18);
    for (let i = 0; i < 18; i += 1) paths[i] = new Path2D();
    const counts = new Uint16Array(18);
    for (const chip of this.chips.values()) {
      if (chip.dying || chip.alpha <= 0.2) continue;
      for (let s = 0; s < segs; s += 1) {
        const a1 = chip.phi - (PROC.trailRad * s) / segs;
        const a0 = chip.phi - (PROC.trailRad * (s + 1)) / segs;
        const path = paths[chip.colorClass * 6 + s];
        if (!path) continue;
        const r = Math.max(0.5, chip.r);
        path.moveTo(Math.sin(a0) * r, -Math.cos(a0) * r);
        path.arc(0, 0, r, a0 - Math.PI / 2, a1 - Math.PI / 2);
        counts[chip.colorClass * 6 + s] += 1;
      }
    }
    ctx.save();
    ctx.lineCap = 'butt';
    for (let idx = 0; idx < 18; idx += 1) {
      if (counts[idx] === 0) continue;
      const cls = Math.floor(idx / 6);
      const s = idx % 6;
      const path = paths[idx];
      if (!path) continue;
      ctx.globalAlpha = clamp01(k * 0.1 * (1 - s / segs));
      ctx.strokeStyle = withAlpha(classColor(pal, cls), 1);
      ctx.lineWidth = 1;
      ctx.stroke(path);
    }
    ctx.restore();
  }

  /** 芯片：切向矩形（宽 = 数据量，高 = 5/7px），CPU 占比实心填充；选中：2px 外描边 + 环 */
  private drawChips(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const zoom = Math.max(0.3, env.zoom);
    const attn = zoom <= 1.6 ? 1 : Math.pow(zoom / 1.6, -0.45);
    const h = (env.mobile ? 7 : 5) * attn;
    for (const chip of this.chips.values()) {
      if (chip.alpha <= 0.01) continue;
      const x = Math.sin(chip.phi) * chip.r;
      const y = -Math.cos(chip.phi) * chip.r;
      const w = chip.width * attn;
      const cpuK = clamp01(chip.cpu / 100);
      ctx.save();
      ctx.globalAlpha = clamp01(k) * chip.alpha;
      ctx.translate(x, y);
      ctx.rotate(chip.phi);
      ctx.fillStyle = withAlpha(pal.base, 0.62);
      ctx.fillRect(-w / 2, -h / 2, w, h);
      if (cpuK > 0.01) {
        ctx.fillStyle = withAlpha(pal.fill, 0.94);
        ctx.fillRect(-w / 2, -h / 2, w * cpuK, h);
      }
      const hot = chip.cpu >= 25;
      ctx.strokeStyle = hot ? withAlpha(pal.fill, 1) : withAlpha(pal.line, 0.55);
      ctx.lineWidth = 1;
      ctx.strokeRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1);
      if (chip.mem > 1024 * 1024 * 1024) {
        ctx.strokeStyle = withAlpha(pal.accent, 0.5);
        ctx.beginPath();
        ctx.moveTo(-w / 2 + 1, h / 2 - 1);
        ctx.lineTo(w / 2 - 1, h / 2 - 1);
        ctx.stroke();
      }
      // 线程密度刻点
      if (chip.threads > 0) {
        const n = Math.min(6, Math.max(1, Math.round(Math.log2(chip.threads + 1))));
        ctx.fillStyle = withAlpha(pal.line, 0.75);
        for (let i = 0; i < n; i += 1) {
          const px = -w / 2 + ((i + 0.5) / n) * w;
          ctx.fillRect(px - 0.5, h / 2 + 1.4, 1, 1.6);
        }
      }
      ctx.restore();
    }
    // 选中：外描边 2px + 选中环 + 四角刻（无辉光）
    const sel = this.selectedPid !== null ? this.chips.get(this.selectedPid) : null;
    if (sel && sel.alpha > 0.05) {
      const x = Math.sin(sel.phi) * sel.r;
      const y = -Math.cos(sel.phi) * sel.r;
      const w = sel.width * attn;
      ctx.save();
      ctx.globalAlpha = clamp01(k) * sel.alpha;
      ctx.translate(x, y);
      ctx.rotate(sel.phi);
      ctx.strokeStyle = withAlpha(pal.fill, 0.95);
      ctx.lineWidth = 2;
      ctx.strokeRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4);
      const ringR = Math.hypot(w / 2, h / 2) + 5;
      ctx.globalAlpha = clamp01(k) * sel.alpha * 0.55;
      ctx.strokeStyle = withAlpha(pal.fill, 0.85);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = clamp01(k) * sel.alpha;
      ctx.lineWidth = 1.2;
      const cx = w / 2 + 5;
      const cy = h / 2 + 5;
      const t = 3;
      ctx.beginPath();
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          ctx.moveTo(sx * cx - sx * t, sy * cy);
          ctx.lineTo(sx * cx, sy * cy);
          ctx.lineTo(sx * cx, sy * cy - sy * t);
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }

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
    const clsName = chip.colorClass === 0 ? 'CPU' : chip.colorClass === 1 ? '内存' : '沉积';
    const label = `${chip.name} · ${clsName} · PID ${chip.pid}`;
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
    const attn = zoom <= 1.6 ? 1 : Math.pow(zoom / 1.6, -0.45);
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
