// XUANJI · 璇玑 — 整机遥测数值格式化
// 只做单位/百分比的呈现，不做任何估算或补全：拿不到的数字一律「—」。
import type { SystemSnapshot } from '../state/types';

/** 0..1 → 「23%」；非有限值 →「—」 */
export function fmtPct(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  const clamped = Math.max(0, Math.min(1, ratio));
  return `${Math.round(clamped * 100)}%`;
}

/** 字节数 → 「1.24 GB」/「512 MB」；单位默认 1024 进位 */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  let value = Math.max(0, n);
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const fixed = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(fixed)} ${units[index]}`;
}

/** 字节/秒 → 「1.24 GB/s」 */
export function fmtRate(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return '—';
  return `${fmtBytes(bps)}/s`;
}

/** 秒 → 「3 日 2 时」「2 时 14 分」「14 分」 */
export function fmtUptime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const total = Math.floor(sec);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days} 日 ${hours} 时`;
  if (hours > 0) return `${hours} 时 ${minutes} 分`;
  return `${minutes} 分`;
}

/** 电池 → 「87%」；无电池 → null（调用方决定显不显示） */
export function fmtBattery(system: SystemSnapshot | null | undefined): string | null {
  const battery = system?.battery;
  if (!battery || !Number.isFinite(battery.percent)) return null;
  return `${Math.round(Math.max(0, Math.min(100, battery.percent)))}%`;
}

/** 网络上下行并排 →「↓1.2 MB/s ↑96 kB/s」 */
export function fmtNetPair(rxBps: number | null | undefined, txBps: number | null | undefined): string {
  return `↓${fmtRate(rxBps)} ↑${fmtRate(txBps)}`;
}

/** 紧凑速率（顶栏用）→「405k/s」「1.2M/s」；拿不到 →「—」 */
export function fmtRateCompact(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps) || bps < 0) return '—';
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(bps >= 10 * 1024 * 1024 ? 0 : 1)}M/s`;
  if (bps >= 1024) return `${Math.round(bps / 1024)}k/s`;
  return `${Math.round(bps)}B/s`;
}

/** 极紧凑速率（顶栏网速用）→「405k」「1.2M」；拿不到 →「—」 */
export function fmtRateTiny(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps) || bps < 0) return '—';
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(bps >= 10 * 1024 * 1024 ? 0 : 1)}M`;
  if (bps >= 1024) return `${Math.round(bps / 1024)}k`;
  return `${Math.round(bps)}B`;
}

/** 极紧凑上下行（顶栏用，单位见 title）→「↓405k ↑27k」 */
export function fmtNetPairCompact(
  rxBps: number | null | undefined,
  txBps: number | null | undefined,
): string {
  const rx = fmtRateTiny(rxBps);
  const tx = fmtRateTiny(txBps);
  return `↓${rx} ↑${tx}`;
}
