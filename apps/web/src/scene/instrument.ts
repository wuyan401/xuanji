// XUANJI · 璇玑 — 仪器层：静态缓存（星野 / 授时刻度环 / 噪点）+ 背景、分野、星轨、五行光带、紫宫。
// 规则（§17.1）：远场冷月蓝、中景暖金铜 1px、仪器是画面里唯一亮而有实体的东西。
// 热循环禁止 shadowBlur；静态层只做 drawImage。

import { COLORS, CATEGORY_COLOR, FONTS, withAlpha } from '../design/tokens';
import { rgba } from './paint';
import { TAU, clamp, clamp01, lerp } from '../lib/math';
import { rand01 } from './rand';
import { sourceTint } from '../state/types';
import { getShichen } from '../lib/format';
import { CATEGORY_ORDER, GEOM, textScale, type Env, type Mark, type SectorArc, type View } from './types';
import type { CameraSystem } from './camera';

// ———————————————————————————————————————————— 静态缓存

export interface StarfieldCache {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
}

export interface TickCache {
  canvas: HTMLCanvasElement;
  size: number;
}

/** 星野：冷月蓝尘埃 + 12 颗锚点星 + 极淡云气（离屏一次，逐帧一次 drawImage）。 */
export function buildStarfield(env: Env): StarfieldCache {
  const w = Math.max(1, Math.round(env.w));
  const h = Math.max(1, Math.round(env.h));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return { canvas, w, h };
  const cx = w / 2;
  const cy = h / 2;
  const R = env.R;
  const maxR = Math.hypot(w, h) / 2 + 24;
  const density = clamp01(env.params.starDensity);
  const count = Math.round(180 + density * 520 + (env.mobile ? 0 : 160));
  const far = R * GEOM.starfield;

  // 云气（先画，最暗；冷月蓝是远场的底色，面积可大但必须弱，§17.1）
  const clouds = env.mobile ? 5 : 9;
  for (let i = 0; i < clouds; i += 1) {
    const a = rand01(`cloud-a${i}`) * TAU;
    const rr = far * (0.68 + rand01(`cloud-r${i}`) * 0.8);
    const x = cx + Math.sin(a) * rr;
    const y = cy - Math.cos(a) * rr;
    const rad = R * (0.5 + rand01(`cloud-s${i}`) * 0.62);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    const tint = i % 2 === 0 ? COLORS.indigo400 : COLORS.cold300;
    grad.addColorStop(0, rgba(tint, 0.03 + rand01(`cloud-o${i}`) * 0.032));
    grad.addColorStop(1, rgba(tint, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, rad, 0, TAU);
    g.fill();
  }

  // 星尘：远场（>0.88R）更亮更冷，场内只作极弱底噪
  for (let i = 0; i < count; i += 1) {
    const a = rand01(`sf-a${i}`) * TAU;
    const rr = Math.sqrt(rand01(`sf-r${i}`)) * maxR;
    const x = cx + Math.sin(a) * rr;
    const y = cy - Math.cos(a) * rr;
    if (x < -6 || y < -6 || x > w + 6 || y > h + 6) continue;
    const outside = rr > far;
    const f = outside ? 0.62 + rand01(`sf-f${i}`) * 0.5 : 0.12 + rand01(`sf-f${i}`) * 0.18;
    const roll = rand01(`sf-c${i}`);
    const color = roll > 0.93 ? COLORS.bone300 : roll > 0.58 ? COLORS.cold300 : COLORS.indigo400;
    const alpha = clamp((0.05 + rand01(`sf-o${i}`) * 0.14) * f, 0.02, 0.2);
    const size = (0.35 + rand01(`sf-s${i}`) * 0.85) * (outside ? 1 : 0.8);
    g.fillStyle = rgba(color, alpha);
    g.beginPath();
    g.arc(x, y, size, 0, TAU);
    g.fill();
  }

  // 12 颗锚点星：唯一允许的柔光（缓存内一次成型）
  for (let i = 0; i < 12; i += 1) {
    const a = rand01(`sfm-a${i}`) * TAU;
    const rr = far * 0.9 + Math.sqrt(rand01(`sfm-r${i}`)) * (maxR - far * 0.9);
    const x = cx + Math.sin(a) * rr;
    const y = cy - Math.cos(a) * rr;
    if (x < 0 || y < 0 || x > w || y > h) continue;
    const rad = 5 + rand01(`sfm-s${i}`) * 9;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, rgba(COLORS.bone200, 0.28));
    grad.addColorStop(0.35, rgba(COLORS.cold300, 0.1));
    grad.addColorStop(1, rgba(COLORS.cold300, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, rad, 0, TAU);
    g.fill();
    g.fillStyle = rgba(COLORS.bone100, 0.65);
    g.beginPath();
    g.arc(x, y, 0.7 + rand01(`sfm-r2${i}`) * 0.7, 0, TAU);
    g.fill();
  }

  // 外天体球：三道断续冷弧（>0.88R 的远场结构；冷=远可大但弱，§17.1）
  const sphereR = [R * 1.04, R * 1.16, R * 1.32];
  for (let i = 0; i < sphereR.length; i += 1) {
    const rad = sphereR[i] ?? 0;
    const start = rand01(`sphere-a${i}`) * TAU;
    const sweep = 0.7 + rand01(`sphere-s${i}`) * 1.9;
    g.strokeStyle = rgba(COLORS.indigo400, 0.05 + 0.012 * (2 - i));
    g.lineWidth = i === 0 ? 1 : 0.75;
    g.beginPath();
    g.arc(cx, cy, rad, start, start + sweep);
    g.stroke();
    g.fillStyle = rgba(COLORS.cold300, 0.1);
    for (let k = 0; k < 3; k += 1) {
      const a2 = start + sweep * rand01(`sphere-d${i}${k}`);
      g.beginPath();
      g.arc(cx + Math.sin(a2) * rad, cy - Math.cos(a2) * rad, 0.9, 0, TAU);
      g.fill();
    }
  }

  // bokeh 大散景（§18.7）：极淡冷月蓝大圆 + 一圈更薄外环，把星野推远一档
  const bokehN = env.mobile ? 2 : 4;
  for (let i = 0; i < bokehN; i += 1) {
    const a = rand01(`bk-a${i}`) * TAU;
    const rr = far * (0.98 + rand01(`bk-r${i}`) * 0.85);
    const x = cx + Math.sin(a) * rr;
    const y = cy - Math.cos(a) * rr;
    const rad = R * (0.1 + rand01(`bk-s${i}`) * 0.17);
    if (x < -rad || y < -rad || x > w + rad || y > h + rad) continue;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, rgba(i % 2 === 0 ? COLORS.cold300 : COLORS.indigo400, 0.055));
    grad.addColorStop(0.6, rgba(COLORS.indigo400, 0.024));
    grad.addColorStop(1, rgba(COLORS.indigo400, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, rad, 0, TAU);
    g.fill();
    g.strokeStyle = rgba(COLORS.cold300, 0.05);
    g.lineWidth = 0.8;
    g.beginPath();
    g.arc(x, y, rad * 0.84, 0, TAU);
    g.stroke();
  }
  return { canvas, w, h };
}

export function drawStarfield(
  ctx: CanvasRenderingContext2D,
  env: Env,
  cache: StarfieldCache,
  offX: number,
  offY: number,
  alphaScale = 1,
): void {
  if (cache.w !== Math.round(env.w) || cache.h !== Math.round(env.h)) return;
  // 手势/深看期星野按 fxWeight 平滑淡出（§22.2 亮度不跳）；淡到阈值以下整层跳过，省一次全屏 blit
  if (alphaScale <= 0.02) return;
  const dof = env.params.dof;
  const scale = 1 + (env.zoom - 1) * 0.05;
  const alpha = (0.78 + 0.22 * (1 - dof)) * (0.9 + 0.1 * Math.min(env.quality, 1));
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0.4, 1) * clamp01(alphaScale);
  ctx.translate(env.w / 2 + offX * 0.14, env.h / 2 + offY * 0.14);
  ctx.scale(scale, scale);
  ctx.drawImage(cache.canvas, -cache.w / 2, -cache.h / 2);
  if (dof > 0.25 && env.zoom < 1.8 && alphaScale > 0.6) {
    // 柔和景深：叠一层放大 1.035 的极淡副本；v2.3 §22.2 手势期间按 fxWeight 连续降权（不硬关）
    ctx.globalAlpha = 0.16 * dof * (0.15 + 0.85 * clamp01(env.fxWeight));
    ctx.scale(1.035, 1.035);
    ctx.drawImage(cache.canvas, -cache.w / 2, -cache.h / 2);
  }
  ctx.restore();
}

