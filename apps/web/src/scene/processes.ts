// XUANJI · 璇玑 — v2.5 §24 第三视图「百工 · 器群」：全进程机械化盘面。
//
// 设计对位（§24.1）：与「智能体（观星）」刻意对立——
//   观星：圆星 / 曲线 / 不均匀节拍 / 阻尼缓动 / 暖金 / 留痕 / 有生命
//   百工：矩形芯片 / 直线 / 严格 1Hz 步进 / 无缓动 / 钢灰冷白 / 无痕 / 庞大无情
//
// 反模式（禁止）：星形、分野弧、星过留痕、呼吸、随机抖动、暖金主色、辉光核心、
// 「数据雨」；禁止 shadowBlur（只允许 1px 硬边描边）。
//
// 性能（§24.7）：单帧 ≤6ms；芯片 ≤220、流线 ≤220；静态几何离屏缓存；
// quality<0.7 关沉积轨流线 + 网格减半；quality<0.85 关孔位亮灭。

import { Env } from './types';
import { COLORS, FONTS, withAlpha } from '../design/tokens';
import { TAU, clamp, clamp01, hash01, lerp } from '../lib/math';
import type { ProcInfo, SystemSnapshot } from '../state/types';

/** 只用到相机的一行能力（避免和 camera.ts 循环依赖） */
interface ScreenCam {
  worldToScreen(env: Env, x: number, y: number): { x: number; y: number };
}

// ———————————————————————————————————————————————— 常量（§24.2 / §24.3）

/** 机轴：0.10R 八边形轮毂 + 外缘 0.14R（流线终点） */
const PROC = {
  hub: 0.1,
  hubOuter: 0.14,
  /** 三档轨道 rail：CPU / 内存 / 沉积（§24.2） */
  rails: [0.26, 0.42, 0.58] as const,
  railNames: ['CPU 轨', '内存轨', '沉积轨'] as const,
  /** 数据总线环：内 0.66 / 外 0.78（§24.2） */
  busIn: 0.66,
  busOut: 0.78,
  busMid: 0.72,
  /** 工程网格星野：0.80–0.96（§24.2） */
  gridIn: 0.8,
  gridOut: 0.96,
  /** 总线孔位 72 个（5° 间隔） */
  holes: 72,
  /** 总线环恒定角速 rad/s（§24.4；QA 断言必须严格 0.05） */
  scrollRate: 0.05,
  /** 芯片上限（= 后端 PROCS_TOP，§24.3/§24.7） */
  maxChips: 220,
  /** 进出场 240ms 线性（禁止回弹/缓动，§24.3） */
  enterMs: 240,
  /** 机械节拍严格 1Hz（§24.4） */
  tickMs: 1000,
  /** 扫描线周期 4s（§24.4） */
  scanMs: 4000,
  /** marching 速度 40px/s（§24.5） */
  marchPxPerSec: 40,
} as const;

/** 主题配色（BIBLE §24.3）：璇玑 = 钢灰 + 冷白 + 骨白；深空 = 青蓝 + 荧光青绿 + 冷白。 */
interface ProcPalette {
  base: string;
  fill: string;
  accent: string;
  line: string;
  text: string;
}
const PALETTES: { xuanji: ProcPalette; scifi: ProcPalette } = {
  xuanji: { base: '#8b8c8f', fill: '#e7eef2', accent: '#d3cbb6', line: '#8b8c8f', text: '#e7eef2' },
  scifi: { base: '#5fd0ea', fill: '#f2f9ff', accent: '#7df0c4', line: '#5fd0ea', text: '#f2f9ff' },
};

function paletteOf(env: Env): ProcPalette {
  return env.theme === 'scifi' ? PALETTES.scifi : PALETTES.xuanji;
}

