// XUANJI · 璇玑 — 器数环（§18.4）：0.93–1.00R 的一圈微型数据块（每分野 7±2 块）。
// 机制借 haloflux 外圈卡片环：每块预渲染离屏缓存，每帧最多重绘 1 块、拍点作废 ≤4 块、屏幕外剔除。
// 数据全部取自该分野真实会话指标；冷月蓝 / 骨白为主，金只作极少量强调（金 ≤8%）。
// v2.1 §20.2：深度放大时按 zoom 档位重渲染（sharp），6× 下读数仍清晰。

import { COLORS, withAlpha } from '../design/tokens';
import { rgba } from './paint';
import { TAU, clamp, clamp01 } from '../lib/math';
import { rand01 } from './rand';
import type { ClientFleetSnapshot } from '../state/types';
import { GEOM, type Env, type SectorArc, type View } from './types';

interface SectorStat {
  id: string;
  live: number;
  ended: number;
  count: number;
  tokenRate: number;
  toolTotal: number;
  pressure: number;
  lastEventAgo: number;
  turns: number;
  steps: number;
}

interface MicroBlock {
  sectorId: string;
  /** 分野弧内局部角 0..1 */
  frac: number;
  /** 角宽（rad） */
  widthRad: number;
  /** 径向高度（css px） */
  height: number;
  type: number;
  seed: string;
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  dirty: boolean;
  /** 0..1 高亮衰减（事件 / 拍点作废） */
  flash: number;
}

const DEG = TAU / 360;
const GAP = 0.9 * DEG; // 块间缝 0.6–1.2°
const TYPE_COUNT = 12;

export class MicroSystem {
  /** 0.93–1.00R 的微型数据块；quality < 0.7 时整层关闭（§18.8） */
  enabled = true;
  stats = new Map<string, SectorStat>();
  blocks: MicroBlock[] = [];
  private arcs: SectorArc[] = [];
  private dirty: number[] = [];
  private built = false;
  private lastBeat = -1;
  private buildQuality = 1;
  private renderDpr = 1.5;
  /** v2.2 跨档交叉淡入：旧块保留 180ms 淡出（禁止清晰度硬切） */
  private fadeFrom: MicroBlock[] = [];
  private fadeStart = -1e9;

  /** 按快照统计每个分野的真实指标（会话 → 分野通过 sector.sessionIds 映射）。 */
  updateStats(snap: ClientFleetSnapshot, env: Env): void {
    const byId = new Map<string, SectorStat>();
    const make = (id: string): SectorStat => ({
      id,
      live: 0,
      ended: 0,
      count: 0,
      tokenRate: 0,
      toolTotal: 0,
      pressure: 0,
      lastEventAgo: 0,
      turns: 0,
      steps: 0,
    });
    for (const sec of snap.sectors) byId.set(sec.id, make(sec.id));
    const unknown = make('__orphan');
    const sessionSector = new Map<string, string>();
    for (const sec of snap.sectors) {
      for (const id of sec.sessionIds) sessionSector.set(id, sec.id);
    }
    for (const s of snap.sessions) {
      const sid = sessionSector.get(s.id);
      const stat = (sid ? byId.get(sid) : undefined) ?? unknown;
      stat.count += 1;
      if (s.state === 'live') stat.live += 1;
      if (s.state === 'ended') stat.ended += 1;
      if (s.state === 'live') stat.tokenRate += s.recentTokenRate;
      const tc = s.toolCounts;
      stat.toolTotal += tc.read + tc.write + tc.exec + tc.net + tc.agent;
      stat.pressure += s.contextPressure;
      stat.turns += s.turns;
      stat.steps += s.steps;
      stat.lastEventAgo = Math.max(stat.lastEventAgo, env.now - s.lastActivityAt);
    }
    for (const stat of byId.values()) {
      stat.pressure = stat.count > 0 ? stat.pressure / stat.count : 0;
      this.stats.set(stat.id, stat);
    }
    if (unknown.count > 0) {
      unknown.pressure /= unknown.count;
      this.stats.set('__orphan', unknown);
    }
    // 数据刷新：轮转作废几块，让数值随时间更新
    if (this.built && this.blocks.length > 0) {
      const n = Math.min(6, this.blocks.length);
      const start = Math.floor(env.now / 700) % this.blocks.length;
      for (let i = 0; i < n; i += 1) {
        const b = this.blocks[(start + i * 2) % this.blocks.length];
        if (b) this.markDirty(b);
      }
    }
  }

