// XUANJI · 璇玑 — 器用气流（§18.5）：0.90–1.06R 的四层楔形束。
// 原则「是气不是灯」：整体亮度永远低于浑仪本体，只在事件与强拍上起反应，不循环闪烁。
// 非对称缓动：快出慢回；只有主层与回弹层吃强拍。

import { CATEGORY_COLOR, COLORS, STATE_COLOR, withAlpha } from '../design/tokens';
import { TAU, clamp, clamp01, damp } from '../lib/math';
import { rand01 } from './rand';
import type { ToolCategory } from '../state/types';
import { GEOM, type Env, type View } from './types';

type Tint = 0 | 1 | 2; // 0 冷蓝 / 1 骨白 / 2 金

interface Strand {
  angle: number;
  len: number;
  target: number;
  base: number;
  tint: Tint;
  alpha: number;
}

interface AirLayer {
  /** 起点半径（以 R 为单位） */
  radius: number;
  strands: Strand[];
  baseAlpha: number;
  widthMul: number;
  listens: boolean;
}

interface Kick {
  angle: number;
  color: string;
  born: number;
  life: number;
  strength: number;
}

interface Drop {
  angle: number;
  r0: number;
  born: number;
  life: number;
  spin: number;
}

/** 24 / 30 / 36 / 26 束，四层；颜色冷蓝 40% / 骨白 40% / 金 20%。 */
export class AirSystem {
  private layers: AirLayer[] = [];
  private kicks: Kick[] = [];
  private drops: Drop[] = [];
  private lastBeat = -1;
  private built = false;

  rebuild(env: Env, quality: number): void {
    this.layers = [];
    this.kicks = [];
    this.drops = [];
    const defs: Array<{ radius: number; count: number; baseAlpha: number; widthMul: number; listens: boolean }> = [
      { radius: GEOM.tickOut + 0.012, count: 24, baseAlpha: 0.16, widthMul: 1.35, listens: false }, // 近
      { radius: GEOM.tickOut + 0.045, count: 30, baseAlpha: 0.22, widthMul: 1.0, listens: true }, // 主
      { radius: GEOM.tickOut + 0.085, count: 36, baseAlpha: 0.1, widthMul: 0.6, listens: false }, // 远
      { radius: GEOM.tickOut + 0.125, count: 26, baseAlpha: 0.13, widthMul: 0.8, listens: true }, // 回弹
    ];
    const keep = quality < 0.7 ? 1 : quality < 0.85 ? 2 : defs.length;
    for (let li = 0; li < keep; li += 1) {
      const def = defs[li];
      if (!def) continue;
      const strands: Strand[] = [];
      for (let i = 0; i < def.count; i += 1) {
        const seed = `air:${li}:${i}`;
        const tint: Tint = (i % 5 === 4 ? 2 : i % 2 === 0 ? 0 : 1) as Tint;
        const base = env.R * (0.02 + rand01(`${seed}:l`) * 0.085);
        strands.push({
          angle: (i / def.count) * TAU + rand01(`${seed}:a`) * 0.02,
          len: base,
          target: base,
          base,
          tint,
          alpha: 0.6 + rand01(`${seed}:o`) * 0.4,
        });
      }
      this.layers.push({
        radius: def.radius,
        strands,
        baseAlpha: def.baseAlpha,
        widthMul: def.widthMul,
        listens: def.listens,
      });
    }
    this.built = true;
    void env;
  }

  /** 事件射束：器用类别对应颜色的一笔；error 走朱砂断点 + 一次坠落点。 */
  kick(cat: ToolCategory | null, angle: number | null, env: Env, error = false): void {
    if (!this.built) return;
    const a = angle ?? rand01(`air-k:${Math.floor(env.now / 60)}`) * TAU;
    this.kicks.push({
      angle: a,
      color: error ? COLORS.bone100 : CATEGORY_COLOR[cat ?? 'exec'],
      born: env.now,
      life: error ? 620 : 480,
      strength: error ? 1.3 : 1,
    });
    if (this.kicks.length > 36) this.kicks.splice(0, this.kicks.length - 36);
    // 邻近束被带动（±0.18rad）
    for (const layer of this.layers) {
      if (!layer.listens) continue;
      for (const s of layer.strands) {
        let d = Math.abs(s.angle - a);
        if (d > Math.PI) d = TAU - d;
        if (d < 0.18) s.target = Math.min(env.R * 0.11, s.target + env.R * 0.035 * (0.5 + 0.5 * (1 - d / 0.18)));
      }
    }
    if (error) {
      this.drops.push({ angle: a, r0: env.R * (GEOM.tickOut + 0.06), born: env.now, life: 320, spin: 0 });
    }
  }