/** 授时刻度环：28 宿 + 12 时辰 + 60 小刻（三档刻度，§17.2），离屏缓存。
 *  v2.1 §20.2：sharp = 深度缩放档位，离屏层按 2 倍档重渲染（文字不烘进缓存，每帧反向缩放）。 */
export function buildTickRing(env: Env, sharp = 1): TickCache {
  const outer = env.R * GEOM.tickOut;
  const inner = env.R * GEOM.tickIn;
  const pad = 10;
  const size = Math.ceil((outer + pad) * 2);
  const dpr = clamp(env.dpr * sharp, 1, 3.6);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(size * dpr));
  canvas.height = Math.max(1, Math.round(size * dpr));
  const g = canvas.getContext('2d');
  if (!g) return { canvas, size };
  g.scale(dpr, dpr);
  g.translate(size / 2, size / 2);

  const p = env.params;
  const eng = clamp01(p.engravingDepth);
  const labelAlpha = 0.52 + 0.16 * eng;
  void labelAlpha;

  const circle = (r: number): void => {
    g.beginPath();
    g.arc(0, 0, r, 0, TAU);
    g.stroke();
  };

  // 授时环的「器」：环带浅洗 + 内外双界 + 二十八宿分界
  g.beginPath();
  g.arc(0, 0, outer, 0, TAU);
  g.arc(0, 0, inner, 0, TAU, true);
  g.fillStyle = rgba(COLORS.gold400, 0.022 + 0.02 * eng);
  g.fill();
  g.strokeStyle = rgba(COLORS.gold500, 0.3 + 0.16 * eng);
  g.lineWidth = 1;
  circle(outer);
  circle(inner);
  g.strokeStyle = rgba(COLORS.gold500, 0.1 + 0.08 * eng);
  circle(inner - 3);
  // 二十八宿分界刻（外缘内向）：比 30° 主刻更旧、更密
  for (let i = 0; i < 28; i += 1) {
    const a = (i / 28) * TAU;
    g.strokeStyle = rgba(COLORS.gold300, 0.4 + 0.14 * eng);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.sin(a) * (outer - 1), -Math.cos(a) * (outer - 1));
    g.lineTo(Math.sin(a) * (outer - 9), -Math.cos(a) * (outer - 9));
    g.stroke();
  }

  // 刻度三档：0.25° 微刻 / 1° 次刻 / 30° 主刻
  const total = 1440;
  for (let i = 0; i < total; i += 1) {
    const deg = i * 0.25;
    const a = (deg / 360) * TAU;
    let w = 0.5;
    let len = 1.5;
    let color = rgba(COLORS.gold500, 0.13);
    if (Math.abs(deg % 30) < 0.001) {
      w = 1;
      len = 7;
      color = rgba(COLORS.gold400, 0.5);
    } else if (Math.abs(deg % 1) < 0.001) {
      w = 0.75;
      len = 3;
      color = rgba(COLORS.gold500, 0.34);
    }
    if (p.ticks < 0.45 && Math.abs(deg % 1) > 0.001) continue;
    g.strokeStyle = color;
    g.lineWidth = w;
    g.beginPath();
    const r1 = outer - 1;
    const r2 = outer - 1 - len * clamp(p.ticks, 0, 1.5);
    g.moveTo(Math.sin(a) * r1, -Math.cos(a) * r1);
    g.lineTo(Math.sin(a) * r2, -Math.cos(a) * r2);
    g.stroke();
  }

  return { canvas, size };
}

/** v2.1：授时环文字（二十八宿 / 十二时辰）独立的屏幕空间层——不烘缓存，
 *  每帧按 1/zoom 反向缩放，深度放大时字号稳定（§20.2）。仅 >1280px 宽显示。 */