  /** 分野弧带变化 / 清晰度档位变化时重建整圈。 */
  rebuild(env: Env, arcs: SectorArc[], quality: number, sharp = 1): void {
    this.arcs = arcs;
    this.buildQuality = quality;
    this.renderDpr = clamp(1.5 * sharp, 1.5, 3.6);
    // v2.2 §21.1：跨档 180ms 交叉淡入（旧块淡出，不是硬切）
    this.fadeFrom = this.built && this.blocks.length > 0 ? this.blocks : [];
    this.fadeStart = env.now;
    this.blocks = [];
    this.dirty = [];
    this.enabled = quality >= 0.7;
    if (!this.enabled || arcs.length === 0) {
      this.built = false;
      return;
    }
    const halve = quality < 0.85;
    const rMid = env.R * ((GEOM.microIn + GEOM.microOut) / 2);
    for (const arc of arcs) {
      const stat = this.stats.get(arc.id);
      if (!stat) continue;
      const spanDeg = arc.span / DEG;
      const desired = halve ? 4 : 7 + Math.round(rand01(`mb-c:${arc.id}`) * 4);
      const fit = Math.max(1, Math.floor(spanDeg / (3.8 + GAP / DEG)));
      const n = Math.max(1, Math.min(desired, fit));
      for (let i = 0; i < n; i += 1) {
        const seed = `mb:${arc.id}:${i}`;
        const widthRad = (3.2 + rand01(`${seed}:w`) * 1.2) * DEG;
        const frac = 0.06 + ((i + 0.5) / n) * 0.88;
        const block: MicroBlock = {
          sectorId: arc.id,
          frac,
          widthRad,
          height: 10 + rand01(`${seed}:h`) * 8,
          type: Math.floor(rand01(`${seed}:t`) * TYPE_COUNT) % TYPE_COUNT,
          seed,
          canvas: document.createElement('canvas'),
          w: Math.max(8, Math.round(widthRad * rMid)),
          h: Math.round(10 + rand01(`${seed}:h`) * 8),
          dirty: true,
          flash: 0,
        };
        block.canvas.width = Math.max(1, Math.round(block.w * this.renderDpr));
        block.canvas.height = Math.max(1, Math.round(block.h * this.renderDpr));
        this.blocks.push(block);
      }
    }
    for (const b of this.blocks) this.renderBlock(b);
    this.built = true;
  }

  /** 事件点亮该分野的几个块（器用呼吸）。 */
  noteEvent(sectorId: string, env: Env): void {
    if (!this.built) return;
    const pool = this.blocks.filter((b) => b.sectorId === sectorId);
    if (pool.length === 0) return;
    for (let i = 0; i < 2; i += 1) {
      const pick = pool[Math.floor(rand01(`mb-ev:${sectorId}:${Math.floor(env.now / 90) + i}`) * pool.length)];
      if (!pick) continue;
      this.markDirty(pick);
      pick.flash = 1;
    }
  }

  private markDirty(b: MicroBlock): void {
    if (b.dirty) return;
    b.dirty = true;
    this.dirty.push(this.blocks.indexOf(b));
  }

  update(env: Env, view: View): void {
    if (!this.enabled || !this.built) return;
    // 拍点作废 ≤4 块（§18.4）
    if (view.beat.serial !== this.lastBeat) {
      this.lastBeat = view.beat.serial;
      const n = Math.min(4, this.blocks.length);
      for (let i = 0; i < n; i += 1) {
        const b = this.blocks[Math.floor(rand01(`mb-beat:${view.beat.serial}:${i}`) * this.blocks.length)];
        if (b) this.markDirty(b);
      }
    }
    // 每帧最多重绘 1 块
    if (this.dirty.length > 0) {
      const idx = this.dirty.shift();
      if (idx !== undefined) {
        const b = this.blocks[idx];
        if (b) {
          b.dirty = false;
          this.renderBlock(b);
        }
      }
    }
    // flash 衰减
    for (const b of this.blocks) {
      if (b.flash > 0) b.flash = Math.max(0, b.flash - env.dt * 1.8);
    }
  }

