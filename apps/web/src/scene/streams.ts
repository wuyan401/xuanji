// XUANJI · 璇玑 — v2.4 工作光流（work stream：star → core）
// 设计权威：DESIGN-BIBLE §23.1。每颗「在行」的星长出一根脐带：
//   connect（320ms 亮头由星体边缘画向中枢）→ stream（底线 + 流向中枢的粒子）→ disconnect（320ms 回收）。
// 颜色全部读 BEAM_TINT（applyTheme 就地改写），scene 内不得硬编码。
// 性能：流 ≤64（quality<0.7→24、<0.85→40）；每流粒子 ≤6；禁 shadowBlur。

import { BEAM_TINT } from '../design/themes';
import { clamp, clamp01, TAU } from '../lib/math';
import { rand01 } from './rand';
import { rgba } from './paint';
import type { EffectsSystem } from './effects';
import type { StarSystem } from './stars';
import type { BeatView, Env, StarNode } from './types';

const CONNECT_MS = 320;
const DISCONNECT_MS = 320;
/** 中枢紫宫外径（§23.1：星心 → 0.10R） */
const CORE_EDGE = 0.1;

interface Packet {
  /** 归一化位置 0=星侧 → 1=中枢边缘 */
  t: number;
  /** 归一化速度（每秒 t 增量） */
  speed: number;
  len: number;
  width: number;
  alpha: number;
}

interface StreamRow {
  id: string;
  /** 0=connect 1=stream 2=disconnect */
  phase: 0 | 1 | 2;
  phaseAt: number;
  packets: Packet[];
  acc: number;
  /** 强拍加粗截止时间 */
  boostUntil: number;
  /** 路径中弧曲（rad，≤0.02） */
  bend: number;
  /** 上次 beat.serial（强拍每流一次） */
  lastBeat: number;
}

export interface WorkStreamStats {
  active: number;
  connecting: number;
  disconnecting: number;
  packets: number;
}

export class WorkStreamSystem {
  private rows = new Map<string, StreamRow>();
  private pktSeq = 0;
  private statsView: WorkStreamStats = { active: 0, connecting: 0, disconnecting: 0, packets: 0 };
  private connectMs = CONNECT_MS;
  private disconnectMs = DISCONNECT_MS;

  get stats(): WorkStreamStats {
    return this.statsView;
  }

  /** 每帧更新：资格判定 → 相位推进 → 粒子推进 → 统计。 */
  update(
    env: Env,
    api: StarSystem,
    beat: BeatView,
    dt: number,
    effects: EffectsSystem,
    tokenRate: number,
    toolRate: number,
  ): void {
    const reduced = env.reducedMotion;
    this.connectMs = reduced ? 200 : CONNECT_MS;
    this.disconnectMs = reduced ? 200 : DISCONNECT_MS;
    const cap = env.quality < 0.7 ? 24 : env.quality < 0.85 ? 40 : 64;

    // —— 资格：live 且近 90s 有活动；按活跃度排序取前 cap 名
    const live: StarNode[] = [];
    for (const star of api.stars) {
      if (star.session.state !== 'live') continue;
      const last = star.session.lastActivityAt ?? 0;
      if (env.now - last > 90000 && !star.session.openStep) continue;
      live.push(star);
    }
    live.sort((a, b) => this.activityOf(b) - this.activityOf(a));
    const allowed = new Set<string>();
    for (let i = 0; i < Math.min(cap, live.length); i += 1) {
      const s = live[i];
      if (s) allowed.add(s.id);
    }

    // —— 相位推进
    for (const star of live) {
      const id = star.id;
      let row = this.rows.get(id);
      if (allowed.has(id)) {
        if (!row) {
          row = {
            id,
            phase: 0,
            phaseAt: env.now,
            packets: [],
            acc: 0,
            boostUntil: 0,
            bend: (rand01(`bend:${id}`) - 0.5) * 0.04,
            lastBeat: -1,
          };
          this.rows.set(id, row);
          // 星侧起点 6px 闪点 + 一次 r=0.02R 涟漪
          const p = this.startPoint(env, api, star);
          effects.spawnRipple(p.x, p.y, env, BEAM_TINT.connect, 1.5, env.R * 0.02, reduced ? 260 : 560);
        } else if (row.phase === 2) {
          row.phase = 0;
          row.phaseAt = env.now;
          row.acc = 0;
        } else if (row.phase === 0 && env.now - row.phaseAt >= this.connectMs) {
          row.phase = 1;
          row.phaseAt = env.now;
        }
      } else if (row && row.phase !== 2) {
        row.phase = 2;
        row.phaseAt = env.now;
      }
    }
    // 不再是 live 的旧流：进入断开（ended 2s 内断开完毕）
    for (const [id, row] of this.rows) {
      if (row.phase === 2) continue;
      if (allowed.has(id)) continue;
      const star = api.find(id);
      if (!star || star.session.state !== 'live') {
        row.phase = 2;
        row.phaseAt = env.now;
      }
    }

    // —— 粒子与相位衰减
    const density = clamp(2 + tokenRate / 12 + toolRate * 6, 2, 12);
    const packetCap = reduced ? 3 : 6;
    for (const [id, row] of this.rows) {
      if (row.phase === 2) {
        if (env.now - row.phaseAt >= this.disconnectMs) this.rows.delete(id);
        continue;
      }
      if (row.phase === 0) continue;
      const star = api.find(id);
      if (!star) {
        row.phase = 2;
        row.phaseAt = env.now;
        continue;
      }
      const p0 = this.startPoint(env, api, star);
      const dist = Math.max(1, Math.hypot(p0.x, p0.y) - env.R * CORE_EDGE);
      // 强拍：本流一次加粗（≤160ms，不循环闪）
      if (beat.strong && beat.serial !== row.lastBeat) {
        row.lastBeat = beat.serial;
        row.boostUntil = env.now + 160;
      }
      row.acc += density * dt * (reduced ? 0.5 : 1);
      while (row.acc >= 1) {
        row.acc -= 1;
        if (row.packets.length >= packetCap) break;
        this.pktSeq += 1;
        const seed = `pkt:${id}:${this.pktSeq}`;
        const speedR = (0.22 + rand01(`ps:${seed}`) * 0.16) * (reduced ? 0.5 : 1);
        row.packets.push({
          t: 0.015,
          speed: (speedR * env.R) / dist,
          len: 3 + rand01(`pl:${seed}`) * 2,
          width: 1.25 + rand01(`pw:${seed}`) * 0.35,
          alpha: 0.52 + rand01(`pa:${seed}`) * 0.18,
        });
      }
      for (const p of row.packets) p.t += p.speed * dt;
      // 到达中枢后消散
      row.packets = row.packets.filter((p) => p.t <= 1.02);
    }

    // —— 统计快照
    let active = 0;
    let connecting = 0;
    let disconnecting = 0;
    let packets = 0;
    for (const row of this.rows.values()) {
      if (row.phase === 1) active += 1;
      else if (row.phase === 0) connecting += 1;
      else disconnecting += 1;
      packets += row.packets.length;
    }
    this.statsView = { active, connecting, disconnecting, packets };
  }

