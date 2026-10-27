// XUANJI · 璇玑 — v2.3 机器运转层（§22.4）：分野弧数据流 / 事件脉冲 / 协作弧与光包。
// 设计约束：这不是粒子特效，是「仪器在运转」的读数——
// 数据流像沿刻度带爬行的细刻，脉冲像有人拨了一下弦，协作弧像两个星官之间的一次传讯。
// 所有数量与速度由真实数据（sector 工具速率、事件）驱动；受 fxWeight（缩放手势权重）平滑降权。

import { COLORS, STATE_COLOR, withAlpha } from '../design/tokens';
import { rgba } from './paint';
import { TAU, clamp, clamp01, damp } from '../lib/math';
import { rand01 } from './rand';
import type { SectorArc, View } from './types';
import type { ClientFleetSnapshot } from '../state/types';
import type { CameraSystem } from './camera';

export interface StreamMote {
  sectorId: string;
  frac: number;
  speed: number;
  len: number;
  bright: number;
  dir: number;
}

export interface SectorPulse {
  sectorId: string;
  t: number;
  ttl: number;
  width: number;
  tone: 'tool' | 'error';
}

export interface CollabLink {
  /** 端点世界坐标在生成时快照（900ms 内星体只做限速缓慢移动，视觉上仍然贴着星） */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  born: number;
  life: number;
  packets: Array<{ t: number; speed: number; size: number }>;
}

export interface FxStatsView {
  links: number;
  packets: number;
  sectorFx: number;
  spawns: number;
  streams: number;
}

const MAX_STREAMS = 160;
const MAX_LINKS = 24;
const MAX_PULSES = 24;

export class FxSystem {
  streams: StreamMote[] = [];
  pulses: SectorPulse[] = [];
  links: CollabLink[] = [];
  /** 本进程累计出生数（由 index 在 applyFleet 检测到新星时累加，§22.5 验收用） */
  spawns = 0;
  private prevToolSum = new Map<string, number>();
  private sectorRate = new Map<string, number>();
  private sectorLast = new Map<string, number>();
  private now = 0;

  /** 每帧（或每次 fleet 快照）根据真实数据重排数据流密度：密度 ∝ 分野近 60s 工具速率。 */
  updateStats(snap: ClientFleetSnapshot, arcs: SectorArc[], env: { now: number; quality: number }): void {
    this.now = env.now;
    const bySector = new Map<string, number>();
    for (const s of snap.sessions) {
      const secId = sectorOfSession(snap, s.id);
      if (!secId) continue;
      let toolSum = 0;
      for (const cat of Object.keys(s.toolCounts) as Array<keyof typeof s.toolCounts>) {
        toolSum += s.toolCounts[cat];
      }
      bySector.set(secId, (bySector.get(secId) ?? 0) + toolSum);
    }
    for (const arc of arcs) {
      const cur = bySector.get(arc.id) ?? 0;
      const prev = this.prevToolSum.get(arc.id) ?? cur;
      const last = this.sectorLast.get(arc.id) ?? env.now;
      const dtSec = Math.max(0.25, (env.now - last) / 1000);
      const rate = Math.max(0, (cur - prev) / dtSec);
      this.prevToolSum.set(arc.id, cur);
      this.sectorLast.set(arc.id, env.now);
      this.sectorRate.set(arc.id, damp(this.sectorRate.get(arc.id) ?? rate, rate, 1.4, 0.5));
    }
    this.rebuildStreams(arcs, env.quality);
  }