/** 进程芯片（数据 + 视觉量；无随机、无漂移，角度只随集合变化重排） */
interface ProcChip {
  pid: number;
  name: string;
  rail: number;
  /** 数据目标（2s 一帧，视觉量线性插值，§24.4） */
  cpu: number;
  cpuTarget: number;
  mem: number;
  memTarget: number;
  threads: number;
  /** 目标位（世界 px，y 向上为负） */
  tx: number;
  ty: number;
  /** 当前位（进入 240ms 从总线环外压入；之后线性追目标） */
  x: number;
  y: number;
  enter: number;
  exit: number;
  dying: boolean;
  width: number;
  angle: number;
}

/** 静态几何缓存（§24.7：网格/轨线/刻度/总线环离屏一次，逐帧一次 drawImage） */
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
}

export class ProcessesPlate {
  private cache: ProcCache | null = null;
  private chips: Map<number, ProcChip> = new Map();
  private snapshot: SystemSnapshot | null = null;
  private layoutKey = '';
  /** 数据帧里 procs 的真实条数（debug.chips 必须等于 min(220, procs.length)） */
  private rawCount = 0;
  private lastNow = 0;
  private flowDrawn = 0;
  private tickPhase = 0;
  private selectedPid: number | null = null;
  hoverPid: number | null = null;

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
    const procs = snapshot.procs.slice(0, PROC.maxChips);
    this.rawCount = Math.min(PROC.maxChips, Array.isArray(snapshot.procs) ? snapshot.procs.length : 0);
    this.syncChips(procs);
  }

  /** 遥测是否可用（不可用时不发 0 值假数据，整盘 0.35 + 中央提示，§24.7） */
  get available(): boolean {
    return !!this.snapshot && this.snapshot.available && this.rawCount > 0;
  }

  get stats(): ProcPlateStats {
    return {
      chips: this.available ? Math.min(PROC.maxChips, this.rawCount) : 0,
      rails: PROC.rails.length,
      flowLines: this.flowDrawn,
      tickPhase: this.tickPhase,
      scrollRate: PROC.scrollRate,
      selectedPid: this.selectedPid,
    };
  }

  // ———————————————————————————————————————————— 布局（确定性）

  /** 分轨：cpu≥1 → CPU 轨；否则 mem>500MB → 内存轨；否则沉积轨（§24.3） */
  private railOf(cpu: number, mem: number): number {
    if (cpu >= 1) return 0;
    if (mem > 500 * 1024 * 1024) return 1;
    return 2;
  }

  /**
   * 集合变化时整体重排（重排只发生在集合变化时，§24.3）：
   * 轨道内按 CPU 降序顺时针排列，角度以 hash(pid) 做轻微稳定偏移（不做每帧漂移）。
   */
  private syncChips(procs: ProcInfo[]): void {
    const key = procs.map((p) => p.pid).join(',');
    if (key === this.layoutKey) {
      // 集合未变：只更新数据目标（视觉量在 update 里线性追，§24.4）
      for (const p of procs) {
        const chip = this.chips.get(p.pid);
        if (!chip) continue;
        chip.cpuTarget = p.cpuPct;
        chip.memTarget = p.memBytes;
        chip.threads = p.threads ?? 0;
        chip.name = p.name;
      }
      return;
    }
    this.layoutKey = key;

    const byRail: ProcInfo[][] = [[], [], []];
    for (const p of procs) {
      const list = byRail[this.railOf(p.cpuPct, p.memBytes)];
      if (list) list.push(p);
    }

    for (const chip of this.chips.values()) chip.dying = true;

    for (let rail = 0; rail < byRail.length; rail += 1) {
      const list = (byRail[rail] ?? []).slice().sort((a, b) => b.cpuPct - a.cpuPct || a.pid - b.pid);
      const n = list.length;
      for (let i = 0; i < n; i += 1) {
        const p = list[i];
        if (!p) continue;
        const slot = (i + 0.5) / n;
        // 拓扑角：从正上方开始顺时针排（-90° 起）；hash 只做稳定微偏移
        const jitter = (hash01(`proc:${p.pid}`) - 0.5) * (TAU / n) * 0.24;
        const angle = -Math.PI / 2 + slot * TAU + jitter;
        const chip = this.chips.get(p.pid);
        if (chip) {
          chip.dying = false;
          chip.rail = rail;
          chip.angle = angle;
          chip.cpuTarget = p.cpuPct;
          chip.memTarget = p.memBytes;
          chip.threads = p.threads ?? 0;
          chip.name = p.name;
        } else {
          this.chips.set(p.pid, {
            pid: p.pid,
            name: p.name,
            rail,
            cpu: p.cpuPct,
            cpuTarget: p.cpuPct,
            mem: p.memBytes,
            memTarget: p.memBytes,
            threads: p.threads ?? 0,
            tx: 0,
            ty: 0,
            x: 0,
            y: 0,
            enter: 0,
            exit: 0,
            dying: false,
            width: 7,
            angle,
          });
        }
      }
    }
    for (const chip of this.chips.values()) if (chip.dying && chip.exit === 0) chip.exit = 1e-4;
    if (this.selectedPid !== null && !this.chips.has(this.selectedPid)) this.selectedPid = null;
  }

  private railCount(rail: number): number {
    let n = 0;
    for (const chip of this.chips.values()) if (chip.rail === rail) n += 1;
    return n;
  }

  /** 轨内芯片宽度系数：单轨超过 36 枚时收窄，避免齿轮状芯片互相粘连（仍保留 CPU 宽度层级）。 */
  private widthK(rail: number): number {
    const n = this.railCount(rail);
    return n > 36 ? clamp(36 / n, 0.45, 1) : 1;
  }

  // ———————————————————————————————————————————— 机械步进 / 每帧

  /**
   * 每帧推进（无缓动、无回弹）：数据 2s 一帧 → 视觉量线性插值（§24.4），
   * 芯片进入 240ms 从总线环外「压入」轨位（线性），退出 240ms 线性淡出。
   */
  update(env: Env): void {
    const now = Date.now();
    const last = this.lastNow || now;
    this.lastNow = now;
    const dt = clamp((now - last) / 1000, 0.0005, 0.25);
    /** 机械节拍：严格 1Hz，无抖动、无随机（§24.4） */
    this.tickPhase = (now % PROC.tickMs) / PROC.tickMs;

    const R = env.R;
    const k = clamp01(dt / 0.2);
    const step = dt / (PROC.enterMs / 1000);
    const pursue = clamp01(1 - Math.exp(-k * 1.6));

    for (const [pid, chip] of this.chips) {
      if (chip.dying) {
        chip.exit = Math.min(1, chip.exit + step);
        if (chip.exit >= 1) {
          this.chips.delete(pid);
          continue;
        }
      } else if (chip.exit > 0) {
        chip.exit = Math.max(0, chip.exit - step);
      }
      chip.cpu = lerp(chip.cpu, chip.cpuTarget, k);
      chip.mem = lerp(chip.mem, chip.memTarget, k);
      chip.enter = chip.dying ? chip.enter : Math.min(1, chip.enter + step);
      // 目标位：拓扑角 × 轨道半径；溢出（>72 枚/轨）时半径交错 ±2% 减少重叠
      const slotCount = this.railCount(chip.rail);
      const stagger = slotCount > 72 ? (hash01(`stagger:${chip.pid}`) * 2 - 1) * 0.02 : 0;
      const radius = R * ((PROC.rails[chip.rail] ?? 0.58) + stagger);
      chip.tx = Math.sin(chip.angle) * radius;
      chip.ty = -Math.cos(chip.angle) * radius;
      // 进入：从总线环外沿同角度压入（§24.3）；之后线性追目标位
      if (chip.enter < 1) {
        const busR = R * PROC.busOut;
        const sx = Math.sin(chip.angle) * busR;
        const sy = -Math.cos(chip.angle) * busR;
        chip.x = lerp(sx, chip.tx, chip.enter);
        chip.y = lerp(sy, chip.ty, chip.enter);
      } else {
        chip.x = lerp(chip.x, chip.tx, pursue);
        chip.y = lerp(chip.y, chip.ty, pursue);
      }
      chip.width = clamp(7 + Math.log2(chip.cpu + 1) * 3, 7, 26) * this.widthK(chip.rail);
    }
  }

  // ———————————————————————————————————————————— 静态缓存（网格/轨线/刻度/总线环）

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
    const lineA = 0.24;

    // 1) 工程网格星野 0.80–0.96R：8° 径向线 + 8 等距环线，极淡（§24.2）
    const gridA = 0.075 * (env.quality < 0.7 ? 0.6 : 1);
    g.strokeStyle = withAlpha(pal.line, gridA);
    g.lineWidth = 1 / sharp;
    g.beginPath();
    for (let i = 0; i < 8; i += 1) {
      const r = R * (PROC.gridIn + ((PROC.gridOut - PROC.gridIn) * i) / 7);
      g.moveTo(Math.sin(0) * r, -Math.cos(0) * r);
      g.arc(0, 0, r, 0, TAU);
    }
    for (let a = 0; a < 360; a += 8) {
      const rad = (a * Math.PI) / 180;
      g.moveTo(Math.sin(rad) * R * PROC.gridIn, -Math.cos(rad) * R * PROC.gridIn);
      g.lineTo(Math.sin(rad) * R * PROC.gridOut, -Math.cos(rad) * R * PROC.gridOut);
    }
    g.stroke();

    // 2) 最外 0.96R 四角定位十字（§24.2）
    g.strokeStyle = withAlpha(pal.line, 0.3);
    for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
      const r = R * PROC.gridOut;
      const x = Math.sin(a) * r;
      const y = -Math.cos(a) * r;
      const dx = Math.sin(a) * 5;
      const dy = -Math.cos(a) * 5;
      g.beginPath();
      g.moveTo(x - dx, y - dy);
      g.lineTo(x + dx, y + dy);
      g.stroke();
    }

    // 3) 三档轨道 rail：1px，每 15° 一道 3px 刻段（§24.2）
    g.strokeStyle = withAlpha(pal.line, lineA);
    g.lineWidth = 1 / sharp;
    for (const railR of PROC.rails) {
      g.beginPath();
      g.arc(0, 0, R * railR, 0, TAU);
      g.stroke();
      g.beginPath();
      for (let a = 0; a < 360; a += 15) {
        const rad = (a * Math.PI) / 180;
        const r0 = R * railR - 1.5;
        const r1 = R * railR + 1.5;
        g.moveTo(Math.sin(rad) * r0, -Math.cos(rad) * r0);
        g.lineTo(Math.sin(rad) * r1, -Math.cos(rad) * r1);
      }
      g.stroke();
    }

    // 4) 数据总线环 0.66–0.78R 双层 + 外缘等距 1px 刻度（§24.2）
    g.strokeStyle = withAlpha(pal.line, lineA);
    g.beginPath();
    g.arc(0, 0, R * PROC.busIn, 0, TAU);
    g.stroke();
    g.beginPath();
    g.arc(0, 0, R * PROC.busOut, 0, TAU);
    g.stroke();
    g.beginPath();
    for (let a = 0; a < 360; a += 5) {
      const rad = (a * Math.PI) / 180;
      const r0 = R * PROC.busOut;
      const r1 = R * PROC.busOut + 3;
      g.moveTo(Math.sin(rad) * r0, -Math.cos(rad) * r0);
      g.lineTo(Math.sin(rad) * r1, -Math.cos(rad) * r1);
    }
    g.stroke();
    g.restore();

    this.cache = { canvas, size, world, sharp, key };
  }

  // ———————————————————————————————————————————— 绘制

  /** 盘面（世界层：在 camera.apply 内调用）。alpha/reveal 与其它盘面一致。 */
  draw(ctx: CanvasRenderingContext2D, env: Env, alpha: number, reveal: number): void {
    const pal = paletteOf(env);
    const k = clamp01(alpha) * clamp01(reveal);
    if (k <= 0.01) return;
    const cache = this.cache;
    if (!cache) return;

    if (!this.available) {
      // 无遥测：整盘 0.35（§24.7），不画假芯片
      ctx.save();
      ctx.globalAlpha = 0.35 * k;
      ctx.drawImage(cache.canvas, -cache.world, -cache.world, cache.world * 2, cache.world * 2);
      ctx.restore();
      this.flowDrawn = 0;
      return;
    }

    const now = env.now;
    const R = env.R;
    const tickIdx = Math.floor(Date.now() / PROC.tickMs);

    // 静态层：一次 drawImage（§24.2 / §24.7）
    ctx.save();
    ctx.globalAlpha = k;
    ctx.drawImage(cache.canvas, -cache.world, -cache.world, cache.world * 2, cache.world * 2);
    ctx.restore();

    // 机轴：0.10R 八边形轮毂 + 8 辐条；每 tick 瞬转 6°（步进，不是连续旋转，§24.4）
    const hubRot = ((tickIdx % 60) * 6 * Math.PI) / 180;
    const hubR = R * PROC.hub;
    const hubOuter = R * PROC.hubOuter;
    ctx.save();
    ctx.globalAlpha = k;
    ctx.strokeStyle = withAlpha(pal.line, 0.42);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, hubOuter, 0, TAU);
    ctx.stroke();
    ctx.rotate(hubRot);
    ctx.strokeStyle = withAlpha(pal.accent, 0.88);
    ctx.beginPath();
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * TAU;
      const x = Math.sin(a) * hubR;
      const y = -Math.cos(a) * hubR;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = withAlpha(pal.line, 0.55);
    ctx.beginPath();
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * TAU;
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.sin(a) * hubR * 0.92, -Math.cos(a) * hubR * 0.92);
    }
    ctx.stroke();
    ctx.restore();

    // 数据总线环：连续恒定 0.05 rad/s；72 孔位每 tick 依次点亮 1 个（§24.2 / §24.4）
    const busRot = (now / 1000) * PROC.scrollRate;
    const holeAlphaOn = env.reducedMotion || env.quality < 0.85 ? 0 : 1;
    const holeIdx = tickIdx % PROC.holes;
    const age = this.tickPhase * PROC.tickMs;
    const holeGlow = age < 60 ? age / 60 : clamp01(1 - (age - 60) / 400);
    ctx.save();
    ctx.globalAlpha = k;
    for (let i = 0; i < PROC.holes; i += 1) {
      const a = busRot + (i / PROC.holes) * TAU;
      const r = R * PROC.busMid;
      const x = Math.sin(a) * r;
      const y = -Math.cos(a) * r;
      const lit = holeAlphaOn > 0 && i === holeIdx ? holeGlow : 0;
      ctx.fillStyle = lit > 0 ? withAlpha(pal.fill, 0.2 + 0.8 * lit) : withAlpha(pal.line, 0.22);
      ctx.beginPath();
      ctx.arc(x, y, lit > 0 ? 2.0 : 1.15, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // 数据总线（§24.5）：每枚芯片一条径向直线到机轴外缘 0.14R；1px 虚线 marching
    this.drawFlows(ctx, env, k, pal);

    // 芯片（矩形、1px 硬边、填充 = CPU 占比，§24.3）
    this.drawChips(ctx, env, k, pal);

    // 机轴中心：一枚冷白小方块（无辉光）
    ctx.save();
    ctx.globalAlpha = k;
    ctx.fillStyle = withAlpha(pal.fill, 0.85);
    const s = Math.max(1.4, R * 0.008);
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.restore();
  }

  /** §24.5 数据总线：批量 Path2D 分桶描边（沉积轨不 marching、静止虚线 alpha .07） */
  private drawFlows(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const R = env.R;
    const hubR = R * PROC.hubOuter;
    const march = (Date.now() / 1000) * PROC.marchPxPerSec;
    const sedimentOn = !(env.quality < 0.7);
    let count = 0;

    for (let rail = 0; rail < 3; rail += 1) {
      if (rail === 2 && !sedimentOn) continue;
      for (let bucket = 0; bucket < 4; bucket += 1) {
        // 4 组 dash 相位：让每条径向流的虚线错开，读成「径向数据流」而不是同心点环
        for (let phase = 0; phase < 4; phase += 1) {
          const path = new Path2D();
          let has = false;
          for (const chip of this.chips.values()) {
            if (chip.rail !== rail || chip.dying) continue;
            const b = chip.cpu >= 25 ? 3 : chip.cpu >= 10 ? 2 : chip.cpu >= 3 ? 1 : 0;
            if (b !== bucket) continue;
            if (chip.pid % 4 !== phase) continue;
            const len = Math.hypot(chip.x, chip.y);
            if (len <= hubR + 1) continue;
            const nx = chip.x / len;
            const ny = chip.y / len;
            path.moveTo(nx * len, ny * len);
            path.lineTo(nx * hubR, ny * hubR);
            has = true;
            count += 1;
          }
          if (!has) continue;
          const cpuMid = bucket === 3 ? 30 : bucket === 2 ? 16 : bucket === 1 ? 6 : 1;
          const width = clamp(0.7 + (cpuMid / 25) * 1.9, 0.7, 2.5);
          // 沉积轨（rail 2）也要读成「数据流」：更慢的 marching（6px/s）+ 更密的虚线，形成庞大的径向线束。
          const alpha = rail === 2 ? 0.26 : 0.34 + (0.45 * cpuMid) / 40;
          const slowMarch = (Date.now() / 1000) * 6;
          ctx.save();
          ctx.globalAlpha = clamp01(k) * clamp01(alpha);
          ctx.strokeStyle = withAlpha(pal.line, 1);
          ctx.lineWidth = rail === 2 ? 1.2 : width;
          ctx.setLineDash(rail === 2 ? [1.8, 2.4] : [2.4, 2.8]);
          ctx.lineDashOffset = rail === 2 ? -slowMarch - phase * 1.3 : -march + phase * 1.3;
          ctx.stroke(path);
          ctx.restore();
        }
      }
    }
    this.flowDrawn = Math.min(count, PROC.maxChips);
  }

  /** 芯片：矩形无圆角，底 = 钢灰 alpha .55，填充 = CPU 占比（实心从左往右，不是透明度） */
  private drawChips(ctx: CanvasRenderingContext2D, env: Env, k: number, pal: ProcPalette): void {
    const zoom = Math.max(0.3, env.zoom);
    // 深看时芯片随仪器放大，但按 zoom^-0.45 收敛，避免 4× 时糊满屏幕
    const attn = zoom <= 1.6 ? 1 : Math.pow(zoom / 1.6, -0.45);
    const h = (env.mobile ? 7 : 5) * attn;
    for (const chip of this.chips.values()) {
      const a = 1 - chip.exit;
      const e = clamp01(chip.enter);
      const alpha = clamp01(k) * a * (0.35 + 0.65 * e) * (chip.rail === 2 ? 0.62 : 1);
      if (alpha <= 0.01) continue;
      const w = chip.width * attn;
      const cpuK = clamp01(chip.cpu / 100);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(chip.x, chip.y);
      ctx.rotate(chip.angle + Math.PI / 2);
      ctx.fillStyle = withAlpha(pal.base, 0.68);
      ctx.fillRect(-w / 2, -h / 2, w, h);
      if (cpuK > 0.01) {
        ctx.fillStyle = withAlpha(pal.fill, 0.96);
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
      // 线程密度：芯片下缘的小刻点（threads 越多刻点越多），让 5400+ 线程读成仪器刻度而不是无意义的数。
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
    // 选中：外描边 2px + 选中环 + 冷白四角刻（无辉光，§24.7）
    const sel = this.selectedPid !== null ? this.chips.get(this.selectedPid) : null;
    if (sel) {
      const w = sel.width * attn + 6;
      const hh = h + 6;
      ctx.save();
      ctx.globalAlpha = clamp01(k);
      ctx.translate(sel.x, sel.y);
      ctx.rotate(sel.angle + Math.PI / 2);
      // 外描边 2px：贴着芯片外缘一圈
      ctx.strokeStyle = withAlpha(pal.fill, 0.95);
      ctx.lineWidth = 2;
      ctx.strokeRect(-sel.width * attn / 2 - 2, -h / 2 - 2, sel.width * attn + 4, h + 4);
      // 选中环：芯片外接圆，保持与芯片同轴
      const ringR = Math.hypot(sel.width * attn / 2, h / 2) + 5;
      ctx.globalAlpha = clamp01(k) * 0.55;
      ctx.strokeStyle = withAlpha(pal.fill, 0.85);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, TAU);
      ctx.stroke();
      // 四角刻
      ctx.globalAlpha = clamp01(k);
      ctx.lineWidth = 1.2;
      const cx = w / 2;
      const cy = hh / 2;
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

  /** §24.4 扫描线：每 4s 一条 1px 水平线自上而下匀速扫过（屏幕空间，只一条） */
  drawScan(ctx: CanvasRenderingContext2D, env: Env, alpha: number, reveal: number): void {
    const k = clamp01(alpha) * clamp01(reveal);
    if (k <= 0.01) return;
    const pal = paletteOf(env);
    if (!env.reducedMotion) {
      const p = (Date.now() % PROC.scanMs) / PROC.scanMs;
      const y = p * env.h;
      ctx.save();
      ctx.globalAlpha = 0.05 * k;
      ctx.strokeStyle = withAlpha(pal.line, 1);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(env.w, y + 0.5);
      ctx.stroke();
      ctx.restore();
    }
    if (!this.available) {
      // 无遥测提示（§24.7：不发 0 值假数据）
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

  /** 世界内标注（屏幕空间）：hover / 选中进程一行等宽字（无花哨引线） */
  drawLabels(ctx: CanvasRenderingContext2D, env: Env, cam: ScreenCam): void {
    const pid = this.hoverPid ?? this.selectedPid;
    if (pid === null) return;
    const chip = this.chips.get(pid);
    if (!chip) return;
    const p = cam.worldToScreen(env, chip.x, chip.y);
    const pal = paletteOf(env);
    const label = `${chip.name} · ${PROC.railNames[chip.rail] ?? ''} · PID ${chip.pid}`;
    ctx.save();
    ctx.font = `500 10px ${FONTS.mono}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(label).width;
    const x = clamp(p.x + 10, 6, env.w - w - 8);
    const y = clamp(p.y - 10, 12, env.h - 10);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = withAlpha(COLORS.inkVoid, 0.72);
    ctx.fillRect(x - 4, y - 8, w + 8, 16);
    ctx.fillStyle = withAlpha(pal.text, 0.95);
    ctx.fillText(label, x, y);
    ctx.strokeStyle = withAlpha(pal.line, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x + 4, p.y - 4);
    ctx.lineTo(x - 4, y);
    ctx.stroke();
    ctx.restore();
  }

  /** 命中（芯片包围盒 + 8px 宽容；返回 pid） */
  pick(env: Env, cam: ScreenCam, sx: number, sy: number): number | null {
    let best: number | null = null;
    let bestD = Infinity;
    const zoom = Math.max(0.3, env.zoom);
    const attn = zoom <= 1.6 ? 1 : Math.pow(zoom / 1.6, -0.45);
    const pad = 8;
    for (const chip of this.chips.values()) {
      if (chip.dying || chip.enter < 0.4) continue;
      const p = cam.worldToScreen(env, chip.x, chip.y);
      const halfW = (chip.width * attn * zoom) / 2 + pad;
      const halfH = ((env.mobile ? 7 : 5) * attn * zoom) / 2 + pad;
      const dx = Math.abs(sx - p.x);
      const dy = Math.abs(sy - p.y);
      if (dx <= halfW && dy <= halfH) {
        const d = dx + dy;
        if (d < bestD) {
          bestD = d;
          best = chip.pid;
        }
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
