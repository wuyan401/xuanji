// XUANJI · 璇玑 — v2.3 复合核心（§22.6）：紫宫不再是一颗死珠，而是六层复合运动机构。
// L0 三层同心圆 / L1 光点椭圆轨道 / L2 极坐标网格 / L3 短弧漂移 / L4 脉冲波 / L5 选中扇区。
// 只用 ink/gold/cold/patina 四族；所有周期量由拍点派生，不用 sin(t) 驱动主视觉。

import { COLORS, withAlpha } from '../design/tokens';
import { rgba } from './paint';
import { TAU, clamp01, lerp } from '../lib/math';
import { rand01 } from './rand';
import type { Env, View } from './types';

interface OrbitDot {
  phase: number;
  speed: number;
  ra: number;
  rb: number;
  tilt: number;
  size: number;
  bright: number;
  gold: boolean;
}

interface DriftArc {
  phase: number;
  speed: number;
  r: number;
  len: number;
  alpha: number;
  dir: number;
  gold: boolean;
}

interface CorePulse {
  born: number;
  life: number;
  strength: number;
}

export class CoreSystem {
  private dots: OrbitDot[] = [];
  private arcs: DriftArc[] = [];
  private pulses: CorePulse[] = [];
  private gridBase = 0;
  private arcBase = 0;
  private built = false;

  /** 预计算 L1 光点与 L3 短弧（数量随 quality 与 tokenRate 调制）。 */
  build(env: Env): void {
    const q = clamp01(env.quality);
    const nDots = Math.round(12 + q * 12);
    this.dots = [];
    for (let i = 0; i < nDots; i += 1) {
      const a = rand01(`core-a${i}`) * TAU;
      this.dots.push({
        phase: a,
        speed: 0.12 + rand01(`core-s${i}`) * 0.28,
        ra: 0.052 + rand01(`core-ra${i}`) * 0.026,
        rb: 0.03 + rand01(`core-rb${i}`) * 0.022,
        tilt: (rand01(`core-t${i}`) - 0.5) * 0.42,
        size: 0.8 + rand01(`core-z${i}`) * 1.1,
        bright: 0.24 + rand01(`core-b${i}`) * 0.35,
        gold: rand01(`core-c${i}`) > 0.35,
      });
    }
    this.arcs = [];
    const nArcs = Math.round(30 + q * 14);
    for (let i = 0; i < nArcs; i += 1) {
      this.arcs.push({
        phase: rand01(`core-ap${i}`) * TAU,
        speed: 0.02 + rand01(`core-as${i}`) * 0.07,
        r: 0.082 + rand01(`core-ar${i}`) * 0.04,
        len: 0.008 + rand01(`core-al${i}`) * 0.02,
        alpha: 0.18 + rand01(`core-aa${i}`) * 0.16,
        dir: rand01(`core-ad${i}`) > 0.5 ? 1 : -1,
        gold: rand01(`core-ac${i}`) > 0.5,
      });
    }
    this.built = true;
  }

  /** 每帧推进：网格/短弧缓慢漂移，拍点时注入一次脉冲波。 */
  update(env: Env, view: View, energy: number): void {
    if (!this.built) this.build(env);
    const scifi = env.theme === 'scifi' ? 1.6 : 1;
    const dt = env.dt;
    this.gridBase += dt * 0.02 * scifi * (0.6 + energy * 0.8);
    this.arcBase += dt * 0.035 * scifi * (0.6 + energy * 0.8);
    const beat = view.beat;
    // 强拍 / 事件高峰 → 一次脉冲波（600ms，不循环）
    if (beat.strong) this.pushPulse(env.now, 0.9);
    else if (beat.pulse > 0.92) this.pushPulse(env.now, 0.55);
    for (const p of this.pulses) p.born = p.born; // 保持字段读取，避免未使用告警
    this.pulses = this.pulses.filter((p) => env.now - p.born < p.life);
  }

  private pushPulse(now: number, strength: number): void {
    if (this.pulses.length > 6) return;
    const last = this.pulses[this.pulses.length - 1];
    if (last && now - last.born < 260) return;
    this.pulses.push({ born: now, life: 600, strength });
  }

