// XUANJI · 璇玑 — 共享数学/缓动工具（Lead 维护；scene 与 hud 都可直接用，禁止重复实现）

export const TAU = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function remap(v: number, a0: number, a1: number, b0: number, b1: number): number {
  return lerp(b0, b1, clamp01(invLerp(a0, a1, v)));
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** 指数趋近（与帧率无关的平滑）：lambda 越大越快，常用 4–14 */
export function damp(current: number, target: number, lambda: number, dtSeconds: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dtSeconds));
}

/** 角度最短路径插值 */
export function dampAngle(current: number, target: number, lambda: number, dtSeconds: number): number {
  let d = (target - current) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return current + d * (1 - Math.exp(-lambda * dtSeconds));
}

export function fract(v: number): number {
  return v - Math.floor(v);
}

/** 确定性 32-bit hash（FNV-1a），用于星的角度/相位抖动 */
export function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 0..1 确定性哈希 */
export function hash01(str: string): number {
  return hash32(str) / 4294967296;
}

/** 0..1 确定性哈希（带盐） */
export function hashRange(str: string, salt: number, min: number, max: number): number {
  return min + (hash01(str + ':' + salt) % 1) * (max - min);
}

/** 极坐标 → 笛卡尔（角度从 12 点方向顺时针，y 向下为正的屏幕系） */
export function polarToXY(cx: number, cy: number, r: number, angle: number): { x: number; y: number } {
  return { x: cx + Math.sin(angle) * r, y: cy - Math.cos(angle) * r };
}

/** 缓入缓出三次 */
export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** 常用的「先快后极慢定住」：运镜转场用 */
export function easePushIn(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 4);
}
