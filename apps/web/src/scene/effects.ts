// XUANJI · 璇玑 — 事件→视觉：五行笔触、穿带亮痕、断墨朱砂、玉色双环、同心涟漪、
// 遣使连线、墨点、守夜扫描。全部短生命周期、有上限（§6.2 / §6.4 / §13）。

import { CATEGORY_COLOR, COLORS, STATE_COLOR, withAlpha } from '../design/tokens';
import { rgba } from './paint';
import { TAU, clamp, clamp01, lerp } from '../lib/math';
import { rand01 } from './rand';
import type { ToolCategory } from '../state/types';
import type { CameraSystem } from './camera';
import { drawGlow } from './instrument';
import { CATEGORY_ORDER, GEOM, type Env, type StarNode, type View } from './types';

export type BeamKind = 'call' | 'result';

export interface Beam {
  id: number;
  kind: BeamKind;
  cat: ToolCategory;
  angle: number;
  r0: number;
  r1: number;
  born: number;
  life: number;
  /** 世界 px 的亮痕长度 */
  trail: number;
  width: number;
  error: boolean;
  prevHead: number;
  /** v2.4 §23.1：起点是否位于该星的工作光流之上（工具光束改锚） */
  fromStream: boolean;
}

interface Hotspot {
  cat: ToolCategory;
  angle: number;
  born: number;
  life: number;
}

interface InkDot {
  x: number;
  y: number;
  born: number;
  life: number;
  r: number;
  color: string;
}

interface Ripple {
  x: number;
  y: number;
  born: number;
  life: number;
  r0: number;
  r1: number;
  width: number;
  color: string;
}

interface Drop {
  x: number;
  y: number;
  born: number;
  life: number;
}

interface TeamLinkFx {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  born: number;
  life: number;
}

interface ApprovalFx {
  x: number;
  y: number;
  born: number;
  life: number;
  r: number;
}

/** 五行带半径（世界 px）。 */
export function bandRadius(cat: ToolCategory, env: Env): number {
  const idx = CATEGORY_ORDER.indexOf(cat);
  return env.R * (GEOM.bandIn + GEOM.bandStep * Math.max(0, idx));
}

export class EffectsSystem {
  beams: Beam[] = [];
  private hotspots: Hotspot[] = [];
  private dots: InkDot[] = [];
  private ripples: Ripple[] = [];
  private drops: Drop[] = [];
  private links: TeamLinkFx[] = [];
  private approvals: ApprovalFx[] = [];
  errorFlashAt = -1e9;
  private seq = 0;

  private get beamCap(): number {
    return 40;
  }

  /** v2.4 §23.1：在飞工具光束数 / 其中起点位于工作光流上的条数（debugStreams 用）。 */
  get beamCount(): number {
    return this.beams.length;
  }

  get beamFromStream(): number {
    let n = 0;
    for (const b of this.beams) if (b.fromStream) n += 1;
    return n;
  }

  /** tool/call：从星朝向中枢的五行笔触。 */
  spawnCall(star: StarNode, cat: ToolCategory, env: Env, error: boolean): void {
    this.emitCall(star, cat, env, error, null);
  }

  /** v2.4 §23.1：工具光束改锚——起点取该星工作光流 t∈[0.25,0.85] 上的世界坐标。 */
  spawnCallAt(star: StarNode, cat: ToolCategory, env: Env, error: boolean, anchor: { x: number; y: number }): void {
    this.emitCall(star, cat, env, error, anchor);
  }

