// XUANJI · 璇玑 — 颜色字符串缓存。
// 热循环里每帧要拼上千个 rgba() 字符串；withAlpha() 每次都要解析 hex 并拼接，
// 在 389 颗星 / 36 分野的真实数据下会成为可观的 CPU 开销。
// 这里按 (hex, alpha 量化 1/64) 记忆化，alpha 量化对肉眼不可见。
import { withAlpha } from '../design/tokens';

const cache = new Map<string, string>();

export function rgba(hex: string, alpha: number): string {
  const q = Math.round(Math.max(0, Math.min(1, alpha)) * 64) / 64;
  const key = `${hex}|${q}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = withAlpha(hex, q);
  cache.set(key, value);
  return value;
}
