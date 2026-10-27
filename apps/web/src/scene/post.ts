// XUANJI · 璇玑 — 后期层：暗角、胶片颗粒、辉光合成与边缘色散。
// 预算：≤3 次全屏绘制（辉光 1 次 + 暗角 1 次 + 颗粒 1 次），§13。

import { COLORS } from '../design/tokens';
import { clamp, clamp01 } from '../lib/math';
import type { Env } from './types';

const GRAIN_TILE = 180;

function buildGrainTile(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = GRAIN_TILE;
  c.height = GRAIN_TILE;
  const g = c.getContext('2d');
  if (!g) return c;
  const img = g.createImageData(GRAIN_TILE, GRAIN_TILE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    // 温和的骨白颗粒；极窄的亮度范围，避免变成电视雪花
    const v = Math.random();
    d[i] = 226;
    d[i + 1] = 218;
    d[i + 2] = 198;
    d[i + 3] = Math.floor(v * v * 30);
  }
  g.putImageData(img, 0, 0);
  return c;
}

export class PostSystem {
  private vignette: HTMLCanvasElement | null = null;
  private vignetteKey = '';
  private grain: HTMLCanvasElement | null = null;
  private grainPattern: CanvasPattern | null = null;
  private grainPatternCtx: CanvasRenderingContext2D | null = null;
  private tintA: HTMLCanvasElement | null = null;
  private tintB: HTMLCanvasElement | null = null;
  private tintACtx: CanvasRenderingContext2D | null = null;
  private tintBCtx: CanvasRenderingContext2D | null = null;
  private tintKey = '';

  /** resize / 参数变化时重建静态层。 */
  build(ctx: CanvasRenderingContext2D, env: Env): void {
    const vk = `${Math.round(env.w)}x${Math.round(env.h)}@${env.cx.toFixed(0)},${env.cy.toFixed(0)}:${env.params.vignette.toFixed(2)}:${env.R.toFixed(0)}`;
    if (this.vignetteKey !== vk) {
      this.vignetteKey = vk;
      this.buildVignette(env);
    }
    if (!this.grain) this.grain = buildGrainTile();
    if (this.grain && (!this.grainPattern || this.grainPatternCtx !== ctx)) {
      this.grainPattern = ctx.createPattern(this.grain, 'repeat');
      this.grainPatternCtx = ctx;
    }
  }

  private buildVignette(env: Env): void {
    const w = Math.max(2, Math.round(env.w));
    const h = Math.max(2, Math.round(env.h));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return;
    const v = clamp(env.params.vignette, 0, 0.8);
    const cx = env.cx;
    const cy = env.cy * 1.02;
    const inner = Math.min(w, h) * 0.24;
    const outer = Math.hypot(w * 0.6, h * 0.62);
    const grad = g.createRadialGradient(cx, cy, inner, cx, cy, outer);
    grad.addColorStop(0, 'rgba(3,4,7,0)');
    grad.addColorStop(0.42, `rgba(3,4,7,${(0.03 + v * 0.05).toFixed(3)})`);
    grad.addColorStop(0.72, `rgba(3,4,7,${(0.10 + v * 0.18).toFixed(3)})`);
    grad.addColorStop(1, `rgba(2,3,6,${(0.28 + v * 0.34).toFixed(3)})`);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    // 底部冷月蓝的远场沉降，压住画面下缘（冷暖面积比校准）
    const cold = g.createLinearGradient(0, h * 0.6, 0, h);
    cold.addColorStop(0, 'rgba(108,127,160,0)');
    cold.addColorStop(1, 'rgba(108,127,160,0.055)');
    g.fillStyle = cold;
    g.fillRect(0, h * 0.6, w, h * 0.4);
    // 顶部微压，保证星野与账本之间有呼吸
    const top = g.createLinearGradient(0, 0, 0, h * 0.12);
    top.addColorStop(0, 'rgba(2,3,6,0.18)');
    top.addColorStop(1, 'rgba(2,3,6,0)');
    g.fillStyle = top;
    g.fillRect(0, 0, w, h * 0.12);
    // 四角冷月蓝：远场必须"冷"（§17.1 冷=远可大但弱）
    const corners: Array<[number, number]> = [
      [0.14, 0.84],
      [0.88, 0.16],
      [0.86, 0.88],
    ];
    for (const [px, py] of corners) {
      const cg = g.createRadialGradient(w * px, h * py, 0, w * px, h * py, Math.max(w, h) * 0.52);
      cg.addColorStop(0, 'rgba(108,127,160,0.05)');
      cg.addColorStop(1, 'rgba(108,127,160,0)');
      g.fillStyle = cg;
      g.fillRect(0, 0, w, h);
    }
    this.vignette = c;
  }