  private emitCall(
    star: StarNode,
    cat: ToolCategory,
    env: Env,
    error: boolean,
    anchor: { x: number; y: number } | null,
  ): void {
    if (this.beams.length >= this.beamCap) this.beams.shift();
    const toolLen = star.session.pendingCalls[star.session.pendingCalls.length - 1]?.length ?? 4;
    const scale = env.R / 420;
    const trail = (72 + clamp(toolLen, 2, 14) * 6) * clamp(env.params.beamLength, 0.2, 1.2) * scale;
    const angle = anchor ? Math.atan2(anchor.x, -anchor.y) : star.angle;
    const r0 = anchor
      ? Math.max(env.R * GEOM.hub + 2, Math.hypot(anchor.x, anchor.y))
      : Math.max(env.R * 0.11, star.radius - 2);
    const r1 = error ? env.R * (GEOM.bandIn + GEOM.bandStep * 4) * 1.3 : env.R * (GEOM.bandIn * 0.92);
    const beam: Beam = {
      id: (this.seq += 1),
      kind: 'call',
      cat,
      angle,
      r0,
      r1,
      born: env.now,
      life: 400 + Math.random() * 220,
      trail,
      width: cat === 'exec' ? 2.6 : cat === 'write' ? 1.8 : cat === 'read' ? 1.2 : 1.6,
      error,
      prevHead: r0,
      fromStream: !!anchor,
    };
    this.beams.push(beam);
    // 沿线 2–4 颗微小墨点
    const dots = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < dots; i += 1) {
      const t = 0.18 + Math.random() * 0.7;
      const rr = lerp(r0, r1, t);
      const a = angle + (Math.random() - 0.5) * 0.02;
      this.dots.push({
        x: Math.sin(a) * rr,
        y: -Math.cos(a) * rr,
        born: env.now,
        life: 460 + Math.random() * 320,
        r: 0.7 + Math.random() * 0.8,
        color: error ? STATE_COLOR.error : CATEGORY_COLOR[cat],
      });
    }
    if (error) {
      this.errorFlashAt = env.now;
      const bx = Math.sin(angle) * r1;
      const by = -Math.cos(angle) * r1;
      this.drops.push({ x: bx, y: by, born: env.now, life: 1000 });
    }
  }

  /** tool/result：回笔，用 durationMs 决定亮痕长度。 */
  spawnResult(star: StarNode, cat: ToolCategory, env: Env, durationMs: number | null | undefined): void {
    if (this.beams.length >= this.beamCap) this.beams.shift();
    const scale = env.R / 420;
    const dur = clamp((durationMs ?? 0) / 900, 0, 2.6);
    const trail = (26 + dur * 26) * clamp(env.params.beamLength, 0.2, 1.2) * scale;
    const br = bandRadius(cat, env);
    this.beams.push({
      id: (this.seq += 1),
      kind: 'result',
      cat,
      angle: star.angle,
      r0: br,
      r1: Math.max(env.R * 0.12, star.radius - 1),
      born: env.now,
      life: 520,
      trail,
      width: cat === 'exec' ? 2.4 : 1.6,
      error: false,
      prevHead: br,
      fromStream: false,
    });
    this.hotspots.push({ cat, angle: star.angle, born: env.now, life: 260 });
  }

  spawnApproval(star: StarNode, env: Env): void {
    this.approvals.push({ x: 0, y: 0, born: env.now, life: 1500, r: star.r });
    // 位置在绘制时由 angle/radius 还原会漂移，这里直接存世界坐标
    const last = this.approvals[this.approvals.length - 1];
    if (last) {
      last.x = Math.sin(star.angle) * star.radius;
      last.y = -Math.cos(star.angle) * star.radius;
    }
  }

  spawnRipple(x: number, y: number, env: Env, color: string, r0: number, r1: number, life: number): void {
    this.ripples.push({ x, y, born: env.now, life, r0, r1, width: 1.2, color });
  }

  spawnIgnite(star: StarNode, env: Env): void {
    const pos = { x: Math.sin(star.angle) * star.radius, y: -Math.cos(star.angle) * star.radius };
    this.spawnRipple(pos.x, pos.y, env, COLORS.gold200, 2, 26, 720);
    this.spawnRipple(pos.x, pos.y, env, COLORS.gold400, 1, 15, 520);
  }

  spawnExtinguish(star: StarNode, env: Env): void {
    const pos = { x: Math.sin(star.angle) * star.radius, y: -Math.cos(star.angle) * star.radius };
    this.spawnRipple(pos.x, pos.y, env, COLORS.bone400, 22, 3, 620);
  }

  spawnTeamLink(a: { x: number; y: number }, b: { x: number; y: number }, env: Env): void {
    if (this.links.length >= 40) this.links.shift();
    this.links.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, born: env.now, life: 600 });
  }

  spawnRippleAt(star: StarNode, env: Env, color: string): void {
    const pos = { x: Math.sin(star.angle) * star.radius, y: -Math.cos(star.angle) * star.radius };
    this.spawnRipple(pos.x, pos.y, env, color, env.R * (2 / 420), env.R * (40 / 420), 620);
    this.spawnRipple(pos.x, pos.y, env, color, 1, env.R * (26 / 420), 780);
  }

  // ———————————————————————————————— 每帧

  update(env: Env): void {
    const now = env.now;
    const q = env.quality;
    const capBeams = Math.round(this.beamCap * (0.5 + 0.5 * q));
    if (this.beams.length > capBeams) this.beams.splice(0, this.beams.length - capBeams);
    this.beams = this.beams.filter((b) => now - b.born < b.life);
    for (const beam of this.beams) {
      const p = clamp01((now - beam.born) / beam.life);
      const head = lerp(beam.r0, beam.r1, 1 - Math.pow(1 - p, 3));
      // 穿带留亮痕：笔触头经过该五行带时点亮
      if (beam.kind === 'call' && !beam.error) {
        const br = bandRadius(beam.cat, env);
        if (beam.prevHead > br && head <= br && this.hotspots.length < 60) {
          this.hotspots.push({ cat: beam.cat, angle: beam.angle, born: now, life: 160 + Math.random() * 100 });
        }
      }
      beam.prevHead = head;
    }
    if (this.hotspots.length > 60) this.hotspots.splice(0, this.hotspots.length - 60);
    this.hotspots = this.hotspots.filter((h) => now - h.born < h.life);
    if (this.dots.length > 120) this.dots.splice(0, this.dots.length - 120);
    this.dots = this.dots.filter((d) => now - d.born < d.life);
    if (this.ripples.length > 30) this.ripples.splice(0, this.ripples.length - 30);
    this.ripples = this.ripples.filter((r) => now - r.born < r.life);
    if (this.drops.length > 40) this.drops.splice(0, this.drops.length - 40);
    this.drops = this.drops.filter((d) => now - d.born < d.life);
    this.links = this.links.filter((l) => now - l.born < l.life);
    this.approvals = this.approvals.filter((a) => now - a.born < a.life);
  }

  // ———————————————————————————————— 绘制（世界坐标）

  draw(ctx: CanvasRenderingContext2D, view: View, dim: number): void {
    const env = view.env;
    const now = env.now;
    const p = env.params;
    const glowParam = p.glow * (0.55 + 0.6 * p.toolGlow);
    const beamAlpha = clamp(1.15 - p.beamFade * 0.5, 0.35, 1.15);

    // 涟漪
    for (const r of this.ripples) {
      const age = now - r.born;
      if (age >= r.life) continue;
      const k = age / r.life;
      const e = 1 - Math.pow(1 - k, 3);
      const rr = lerp(r.r0, r.r1, e);
      ctx.strokeStyle = rgba(r.color, (1 - k) * 0.4 * dim);
      ctx.lineWidth = r.width;
      ctx.beginPath();
      ctx.arc(r.x, r.y, Math.max(0.4, rr), 0, TAU);
      ctx.stroke();
    }

    // 遣使：两星之间实金细线 + 端点小环
    for (const l of this.links) {
      const age = now - l.born;
      if (age >= l.life) continue;
      const k = 1 - age / l.life;
      ctx.strokeStyle = rgba(COLORS.gold200, 0.5 * k * dim);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(l.ax, l.ay);
      ctx.lineTo(l.bx, l.by);
      ctx.stroke();
      ctx.strokeStyle = rgba(COLORS.gold100, 0.55 * k * dim);
      ctx.beginPath();
      ctx.arc(l.bx, l.by, 2.6 + (1 - k) * 2, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(l.ax, l.ay, 1.8, 0, TAU);
      ctx.stroke();
    }

    // 五行笔触 / 回笔
    const layers = clamp(Math.round(p.beamLayers), 1, 5);
    for (const beam of this.beams) {
      const age = now - beam.born;
      if (age >= beam.life) continue;
      const prog = clamp01(age / beam.life);
      const e = 1 - Math.pow(1 - prog, 3);
      const head = lerp(beam.r0, beam.r1, e);
      const dir = beam.r1 >= beam.r0 ? 1 : -1;
      const trail = beam.trail * (0.7 + 0.3 * (1 - prog));
      const tail = head - dir * trail;
      const sx = Math.sin(beam.angle);
      const sy = -Math.cos(beam.angle);
      const color = beam.error ? STATE_COLOR.error : CATEGORY_COLOR[beam.cat];
      const alpha = (1 - prog) * beamAlpha;
      if (alpha <= 0.01) continue;
      // 外层柔光（低透明宽笔）
      ctx.strokeStyle = rgba(color, alpha * 0.3 * (0.5 + glowParam));
      ctx.lineWidth = beam.width * 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx * tail, sy * tail);
      ctx.lineTo(sx * head, sy * head);
      ctx.stroke();
      for (let i = 0; i < layers; i += 1) {
        const w = beam.width * (1 + i * 0.45);
        const a = alpha * (i === 0 ? 0.9 : 0.16 / (i + 0.6));
        ctx.strokeStyle = rgba(color, clamp(a, 0, 1));
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(sx * tail, sy * tail);
        ctx.lineTo(sx * head, sy * head);
        ctx.stroke();
      }
      // 笔头
      ctx.fillStyle = rgba(beam.error ? STATE_COLOR.error : COLORS.bone100, alpha * 0.85);
      ctx.beginPath();
      ctx.arc(sx * head, sy * head, beam.error ? 1.6 : beam.width * 0.75, 0, TAU);
      ctx.fill();
    }

    // 穿带亮痕
    for (const h of this.hotspots) {
      const age = now - h.born;
      if (age >= h.life) continue;
      const k = 1 - age / h.life;
      const br = bandRadius(h.cat, env);
      const traceLen = env.R * (0.085 + 0.1 * k);
      const half = traceLen / Math.max(1, br * 2);
      ctx.strokeStyle = rgba(CATEGORY_COLOR[h.cat], 0.75 * k * dim);
      ctx.lineWidth = 1.8 + 1.8 * k;
      ctx.beginPath();
      ctx.arc(0, 0, br, h.angle - half, h.angle + half);
      ctx.stroke();
    }

    // 墨点
    for (const d of this.dots) {
      const age = now - d.born;
      if (age >= d.life) continue;
      const k = 1 - age / d.life;
      ctx.fillStyle = rgba(d.color, 0.55 * k * dim);
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r * (0.5 + 0.5 * k), 0, TAU);
      ctx.fill();
    }

    // 审批：玉色双环（星位置由 spawn 时快照）
    for (const a of this.approvals) {
      const age = now - a.born;
      if (age >= a.life) continue;
      const k = age / a.life;
      const rr = a.r + 4 + k * 20;
      ctx.strokeStyle = rgba(COLORS.patina300, (1 - k) * 0.8 * dim);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(a.x, a.y, rr, 0, TAU * 0.85);
      ctx.stroke();
      const rr2 = a.r + 8 + k * 30;
      if (rr2 > a.r + 6) {
        ctx.strokeStyle = rgba(COLORS.patina300, (1 - k) * 0.45 * dim);
        ctx.beginPath();
        ctx.arc(a.x, a.y, rr2, Math.PI, Math.PI + TAU * 0.7);
        ctx.stroke();
      }
    }

    // 朱砂断墨坠落
    for (const d of this.drops) {
      const age = now - d.born;
      if (age >= d.life) continue;
      const fall = Math.max(0, age - 300);
      const y = d.y + (fall / 700) * (fall / 700) * 70;
      const k = 1 - age / d.life;
      ctx.fillStyle = rgba(STATE_COLOR.error, clamp(k * 0.9, 0, 0.9) * dim);
      ctx.beginPath();
      ctx.arc(d.x, y, 1.8, 0, TAU);
      ctx.fill();
    }
  }

  /** 辉光层：笔触 / 亮痕 / 审批 / 涟漪的低饱和大半径光。 */
  drawGlow(glowCtx: CanvasRenderingContext2D, view: View, dim: number): void {
    const env = view.env;
    const now = env.now;
    const glowParam = env.params.glow * (0.55 + 0.6 * env.params.toolGlow);
    for (const beam of this.beams) {
      const age = now - beam.born;
      if (age >= beam.life) continue;
      const prog = clamp01(age / beam.life);
      const e = 1 - Math.pow(1 - prog, 3);
      const head = lerp(beam.r0, beam.r1, e);
      const dir = beam.r1 >= beam.r0 ? 1 : -1;
      const tail = head - dir * beam.trail * 0.6;
      const color = beam.error ? STATE_COLOR.error : CATEGORY_COLOR[beam.cat];
      const mx = Math.sin(beam.angle) * ((head + tail) / 2);
      const my = -Math.cos(beam.angle) * ((head + tail) / 2);
      drawGlow(glowCtx, color, mx, my, beam.width * 14, (1 - prog) * 0.3 * glowParam * dim);
    }
    for (const h of this.hotspots) {
      const age = now - h.born;
      if (age >= h.life) continue;
      const k = 1 - age / h.life;
      const br = bandRadius(h.cat, env);
      drawGlow(
        glowCtx,
        CATEGORY_COLOR[h.cat],
        Math.sin(h.angle) * br,
        -Math.cos(h.angle) * br,
        env.R * 0.045,
        0.28 * k * glowParam * dim,
      );
    }
    for (const a of this.approvals) {
      const age = now - a.born;
      if (age >= a.life) continue;
      const k = 1 - age / a.life;
      drawGlow(glowCtx, COLORS.patina300, a.x, a.y, a.r + 10, 0.3 * k * glowParam);
    }
    for (const r of this.ripples) {
      const age = now - r.born;
      if (age >= r.life) continue;
      const k = age / r.life;
      const e = 1 - Math.pow(1 - k, 3);
      const rr = lerp(r.r0, r.r1, e);
      drawGlow(glowCtx, r.color, r.x, r.y, Math.max(3, rr * 1.5), 0.16 * (1 - k) * glowParam);
    }
    for (const l of this.links) {
      const age = now - l.born;
      if (age >= l.life) continue;
      const k = 1 - age / l.life;
      drawGlow(glowCtx, COLORS.gold200, (l.ax + l.bx) / 2, (l.ay + l.by) / 2, Math.hypot(l.bx - l.ax, l.by - l.ay) * 0.5, 0.12 * k);
    }
  }

  /** 错误：全屏 180ms 朱砂侧闪（≤8%，不铺满故障）。屏幕坐标。 */
  drawFlash(ctx: CanvasRenderingContext2D, env: Env): void {
    const age = env.now - this.errorFlashAt;
    if (age < 0 || age > 180) return;
    const k = 1 - age / 180;
    const alpha = 0.08 * k;
    const left = ctx.createLinearGradient(0, 0, env.w * 0.18, 0);
    left.addColorStop(0, rgba(STATE_COLOR.error, alpha));
    left.addColorStop(1, rgba(STATE_COLOR.error, 0));
    ctx.fillStyle = left;
    ctx.fillRect(0, 0, env.w * 0.18, env.h);
    const right = ctx.createLinearGradient(env.w, 0, env.w * 0.82, 0);
    right.addColorStop(0, rgba(STATE_COLOR.error, alpha));
    right.addColorStop(1, rgba(STATE_COLOR.error, 0));
    ctx.fillStyle = right;
    ctx.fillRect(env.w * 0.82, 0, env.w * 0.18, env.h);
  }
}