  /** 强拍：只有主层与回弹层起浪。 */
  strongBeat(env: Env): void {
    for (const layer of this.layers) {
      if (!layer.listens) continue;
      for (const s of layer.strands) {
        s.target = Math.min(env.R * 0.11, s.target + s.base * 0.55);
      }
    }
  }

  update(env: Env, view: View): void {
    if (!this.built) return;
    const pulse = view.beat.pulse;
    if (view.beat.serial !== this.lastBeat) {
      this.lastBeat = view.beat.serial;
      if (view.beat.strong) this.strongBeat(env);
    }
    const dimPulse = env.reducedMotion ? 0.5 : 1;
    for (const layer of this.layers) {
      for (const s of layer.strands) {
        const base = s.base * (1 + 0.18 * pulse * dimPulse * (layer.listens ? 1 : 0.4));
        // 快出慢回：目标大于当前时快，回落时慢
        const goingUp = s.target > s.len;
        const lambda = goingUp ? 15 : 1.9;
        s.len = damp(s.len, s.target, lambda, env.dt);
        s.target = damp(s.target, base, 1.25, env.dt);
      }
    }
    for (let i = this.kicks.length - 1; i >= 0; i -= 1) {
      const k = this.kicks[i];
      if (!k || env.now - k.born > k.life) this.kicks.splice(i, 1);
    }
    for (let i = this.drops.length - 1; i >= 0; i -= 1) {
      const d = this.drops[i];
      if (!d || env.now - d.born > d.life) this.drops.splice(i, 1);
    }
  }

  draw(ctx: CanvasRenderingContext2D, view: View, dim: number): void {
    if (!this.built || dim <= 0.02) return;
    const env = view.env;
    const R = env.R;
    const now = env.now;
    const bright = clamp(0.75 + 0.25 * view.beat.pulse, 0.6, 1);
    for (const layer of this.layers) {
      const r0 = R * layer.radius;
      for (let tint = 0 as Tint; tint <= 2; tint = (tint + 1) as Tint) {
        const color = tint === 0 ? COLORS.cold300 : tint === 1 ? COLORS.bone300 : COLORS.gold300;
        const share = tint === 2 ? 0.62 : 0.75;
        ctx.strokeStyle = withAlpha(color, layer.baseAlpha * share * bright * dim);
        ctx.lineWidth = (env.mobile ? 0.7 : 1) * layer.widthMul;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (const s of layer.strands) {
          if (s.tint !== tint) continue;
          const a = env.skyRot + s.angle;
          const len = Math.max(4, s.len * (0.7 + 0.3 * s.alpha));
          const sa = Math.sin(a);
          const ca = -Math.cos(a);
          ctx.moveTo(sa * r0, ca * r0);
          ctx.lineTo(sa * (r0 + len), ca * (r0 + len));
        }
        ctx.stroke();
      }
    }
    // 事件射束（器用色的一笔，向外）
    for (const k of this.kicks) {
      const t = clamp01((now - k.born) / k.life);
      const bite = t < 0.35 ? t / 0.35 : 1 - (t - 0.35) / 0.65;
      const len = R * 0.1 * bite * k.strength;
      const a = env.skyRot + k.angle;
      const r0 = R * (GEOM.tickOut + 0.03);
      const sa = Math.sin(a);
      const ca = -Math.cos(a);
      ctx.strokeStyle = withAlpha(k.color, clamp(0.42 * (1 - t * 0.55), 0, 0.45) * dim);
      ctx.lineWidth = 1.5 * k.strength;
      ctx.beginPath();
      ctx.moveTo(sa * r0, ca * r0);
      ctx.lineTo(sa * (r0 + len), ca * (r0 + len));
      ctx.stroke();
      if (t < 0.5 && k.strength > 1.1) {
        // 朱砂断点
        ctx.fillStyle = withAlpha(STATE_COLOR.error, 0.7 * (1 - t * 2) * dim);
        ctx.beginPath();
        ctx.arc(sa * (r0 + len), ca * (r0 + len), 1.5, 0, TAU);
        ctx.fill();
      }
    }
    // 坠落点：断墨后一次坠落，不循环
    for (const d of this.drops) {
      const t = clamp01((now - d.born) / d.life);
      const fall = t * t;
      const a = env.skyRot + d.angle + fall * 0.05;
      const rr = d.r0 + R * 0.06 * fall;
      const sa = Math.sin(a);
      const ca = -Math.cos(a);
      ctx.fillStyle = withAlpha(STATE_COLOR.error, 0.75 * (1 - t) * dim);
      ctx.beginPath();
      ctx.arc(sa * rr, ca * rr, 1.7 * (1 - t * 0.5), 0, TAU);
      ctx.fill();
    }
  }
}