  /** 辉光层合成：1/3 分辨率离屏 + 一次 filter blur + lighter。 */
  drawGlow(ctx: CanvasRenderingContext2D, env: Env, glow: HTMLCanvasElement): void {
    const p = env.params;
    if (p.glow <= 0.02 || env.quality < 0.42) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const blur = 1.1 + p.glow * 2.4 + (1 - env.quality) * 1.6;
    // v2.3 §22.2：辉光强度随 fxWeight 连续降权（0.55 时 71%），不做硬开关；
    // blur 仍只在手势外开启，但因整体 alpha 平滑下降，帧间亮度变化 <8%
    if (env.fxWeight > 0.8 && env.quality > 0.5 && typeof ctx.filter === 'string') {
      ctx.filter = `blur(${blur.toFixed(2)}px)`;
    }
    ctx.globalAlpha = 0.35 + 0.65 * clamp01(env.fxWeight);
    ctx.drawImage(glow, 0, 0, env.w, env.h);
    ctx.globalAlpha = 1;
    ctx.restore();
    if (env.fxWeight > 0.7) this.drawAberration(ctx, env, glow);
  }

  /** 色散：只在有辉光的亮部做轻微通道偏移（不是全屏滤镜）。 */
  private drawAberration(ctx: CanvasRenderingContext2D, env: Env, glow: HTMLCanvasElement): void {
    const k = env.params.aberration;
    if (k <= 0.05 || env.quality < 0.58 || glow.width < 4) return;
    const key = `${glow.width}x${glow.height}`;
    if (this.tintKey !== key) {
      this.tintKey = key;
      this.tintA = document.createElement('canvas');
      this.tintA.width = glow.width;
      this.tintA.height = glow.height;
      this.tintB = document.createElement('canvas');
      this.tintB.width = glow.width;
      this.tintB.height = glow.height;
      this.tintACtx = this.tintA.getContext('2d');
      this.tintBCtx = this.tintB.getContext('2d');
    }
    const a = this.tintACtx;
    const b = this.tintBCtx;
    if (!a || !b || !this.tintA || !this.tintB) return;
    a.clearRect(0, 0, this.tintA.width, this.tintA.height);
    a.drawImage(glow, 0, 0);
    a.globalCompositeOperation = 'source-in';
    a.fillStyle = COLORS.gold300;
    a.fillRect(0, 0, this.tintA.width, this.tintA.height);
    a.globalCompositeOperation = 'source-over';
    b.clearRect(0, 0, this.tintB.width, this.tintB.height);
    b.drawImage(glow, 0, 0);
    b.globalCompositeOperation = 'source-in';
    b.fillStyle = COLORS.cold300;
    b.fillRect(0, 0, this.tintB.width, this.tintB.height);
    b.globalCompositeOperation = 'source-over';
    const off = 0.7 + k * 4.2;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(0.06 + k * 0.14, 0, 0.22);
    ctx.drawImage(this.tintA, -off, 0, env.w, env.h);
    ctx.globalAlpha = clamp(0.05 + k * 0.11, 0, 0.18);
    ctx.drawImage(this.tintB, off, 0, env.w, env.h);
    ctx.restore();
  }

  /** 暗角 + 颗粒（屏幕空间）。 */
  draw(ctx: CanvasRenderingContext2D, env: Env): void {
    if (this.vignette) {
      ctx.drawImage(this.vignette, 0, 0, env.w, env.h);
    }
    const grain = env.params.grain;
    // v2.3 §22.2：颗粒也不硬跳过——手势期间按 fxWeight 连续减淡
    if (grain > 0.02 && env.quality > 0.52 && this.grainPattern && this.grain) {
      const ox = Math.floor(Math.random() * GRAIN_TILE);
      const oy = Math.floor(Math.random() * GRAIN_TILE);
      ctx.save();
      ctx.translate(-ox, -oy);
      ctx.globalAlpha = clamp(0.18 + grain * 0.55, 0, 0.6) * (0.45 + 0.55 * clamp01(env.fxWeight));
      ctx.fillStyle = this.grainPattern;
      ctx.fillRect(0, 0, env.w + GRAIN_TILE, env.h + GRAIN_TILE);
      ctx.restore();
    }
  }

  dispose(): void {
    this.vignette = null;
    this.grain = null;
    this.grainPattern = null;
    this.grainPatternCtx = null;
    this.tintA = null;
    this.tintB = null;
    this.tintACtx = null;
    this.tintBCtx = null;
  }
}

/** 空态/连接中时画面也不能全黑：极淡的暖金地平线弧（由 index 调用）。 */
export function drawQuietHorizon(ctx: CanvasRenderingContext2D, env: Env, alpha: number): void {
  if (alpha <= 0.01) return;
  const r = Math.min(env.w, env.h) * 0.82;
  ctx.save();
  ctx.strokeStyle = `rgba(232,200,120,${(0.10 * alpha).toFixed(3)})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(env.cx, env.cy, r, Math.PI * 1.08, Math.PI * 1.92);
  ctx.stroke();
  ctx.strokeStyle = `rgba(108,127,160,${(0.10 * alpha).toFixed(3)})`;
  ctx.beginPath();
  ctx.arc(env.cx, env.cy, r * 1.045, Math.PI * 1.1, Math.PI * 1.9);
  ctx.stroke();
  ctx.restore();
}

/** 供 index 汇报的冷色比例工具（调试用，不参与渲染）。 */
export function coldWarmHint(env: Env): number {
  return clamp01((env.R / Math.max(1, env.w)) * 2);
}