export function drawTickLabels(ctx: CanvasRenderingContext2D, view: View, dim: number, camera?: CameraSystem): void {
  const env = view.env;
  if (env.w <= 1280 || dim <= 0.05) return;
  const outer = env.R * GEOM.tickOut;
  const inner = env.R * GEOM.tickIn;
  const eng = clamp01(env.params.engravingDepth);
  const labelAlpha = 0.52 + 0.16 * eng;
  const ts = textScale(env) * clamp(dim, 0.4, 1);
  const onScreen = (x: number, y: number): boolean => {
    if (!camera) return true;
    const p = camera.worldToScreen(env, x, y);
    return p.x > -40 && p.x < env.w + 40 && p.y > -40 && p.y < env.h + 40;
  };
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 二十八宿（外圈，直立字，避免倒置）
  const xiu = [
    '角', '亢', '氐', '房', '心', '尾', '箕', '斗', '牛', '女', '虚', '危', '室', '壁',
    '奎', '娄', '胃', '昴', '毕', '觜', '参', '井', '鬼', '柳', '星', '张', '翼', '轸',
  ];
  ctx.font = `400 14px ${FONTS.mono}`;
  ctx.fillStyle = rgba(COLORS.bone200, labelAlpha * 0.85);
  const rXiu = outer + 15;
  for (let i = 0; i < xiu.length; i += 1) {
    const a = (i / xiu.length) * TAU;
    const x = Math.sin(a) * rXiu;
    const y = -Math.cos(a) * rXiu;
    if (!onScreen(x, y)) continue;
    ctx.save();
    ctx.translate(x, y);
    if (ts !== 1) ctx.scale(ts, ts);
    ctx.fillText(xiu[i] ?? '', 0, 0);
    ctx.restore();
  }
  // 十二时辰（环内，直立字，主刻 30° 一个）
  const shichen = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  ctx.font = `400 14px ${FONTS.mono}`;
  ctx.fillStyle = rgba(COLORS.gold200, clamp(labelAlpha * 1.05, 0, 0.66));
  const rShi = inner + 14;
  for (let i = 0; i < shichen.length; i += 1) {
    const a = (i / shichen.length) * TAU;
    const x = Math.sin(a) * rShi;
    const y = -Math.cos(a) * rShi;
    if (!onScreen(x, y)) continue;
    ctx.save();
    ctx.translate(x, y);
    if (ts !== 1) ctx.scale(ts, ts);
    ctx.fillText(shichen[i] ?? '', 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/** 授时环动态层：当前时辰/小刻亮刻 + live 会话刻点。 */
export function drawTickDynamic(ctx: CanvasRenderingContext2D, view: View, dim: number): void {
  const env = view.env;
  const R = env.R;
  if (dim <= 0.02) return;
  const date = new Date();
  const shi = getShichen(date);
  const hf = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const shichenFloat = ((((hf + 1) % 24) / 2) % 12 + 12) % 12;
  const a = (shichenFloat / 12) * TAU;
  const r = R * ((GEOM.tickIn + GEOM.tickOut) / 2);
  const gold = rgba(COLORS.gold200, 0.85 * dim);
  // §22.4 授时环秒针：每拍顿挫 0.7°（0.0122rad）+ 回弹 0.15°（拍相位派生，不匀速）
  const beatQ = clamp01(view.beat.q);
  const wob = 0.0122 * Math.max(0, 1 - beatQ) + 0.0026 * Math.sin(beatQ * Math.PI);
  const aNow = a + wob;
  // 当前时辰亮刻
  ctx.strokeStyle = gold;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.arc(0, 0, r, aNow - 0.016, aNow + 0.016);
  ctx.stroke();
  ctx.strokeStyle = rgba(COLORS.gold100, 0.5 * dim);
  ctx.lineWidth = 1;
  ctx.beginPath();
  const r1 = R * GEOM.tickOut - 1;
  const r2 = r1 - 10;
  ctx.moveTo(Math.sin(aNow) * r1, -Math.cos(aNow) * r1);
  ctx.lineTo(Math.sin(aNow) * r2, -Math.cos(aNow) * r2);
  ctx.stroke();
  // 当前小刻（15 分钟一刻，每时辰 8 刻）
  const keA = a + (shi.ke / 8) * (TAU / 12);
  ctx.strokeStyle = rgba(COLORS.gold200, 0.6 * dim);
  ctx.lineWidth = 1.6;
  const kr1 = R * GEOM.tickOut - 2;
  const kr2 = kr1 - 4.5;
  ctx.beginPath();
  ctx.moveTo(Math.sin(keA) * kr1, -Math.cos(keA) * kr1);
  ctx.lineTo(Math.sin(keA) * kr2, -Math.cos(keA) * kr2);
  ctx.stroke();

  // live 会话刻点（靠近所属分野弧）
  const rr = R * (GEOM.tickOut + 0.012);
  const pulse = view.beat.pulse;
  for (const s of view.stars) {
    if (s.session.state !== 'live' || s.appear < 0.5) continue;
    const alpha = (0.35 + 0.45 * clamp01(s.glow + pulse * 0.3)) * dim;
    ctx.fillStyle = rgba(COLORS.gold200, clamp(alpha, 0.1, 0.85));
    ctx.beginPath();
    ctx.arc(Math.sin(s.angle) * rr, -Math.cos(s.angle) * rr, 1.3, 0, TAU);
    ctx.fill();
  }
  // §22.7 scifi：授时环 45° 扫描扇区（随势 ×0.8 转速，只此一道，不循环闪烁）
  if (env.theme === 'scifi') {
    const scanA = ((env.tickScan % TAU) + TAU) % TAU;
    const tIn = R * GEOM.tickIn;
    const tOut = R * GEOM.tickOut;
    ctx.strokeStyle = rgba(COLORS.cold300, 0.08 * dim);
    ctx.lineWidth = tOut - tIn;
    ctx.beginPath();
    ctx.arc(0, 0, (tIn + tOut) / 2, scanA - Math.PI / 4, scanA);
    ctx.stroke();
    ctx.strokeStyle = rgba(COLORS.gold200, 0.18 * dim);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(Math.sin(scanA) * tIn, -Math.cos(scanA) * tIn);
    ctx.lineTo(Math.sin(scanA) * tOut, -Math.cos(scanA) * tOut);
    ctx.stroke();
  }
}

export function drawTickRing(ctx: CanvasRenderingContext2D, cache: TickCache, alpha: number): void {
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.drawImage(cache.canvas, -cache.size / 2, -cache.size / 2, cache.size, cache.size);
  ctx.restore();
}

// ———————————————————————————————————————————— 噪点 / 辉光精灵

export function buildNoise(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  if (g) {
    const img = g.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 110 + Math.random() * 145;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v * 0.94;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  return c;
}

const glowSprites = new Map<string, HTMLCanvasElement>();

/** 半径辉光精灵（按色缓存；热循环只 drawImage，不用 shadowBlur）。 */
export function glowSprite(color: string): HTMLCanvasElement {
  const cached = glowSprites.get(color);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, rgba(color, 1));
    grad.addColorStop(0.18, rgba(color, 0.62));
    grad.addColorStop(0.46, rgba(color, 0.16));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  glowSprites.set(color, c);
  return c;
}

export function drawGlow(
  ctx: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  radius: number,
  alpha: number,
): void {
  if (alpha <= 0.004 || radius <= 0.3) return;
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.drawImage(glowSprite(color), x - radius, y - radius, radius * 2, radius * 2);
  ctx.globalAlpha = 1;
}

// ———————————————————————————————————————————— 背景

/** v2.2：背景（底 + 暖光 + 冷压）离屏缓存——热循环只做一次 drawImage，省掉每帧建径向渐变。 */
let bgCache: { canvas: HTMLCanvasElement; w: number; h: number; dpr: number; key: string } | null = null;

function buildBackdrop(env: Env): HTMLCanvasElement | null {
  const dpr = Math.max(1, Math.min(2, env.dpr));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(env.w * dpr));
  canvas.height = Math.max(1, Math.round(env.h * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.inkVoid;
  ctx.fillRect(0, 0, env.w, env.h);
  const lightX = env.w / 2;
  const lightY = env.h * 0.46;
  const glow = env.params.glow;
  const g = ctx.createRadialGradient(lightX, lightY, 0, lightX, lightY, Math.max(env.w, env.h) * 0.66);
  g.addColorStop(0, rgba(COLORS.gold300, 0.13 + 0.06 * glow));
  g.addColorStop(0.34, rgba(COLORS.gold400, 0.05 + 0.03 * glow));
  g.addColorStop(0.7, rgba(COLORS.gold500, 0.012));
  g.addColorStop(1, rgba(COLORS.gold500, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, env.w, env.h);
  // 远场冷月蓝，压住整屏暖棕（§17.1 冷暖面积约束）
  const cg = ctx.createRadialGradient(env.w * 0.5, env.h * 1.04, 0, env.w * 0.5, env.h * 1.04, env.h * 0.95);
  cg.addColorStop(0, rgba(COLORS.indigo400, 0.07));
  cg.addColorStop(0.55, rgba(COLORS.indigo400, 0.025));
  cg.addColorStop(1, rgba(COLORS.indigo400, 0));
  ctx.fillStyle = cg;
  ctx.fillRect(0, 0, env.w, env.h);
  return canvas;
}

export function drawBackground(ctx: CanvasRenderingContext2D, env: Env): void {
  const key = `${env.w}x${env.h}@${env.dpr.toFixed(2)}:${env.params.glow.toFixed(2)}`;
  if (!bgCache || bgCache.key !== key) {
    const canvas = buildBackdrop(env);
    if (!canvas) {
      // 兜底：极端情况下直接铺底色
      ctx.fillStyle = COLORS.inkVoid;
      ctx.fillRect(0, 0, env.w, env.h);
      return;
    }
    bgCache = { canvas, w: env.w, h: env.h, dpr: Math.max(1, Math.min(2, env.dpr)), key };
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bgCache.canvas, 0, 0);
  ctx.restore();
}

// ———————————————————————————————————————————— 尘埃

export interface DustMote {
  x: number;
  y: number;
  r: number;
  alpha: number;
  vx: number;
  vy: number;
}

export function createDust(env: Env): DustMote[] {
  const count = env.mobile ? 0 : Math.round(24 + clamp01(env.params.dust) * 96);
  const motes: DustMote[] = [];
  for (let i = 0; i < count; i += 1) {
    motes.push({
      x: rand01(`dust-x${i}`) * env.w,
      y: rand01(`dust-y${i}`) * env.h,
      r: 0.5 + rand01(`dust-r${i}`) * 0.9,
      alpha: 0.04 + rand01(`dust-o${i}`) * 0.09,
      vx: (rand01(`dust-vx${i}`) - 0.5) * 4,
      vy: -1.5 - rand01(`dust-vy${i}`) * 3,
    });
  }
  return motes;
}

export function drawDust(
  ctx: CanvasRenderingContext2D,
  env: Env,
  motes: DustMote[],
  offX: number,
  offY: number,
  weight = 1,
): void {
  if (weight <= 0.02) return;
  const dt = env.dt;
  const quality = env.quality;
  const limit = Math.round(motes.length * (0.45 + 0.55 * quality));
  for (let i = 0; i < limit; i += 1) {
    const m = motes[i];
    if (!m) continue;
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    if (m.y < -8) {
      m.y = env.h + 8;
      m.x = rand01(`dust-rx${i}${Math.floor(env.now / 4000)}`) * env.w;
    }
    if (m.x < -8) m.x = env.w + 8;
    if (m.x > env.w + 8) m.x = -8;
    const x = m.x + offX * 0.45;
    const y = m.y + offY * 0.45;
    ctx.fillStyle = rgba(
      i % 5 === 0 ? COLORS.cold300 : COLORS.indigo400,
      m.alpha * (0.7 + 0.3 * quality) * clamp01(weight),
    );
    ctx.fillRect(x, y, m.r, m.r);
  }
}

// ———————————————————————————————————————————— 分野弧带

export function drawSectors(ctx: CanvasRenderingContext2D, view: View, dim: number, camera?: CameraSystem): void {
  const env = view.env;
  const R = env.R;
  const rot = env.skyRot;
  const rIn = R * GEOM.sectorIn;
  const rOut = R * GEOM.sectorOut;

  // 12 个 30° 主分割线（§17.2 分层轮盘）
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(COLORS.gold500, 0.26 * dim);
  ctx.beginPath();
  for (let i = 0; i < 12; i += 1) {
    const a = rot + (i / 12) * TAU;
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    ctx.moveTo(sin * R * GEOM.sectorDivIn, -cos * R * GEOM.sectorDivIn);
    ctx.lineTo(sin * R * GEOM.sectorDivOut, -cos * R * GEOM.sectorDivOut);
  }
  ctx.stroke();

  // 空态（无会话/无分野）：仪器仍完整——只留环带界与主分割线，绝不用占位点充数（§17.2 缺席优于灰点）
  if (view.arcs.length === 0) {
    ctx.strokeStyle = rgba(COLORS.gold500, 0.2 * dim);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, rOut, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, rIn, 0, TAU);
    ctx.stroke();
    const mid = (rIn + rOut) / 2;
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = rgba(COLORS.gold500, 0.14 * dim);
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.arc(0, 0, mid, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  for (let ai = 0; ai < view.arcs.length; ai += 1) {
    const arc = view.arcs[ai] as SectorArc;
    const a0 = rot + arc.start;
    const a1 = rot + arc.start + arc.span;
    const live = arc.live;
    const count = arc.count;
    const warm = count > 0;
    // §19.1 来源筛选：非匹配分野压暗到 .18（弧与标签一起压暗，不删除）
    const srcDim = env.sourceFilter && arc.source !== env.sourceFilter ? 0.18 : 1;
    const dimmed = srcDim < 1;
    if (dimmed) {
      ctx.save();
      ctx.globalAlpha = srcDim;
    }
    // 弧体（内外双线 + 极淡暖填充）
    if (warm) {
      ctx.fillStyle = rgba(COLORS.gold400, 0.08 * dim);
      ctx.beginPath();
      ctx.arc(0, 0, rOut, a0, a1);
      ctx.arc(0, 0, rIn, a1, a0, true);
      ctx.closePath();
      ctx.fill();
      // 外缘收边：一条更亮的细弧 + 内侧暗压，形成铜环的厚度
      ctx.fillStyle = rgba(COLORS.gold300, 0.04 * dim);
      ctx.beginPath();
      ctx.arc(0, 0, rOut, a0, a1);
      ctx.arc(0, 0, rOut - (rOut - rIn) * 0.32, a1, a0, true);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = rgba(warm ? COLORS.gold300 : COLORS.gold500, (warm ? 0.4 + 0.3 * Math.min(live / 4, 1) : 0.17) * dim);
    ctx.lineWidth = warm ? 1.5 : 1;
    ctx.beginPath();
    ctx.arc(0, 0, rOut, a0, a1);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, rIn, a0, a1);
    ctx.stroke();

    // 细分小刻（每 ~2.5°）；v2.3 按 fxWeight 连续抽稀（不硬关，帧间亮度不跳）
    const baseSteps = Math.max(2, Math.round(arc.span / (TAU / 144)));
    const steps = Math.max(2, Math.round(baseSteps * (0.3 + 0.7 * clamp01(env.fxWeight))));
    ctx.strokeStyle = rgba(COLORS.gold500, (warm ? 0.2 : 0.1) * dim * (0.4 + 0.6 * clamp01(env.fxWeight)));
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    for (let k = 0; k <= steps; k += 1) {
      const a = a0 + (k / steps) * arc.span;
      const sin = Math.sin(a);
      const cos = Math.cos(a);
      ctx.moveTo(sin * rIn, -cos * rIn);
      ctx.lineTo(sin * (rIn + R * 0.012), -cos * (rIn + R * 0.012));
    }
    ctx.stroke();

    // §22.7 scifi：分野弧每 6° 一道 2px 短刻段（科技语法，只在外缘）
    if (env.theme === 'scifi' && arc.span > 0.12) {
      const nSeg = Math.max(1, Math.round(arc.span / (TAU / 60)));
      ctx.strokeStyle = rgba(COLORS.gold400, 0.26 * dim);
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let k = 0; k <= nSeg; k += 1) {
        const a = a0 + (k / nSeg) * arc.span;
        const sin = Math.sin(a);
        const cos = Math.cos(a);
        ctx.moveTo(sin * (rOut - 3), -cos * (rOut - 3));
        ctx.lineTo(sin * rOut, -cos * rOut);
      }
      ctx.stroke();
    }

    if (!warm) {
      if (dimmed) ctx.restore();
      continue;
    }
    // v2.2 性能：深度放大时大量分野标注在屏外——先按视角剔除，省掉 measureText/截断/描字
    if (camera) {
      const midA = (a0 + a1) / 2;
      const lp = camera.worldToScreen(env, Math.sin(midA) * R * GEOM.labelR, -Math.cos(midA) * R * GEOM.labelR);
      if (lp.x < -150 || lp.x > env.w + 150 || lp.y < -90 || lp.y > env.h + 90) {
        if (dimmed) ctx.restore();
        continue;
      }
    }
    // 分野双行标注（§18.3）：第一行分野名（显示体 13px 骨白 ~.8），第二行 行 n · 藏 m · 共 N（mono 10px ~.5）
    // v1.2：按弧长自适应字号 + 相邻弧径向错位，长 prefix 截断，保证 6 分野同名也能读清
    const mid = (a0 + a1) / 2;
    const arcLen = arc.span * R * GEOM.labelR;
    // v2.3 性能/可读性：真实数据 36 分野时多数弧段很短（<62px），标注会互相压叠且每帧 measureText 很贵；
    // 小弧只留弧线与刻度（缺席优于挤成一团），完整分野名在 HUD 分野总览里可读。
    if (arcLen < 62) {
      if (dimmed) ctx.restore();
      continue;
    }
    const stagger = (ai % 2 === 0 ? 0 : 1) * R * (env.mobile ? 0.055 : 0.02);
    const labelR = R * GEOM.labelR + stagger;
    const maxW = Math.max(38, arcLen * 0.88);
    const nameSize = arcLen > 230 ? 13 : arcLen > 170 ? 12 : arcLen > 120 ? 10.5 : 9;
    const metaSize = Math.max(8, Math.round(nameSize * 0.78));
    const showMeta = arcLen > 118;
    const breath = clamp01(arc.breath);
    ctx.save();
    ctx.rotate(mid);
    ctx.translate(0, -labelR);
    // 让底部文字不倒置
    if (Math.cos(mid) < -0.2) ctx.rotate(Math.PI);
    // v2.1 §20.2：深度放大时标注按 1/zoom 反向缩放，屏幕字号稳定
    const ts = textScale(env);
    if (ts < 0.999) ctx.scale(ts, ts);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `500 ${nameSize}px ${FONTS.display}`;
    let displayName = arc.name;
    let nameW = ctx.measureText(displayName).width;
    while (nameW > maxW && displayName.length > 2) {
      displayName = displayName.slice(0, -1);
      nameW = ctx.measureText(displayName).width;
    }
    if (displayName !== arc.name) {
      displayName = `${displayName}…`;
      nameW = ctx.measureText(displayName).width;
    }
    const meta = `行 ${arc.live} · 藏 ${arc.ended} · 共 ${count}`;
    // 第一行：分野名（live 分野随拍点呼吸提亮；§18.3）
    // §19.1：多来源时名字前加 1px 来源色短划（识别用，不做大色块）
    if (env.sourceCount >= 2) {
      const tint = sourceTint(arc.source);
      ctx.fillStyle = rgba(tint, 0.75 * dim);
      ctx.fillRect(
        -nameW / 2 - 6.5,
        (showMeta ? -nameSize * 0.42 : 0) - nameSize * 0.34,
        2.4,
        nameSize * 0.68,
      );
    }
    ctx.fillStyle = rgba(COLORS.bone200, (0.72 + 0.16 * breath) * dim);
    ctx.fillText(displayName, -nameW / 2, showMeta ? -nameSize * 0.42 : 0);
    // 第二行：行 / 藏 / 共（mono 等宽，行驻藏用词与状态字一致）
    if (showMeta) {
      ctx.font = `400 ${metaSize}px ${FONTS.mono}`;
      let metaText = meta;
      let metaW = ctx.measureText(metaText).width;
      while (metaW > maxW && metaText.length > 3) {
        metaText = metaText.slice(0, -2) + '…';
        metaW = ctx.measureText(metaText).width;
        if (metaText.endsWith('……')) break;
      }
      ctx.fillStyle = rgba(COLORS.bone300, (0.4 + 0.18 * breath) * dim);
      ctx.fillText(metaText, -Math.min(metaW, maxW) / 2, nameSize * 0.86);
    }
    ctx.restore();
    if (dimmed) ctx.restore();
  }
}

// ———————————————————————————————————————————— 星轨（深度环）

export function orbitRadii(env: Env): number[] {
  const n = clamp(Math.round(env.params.ringCount), 1, 5);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(n === 1 ? env.R * 0.46 : env.R * (GEOM.orbitIn + (GEOM.orbitOut - GEOM.orbitIn) * (i / (n - 1))));
  }
  return out;
}

export function drawOrbits(ctx: CanvasRenderingContext2D, view: View, dim: number): void {
  const env = view.env;
  const radii = orbitRadii(env);
  const eng = clamp01(env.params.engravingDepth);
  const selectedStar = view.selected ? view.stars.find((s) => s.id === view.selected) ?? null : null;
  for (let i = 0; i < radii.length; i += 1) {
    const r = radii[i] ?? 0;
    const sel = selectedStar && Math.abs(selectedStar.radius - r) < env.R * 0.02;
    ctx.strokeStyle = rgba(sel ? COLORS.gold300 : COLORS.gold500, (sel ? 0.4 : 0.2 + eng * 0.07) * dim);
    ctx.lineWidth = sel ? 1.4 : 1;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
    // 环上小刻（每 30°，短线，器械感）；深看时环被放大裁切，省掉细刻
    if (env.zoom < 2.4) {
      ctx.strokeStyle = rgba(COLORS.gold500, (0.19 + eng * 0.07) * dim);
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      for (let k = 0; k < 36; k += 1) {
        const a = (k / 36) * TAU;
        const sin = Math.sin(a);
        const cos = Math.cos(a);
        const r1 = r + (k % 9 === 0 ? 3.6 : 2.2);
        ctx.moveTo(sin * r, -cos * r);
        ctx.lineTo(sin * r1, -cos * r1);
      }
      ctx.stroke();
    }
  }
  // 墨痕（step/end 事件在该星轨道环上留下的短弧，20s 衰减）；v2.3 按 fxWeight 连续减淡
  drawMarks(ctx, env, view.marks, dim * (0.25 + 0.75 * clamp01(env.fxWeight)));
}

function drawMarks(ctx: CanvasRenderingContext2D, env: Env, marks: Mark[], dim: number): void {
  const now = env.now;
  const limit = Math.round(marks.length);
  ctx.lineCap = 'butt';
  for (let i = 0; i < limit; i += 1) {
    const m = marks[i];
    if (!m) continue;
    const age = now - m.born;
    if (age >= m.life) continue;
    const k = 1 - age / m.life;
    const alpha = k * k * (m.tone === 0 ? 0.5 : 0.36) * dim;
    if (alpha < 0.008) continue;
    ctx.strokeStyle = rgba(m.tone === 0 ? COLORS.gold300 : COLORS.bone300, alpha);
    ctx.lineWidth = 2.1;
    ctx.beginPath();
    ctx.arc(0, 0, m.radius, m.angle, m.angle + m.width);
    ctx.stroke();
    // 墨痕末端一点更密的墨
    const endA = m.angle + m.width;
    ctx.fillStyle = rgba(m.tone === 0 ? COLORS.gold200 : COLORS.bone200, alpha * 0.9);
    ctx.beginPath();
    ctx.arc(Math.sin(endA) * m.radius, -Math.cos(endA) * m.radius, 0.9, 0, TAU);
    ctx.fill();
  }
}

// ———————————————————————————————————————————— 五行光带

export function drawBands(ctx: CanvasRenderingContext2D, view: View, dim: number): void {
  const env = view.env;
  const p = env.params;
  const R = env.R;
  const eng = clamp01(p.engravingDepth);
  const beat = view.beat;
  // 找出最近活跃的一条（弱拍只颤它）
  let activeIdx = -1;
  let activeLevel = 0;
  for (let i = 0; i < view.bands.length; i += 1) {
    const lv = view.bands[i] ?? 0;
    if (lv > activeLevel) {
      activeLevel = lv;
      activeIdx = i;
    }
  }
  const shake = beat.strong ? beat.pulse * 0.6 : beat.weak ? beat.pulse * 0.42 : 0;
  // §22.4 五行带：0.37Hz 极慢纵向（径向）呼吸 ≤3px，由时间与拍点共同调制，不是主视觉
  const bandJitter = Math.sin((env.now / 1000) * TAU * 0.37) * 2.4 * (0.35 + 0.65 * clamp01(env.fxWeight));
  for (let i = 0; i < CATEGORY_ORDER.length; i += 1) {
    const cat = CATEGORY_ORDER[i];
    if (!cat) continue;
    const color = CATEGORY_COLOR[cat];
    const baseR = R * (GEOM.bandIn + GEOM.bandStep * i) + bandJitter;
    const lvl = clamp01(view.bands[i] ?? 0);
    const off = i === activeIdx || beat.strong ? shake : 0;
    // 静止时只有 8–12% 的铜底暗刻线：五行色只属于「动作」，不给整圈上色
    ctx.strokeStyle = rgba(COLORS.gold500, (0.11 + eng * 0.06) * dim);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, baseR, 0, TAU);
    ctx.stroke();
    // 内缘一道更暗的副刻线（錾刻感：一明一暗的双线）
    ctx.strokeStyle = rgba(COLORS.gold500, (0.04 + eng * 0.03) * dim);
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.arc(0, 0, baseR - 2.4, 0, TAU);
    ctx.stroke();
    // 每 2° 细刻（§18.6）；v2.3 按 fxWeight 连续抽稀（不硬关，帧间亮度不跳）
    ctx.strokeStyle = rgba(COLORS.gold500, (0.06 + eng * 0.02) * dim);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    const tickStep = clamp(Math.round(1 + (1 - clamp01(env.fxWeight)) * 2), 1, 3);
    for (let k = 0; k < 180; k += tickStep) {
      const a = (k / 180) * TAU;
      const sin = Math.sin(a);
      const cos = Math.cos(a);
      ctx.moveTo(sin * (baseR - 1.1), -cos * (baseR - 1.1));
      ctx.lineTo(sin * (baseR + 1.1), -cos * (baseR + 1.1));
    }
    ctx.stroke();
    // 活动亮度：只让承载动作的一段弧亮起类别色（仪表读数，不做彩虹圆环）
    if (lvl > 0.012) {
      const arcA = clamp(0.42 + lvl * 2.0, 0, 2.3);
      const startA = -arcA / 2 + i * 0.62 - env.skyRot * 0.4;
      ctx.strokeStyle = rgba(color, (0.07 + 0.42 * lvl) * dim);
      ctx.lineWidth = 1.1 + 1.6 * lvl;
      ctx.beginPath();
      ctx.arc(0, 0, baseR + off, startA, startA + arcA);
      ctx.stroke();
      // 带内墨点推进：速率 ∝ 该类工具 60s 速率（§18.6）
      const dotN = 1 + Math.round(lvl * 3);
      for (let k = 0; k < dotN; k += 1) {
        const speed = 0.16 + lvl * 0.85;
        const a =
          env.skyRot * (0.3 + i * 0.07) + (env.now / 1000) * speed * (k % 2 === 0 ? 1 : -0.7) + k * 2.1 + i * 1.3;
        ctx.fillStyle = rgba(color, (0.22 + 0.38 * lvl) * dim);
        ctx.beginPath();
        ctx.arc(Math.sin(a) * baseR, -Math.cos(a) * baseR, 0.9 + lvl * 1.1, 0, TAU);
        ctx.fill();
      }
    }
  }

  // 带内侧小字：览 / 书 / 作 / 讯 / 遣（§18.6，世界内标注例外，沿一条径向排成读数柱）
  const chars = ['览', '书', '作', '讯', '遣'];
  const labA = -0.95;
  const ts = textScale(env);
  ctx.font = `500 11px ${FONTS.display}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < chars.length; i += 1) {
    const br = R * (GEOM.bandIn + GEOM.bandStep * i) + 7.5;
    ctx.fillStyle = rgba(COLORS.bone300, (0.3 + 0.2 * clamp01(view.bands[i] ?? 0)) * dim);
    const lx = Math.sin(labA) * br;
    const ly = -Math.cos(labA) * br;
    ctx.save();
    ctx.translate(lx, ly);
    if (ts < 0.999) ctx.scale(ts, ts);
    ctx.fillText(chars[i] ?? '', 0, 0);
    ctx.restore();
  }
  ctx.textAlign = 'left';
}

// ———————————————————————————————————————————— 紫宫（中枢）

export function drawHub(ctx: CanvasRenderingContext2D, view: View, dim: number): void {
  const env = view.env;
  const R = env.R;
  const hubR = R * GEOM.hub;
  const beat = view.beat;
  const p = env.params;
  const eng = clamp01(p.engravingDepth);
  const glowAmt = p.glow;

  // 紫宫底部暖光池：仪器是被一盏灯照亮的（唯一主光源）
  drawGlow(ctx, COLORS.gold300, 0, 0, hubR * 1.9, clamp(0.05 + 0.1 * glowAmt, 0, 0.18) * dim);

  // 三嵌套转环（节拍相位驱动，非自由旋转；跨拍连续）
  const phase = (beat.serial * 0.25 + beat.q * 0.25) * TAU;
  for (let i = 0; i < 3; i += 1) {
    const rad = hubR * (0.52 + i * 0.21);
    const squash = 0.26 + i * 0.1;
    const rot = phase * (i % 2 === 0 ? 1 : -0.62) + i * 0.9;
    ctx.save();
    ctx.rotate(rot);
    ctx.strokeStyle = rgba(i === 0 ? COLORS.gold200 : COLORS.gold300, (0.42 - i * 0.06) * dim);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, rad, rad * squash, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // 紫宫环体：双环 + 12 辐条 + 内圈 36 小刻 + 外缘 12 颗刻漏珠（§18.6）
  ctx.strokeStyle = rgba(COLORS.gold400, (0.46 + eng * 0.12) * dim);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, hubR * 0.98, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = rgba(COLORS.gold400, (0.28 + eng * 0.1) * dim);
  ctx.beginPath();
  ctx.arc(0, 0, hubR * 0.84, 0, TAU);
  ctx.stroke();
  // 12 辐条（微微吃节拍，不做自由旋转）
  ctx.strokeStyle = rgba(COLORS.gold500, (0.22 + eng * 0.08) * dim);
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  for (let k = 0; k < 12; k += 1) {
    const a = (k / 12) * TAU + beat.serial * 0.0008;
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    ctx.moveTo(sin * hubR * 0.2, -cos * hubR * 0.2);
    ctx.lineTo(sin * hubR * 0.82, -cos * hubR * 0.82);
  }
  ctx.stroke();
  // 内圈 36 小刻
  ctx.strokeStyle = rgba(COLORS.gold500, (0.3 + eng * 0.1) * dim);
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  for (let k = 0; k < 36; k += 1) {
    const a = (k / 36) * TAU;
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    ctx.moveTo(sin * hubR * 0.8, -cos * hubR * 0.8);
    ctx.lineTo(sin * hubR * 0.84, -cos * hubR * 0.84);
  }
  ctx.stroke();
  // 外缘 12 颗刻漏珠：按真实时辰点亮，当前时辰最亮
  const nowDate = new Date();
  const hfDay = nowDate.getHours() + nowDate.getMinutes() / 60;
  const curShichen = Math.round((((hfDay + 1) % 24) / 2) % 12) % 12;
  for (let k = 0; k < 12; k += 1) {
    const a = (k / 12) * TAU;
    const x = Math.sin(a) * hubR * 0.99;
    const y = -Math.cos(a) * hubR * 0.99;
    const isCur = k === curShichen;
    ctx.fillStyle = rgba(isCur ? COLORS.gold100 : COLORS.gold400, (isCur ? 0.95 : 0.4 + 0.08 * eng) * dim);
    ctx.beginPath();
    ctx.arc(x, y, isCur ? 2.2 : 1.2, 0, TAU);
    ctx.fill();
    if (isCur) drawGlow(ctx, COLORS.gold200, x, y, 7.5, 0.32 * dim);
  }

  // 枢星（暗金）+ 唯一主光晕
  const pulse = 1 + beat.pulse * 0.5;
  drawGlow(ctx, COLORS.gold200, 0, 0, hubR * 0.9 * pulse, clamp(0.3 * pulse * (0.4 + glowAmt), 0, 0.6) * dim);
  ctx.fillStyle = rgba(COLORS.gold100, 0.95 * dim);
  ctx.beginPath();
  ctx.arc(0, 0, 1.9, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = rgba(COLORS.gold100, 0.62 * dim);
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.arc(0, 0, 3.4, 0, TAU);
  ctx.stroke();
  // 枢星的十字星芒（星图传统记号，不做大面积发光）
  ctx.strokeStyle = rgba(COLORS.gold200, 0.5 * dim);
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(-6.5, 0);
  ctx.lineTo(-2.2, 0);
  ctx.moveTo(2.2, 0);
  ctx.lineTo(6.5, 0);
  ctx.moveTo(0, -6.5);
  ctx.lineTo(0, -2.2);
  ctx.moveTo(0, 2.2);
  ctx.lineTo(0, 6.5);
  ctx.stroke();

  // 圭表（底座 + 立表 + 真实时刻投影）
  const baseY = hubR * 0.92;
  ctx.strokeStyle = rgba(COLORS.gold400, 0.34 * dim);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-hubR * 0.5, baseY);
  ctx.lineTo(hubR * 0.5, baseY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, baseY);
  ctx.lineTo(0, baseY - hubR * 0.34);
  ctx.stroke();
  const date = new Date();
  const hf = date.getHours() + date.getMinutes() / 60;
  const dayFrac = hf / 24;
  const sun = (dayFrac - 0.5) * TAU;
  const shadowLen = hubR * (0.2 + 0.32 * Math.abs(Math.cos(sun)));
  const shadowDir = Math.sin(sun) >= 0 ? 1 : -1;
  ctx.strokeStyle = rgba(COLORS.gold500, 0.28 * dim);
  ctx.beginPath();
  ctx.moveTo(0, baseY);
  ctx.lineTo(shadowLen * shadowDir, baseY);
  ctx.stroke();

  // 水漏钟摆（拍点派生相位）
  const pivotY = -hubR * 0.44;
  const rodLen = hubR * 0.62;
  const swing = beat.pendulum * (env.reducedMotion ? 0.22 : 0.44);
  const bobX = Math.sin(swing) * rodLen;
  const bobY = pivotY + Math.cos(swing) * rodLen;
  ctx.strokeStyle = rgba(COLORS.gold400, 0.4 * dim);
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(0, pivotY);
  ctx.lineTo(bobX, bobY);
  ctx.stroke();
  ctx.fillStyle = rgba(COLORS.gold300, 0.7 * dim);
  ctx.beginPath();
  ctx.arc(bobX, bobY, 1.7, 0, TAU);
  ctx.fill();
  // 摆动轨迹弧
  ctx.strokeStyle = rgba(COLORS.gold500, 0.1 * dim);
  ctx.beginPath();
  ctx.arc(0, pivotY, rodLen, Math.PI / 2 - 0.46, Math.PI / 2 + 0.46);
  ctx.stroke();
  // 水滴：每拍从水槽落下一滴（位置由拍内进度决定）
  const dropQ = clamp01((beat.q - 0.08) / 0.72);
  const dropY = lerp(-hubR * 0.98, baseY - hubR * 0.06, dropQ * dropQ);
  if (beat.q < 0.86) {
    ctx.fillStyle = rgba(COLORS.cold300, 0.5 * dim * (0.6 + 0.4 * (1 - dropQ)));
    ctx.beginPath();
    ctx.arc(0, dropY, 0.9, 0, TAU);
    ctx.fill();
  }
  // 落水微澜
  if (beat.q > 0.82) {
    const k = (beat.q - 0.82) / 0.18;
    ctx.strokeStyle = rgba(COLORS.cold300, 0.3 * dim * (1 - k));
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.arc(0, baseY - hubR * 0.06, 1 + k * 5, 0, TAU);
    ctx.stroke();
  }
}

// ———————————————————————————————————————————— §22.7 scifi 天穹

/** scifi 主题的天穹极细网格（12.8px，alpha .05–.07；屏幕空间；其他主题直接返回）。 */
export function drawSkyGrid(ctx: CanvasRenderingContext2D, env: Env): void {
  if (env.theme !== 'scifi' || env.quality < 0.45) return;
  const step = env.mobile ? 16 : 12.8;
  ctx.save();
  ctx.strokeStyle = rgba(COLORS.cold300, 0.05 + 0.02 * clamp01(env.fxWeight));
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let x = 0; x < env.w; x += step) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, env.h);
  }
  for (let y = 0; y < env.h; y += step) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(env.w, Math.round(y) + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}
