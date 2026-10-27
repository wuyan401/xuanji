// XUANJI · 璇玑 — 场景内确定性随机。
// lib/math 的 hash01 对「前缀相同、仅末字符不同」的短 seed 雪崩不足
// （例如 `sfm-a0..sfm-a11` 会落在相邻角度上，导致星野锚点/星角聚成一串），
// 这里在 FNV-1a 之后补一轮 murmur3 风格的 finalizer，保证视觉分布均匀且确定性不变。

import { hash32 } from '../lib/math';

/** 0..1 确定性随机（带雪崩混合）。 */
export function rand01(seed: string): number {
  let h = hash32(seed);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** [min,max) 确定性随机。 */
export function randRange(seed: string, min: number, max: number): number {
  return min + rand01(seed) * (max - min);
}

/** -1..1 确定性随机。 */
export function randSigned(seed: string): number {
  return rand01(seed) * 2 - 1;
}