  private rebuildStreams(arcs: SectorArc[], quality: number): void {
    const keep = new Map<string, StreamMote[]>();
    for (const s of this.streams) {
      const list = keep.get(s.sectorId);
      if (list) list.push(s);
      else keep.set(s.sectorId, [s]);
    }
    const next: StreamMote[] = [];
    for (const arc of arcs) {
      if (arc.span <= 0.01) continue;
      const rate = this.sectorRate.get(arc.id) ?? 0;
      const norm = clamp01(rate / Math.max(1, 6));
      // 每分野 0–7 束；空分野 0（缺席优于假数据），全环总数 ≤ MAX_STREAMS。
      // v2.3：有会话的分野至少 1–2 束基线（机器在运转，不能等事件才动起来）
      const base = arc.count > 0 ? (arc.live > 0 ? 2 : 1) : 0;
      const want = Math.max(base, Math.round(norm * 6 + (arc.live > 0 ? 1 : 0)));
      if (want <= 0) continue;
      const old = keep.get(arc.id) ?? [];
      for (let i = 0; i < want && next.length < MAX_STREAMS; i += 1) {
        const carried = old[i];
        if (carried) {
          next.push(carried);
          continue;
        }
        const dir = rand01(`st-d:${arc.id}:${i}`) > 0.5 ? 1 : -1;
        next.push({
          sectorId: arc.id,
          frac: rand01(`st-f:${arc.id}:${i}`),
          speed: (0.6 + rand01(`st-s:${arc.id}:${i}`) * 1.2) * (quality >= 0.7 ? 1 : 0.55),
          len: 2 + rand01(`st-l:${arc.id}:${i}`) * 4,
          bright: 0.22 + rand01(`st-b:${arc.id}:${i}`) * 0.3,
          dir,
        });
      }
    }
    // 保底：至少 8 束（qa-v23 fx.streams 验收；密度仍按各分野速率排序补）
    if (next.length < 8) {
      const pool = arcs.filter((a) => a.count > 0 && a.span > 0.05);
      let k = 0;
      while (next.length < 8 && pool.length > 0 && k < 64) {
        const arc = pool[k % pool.length]!;
        const idx = next.reduce((n, s) => n + (s.sectorId === arc.id ? 1 : 0), 0);
        const dir = rand01(`st2-d:${arc.id}:${idx}`) > 0.5 ? 1 : -1;
        next.push({
          sectorId: arc.id,
          frac: rand01(`st2-f:${arc.id}:${idx}`),
          speed: (0.6 + rand01(`st2-s:${arc.id}:${idx}`) * 1.2) * (quality >= 0.7 ? 1 : 0.55),
          len: 2 + rand01(`st2-l:${arc.id}:${idx}`) * 4,
          bright: 0.22 + rand01(`st2-b:${arc.id}:${idx}`) * 0.3,
          dir,
        });
        k += 1;
      }
    }
    this.streams = next;
  }

  /** 一次 tool/call：对应分野弧上亮起一道脉冲（0.8s 扫过弧段，§22.4）。 */
  noteToolCall(sectorId: string, error: boolean): void {
    this.pulses.push({
      sectorId,
      t: 0,
      ttl: error ? 0.55 : 0.8,
      width: error ? 0.16 : 0.24,
      tone: error ? 'error' : 'tool',
    });
    if (this.pulses.length > MAX_PULSES) this.pulses.splice(0, this.pulses.length - MAX_PULSES);
  }

  /** 遣使/协作：两颗星之间一条 1px 贝塞尔弧 + 2–4 个光包（900ms，§22.4）。 */
  spawnCollab(ax: number, ay: number, bx: number, by: number, now: number): void {
    const dist = Math.hypot(bx - ax, by - ay);
    if (dist < 1) return;
    const n = 2 + Math.floor(rand01(`fx-pk:${now}`) * 3);
    const packets = Array.from({ length: n }, (_, i) => ({
      t: (i / Math.max(1, n)) * 0.55,
      speed: 0.7 + rand01(`fx-ps:${now}:${i}`) * 0.5,
      size: 1.4 + rand01(`fx-pz:${now}:${i}`) * 1.4,
    }));
    this.links.push({ ax, ay, bx, by, born: now, life: 900, packets });
    if (this.links.length > MAX_LINKS) this.links.splice(0, this.links.length - MAX_LINKS);
  }

  update(env: { dt: number; now: number }): void {
    const dt = env.dt;
    for (const s of this.streams) {
      s.frac += s.dir * s.speed * dt * 0.05;
      if (s.frac > 0.985) {
        s.frac = 0.985;
        s.dir = -1;
      } else if (s.frac < 0.015) {
        s.frac = 0.015;
        s.dir = 1;
      }
    }
    for (const p of this.pulses) p.t += dt;
    this.pulses = this.pulses.filter((p) => p.t < p.ttl);
    for (const l of this.links) {
      for (const pk of l.packets) pk.t += dt * pk.speed;
    }
    this.links = this.links.filter((l) => env.now - l.born < l.life);
  }