  /** 工具光束改锚：返回该星流上 t∈[0.25,0.85] 的世界坐标（无流返回 null）。 */
  pointOn(env: Env, api: StarSystem, id: string, t: number): { x: number; y: number } | null {
    const row = this.rows.get(id);
    if (!row || row.phase === 2) return null;
    const star = api.find(id);
    if (!star) return null;
    const p0 = this.startPoint(env, api, star);
    const coreR = env.R * CORE_EDGE;
    const len = Math.max(1, Math.hypot(p0.x, p0.y));
    const end = { x: (p0.x / len) * coreR, y: (p0.y / len) * coreR };
    const ctl = this.controlPoint(p0, end, row.bend);
    return this.qpoint(p0, ctl, end, clamp01(t));
  }

  /** 世界层绘制（在 camera.apply 内调用）。 */
  draw(ctx: CanvasRenderingContext2D, env: Env, api: StarSystem, dim = 1): void {
    const now = env.now;
    const coreR = env.R * CORE_EDGE;
    ctx.save();
    for (const row of this.rows.values()) {
      const star = api.find(row.id);
      if (!star) continue;
      const p0 = this.startPoint(env, api, star);
      const len = Math.hypot(p0.x, p0.y);
      if (len <= coreR + 2) continue;
      const end = { x: (p0.x / len) * coreR, y: (p0.y / len) * coreR };
      const ctl = this.controlPoint(p0, end, row.bend);
      const pathLen = Math.max(8, len - coreR);
      const boosting = now < row.boostUntil;
      const boost = boosting ? 1.35 : 1;
      const boostA = boosting ? 1.5 : 1;

      if (row.phase === 0) {
        // connect：亮头由星体边缘画向中枢，alpha 1→0.55
        const p = clamp01((now - row.phaseAt) / this.connectMs);
        const e = 1 - (1 - p) * (1 - p) * (1 - p);
        this.strokePartial(ctx, p0, ctl, end, 0, e, rgba(BEAM_TINT.connect, (1 - e * 0.45) * 0.95 * dim), 2.2);
        const head = this.qpoint(p0, ctl, end, e);
        ctx.fillStyle = rgba(BEAM_TINT.connect, 0.95 * dim);
        ctx.beginPath();
        ctx.arc(head.x, head.y, 2.1, 0, TAU);
        ctx.fill();
        // 星侧 6px 闪点
        ctx.fillStyle = rgba(BEAM_TINT.particle, (1 - p) * 0.9 * dim);
        ctx.beginPath();
        ctx.arc(p0.x, p0.y, 3, 0, TAU);
        ctx.fill();
      } else if (row.phase === 1) {
        // stream：底线 1.2px（alpha 0.10–0.16）+ 流向中枢的粒子
        const breathe = 0.155 + 0.005 * Math.sin(now / 1000 + row.bend * 90);
        ctx.strokeStyle = rgba(BEAM_TINT.stream, clamp(breathe, 0.1, 0.16) * boostA * dim);
        ctx.lineWidth = 1.2 * boost;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.quadraticCurveTo(ctl.x, ctl.y, end.x, end.y);
        ctx.stroke();
        for (const p of row.packets) {
          const t1 = clamp01(p.t);
          const t0 = clamp01(p.t - p.len / pathLen);
          const a = this.qpoint(p0, ctl, end, t0);
          const b = this.qpoint(p0, ctl, end, t1);
          ctx.strokeStyle = rgba(BEAM_TINT.particle, clamp01(p.alpha * boostA) * dim);
          ctx.lineWidth = p.width * boost;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      } else {
        // disconnect：粒子停发，底线从中枢侧向星侧退淡；末端 180ms 收束闪光
        const p = clamp01((now - row.phaseAt) / this.disconnectMs);
        const alive = 1 - p;
        if (alive > 0.02) {
          // 回收中的底线：颜色由 stream 向 disconnect 过渡，alpha 随回收衰减——能看见「退」的过程
          const mix = clamp01(alive);
          this.strokePartial(ctx, p0, ctl, end, 0, alive, rgba(this.mixHex(BEAM_TINT.disconnect, BEAM_TINT.stream, mix), clamp(0.14 + 0.14 * alive, 0.2, 0.28) * dim), 1.35);
          for (const pt of row.packets) {
            const t1 = clamp01(pt.t);
            const a = this.qpoint(p0, ctl, end, Math.max(0, t1 - 0.02));
            const b = this.qpoint(p0, ctl, end, t1);
            ctx.strokeStyle = rgba(BEAM_TINT.particle, clamp01(pt.alpha * alive * 0.6) * dim);
            ctx.lineWidth = pt.width;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
        if (p > 0.55) {
          const f = (p - 0.55) / 0.45;
          ctx.fillStyle = rgba(BEAM_TINT.connect, (1 - f) * 0.72 * dim);
          ctx.beginPath();
          ctx.arc(p0.x, p0.y, 2.2 + 5.5 * f, 0, TAU);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // ————————————————————————————————————————————— 路径与几何

  private activityOf(star: StarNode): number {
    const s = star.session;
    return (s.recentTokenRate ?? 0) + (s.openStep ? 0.4 : 0) + (s.pendingCalls?.length ?? 0) * 0.2;
  }

  /** 星体边缘（朝中枢一侧）作为流的起点，随轨道每帧重算。 */
  private startPoint(env: Env, api: StarSystem, star: StarNode): { x: number; y: number } {
    const c = api.worldPos(star);
    const len = Math.max(1, Math.hypot(c.x, c.y));
    const rs = Math.max(env.R * CORE_EDGE + 2, len - star.r - 1);
    return { x: (c.x / len) * rs, y: (c.y / len) * rs };
  }

  /** 中点弧曲：控制点沿切向偏移 sin(bend)·路径长/2，≤0.02rad 的轻微弧。 */
  private controlPoint(
    p0: { x: number; y: number },
    end: { x: number; y: number },
    bend: number,
  ): { x: number; y: number } {
    const mx = (p0.x + end.x) / 2;
    const my = (p0.y + end.y) / 2;
    const mr = Math.max(1, Math.hypot(mx, my));
    const tx = my / mr;
    const ty = -mx / mr;
    const off = Math.sin(bend) * Math.hypot(end.x - p0.x, end.y - p0.y) * 0.5;
    return { x: mx + tx * off, y: my + ty * off };
  }

  private qpoint(
    p0: { x: number; y: number },
    c: { x: number; y: number },
    p1: { x: number; y: number },
    t: number,
  ): { x: number; y: number } {
    const u = 1 - t;
    return {
      x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
    };
  }

  /** 两个 hex 颜色按 t 线性混合（t=0 → a，t=1 → b）；6 行流每帧各一次，开销可忽略。 */
  private mixHex(a: string, b: string, t: number): string {
    const k = Math.max(0, Math.min(1, t));
    const ar = parseInt(a.slice(1, 3), 16);
    const ag = parseInt(a.slice(3, 5), 16);
    const ab = parseInt(a.slice(5, 7), 16);
    const br = parseInt(b.slice(1, 3), 16);
    const bg = parseInt(b.slice(3, 5), 16);
    const bb = parseInt(b.slice(5, 7), 16);
    const r = Math.round(ar + (br - ar) * k);
    const g = Math.round(ag + (bg - ag) * k);
    const bl = Math.round(ab + (bb - ab) * k);
    const h = (v: number) => v.toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(bl)}`;
  }

  /** 采样绘制二次贝塞尔的一段（t0..t1）。 */
  private strokePartial(
    ctx: CanvasRenderingContext2D,
    p0: { x: number; y: number },
    c: { x: number; y: number },
    p1: { x: number; y: number },
    t0: number,
    t1: number,
    color: string,
    width: number,
  ): void {
    const steps = Math.max(2, Math.ceil((t1 - t0) * 14));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i <= steps; i += 1) {
      const t = t0 + ((t1 - t0) * i) / steps;
      const p = this.qpoint(p0, c, p1, t);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
}
