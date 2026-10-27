// XUANJI · 璇玑 — 不均匀节拍时钟（DESIGN-BIBLE §7）。
// 一切周期量从拍点/拍内进度派生；不使用 sin(t) 驱动主视觉。

import { EASE } from '../design/tokens';
import { clamp, clamp01, damp, TAU } from '../lib/math';
import type { BeatView, Env } from './types';

export interface BeatInputs {
  /** 近 1.5s 事件数 / 12 */
  eventBurst: number;
  /** aggregates.tokenRate（token/分钟量级） */
  tokenRate: number;
  liveCount: number;
  /** 选中/聚焦星近 10s 事件数 / 6 */
  focusEnergy: number;
  /** 距最近一次真实事件的毫秒数 */
  idleMs: number;
}

/** 擒纵环面：一拍内先走完 96.5%，最后 35% 时间只做「定住」微调。 */
export function ringCurve(q: number): number {
  const t = clamp01(q);
  if (t <= 0) return 0;
  if (t < 0.6) return EASE.out(t / 0.6) * 0.965;
  if (t < 0.84) return 0.965 + 0.035 * EASE.engrave((t - 0.6) / 0.24);
  // 8% 过冲回弹
  return 1 + 0.008 * Math.sin(((t - 0.84) / 0.16) * Math.PI);
}

export class BeatClock implements BeatView {
  /** 平滑后的能量 0..~1.6 */
  energy = 0.12;
  /** Hz */
  tempo = 0.34;
  /** 当前拍时长（秒） */
  interval = 1.7;
  sinceBeat = 1.1;
  q = 0.6;
  pulse = 0;
  strong = false;
  weak = false;
  pendulum = 0;
  idle = true;
  serial = 0;
  lastStep = 0.01;
  /** 拍序号（用于守夜呼吸相位） */
  beatIndex = 0;
  /** 最近一拍时刻（performance.now） */
  beatAt = 0;

  private weakCount = 6;
  private pulsePeak = 1;

  update(env: Env, input: BeatInputs): void {
    const p = env.params;
    const dt = env.dt;
    const idle = input.idleMs > 6000;
    this.idle = idle;

    const tokenTerm = Math.min(Math.max(input.tokenRate, 0), 55) * 0.02;
    let target =
      0.35 * clamp(input.eventBurst, 0, 1.5) +
      tokenTerm +
      0.08 * Math.min(Math.max(input.liveCount, 0), 10) +
      0.2 * clamp(input.focusEnergy, 0, 1.5);
    target = clamp(target, 0.05, 1.6);
    if (idle) target = Math.min(target, 0.12);
    this.energy = damp(this.energy, target, idle ? 0.9 : 2.4, dt);

    const tempoTarget = idle
      ? 0.3
      : clamp(0.28 + 0.95 * this.energy * p.tempoGain, 0.28, 1.9);
    this.tempo = damp(this.tempo, tempoTarget, idle ? 1.2 : 2.4, dt);

    this.sinceBeat += dt;
    if (this.sinceBeat >= this.interval) {
      this.sinceBeat -= this.interval;
      if (this.sinceBeat < 0) this.sinceBeat = 0;
      this.beatIndex += 1;
      this.serial += 1;
      this.beatAt = env.now;

      // —— 排下一拍：±jitter 抖动，每 7±3 拍弱拍，每 8 拍强拍
      let next = 1 / Math.max(0.05, this.tempo);
      next *= 1 + (Math.random() * 2 - 1) * p.jitter;
      this.strong = false;
      this.weak = false;
      if ((this.beatIndex + 1) % 8 === 0) {
        next *= 0.72;
        this.strong = true;
      } else {
        this.weakCount -= 1;
        if (this.weakCount <= 0) {
          next *= 1.55;
          this.weak = true;
          this.weakCount = 5 + Math.floor(Math.random() * 5);
        }
      }
      this.interval = clamp(next, 0.28, 3.6);
      this.q = 0;
      this.pulsePeak =
        (0.5 + 0.8 * p.beatEnergy) * (this.strong ? 1.5 : this.weak ? 0.62 : 1);
      this.pulse = this.pulsePeak;

      // 擒纵：一次 30° 内的推进量（rad），随能量与 ringSpeed 变化
      const stretch = 0.55 + 0.9 * clamp(this.energy, 0, 1.2);
      this.lastStep =
        (0.0042 + p.ringSpeed * 0.11) * stretch * (this.weak ? 0.55 : 1) * (this.strong ? 1.25 : 1);
    }

    this.q = clamp01(this.sinceBeat / this.interval);
    // 拍点抬升后按 pulseDecay 衰减（0 = 慢，1 = 快）
    this.pulse = damp(this.pulse, 0, 1.4 + p.pulseDecay * 6.5, dt);
    // 钟摆 = 两拍一个完整摆动，相位由拍点派生
    const phase = (this.beatIndex + this.q) * 0.5;
    this.pendulum = Math.cos(phase * TAU);
  }

  /** 守夜呼吸：连续 3 拍一次全局亮度 3% 起伏；非守夜为 1。 */
  get breathe(): number {
    if (!this.idle) return 1;
    const phase = (this.beatIndex / 3 + this.q / 3) * TAU;
    return 1 - 0.015 + 0.015 * Math.cos(phase);
  }

  /** 节拍给动态元素用的亮度乘子（reduced-motion 下幅度减半）。 */
  pulseGain(reduced: boolean): number {
    return 1 + this.pulse * (reduced ? 0.12 : 0.25);
  }
}