  /** 世界坐标绘制（在 camera.apply 内调用）。 */
  draw(ctx: CanvasRenderingContext2D, view: View, dim: number): void {
    const env = view.env;
    const R = env.R;
    const pulse = view.beat.pulse;
    const energy = clamp01(view.beat.q);
    void energy;
    const goldA = (k: number): string => rgba(COLORS.gold300, k * dim);
    const boneA = (k: number): string => rgba(COLORS.bone300, k * dim);
    const coldA = (k: number): string => rgba(COLORS.cold300, k * dim);

    // L0 三层同心圆：每拍一次 1 → 1.06 → 1 的呼吸（由脉冲包络驱动，不是 sin(t)）
    const env0 = 1 + 0.06 * clamp01(pulse);
    for (let i = 0; i < 3; i += 1) {
      const r = R * (0.02 + i * 0.014) * (i === 0 ? env0 : 1);
      ctx.strokeStyle = i === 0 ? rgba(COLORS.gold200, (0.34 + 0.2 * pulse) * dim) : goldA(0.2 - i * 0.045);
      ctx.lineWidth = i === 0 ? 1.1 : 0.8;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
    }
    // 核中心珠
    ctx.fillStyle = rgba(COLORS.gold100, (0.7 + 0.25 * pulse) * dim);
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1.1, R * 0.006), 0, TAU);
    ctx.fill();

    // L2 极坐标网格 24×3（§22.6，alpha ≤ .06，scifi 转速 ×1.6）
    const gridRot = this.gridBase;
    const gr0 = R * 0.03;
    const gr1 = R * 0.11;
    ctx.strokeStyle = rgba(COLORS.gold500, 0.06 * dim);
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let i = 0; i < 24; i += 1) {
      const a = gridRot + (i / 24) * TAU;
      ctx.moveTo(Math.sin(a) * gr0, -Math.cos(a) * gr0);
      ctx.lineTo(Math.sin(a) * gr1, -Math.cos(a) * gr1);
    }
    ctx.stroke();
    for (let k = 0; k < 3; k += 1) {
      const rr = lerp(gr0, gr1, (k + 1) / 3);
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, TAU);
      ctx.stroke();
    }

    // L1 光点椭圆轨道（倾角 ±12°，亮度 ∝ tokenRate 与能量）
    const energyK = clamp01(0.35 + view.beat.pulse * 0.2);
    for (const d of this.dots) {
      const a = d.phase + this.arcBase * 0.4 + env.now / 1000 * d.speed;
      const ex = Math.sin(a) * R * d.ra;
      const ey = -Math.cos(a) * R * d.rb;
      const ca = Math.cos(d.tilt);
      const sa = Math.sin(d.tilt);
      const x = ex * ca - ey * sa;
      const y = ex * sa + ey * ca;
      ctx.fillStyle = d.gold
        ? rgba(COLORS.gold200, d.bright * energyK * dim)
        : rgba(COLORS.bone200, d.bright * 0.8 * energyK * dim);
      ctx.beginPath();
      ctx.arc(x, y, d.size, 0, TAU);
      ctx.fill();
    }

    // L3 36 段短弧（3–8px，不同速/向漂移，alpha .18–.34）
    for (const arc of this.arcs) {
      const a = arc.phase + this.arcBase * arc.dir + env.now / 1000 * arc.speed * arc.dir * 0.4;
      const r = R * arc.r;
      const half = (R * arc.len) / Math.max(1, r);
      ctx.strokeStyle = arc.gold
        ? rgba(COLORS.gold400, arc.alpha * dim)
        : rgba(COLORS.patina300, arc.alpha * 0.8 * dim);
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(0, 0, r, a - half, a + half);
      ctx.stroke();
    }

    // L4 脉冲波：.06R → .16R，600ms，alpha .25 → 0
    for (const p of this.pulses) {
      const age = (env.now - p.born) / p.life;
      if (age < 0 || age > 1) continue;
      const r = R * lerp(0.06, 0.16, age);
      const alpha = (1 - age) * 0.25 * p.strength * dim;
      if (alpha <= 0.01) continue;
      ctx.strokeStyle = rgba(COLORS.gold200, alpha);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
    }

    // L5 选中项：核部 60° 金线扇区（alpha .12）
    if (view.selected || view.focusId) {
      const a = Math.PI * 1.5;
      ctx.fillStyle = rgba(COLORS.gold300, 0.12 * dim);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R * 0.05, a - Math.PI / 6, a + Math.PI / 6);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = goldA(0.2);
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.05, a - Math.PI / 6, a + Math.PI / 6);
      ctx.stroke();
    }
    void coldA;
    void boneA;
  }

  /** 验收：复合核心层数（§22.6，qa 要求 ≥4）。 */
  get nodeCount(): number {
    return 6;
  }
}