  /** 12 种微型仪表块型（柱/火花线/点阵/进度/伪文条/波形/小环/比例条/刻度尺/矩阵点/数字条/梳状）。 */
  private renderBlock(b: MicroBlock): void {
    const g = b.canvas.getContext('2d');
    if (!g) return;
    const dpr = this.renderDpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, b.w, b.h);
    const st = this.stats.get(b.sectorId);
    const w = b.w;
    const h = b.h;
    const live = st ? st.live : 0;
    const tokenRate = st ? st.tokenRate : 0;
    const pressure = st ? clamp01(st.pressure) : 0;
    const toolTotal = st ? st.toolTotal : 0;
    const cold = COLORS.cold300;
    const bone = COLORS.bone200;
    const gold = COLORS.gold300;
    const at = (i: number): number => rand01(`${b.seed}:v${i}`);
    // 共同「纸面」：底部一条极淡横刻线
    g.strokeStyle = rgba(cold, 0.16);
    g.lineWidth = 0.5;
    g.beginPath();
    g.moveTo(0, h - 0.5);
    g.lineTo(w, h - 0.5);
    g.stroke();
    switch (b.type) {
      case 0: {
        // 柱：4 根竖柱（工具量 / 卷帙 / 行 / 文速）
        const vals = [clamp01(toolTotal / 60), pressure, clamp01(live / 4), clamp01(tokenRate / 90)];
        const bw = Math.max(1, (w - 5) / 4);
        for (let i = 0; i < 4; i += 1) {
          const v = vals[i] ?? 0;
          const bh = Math.max(1.2, v * (h - 3));
          g.fillStyle = rgba(i === 1 && pressure > 0.7 ? gold : cold, 0.32 + 0.4 * v);
          g.fillRect(1 + i * bw, h - 1 - bh, Math.max(0.8, bw - 1.4), bh);
        }
        break;
      }
      case 1: {
        // 火花线：文速驱动的折线
        const pts = 9;
        g.strokeStyle = rgba(cold, 0.55);
        g.lineWidth = 0.8;
        g.beginPath();
        for (let i = 0; i < pts; i += 1) {
          const k = i / (pts - 1);
          const v = clamp01(
            0.35 + 0.45 * Math.sin((k + at(0)) * 3.1) * clamp01(tokenRate / 90) + (at(i) - 0.5) * 0.3,
          );
          const x = k * w;
          const y = h - 1.4 - v * (h - 3);
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
        g.fillStyle = rgba(bone, 0.6);
        g.fillRect(w - 1.2, h - 2.3 - clamp01(tokenRate / 90) * (h - 3), 1.2, 1.2);
        break;
      }
      case 2: {
        // 点阵：4×3，亮 = 近期有活动
        const cols = 4;
        const rows = 3;
        const cell = Math.min((w - 2) / cols, (h - 2) / rows);
        for (let r = 0; r < rows; r += 1) {
          for (let c = 0; c < cols; c += 1) {
            const on = rand01(`${b.seed}:dot${r}${c}`) < clamp01(0.25 + tokenRate / 120);
            g.fillStyle = rgba(on ? (c % 2 ? bone : cold) : bone, on ? 0.55 : 0.12);
            const sz = Math.max(0.9, cell * 0.5);
            g.fillRect(1 + c * cell + (cell - sz) / 2, 1 + r * cell + (cell - sz) / 2, sz, sz);
          }
        }
        break;
      }
      case 3: {
        // 进度：卷帙压力
        const v = pressure > 0.02 ? pressure : clamp01(toolTotal / 80);
        g.strokeStyle = rgba(cold, 0.24);
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(1, h / 2);
        g.lineTo(w - 1, h / 2);
        g.stroke();
        g.strokeStyle = rgba(pressure > 0.75 ? gold : bone, 0.6);
        g.beginPath();
        g.moveTo(1, h / 2);
        g.lineTo(1 + (w - 2) * v, h / 2);
        g.stroke();
        break;
      }
      case 4: {
        // 伪文条：像一页密集史料，长度按文速
        const lines = Math.max(3, Math.floor((h - 2) / 2.4));
        for (let i = 0; i < lines; i += 1) {
          const lw = (0.35 + at(i) * 0.6) * (w - 2);
          g.fillStyle = rgba(cold, 0.16 + 0.22 * clamp01(tokenRate / 90));
          g.fillRect(1, 1 + i * 2.4, lw, 0.8);
        }
        break;
      }
      case 5: {
        // 波形：双股（工具速率 / 文速合成）
        g.strokeStyle = rgba(cold, 0.4);
        g.lineWidth = 0.8;
        for (let s = 0; s < 2; s += 1) {
          g.beginPath();
          for (let i = 0; i <= 10; i += 1) {
            const k = i / 10;
            const amp = i % 2 === 0 ? 0.32 : -0.32;
            const v = 0.5 + amp * (0.5 + 0.5 * Math.sin(k * 5 + at(s))) * clamp01(0.4 + toolTotal / 100);
            const x = k * w;
            const y = h - 1.2 - v * (h - 2.4);
            if (i === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.stroke();
        }
        break;
      }
      case 6: {
        // 小环：live 占比
        const r = Math.min(w, h) * 0.34;
        const cx = w / 2;
        const cy = h / 2;
        g.strokeStyle = rgba(cold, 0.2);
        g.lineWidth = 1.2;
        g.beginPath();
        g.arc(cx, cy, r, 0, TAU);
        g.stroke();
        g.strokeStyle = rgba(gold, 0.65);
        g.lineWidth = 1.4;
        g.beginPath();
        g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * clamp01(live / 4));
        g.stroke();
        break;
      }
      case 7: {
        // 比例条：读/写/执行/其它 的工具量占比
        const parts = [0.34, 0.26, 0.24, 0.16];
        let x = 1;
        const scale = clamp01(toolTotal / 60 + 0.2);
        for (let i = 0; i < parts.length; i += 1) {
          const sw = (parts[i] ?? 0) * (w - 2) * scale;
          g.fillStyle = rgba(i === 0 ? bone : cold, 0.22 + 0.3 * (parts[i] ?? 0));
          g.fillRect(x, h / 2 - 1.6, Math.max(0.8, sw), 3.2);
          x += sw + 0.8;
        }
        break;
      }
      case 8: {
        // 刻度尺 + 指针：距最近事件（近 → 指针靠右）
        const ticks = Math.max(4, Math.floor(w / 3));
        g.strokeStyle = rgba(cold, 0.35);
        g.lineWidth = 0.5;
        g.beginPath();
        for (let i = 0; i < ticks; i += 1) {
          const x = 1 + (i / (ticks - 1)) * (w - 2);
          const tall = i % 3 === 0 ? 3.4 : 1.8;
          g.moveTo(x, h - 1);
          g.lineTo(x, h - 1 - tall);
        }
        g.stroke();
        const fresh = st ? clamp01(1 - st.lastEventAgo / 240000) : 0.2;
        g.strokeStyle = rgba(gold, 0.7);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(1 + fresh * (w - 2), h - 0.5);
        g.lineTo(1 + fresh * (w - 2), 2);
        g.stroke();
        break;
      }
      case 9: {
        // 矩阵点：3×3，大小随压力
        const cell = Math.min((w - 2) / 3, (h - 2) / 3);
        for (let r = 0; r < 3; r += 1) {
          for (let c = 0; c < 3; c += 1) {
            const v = clamp01(pressure * 1.1 + (at(r * 3 + c) - 0.5) * 0.4);
            g.fillStyle = rgba(v > 0.66 ? gold : bone, 0.2 + 0.42 * v);
            const sz = Math.max(0.9, cell * (0.28 + 0.34 * v));
            g.fillRect(1 + c * cell + (cell - sz) / 2, 1 + r * cell + (cell - sz) / 2, sz, sz);
          }
        }
        break;
      }
      case 10: {
        // 数字条：轮次数字拆成等宽短划（不伪造数值）
        const digits = String(Math.max(0, st ? st.turns : 0)).slice(-3).padStart(3, '0');
        const dw = (w - 2) / 3;
        for (let i = 0; i < 3; i += 1) {
          const n = Number(digits[i] ?? '0');
          const bars = Math.max(1, n);
          g.fillStyle = rgba(i === 2 ? gold : cold, 0.4);
          for (let k = 0; k < bars; k += 1) {
            g.fillRect(1 + i * dw + (dw - 2) * (k / bars), h - 1.4, Math.max(0.6, (dw - 2) / bars - 0.4), 1.2);
          }
        }
        break;
      }
      default: {
        // 梳状：密集竖齿，长度按 live 数
        const teeth = Math.max(5, Math.floor(w / 1.8));
        for (let i = 0; i < teeth; i += 1) {
          const tall = i % 2 === 0 ? 0.6 : 0.32;
          const v = clamp01(live / 4) * (h - 3) * tall + 1;
          g.fillStyle = rgba(i % 4 === 0 ? bone : cold, 0.22 + (0.2 * v) / h);
          g.fillRect(1 + (i / teeth) * (w - 2), h - 1 - v, 0.7, v);
        }
        break;
      }
    }
    // 金框：仅事件闪烁时出现（控制金面积）
    if (b.flash > 0.02) {
      g.strokeStyle = rgba(COLORS.gold200, 0.55 * b.flash);
      g.lineWidth = 0.8;
      g.strokeRect(0.4, 0.4, w - 0.8, h - 0.8);
    }
  }

  draw(ctx: CanvasRenderingContext2D, view: View, dim: number): void {
    if (!this.enabled || !this.built || this.blocks.length === 0) return;
    const env = view.env;
    const rMid = env.R * ((GEOM.microIn + GEOM.microOut) / 2);
    const arcById = new Map<string, SectorArc>();
    for (const a of view.arcs) arcById.set(a.id, a);
    // v2.3 性能：器数环在 0.93–1.00R，survey 下上下两端会出屏；按屏幕矩形剔除（不再只用 env.w 的圆半径）
    const cullX = env.cx / Math.max(0.6, env.zoom) + 60;
    const cullY = env.cy / Math.max(0.6, env.zoom) + 60;
    const pulse = view.beat.pulse;
    // §22.7 scifi：活跃块之间用虚线数据链串起来（科技语法，低饱和）
    if (env.theme === 'scifi') {
      ctx.save();
      ctx.strokeStyle = rgba(COLORS.cold300, 0.22 * dim * (0.5 + 0.5 * clamp01(env.fxWeight)));
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      let prevA = -1;
      for (const b of this.blocks) {
        if (b.flash < 0.04) continue;
        const arc = arcById.get(b.sectorId);
        if (!arc) continue;
        // v2.4 §23.3：scifi 下器数环以 1.25× 基准随势转（xuanji 时 skyRotFast ≡ skyRot）
      const a = env.skyRotFast + arc.start + b.frac * arc.span;
        if (prevA >= 0) {
          ctx.beginPath();
          ctx.arc(0, 0, rMid, prevA, a);
          ctx.stroke();
        }
        prevA = a;
      }
      ctx.setLineDash([]);
      ctx.restore();
    }
    for (const b of this.blocks) {
      const arc = arcById.get(b.sectorId);
      if (!arc) continue;
      // v2.4 §23.3：scifi 下器数环以 1.25× 基准随势转（xuanji 时 skyRotFast ≡ skyRot）
      const a = env.skyRotFast + arc.start + b.frac * arc.span;
      // §22.4 器数环每拍微抖 ≤0.5px（不是全环旋转）
      const phase = b.frac * 6.283 + b.type * 1.7;
      const jitter = Math.sin((env.now / 1000) * TAU * 0.31 + phase) * 0.5 * (0.4 + 0.6 * pulse);
      const x = Math.sin(a) * (rMid + jitter);
      const y = -Math.cos(a) * (rMid + jitter);
      if (Math.abs(x) > cullX || Math.abs(y) > cullY) continue;
      const alpha = clamp(0.34 + 0.16 * clamp01(b.flash + pulse * 0.35), 0.3, 0.72) * dim;
      if (alpha <= 0.02) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.globalAlpha = alpha;
      ctx.drawImage(b.canvas, -b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    // v2.2 跨档淡出：旧档位块 180ms 内叠在下面逐渐消失（§21.1）
    if (this.fadeFrom.length > 0) {
      const t = clamp01((env.now - this.fadeStart) / 180);
      if (t < 1) {
        for (const b of this.fadeFrom) {
          const arc = arcById.get(b.sectorId);
          if (!arc) continue;
          // v2.4 §23.3：scifi 下器数环以 1.25× 基准随势转（xuanji 时 skyRotFast ≡ skyRot）
      const a = env.skyRotFast + arc.start + b.frac * arc.span;
          const x = Math.sin(a) * rMid;
          const y = -Math.cos(a) * rMid;
          if (Math.abs(x) > cullX || Math.abs(y) > cullY) continue;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(a);
          ctx.globalAlpha = clamp(0.34 + 0.16 * clamp01(b.flash + pulse * 0.35), 0.3, 0.72) * dim * (1 - t);
          ctx.drawImage(b.canvas, -b.w / 2, -b.h / 2, b.w, b.h);
          ctx.restore();
        }
      } else {
        this.fadeFrom = [];
      }
    }
    void this.arcs;
    void this.buildQuality;
  }

  get blockCount(): number {
    return this.blocks.length;
  }
}