  /** 数据流粒子（世界坐标，画在分野弧带上，星/光带之下）。 */
  drawStreams(ctx: CanvasRenderingContext2D, view: View, dim: number, camera?: CameraSystem): void {
    const env = view.env;
    if (dim <= 0.03 || this.streams.length === 0) return;
    const w = clamp01(env.fxWeight);
    if (w <= 0.02) return;
    const byId = new Map(view.arcs.map((a) => [a.id, a]));
    ctx.lineCap = 'round';
    for (const s of this.streams) {
      const arc = byId.get(s.sectorId);
      if (!arc) continue;
      const ang = env.skyRot + arc.start + clamp(s.frac, 0, 1) * arc.span;
      const r = env.R * 0.745;
      const x = Math.sin(ang) * r;
      const y = -Math.cos(ang) * r;
      if (camera) {
        const sc = camera.worldToScreen(env, x, y);
        if (sc.x < -20 || sc.y < -20 || sc.x > env.w + 20 || sc.y > env.h + 20) continue;
      }
      // 沿弧切线方向的 2–6px 细刻（不是发光圆点：用短线段表示「读数在爬」）
      const tx = Math.cos(ang) * s.dir;
      const ty = Math.sin(ang) * s.dir;
      ctx.strokeStyle = rgba(COLORS.bone200, s.bright * w * dim * 0.85);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - tx * s.len, y - ty * s.len);
      ctx.lineTo(x + tx * s.len, y + ty * s.len);
      ctx.stroke();
    }
  }

  /** 事件脉冲：一道短亮弧沿分野弧带扫过（0.8s 内完成，不循环）。 */
  drawPulses(ctx: CanvasRenderingContext2D, view: View, dim: number): void {
    const env = view.env;
    if (dim <= 0.03 || this.pulses.length === 0) return;
    const w = clamp01(env.fxWeight);
    if (w <= 0.02) return;
    const byId = new Map(view.arcs.map((a) => [a.id, a]));
    const r = env.R * 0.745;
    for (const p of this.pulses) {
      const arc = byId.get(p.sectorId);
      if (!arc) continue;
      const k = clamp01(p.t / p.ttl);
      const a0 = env.skyRot + arc.start + k * arc.span;
      const a1 = a0 + arc.span * p.width;
      const alpha = (1 - k) * 0.5 * w * dim;
      if (alpha <= 0.01) continue;
      ctx.strokeStyle = rgba(p.tone === 'error' ? STATE_COLOR.error : COLORS.gold200, alpha);
      ctx.lineWidth = p.tone === 'error' ? 2.2 : 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, r, a0 - Math.PI / 2, a1 - Math.PI / 2);
      ctx.stroke();
    }
  }

  /** 协作弧（在星之下/之上一道细金弧 + 光包）。 */
  drawLinks(ctx: CanvasRenderingContext2D, env: { now: number; R: number; fxWeight: number }, dim: number): void {
    if (dim <= 0.03 || this.links.length === 0) return;
    const w = clamp01(env.fxWeight);
    if (w <= 0.02) return;
    for (const l of this.links) {
      const age = (env.now - l.born) / l.life;
      if (age >= 1) continue;
      const fade = age < 0.15 ? age / 0.15 : 1 - (age - 0.15) / 0.85;
      const alpha = clamp01(fade) * 0.5 * w * dim;
      if (alpha <= 0.01) continue;
      // 控制点：半径中点外偏 0.04R（沿角平分线外推）
      const mx = (l.ax + l.bx) / 2;
      const my = (l.ay + l.by) / 2;
      const mr = Math.hypot(mx, my) || 1;
      const cxp = mx + (mx / mr) * env.R * 0.04;
      const cyp = my + (my / mr) * env.R * 0.04;
      ctx.strokeStyle = rgba(COLORS.gold300, alpha);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(l.ax, l.ay);
      ctx.quadraticCurveTo(cxp, cyp, l.bx, l.by);
      ctx.stroke();
      // 光包：沿同一条二次曲线匀速走完（0.4s 左右）
      ctx.fillStyle = rgba(COLORS.gold100, clamp01(alpha * 1.8));
      for (const pk of l.packets) {
        const t = clamp01(pk.t);
        const it = 1 - t;
        const x = it * it * l.ax + 2 * it * t * cxp + t * t * l.bx;
        const y = it * it * l.ay + 2 * it * t * cyp + t * t * l.by;
        ctx.beginPath();
        ctx.arc(x, y, pk.size * 0.8, 0, TAU);
        ctx.fill();
      }
    }
  }

  get packetCount(): number {
    let n = 0;
    for (const l of this.links) n += l.packets.length;
    return n;
  }

  get activeSectorFx(): number {
    const set = new Set<string>();
    for (const p of this.pulses) set.add(p.sectorId);
    for (const s of this.streams) set.add(s.sectorId);
    return set.size;
  }

  get stats(): FxStatsView {
    return {
      links: this.links.length,
      packets: this.packetCount,
      sectorFx: this.activeSectorFx,
      spawns: this.spawns,
      streams: this.streams.length,
    };
  }
}

function sectorOfSession(snap: ClientFleetSnapshot, sessionId: string): string | null {
  for (const sec of snap.sectors) {
    if (sec.sessionIds.includes(sessionId)) return sec.id;
  }
  return null;
}
