// XUANJI · 璇玑 — 星野层（§18.7）：事件触发的单颗流星。
// 不循环、不常驻：只有真实事件推一次才划过一颗，0.6s 消失；星野亮度始终低于浑仪本体一档。

import { COLORS, withAlpha } from '../design/tokens';
import { rgba } from './paint';
import { clamp01 } from '../lib/math';
import { rand01 } from './rand';
import type { Env } from './types';

interface Meteor {
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  dist: number;
  born: number;
  life: number;
  width: number;
  color: string;
  seed: string;
}

/** 流星：屏幕坐标（画在星野之后、仪器之前）。 */
export class SkySystem {
  private meteors: Meteor[] = [];
  private lastAt = -1e9;
  private seq = 0;

  /** 事件触发一颗流星；内部冷却 950ms、同屏最多 3 颗，避免事件洪峰刷屏。 */
  spawn(env: Env): void {
    if (env.reducedMotion) return;
    if (env.now - this.lastAt < 950) return;
    if (this.meteors.length >= 3) return;
    this.lastAt = env.now;
    const seed = `meteor:${this.seq}:${Math.floor(env.now)}`;
    this.seq += 1;
    const dir = rand01(`${seed}:d`) > 0.5 ? 1 : -1;
    const ang = (0.16 + rand01(`${seed}:a`) * 0.52) * dir;
    const x0 = env.w * (0.16 + rand01(`${seed}:x`) * 0.68);
    const y0 = env.h * (0.08 + rand01(`${seed}:y`) * 0.42);
    const dist = 170 + rand01(`${seed}:t`) * 210;
    this.meteors.push({
      x0,
      y0,
      dx: Math.sin(ang),
      dy: Math.cos(ang),
      dist,
      born: env.now,
      life: 600,
      width: env.mobile ? 0.8 : 1.05,
      color: rand01(`${seed}:c`) > 0.55 ? COLORS.bone200 : COLORS.cold300,
      seed,
    });
  }

  update(env: Env): void {
    for (let i = this.meteors.length - 1; i >= 0; i -= 1) {
      const m = this.meteors[i];
      if (!m || env.now - m.born > m.life) this.meteors.splice(i, 1);
    }
  }

  draw(ctx: CanvasRenderingContext2D, env: Env): void {
    if (this.meteors.length === 0) return;
    const dimBase = env.connection === 'offline' ? 0.4 : 1;
    for (const m of this.meteors) {
      const t = clamp01((env.now - m.born) / m.life);
      // 快出慢尾：前 70% 走完 88% 距离
      const travel = t < 0.7 ? (t / 0.7) * 0.88 : 0.88 + ((t - 0.7) / 0.3) * 0.12;
      const hx = m.x0 + m.dx * m.dist * travel;
      const hy = m.y0 + m.dy * m.dist * travel;
      const tail = (52 + rand01(`${m.seed}:tail`) * 46) * (0.4 + 0.6 * Math.sin(t * Math.PI));
      const fade = Math.sin(Math.min(1, t * 1.15) * Math.PI) * 0.9;
      const tx = hx - m.dx * tail;
      const ty = hy - m.dy * tail;
      const grad = ctx.createLinearGradient(tx, ty, hx, hy);
      grad.addColorStop(0, rgba(m.color, 0));
      grad.addColorStop(0.7, rgba(m.color, 0.16 * fade * dimBase));
      grad.addColorStop(1, rgba(m.color, 0.5 * fade * dimBase));
      ctx.strokeStyle = grad;
      ctx.lineWidth = m.width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.fillStyle = rgba(COLORS.bone100, 0.65 * fade * dimBase);
      ctx.beginPath();
      ctx.arc(hx, hy, 0.9 + m.width * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