/** 拂扫：3.6s 扫一圈的扫描光带 + 异常/高压力星方框锁定。 */
export function drawScan(ctx: CanvasRenderingContext2D, view: View, camera: CameraSystem): void {
  const env = view.env;
  const R = env.R;
  const a = camera.scanAngle;
  const inner = R * 0.3;
  const outer = R * 0.92;
  const sweep = 0.36;
  const c0 = a - Math.PI / 2;
  // 尾迹楔形（低透明暖金）—— 拂扫时「读数」的可见光带
  ctx.fillStyle = rgba(COLORS.gold300, 0.085);
  ctx.beginPath();
  ctx.arc(0, 0, outer, c0, c0 + sweep);
  ctx.arc(0, 0, inner, c0 + sweep, c0, true);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = rgba(COLORS.gold300, 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, outer, c0 + sweep, c0 + sweep * 2.1);
  ctx.arc(0, 0, inner, c0 + sweep * 2.1, c0 + sweep, true);
  ctx.closePath();
  ctx.fill();
  // 刻度读数弧（外缘）
  ctx.strokeStyle = rgba(COLORS.gold200, 0.16);
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.arc(0, 0, outer * 0.985, c0, c0 + sweep * 1.25);
  ctx.stroke();
  // 扫描前缘
  ctx.strokeStyle = rgba(COLORS.gold200, 0.62);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(Math.sin(a) * inner, -Math.cos(a) * inner);
  ctx.lineTo(Math.sin(a) * outer, -Math.cos(a) * outer);
  ctx.stroke();
  // 前缘上的刻度：器物的「读针」
  for (let t = 0; t < 12; t += 1) {
    const rr = inner + ((outer - inner) * (t + 0.5)) / 12;
    const len = t % 3 === 0 ? 5.5 : 2.6;
    const px = Math.sin(a) * rr;
    const py = -Math.cos(a) * rr;
    ctx.strokeStyle = rgba(COLORS.bone200, t % 3 === 0 ? 0.4 : 0.22);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len);
    ctx.stroke();
  }

  // 异常锁定框
  const now = env.now;
  for (const star of view.stars) {
    const abnormal =
      (star.errorAt > 0 && now - star.errorAt < 10000) || star.session.contextPressure > 0.72;
    if (!abnormal) continue;
    const x = Math.sin(star.angle) * star.radius;
    const y = -Math.cos(star.angle) * star.radius;
    const s = star.r + 8;
    const color = star.errorAt > 0 && now - star.errorAt < 10000 ? STATE_COLOR.error : COLORS.gold300;
    ctx.strokeStyle = rgba(color, 0.42);
    ctx.lineWidth = 1;
    const arm = s * 0.5;
    const corners = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    for (const [cx, cy] of corners) {
      const px = x + (cx ?? 1) * s;
      const py = y + (cy ?? 1) * s;
      ctx.beginPath();
      ctx.moveTo(px + (cx ?? 1) * -arm, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + (cy ?? 1) * -arm);
      ctx.stroke();
    }
  }
}

/** 点状尘埃的「星野呼吸」相位：守夜时极轻，正常时随拍点微亮。 */
export function twinkleGain(env: Env, pulse: number): number {
  return 1 + pulse * 0.04 + (env.params.twinkle > 0.6 ? (rand01(`tw${Math.floor(env.now / 900)}`) - 0.5) * 0.05 : 0);
}
