// XUANJI · 璇玑 — 星层：会话 → 星（布局 / 径向层级 / 轨道混沌 / 防重合 / 状态双编码 / 出生退场）。
// 约束：单 Canvas 热循环，不逐星建渐变/阴影；视觉量只改目标值再 damp；
// 单帧角位移/径向位移/alpha 限速（§22.1），避免「闪烁 / 错位」。
import { COLORS, STATE_COLOR, FONTS } from '../design/tokens';
import { rgba } from './paint';
import { TAU, clamp, clamp01, damp, dampAngle } from '../lib/math';
import { truncate } from '../lib/format';
import { rand01 } from './rand';
import {
  GEOM,
  textScreenGrow,
  type Env,
  type Mark,
  type SectorArc,
  type SatelliteMote,
  type StarNode,
  type View,
} from './types';
import type { AgentSession, ClientFleetSnapshot } from '../state/types';
import type { CameraSystem } from './camera';

const ORBIT_TABLE = [1.0, 0.63, 0.41, 0.78, 0.52, 0.33];
const MIN_GAP_RAD = (0.6 * Math.PI) / 180;
const MAX_STARS = 400;
const TELEPORT_ANGLE = 0.02;
const TELEPORT_RADIUS = 3;
const MAX_ALPHA_STEP = 0.06;
const MAX_ANGLE_RATE = 0.004;
const MAX_ANGLE_STEP = 0.019;
const RING_GUARD = 0.18;
const MOTION_WINDOW = 200;

interface SectorDraft {
  id: string;
  name: string;
  path: string;
  source: string;
  sessionIds: string[];
  count: number;
  live: number;
  ended: number;
  weight: number;
  units: number;
}

interface Bucket {
  star: StarNode;
  want: number;
  u: number;
}

/** 星体半径：由累计 output tokens 决定（§18.2）。 */
function starRadius(tokens: number): number {
  return clamp(2.6 + Math.log10(tokens + 1) * 1.25, 2.6, 10);
}

/** 同名分野的路径尾缀（取 path 倒数第二段，如 `AI/`）。 */
function pathSuffix(path: string): string {
  if (!path) return '';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return '';
  const seg = parts[parts.length - 2] ?? '';
  return seg ? `${seg}/` : '';
}

/** 选中四角刻的相位（拍点派生）。 */
function phaseOf(now: number): number {
  return (now / 1000) * 0.12;
}

function wrapAngle(a: number): number {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  if (x < -Math.PI) x += TAU;
  return x;
}

/** 秩相关（Spearman）：-1..1；用于 §22.3 径向层级校验。 */
function spearman(pairs: Array<{ a: number; b: number }>): number {
  const n = pairs.length;
  if (n < 3) return 0;
  const rank = (values: number[]): number[] => {
    const idx = values.map((v, i) => ({ v, i }));
    idx.sort((x, y) => x.v - y.v);
    const out = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) out[idx[i]!.i] = i;
    return out;
  };
  const ra = rank(pairs.map((p) => p.a));
  const rb = rank(pairs.map((p) => p.b));
  const mean = (n - 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = (ra[i] ?? 0) - mean;
    const y = (rb[i] ?? 0) - mean;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

/** 来源色（1px 识别用，保持与 state/types 同语义）。 */
function sourceTint(source: string): string {
  switch (source) {
    case 'dsh':
      return COLORS.gold300;
    case 'hermes':
      return COLORS.patina300;
    case 'opencode':
      return COLORS.indigo400;
    case 'claude':
      return COLORS.gold400;
    default:
      return COLORS.bone400;
  }
}

/** 来源短名（同名分野区分用）。 */
function shortSource(source: string): string {
  switch (source) {
    case 'dsh':
      return 'DSH';
    case 'hermes':
      return 'Hermes';
    case 'opencode':
      return 'opencode';
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    default:
      return '其它';
  }
}

// —— 辉光精灵缓存（替代 shadowBlur；按颜色缓存一次）
const glowCache = new Map<string, HTMLCanvasElement>();
function glowSprite(color: string): HTMLCanvasElement {
  const hit = glowCache.get(color);
  if (hit) return hit;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, rgba(color, 0.85));
    grad.addColorStop(0.35, rgba(color, 0.28));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  glowCache.set(color, canvas);
  return canvas;
}

export class StarSystem {
  stars: StarNode[] = [];
  arcs: SectorArc[] = [];
  marks: Mark[] = [];
  /** 出生计数（QA debugFx.spawns 的备用来源）。 */
  spawnCount = 0;
  private sessions = new Map<string, AgentSession>();
  private childIndex = new Map<string, AgentSession[]>();
  private initialised = false;
  /** 每层独立角速度（rad/s，约 30% 反向；§21.2）。 */
  private zoneSpeed: number[] = [];
  private zoneRot: number[] = [];
  private constellation: Array<{ a: string; b: string }> = [];
  /** §22.1 最近 200 帧的 teleport / alpha 跳变记录。 */
  private motionLog: Array<{ tele: number; alpha: number }> = [];
  private prevPose = new Map<string, { angle: number; radius: number }>();
  private frameAlphaStep = 0;
  private brightnessEstimate = 0;
  private ringRadius = new Map<number, number>();

  // ————————————————————————————————————————————— 数据接入

  setFleet(snap: ClientFleetSnapshot, env: Env): void {
    this.sessions.clear();
    this.childIndex.clear();
    for (const s of snap.sessions) {
      this.sessions.set(s.id, s);
      if (s.parentId) {
        const list = this.childIndex.get(s.parentId) ?? [];
        list.push(s);
        this.childIndex.set(s.parentId, list);
      }
    }

    // —— 分野显示名：同名跨来源加来源短名，同来源同名加路径尾缀
    const nameGroups = new Map<string, { sources: Set<string>; count: number }>();
    for (const sec of snap.sectors) {
      const base = sec.name || sec.path || sec.id;
      const g = nameGroups.get(base) ?? { sources: new Set<string>(), count: 0 };
      g.sources.add(sec.source ?? 'other');
      g.count += 1;
      nameGroups.set(base, g);
    }
    const sectorOf = new Map<string, string>();
    const drafts: SectorDraft[] = [];
    for (const sec of snap.sectors) {
      const base = sec.name || sec.path || sec.id;
      const group = nameGroups.get(base);
      const source = sec.source ?? 'other';
      const path = sec.path ?? '';
      let name = base;
      if (group && group.count > 1) {
        name =
          group.sources.size > 1
            ? `${base} · ${shortSource(source)}`
            : `${base} · ${pathSuffix(path)}`.trim();
      }
      const ids = sec.sessionIds ?? [];
      let live = 0;
      let ended = 0;
      for (const id of ids) {
        sectorOf.set(id, sec.id);
        const session = this.sessions.get(id);
        if (!session) continue;
        if (session.state === 'live') live += 1;
        else if (session.state === 'ended') ended += 1;
      }
      drafts.push({
        id: sec.id,
        name,
        path,
        source,
        sessionIds: ids,
        count: ids.length,
        live,
        ended,
        weight: 0.6 + live * 1.15 + ids.length * 0.5,
        units: 0,
      });
    }
    // 无归属会话归「野 · 未隶」
    const orphans: AgentSession[] = [];
    for (const s of snap.sessions) if (!s.parentId && !sectorOf.has(s.id)) orphans.push(s);
    if (orphans.length > 0) {
      const ids = orphans.map((s) => s.id);
      for (const id of ids) sectorOf.set(id, '__orphan');
      let live = 0;
      let ended = 0;
      for (const s of orphans) {
        if (s.state === 'live') live += 1;
        else if (s.state === 'ended') ended += 1;
      }
      drafts.push({
        id: '__orphan',
        name: '野 · 未隶',
        path: '',
        source: 'other',
        sessionIds: ids,
        count: ids.length,
        live,
        ended,
        weight: 0.6 + live * 1.15 + ids.length * 0.5,
        units: 0,
      });
    }

    // —— 弧带分配（≤12 个用 12 宫最大余数法；>12 按权重、每段至少 18°）
    const n = drafts.length;
    const gap = n <= 8 ? 0.021 : 0.014;
    const avail = TAU - gap * Math.max(0, n - 1);
    if (n <= 12) {
      const total = drafts.reduce((sum, d) => sum + d.weight, 0) || 1;
      const raw = drafts.map((d) => Math.max(0.55, (d.weight / total) * 12));
      const base = raw.map((v) => Math.max(1, Math.floor(v)));
      let left = 12 - base.reduce((a, b) => a + b, 0);
      const order = raw
        .map((v, i) => ({ rem: v - Math.floor(v), i }))
        .sort((a, b) => b.rem - a.rem);
      let k = 0;
      while (left > 0 && order.length > 0) {
        const slot = order[k % order.length]!;
        base[slot.i] = (base[slot.i] ?? 1) + 1;
        left -= 1;
        k += 1;
      }
      drafts.forEach((d, i) => {
        d.units = base[i] ?? 1;
      });
    } else {
      const total = drafts.reduce((sum, d) => sum + d.weight, 0) || 1;
      const minRad = (18 * Math.PI) / 180;
      let fixed = 0;
      const free: number[] = [];
      drafts.forEach((d, i) => {
        const want = (d.weight / total) * avail;
        if (want < minRad) {
          drafts[i]!.units = -minRad;
          fixed += minRad;
        } else {
          free.push(i);
        }
      });
      const remain = avail - fixed;
      const freeSum = free.reduce((sum, i) => sum + (drafts[i]!.weight || 1), 0) || 1;
      for (const i of free) {
        const d = drafts[i]!;
        d.units = (d.weight / freeSum) * remain;
      }
    }

    const prevById = new Map(this.arcs.map((a) => [a.id, a]));
    let cursor = 0;
    const arcs: SectorArc[] = drafts.map((d, i) => {
      const span = d.units < 0 ? -d.units : (d.units / 12) * avail;
      const start = cursor;
      cursor += span + (i < n - 1 ? gap : 0);
      const prev = prevById.get(d.id);
      return {
        id: d.id,
        name: d.name,
        path: d.path,
        source: d.source,
        units: d.units < 0 ? 1 : d.units,
        start: prev ? prev.start : env.skyRot + start,
        span: prev ? prev.span : span,
        startTarget: start,
        spanTarget: span,
        count: d.count,
        live: d.live,
        ended: d.ended,
        breath: prev ? prev.breath : 0,
      };
    });

    // —— 每分野内 root 会话
    const rootSessions: AgentSession[] = [];
    const bySector = new Map<string, AgentSession[]>();
    for (const s of snap.sessions) {
      if (s.parentId) continue;
      const sid = sectorOf.get(s.id) ?? '__orphan';
      const list = bySector.get(sid) ?? [];
      list.push(s);
      if (rootSessions.length < MAX_STARS) rootSessions.push(s);
      bySector.set(sid, list);
    }
    if (rootSessions.length > MAX_STARS) rootSessions.length = MAX_STARS;

    // —— §22.3 径向层级权重（体量 0.55 / 活跃 0.35 / live 0.10）
    // 归一用「秩百分位」而不是 max 归一：会话间体量差很小时 max 归一会把权重挤成一团，
    // 秩归一保证内→外的权重光谱始终展开（QA hierarchy.gap 稳定达标）。
    const rankPct = (values: number[]): number[] => {
      const n = values.length;
      if (n <= 1) return values.map(() => 0.5);
      const idx = values.map((v, i) => ({ v, i }));
      idx.sort((a, b) => a.v - b.v);
      const out = new Array<number>(n).fill(0.5);
      idx.forEach((item, rank) => {
        out[item.i] = n > 1 ? rank / (n - 1) : 0.5;
      });
      return out;
    };
    const logPct = rankPct(rootSessions.map((s) => Math.log10((s.tokens?.output ?? 0) + 1)));
    const actPct = rankPct(rootSessions.map((s) => s.recentTokenRate ?? 0));
    const weightOf = new Map<string, number>();
    rootSessions.forEach((s, i) => {
      const liveBonus = s.state === 'live' ? 1 : 0;
      weightOf.set(
        s.id,
        clamp01(0.55 * (logPct[i] ?? 0.5) + 0.35 * (actPct[i] ?? 0.5) + 0.1 * liveBonus),
      );
    });

    const ringCount = clamp(Math.round(env.params.ringCount), 1, 5);
    this.zoneSpeed = [];
    const nextZones: number[] = [];
    for (let z = 0; z < ringCount; z += 1) {
      const table = ORBIT_TABLE[z] ?? 0.4;
      const jitter = 0.85 + rand01(`zonej:${z}`) * 0.3;
      const dir = rand01(`zoned:${z}`) < 0.3 ? -1 : 1;
      this.zoneSpeed.push(0.048 * table * jitter * dir);
      nextZones.push(this.zoneRot[z] ?? env.skyRot);
    }
    this.zoneRot = nextZones;

    // 权重降序 → 内环优先；同环内按秩均匀分布
    const ranked = [...rootSessions].sort(
      (a, b) => (weightOf.get(b.id) ?? 0) - (weightOf.get(a.id) ?? 0),
    );
    const ringOf = new Map<string, number>();
    const ringRank = new Map<string, { pos: number; total: number }>();
    const perRing = ranked.length / ringCount;
    const ringCounters: number[] = new Array<number>(ringCount).fill(0);
    for (let i = 0; i < ranked.length; i += 1) {
      const s = ranked[i]!;
      const ring = clamp(Math.floor(i / Math.max(1, perRing)), 0, ringCount - 1);
      ringOf.set(s.id, ring);
      ringCounters[ring] = (ringCounters[ring] ?? 0) + 1;
    }
    for (let i = 0; i < ranked.length; i += 1) {
      const s = ranked[i]!;
      const ring = ringOf.get(s.id) ?? 0;
      const total = ringCounters[ring] ?? 1;
      const pos = ranked
        .slice(0, i)
        .filter((x) => (ringOf.get(x.id) ?? 0) === ring).length;
      ringRank.set(s.id, { pos, total });
    }

    const band = GEOM.orbitOut - GEOM.orbitIn;
    const nextStars: StarNode[] = [];
    const prevStars = new Map(this.stars.map((s) => [s.id, s]));
    const now = env.now;
    for (const arc of arcs) {
      const list = (bySector.get(arc.id) ?? []).filter((s) => rootSessions.includes(s));
      if (list.length === 0) continue;
      const span = Math.max(arc.spanTarget, 0.0001);
      const even = list.length > 1 && (span * 0.9) / list.length < MIN_GAP_RAD;
      const ordered = [...list].sort((a, b) => rand01(`loc:${a.id}`) - rand01(`loc:${b.id}`));
      ordered.forEach((session, i) => {
        const total = ordered.length;
        const base = even
          ? (i + 0.5) / total
          : (i + 0.06 + 0.88 * rand01(`jit:${session.id}`)) / total;
        const jitter = (rand01(`spj:${session.id}`) - 0.5) * (0.7 / total);
        const frac = clamp01(base + jitter);
        const local = 0.05 + clamp01(frac) * 0.9;
        const zone = ringOf.get(session.id) ?? 0;
        const inRing = ringRank.get(session.id) ?? { pos: 0.5, total: 1 };
        const t = inRing.total > 1 ? inRing.pos / (inRing.total - 1) : 0.5;
        const bandFrac = (zone + RING_GUARD + (1 - 2 * RING_GUARD) * t) / ringCount;
        const jitterR = (rand01(`rz:${session.id}`) - 0.5) * 0.06 * band;
        const radiusBase = env.R * (GEOM.orbitIn + band * bandFrac + jitterR);
        const weight = weightOf.get(session.id) ?? 0.5;
        const prev = prevStars.get(session.id);
        const children = this.childIndex.get(session.id) ?? [];
        const teamLinks = (session.team?.memberIds ?? []).filter((id) => id !== session.id);
        const satellites: SatelliteMote[] = children.slice(0, 8).map((c) => {
          const prevSat = prev?.satellites.find((x) => x.id === c.id);
          return {
            id: c.id,
            angle: prevSat?.angle ?? rand01(`sata:${c.id}`) * TAU,
            radius: prevSat?.radius ?? 15 + (c.depth ?? 1) * 5 + rand01(`satr:${c.id}`) * 6,
            r: clamp(1.5 + Math.log10((c.tokens?.output ?? 0) + 1) * 0.45, 1.5, 3.4),
            state: c.state,
            appear: prevSat?.appear ?? 0,
            dir: prevSat?.dir ?? (rand01(`satd:${c.id}`) > 0.5 ? 1 : -1),
          };
        });
        if (prev) {
          prev.session = session;
          prev.sectorId = arc.id;
          prev.local = local;
          prev.zone = zone;
          prev.weight = weight;
          prev.radiusBase = radiusBase;
          prev.satellites = satellites;
          prev.teamLinks = teamLinks;
          prev.teamTasks = session.team?.tasks ?? 0;
          nextStars.push(prev);
        } else {
          const angle = env.skyRot + arc.start + local * arc.span;
          nextStars.push({
            id: session.id,
            session,
            sectorId: arc.id,
            local,
            driftDir: rand01(`dir:${session.id}`) > 0.5 ? 1 : -1,
            drift: 0,
            angle,
            zone,
            speedK: 0.55 + rand01(`spk:${session.id}`) * 1.05,
            radiusBase,
            breathPhase: rand01(`bp:${session.id}`),
            breathPeriod: 40 + rand01(`bpd:${session.id}`) * 80,
            shift: 0,
            shiftTarget: 0,
            sep: 0,
            weight,
            spawn: this.initialised ? 0 : 1,
            spawnAt: now,
            alphaVis: this.initialised ? 0 : 0.42,
            radius: radiusBase,
            radiusTarget: radiusBase,
            r: starRadius(session.tokens?.output ?? 0),
            appear: this.initialised ? 0 : 1,
            vanishing: false,
            pulse: 0,
            glow: 0,
            activity: session.state === 'live' ? 0.6 : 0.1,
            errorAt: 0,
            approvalAt: 0,
            lastEventAt: now,
            satellites,
            trail: [],
            teamTasks: session.team?.tasks ?? 0,
            teamLinks,
          });
          if (this.initialised) this.spawnCount += 1;
        }
      });
    }

    // 消失的会话：保留对象做退场动画
    const nextIds = new Set(nextStars.map((s) => s.id));
    for (const old of this.stars) {
      if (!nextIds.has(old.id)) {
        old.vanishing = true;
        nextStars.push(old);
      }
    }
    this.stars = nextStars;
    this.arcs = arcs;
    this.relaxOverlap(env);
    this.rebuildConstellation();
    this.initialised = true;
  }

  // ————————————————————————————————————————————— 布局松弛

  /** 环带内角度松弛：只写 shift 目标，不直接改 angle（§22.1）。 */
  private relaxOverlap(env: Env): void {
    const ringCount = clamp(Math.round(env.params.ringCount), 1, 5);
    const groups = new Map<number, StarNode[]>();
    for (const s of this.stars) {
      if (s.vanishing) continue;
      const z = clamp(Math.round(s.zone), 0, ringCount - 1);
      const list = groups.get(z) ?? [];
      list.push(s);
      groups.set(z, list);
    }
    for (const [z, list] of groups) {
      if (list.length < 2) continue;
      const ringR = Math.max(40, env.R * (GEOM.orbitIn + (GEOM.orbitOut - GEOM.orbitIn) * ((z + 0.5) / ringCount)));
      const circ = TAU * ringR;
      let needSum = 0;
      for (const s of list) needSum += Math.max(6, s.r * 1.24);
      const fit = Math.min(1, (circ * 0.96) / Math.max(1, needSum));
      const ref = list[0]!.angle;
      const unwrap = (a: number): number => ((a - ref + Math.PI * 3) % TAU) - Math.PI;
      const items: Bucket[] = list.map((s) => {
        const want = this.baseAngleOf(s) + s.shift;
        return { star: s, want, u: unwrap(want) };
      });
      items.sort((a, b) => a.u - b.u);
      const pos = items.map((i) => i.u);
      for (let round = 0; round < 32; round += 1) {
        for (let i = 0; i < items.length; i += 1) {
          const a = items[i]!;
          const b = items[(i + 1) % items.length]!;
          let gap = (pos[(i + 1) % items.length] ?? 0) - (pos[i] ?? 0);
          if (i === items.length - 1) gap += TAU;
          const need = (Math.max(6, (a.star.r + b.star.r) * 0.62) * fit) / ringR;
          if (gap < need) {
            const push = (need - gap) * 0.5;
            pos[i] = (pos[i] ?? 0) - push;
            pos[(i + 1) % items.length] = (pos[(i + 1) % items.length] ?? 0) + push;
          }
        }
      }
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]!;
        const settled = ref + (pos[i] ?? 0);
        item.star.shiftTarget = clamp(wrapAngle(settled - this.baseAngleOf(item.star)), -0.9, 0.9);
        item.star.shift = item.star.shiftTarget;
      }
    }
  }

  /** 星的基准期望角（环速 + 分野弧 + 漂移）。 */
  private baseAngleOf(star: StarNode): number {
    const arc = this.arcs.find((a) => a.id === star.sectorId);
    const z = clamp(star.zone, 0, this.zoneRot.length - 1);
    const zoneBase = this.zoneRot[z] ?? 0;
    const arcStart = arc ? arc.start : 0;
    const span = arc ? arc.span : 0;
    const frac = clamp(star.local + (span > 0 ? star.drift / span : 0), 0.02, 0.98);
    return zoneBase + arcStart + frac * span;
  }

  // ————————————————————————————————————————————— 每帧

  update(env: Env, energy: number): void {
    const dt = env.dt;
    const now = env.now;
    const chaos = env.reducedMotion ? 0.3 : env.params.tempoGain < 0.9 ? 0.55 : 1;
    const ringCount = clamp(Math.round(env.params.ringCount), 1, 5);
    // 派生层数变化时补齐/截断
    if (this.zoneRot.length !== ringCount) {
      while (this.zoneRot.length < ringCount) this.zoneRot.push(env.skyRot);
      while (this.zoneRot.length > ringCount) this.zoneRot.pop();
      while (this.zoneSpeed.length < ringCount) this.zoneSpeed.push(0.02);
      while (this.zoneSpeed.length > ringCount) this.zoneSpeed.pop();
    }
    this.ringRadius.clear();
    for (let z = 0; z < ringCount; z += 1) {
      this.ringRadius.set(
        z,
        Math.max(40, env.R * (GEOM.orbitIn + (GEOM.orbitOut - GEOM.orbitIn) * ((z + 0.5) / ringCount))),
      );
    }
    // 分野弧阻尼
    for (const arc of this.arcs) {
      arc.start = dampAngle(arc.start, arc.startTarget, 6, dt);
      arc.span = damp(arc.span, arc.spanTarget, 6, dt);
      arc.breath = damp(
        arc.breath,
        arc.live > 0 ? clamp01(0.35 + energy * 0.55 + arc.live * 0.08) : 0.06,
        2.4,
        dt,
      );
    }
    // 环速（每层不同；强拍/能量调制）
    const energyK = 0.55 + 0.45 * clamp01(energy);
    for (let z = 0; z < this.zoneRot.length; z += 1) {
      this.zoneRot[z] = (this.zoneRot[z] ?? env.skyRot) + (this.zoneSpeed[z] ?? 0) * dt * energyK * chaos;
    }

    const wantOf = new Map<string, number>();
    const fading: StarNode[] = [];
    for (const star of this.stars) {
      const session = star.session;
      const z = clamp(star.zone, 0, this.zoneRot.length - 1);
      star.zone = z;
      // —— 状态 / 体积
      const rate = session.recentTokenRate ?? 0;
      const liveTarget =
        session.state === 'live'
          ? clamp01(
              0.25 +
                rate / 40 +
                (session.openStep ? 0.3 : 0) +
                Math.min(0.3, (session.pendingCalls?.length ?? 0) * 0.12),
            )
          : session.state === 'idle'
            ? 0.14
            : 0;
      star.activity = damp(star.activity, liveTarget, 2.2, dt);
      star.pulse = damp(star.pulse, 0, 2.6 + env.params.pulseDecay * 2.4, dt);
      star.r = starRadius(session.tokens?.output ?? 0);
      const glowTarget =
        session.state === 'live'
          ? clamp01(0.2 + (rate / 26) * 0.8 + (session.openStep ? 0.15 : 0))
          : session.state === 'idle'
            ? 0.12
            : 0;
      star.glow = damp(star.glow, glowTarget, 2.6, dt);
      // —— 点火 / 熄灭
      if (star.vanishing) {
        star.appear = damp(star.appear, 0, 8, dt);
        star.vanishStep = clamp01((star.vanishStep ?? 0) + dt / 0.22);
      } else {
        star.appear = Math.min(1, star.appear + dt * 2.4);
      }
      if (star.spawn < 1) star.spawn = Math.min(1, star.spawn + dt / 0.26);
      // —— 轨道漂移（每星不同速，§21.2）
      if (env.connection !== 'offline') {
        const speed = 0.022 * (0.12 + 0.88 * star.activity) * star.speedK * chaos * energyK;
        star.drift += star.driftDir * speed * dt;
      }
      const arc = this.arcs.find((a) => a.id === star.sectorId);
      const span = arc ? arc.span : 0;
      if (span > 0) {
        const dMax = span * (0.96 - star.local);
        const dMin = span * (0.04 - star.local);
        if (star.drift > dMax) {
          star.drift = dMax;
          star.driftDir = -1;
        } else if (star.drift < dMin) {
          star.drift = dMin;
          star.driftDir = 1;
        }
      }
      wantOf.set(star.id, this.baseAngleOf(star));
      // —— 半径：基准 + ±2.5% 极慢呼吸（40–120s）
      const breath =
        1 + 0.025 * Math.sin(((now / 1000) / star.breathPeriod + star.breathPhase) * TAU);
      star.radiusTarget = star.radiusBase * breath;
      // —— 卫星独立角速/方向
      for (const sat of star.satellites) {
        sat.appear = Math.min(1, sat.appear + dt * 2.2);
        const child = this.sessions.get(sat.id);
        if (child) sat.state = child.state;
        sat.angle += sat.dir * dt * (0.18 + rand01(`satsp:${sat.id}`) * 0.5) * chaos;
      }
    }

    this.solveSeparation(env, wantOf);

    // —— 限速积分（§22.1）：角度过渡态 ≤0.019、稳态 ≤0.004 rad/frame；径向 ≤1.2px/frame
    for (const star of this.stars) {
      const want = wantOf.get(star.id);
      if (want !== undefined) {
        const target = want + star.shift + star.sep;
        const delta = wrapAngle(target - star.angle);
        const maxStep = Math.abs(delta) > 0.06 ? MAX_ANGLE_STEP : MAX_ANGLE_RATE;
        star.angle += clamp(delta, -maxStep, maxStep);
      }
      const rd = star.radiusTarget - star.radius;
      star.radius += clamp(rd, -1.2, 1.2);
      if (star.vanishing && star.appear <= 0.02) fading.push(star);
    }
    if (fading.length > 0) {
      const gone = new Set(fading.map((s) => s.id));
      this.stars = this.stars.filter((s) => !gone.has(s.id));
    }

    // 墨痕衰减
    if (this.marks.length > 0) {
      this.marks = this.marks.filter((m) => now - m.born < m.life);
      if (this.marks.length > 220) this.marks.splice(0, this.marks.length - 220);
    }

    this.trackMotion(env);
  }

  /** 每帧相邻防重合：按环带排序、只产出 sep 补正。 */
  private solveSeparation(env: Env, wantOf: Map<string, number>): void {
    const groups = new Map<number, StarNode[]>();
    for (const s of this.stars) {
      if (s.vanishing) continue;
      const z = clamp(s.zone, 0, Math.max(0, this.zoneRot.length - 1));
      const list = groups.get(z) ?? [];
      list.push(s);
      groups.set(z, list);
    }
    const sepTarget = new Map<string, number>();
    for (const [z, list] of groups) {
      if (list.length < 2) continue;
      const radius = this.ringRadius.get(z) ?? Math.max(40, env.R * GEOM.orbitMid);
      const ref = list[0]!.angle;
      const unwrap = (a: number): number => ((a - ref + Math.PI * 3) % TAU) - Math.PI;
      const items: Bucket[] = list.map((s) => {
        const want = wantOf.get(s.id) ?? s.angle;
        return { star: s, want, u: unwrap(want + s.shift + s.sep) };
      });
      items.sort((a, b) => a.u - b.u);
      const pos = items.map((i) => i.u);
      for (let round = 0; round < 6; round += 1) {
        for (let i = 0; i < items.length; i += 1) {
          const a = items[i]!;
          const b = items[(i + 1) % items.length]!;
          let gap = (pos[(i + 1) % items.length] ?? 0) - (pos[i] ?? 0);
          if (i === items.length - 1) gap += TAU;
          const need = Math.max(6, (a.star.r + b.star.r) * 0.62) / radius;
          if (gap < need) {
            const push = Math.min((need - gap) * 0.5, 0.02);
            pos[i] = (pos[i] ?? 0) - push;
            pos[(i + 1) % items.length] = (pos[(i + 1) % items.length] ?? 0) + push;
          }
        }
      }
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]!;
        const located = ref + (pos[i] ?? 0);
        sepTarget.set(
          item.star.id,
          clamp(wrapAngle(located - item.want - item.star.shift), -0.9, 0.9),
        );
      }
    }
    for (const star of this.stars) {
      const target = sepTarget.get(star.id) ?? 0;
      star.sep = damp(star.sep, clamp(target, -0.9, 0.9), 6, env.dt);
    }
  }

  /** §22.1：记录单帧角位移/径向位移（teleport 判定），维护 200 帧窗口。 */
  private trackMotion(env: Env): void {
    let tele = 0;
    let alphaSum = 0;
    let alphaN = 0;
    for (const star of this.stars) {
      const prev = this.prevPose.get(star.id);
      if (prev) {
        const da = Math.abs(wrapAngle(star.angle - prev.angle));
        const dr = Math.abs(star.radius - prev.radius);
        if (da > TELEPORT_ANGLE || dr > TELEPORT_RADIUS) tele += 1;
      }
      this.prevPose.set(star.id, { angle: star.angle, radius: star.radius });
      alphaSum += star.alphaVis;
      alphaN += 1;
    }
    if (this.prevPose.size > this.stars.length + 16) {
      const alive = new Set(this.stars.map((s) => s.id));
      for (const id of this.prevPose.keys()) if (!alive.has(id)) this.prevPose.delete(id);
    }
    this.motionLog.push({ tele, alpha: this.frameAlphaStep });
    if (this.motionLog.length > MOTION_WINDOW) this.motionLog.shift();
    this.brightnessEstimate = alphaN > 0 ? alphaSum / alphaN : 0;
    void env;
  }

  /** §22.1：绘制 alpha 单帧限速（≤0.06/frame）。 */
  private trackAlpha(star: StarNode, desired: number): number {
    const target = clamp01(desired);
    const step = clamp(target - star.alphaVis, -MAX_ALPHA_STEP, MAX_ALPHA_STEP);
    star.alphaVis = clamp01(star.alphaVis + step);
    const absStep = Math.abs(step);
    if (absStep > this.frameAlphaStep) this.frameAlphaStep = absStep;
    return star.alphaVis;
  }

  // ————————————————————————————————————————————— 查询

  addMark(star: StarNode, tone: number, now: number): void {
    const width = ((0.6 + rand01(`mk:${Math.round(now)}`) * 1.0) * Math.PI) / 180;
    this.marks.push({ angle: star.angle, radius: star.radius, width, born: now, life: 20000, tone });
    if (this.marks.length > 240) this.marks.splice(0, this.marks.length - 240);
  }

  find(id: string): StarNode | null {
    return this.stars.find((s) => s.id === id) ?? null;
  }

  satellitesOf(parentId: string): SatelliteMote[] {
    return this.find(parentId)?.satellites ?? [];
  }

  locate(id: string): { star: StarNode; satellite?: SatelliteMote } | null {
    for (const star of this.stars) {
      if (star.id === id) return { star };
      const sat = star.satellites.find((s) => s.id === id);
      if (sat) return { star, satellite: sat };
    }
    return null;
  }

  worldPos(star: StarNode): { x: number; y: number } {
    return { x: Math.sin(star.angle) * star.radius, y: -Math.cos(star.angle) * star.radius };
  }

  satellitePos(star: StarNode, sat: SatelliteMote): { x: number; y: number } {
    const p = this.worldPos(star);
    return {
      x: p.x + Math.sin(sat.angle) * sat.radius,
      y: p.y - Math.cos(sat.angle) * sat.radius,
    };
  }

  focusPos(id: string | null): { x: number; y: number } | null {
    if (!id) return null;
    const loc = this.locate(id);
    if (!loc) return null;
    if (loc.satellite) return this.satellitePos(loc.star, loc.satellite);
    return this.worldPos(loc.star);
  }

  liveIds(): string[] {
    return [...this.stars]
      .filter((s) => s.session.state === 'live' && !s.vanishing)
      .sort((a, b) => (b.session.recentTokenRate ?? 0) - (a.session.recentTokenRate ?? 0))
      .map((s) => s.id);
  }

  mostActiveLive(): string | null {
    return this.liveIds()[0] ?? null;
  }

  pick(env: Env, camera: CameraSystem, sx: number, sy: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const star of this.stars) {
      if (star.vanishing || star.appear <= 0.2) continue;
      const cands: Array<{ id: string; x: number; y: number; hit: number }> = [];
      const wp = this.worldPos(star);
      cands.push({ id: star.id, x: wp.x, y: wp.y, hit: Math.max(14, star.r * 1.5 + 6) });
      for (const sat of star.satellites) {
        if (sat.appear <= 0.3) continue;
        const sp = this.satellitePos(star, sat);
        cands.push({ id: sat.id, x: sp.x, y: sp.y, hit: 12 });
      }
      for (const c of cands) {
        const p = camera.worldToScreen(env, c.x, c.y);
        const d = Math.hypot(p.x - sx, p.y - sy);
        if (d <= c.hit && d < bestD) {
          bestD = d;
          best = c.id;
        }
      }
    }
    return best;
  }

  // ————————————————————————————————————————————— 绘制

  private rebuildConstellation(): void {
    const pairs: Array<{ a: string; b: string }> = [];
    const seen = new Set<string>();
    const groups = new Map<string, StarNode[]>();
    for (const s of this.stars) {
      if (s.vanishing) continue;
      const list = groups.get(s.sectorId) ?? [];
      list.push(s);
      groups.set(s.sectorId, list);
    }
    for (const list of groups.values()) {
      const sorted = [...list].sort((a, b) => a.angle - b.angle);
      for (let i = 0; i < sorted.length; i += 1) {
        const a = sorted[i]!;
        for (let k = 1; k <= 2; k += 1) {
          const b = sorted[(i + k) % sorted.length]!;
          if (!b || a.id === b.id) continue;
          const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pairs.push({ a: a.id, b: b.id });
        }
      }
    }
    this.constellation = pairs;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    view: View,
    dimOthers: number,
    focusId: string | null,
    camera?: CameraSystem,
  ): void {
    const env = view.env;
    const now = env.now;
    const pulse = view.beat.pulse;
    const offline = env.connection === 'offline';
    const connDim =
      env.connection === 'reconnecting' ? 0.8 : env.connection === 'connecting' ? 0.85 : 1;
    this.frameAlphaStep = 0;

    // §18.7 近邻星座连线（survey/vigil；多来源筛选时淡出）
    if (
      (env.mode === 'survey' || env.mode === 'vigil') &&
      env.quality >= 0.7 &&
      !env.sourceFilter
    ) {
      ctx.strokeStyle = rgba(COLORS.cold300, 0.05 + 0.05 * clamp01(pulse + 0.15));
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (const pair of this.constellation) {
        const a = this.find(pair.a);
        const b = this.find(pair.b);
        if (!a || !b || a.vanishing || b.vanishing) continue;
        if (a.appear < 0.5 || b.appear < 0.5) continue;
        const pa = this.worldPos(a);
        const pb = this.worldPos(b);
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
      }
      ctx.stroke();
    }

    // 团队协作虚线（同屏 ≤40）
    {
      let links = 0;
      ctx.strokeStyle = rgba(COLORS.gold300, 0.18);
      ctx.lineWidth = 0.8;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      for (const star of this.stars) {
        if (links >= 40) break;
        if (star.session.state === 'ended') continue;
        for (const mid of star.teamLinks) {
          if (links >= 40) break;
          if (mid === star.id) continue;
          const other = this.find(mid);
          if (!other) continue;
          const a = this.worldPos(star);
          const b = this.worldPos(other);
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          links += 1;
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const star of this.stars) {
      const wp0 = this.worldPos(star);
      const s = star.session;
      const isFocus = !!focusId && star.id === focusId;
      const isHover = view.hovered === star.id;
      const isSelected = view.selected === star.id;
      const appear = star.appear * (1 - (star.vanishStep ?? 0));
      if (appear <= 0.02) continue;
      if (camera && (env.zoom > 1.4 || this.stars.length > 140)) {
        const p = camera.worldToScreen(env, wp0.x, wp0.y);
        if (p.x < -60 || p.x > env.w + 60 || p.y < -60 || p.y > env.h + 60) continue;
      }
      let dim = connDim;
      if (focusId) dim *= isFocus ? 1 : dimOthers;
      else if (dimOthers < 0.999) dim *= dimOthers;
      if (env.sourceFilter && s.source !== env.sourceFilter) dim *= 0.18;
      // 出生：从分野弧径向飞入 0.06R（260ms ease-out）
      const wp = { x: wp0.x, y: wp0.y };
      if (star.spawn < 1) {
        const e = 1 - Math.pow(1 - clamp01(star.spawn), 3);
        const reach = Math.hypot(wp0.x, wp0.y) || 1;
        const off = env.R * 0.06 * (1 - e);
        wp.x += (wp0.x / reach) * off;
        wp.y += (wp0.y / reach) * off;
      }
      const rDraw = Math.max(
        s.state === 'ended' || offline ? 1.6 : 0.6,
        star.r *
          (0.55 + 0.45 * appear) *
          (isFocus || isSelected ? 1.35 : 1) *
          (s.state === 'ended' ? 0.78 : 1) *
          (s.state === 'live' ? 1 + pulse * 0.25 : 1) *
          (env.mobile ? 0.42 : 1),
      );
      // 尾迹刻度（手势期降权）
      if (env.fxWeight > 0.6) {
        const trailW = 0.22 + 0.78 * clamp01(env.fxWeight);
        for (let t = 0; t < star.trail.length; t += 1) {
          const a = star.trail[t] ?? 0;
          const k = 1 - t / (star.trail.length + 1);
          ctx.strokeStyle = rgba(COLORS.bone300, 0.18 * k * dim * appear * trailW);
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.moveTo(Math.sin(a) * (star.radius + 2.5), -Math.cos(a) * (star.radius + 2.5));
          ctx.lineTo(Math.sin(a) * (star.radius + 5), -Math.cos(a) * (star.radius + 5));
          ctx.stroke();
        }
      }
      // 卫星
      for (const sat of star.satellites) {
        if (sat.appear <= 0.02) continue;
        const sp = this.satellitePos(star, sat);
        const linkBright =
          star.pulse > 0.05 && star.activity > 0.5 ? 0.1 + star.pulse * 0.25 : 0.09;
        ctx.strokeStyle = rgba(COLORS.gold300, linkBright * dim * sat.appear);
        ctx.lineWidth = 0.7;
        ctx.setLineDash([2, 2.6]);
        ctx.beginPath();
        ctx.moveTo(wp.x, wp.y);
        ctx.lineTo(sp.x, sp.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const satColor = offline ? COLORS.bone400 : STATE_COLOR[sat.state];
        ctx.fillStyle = rgba(
          satColor,
          clamp((sat.state === 'ended' ? 0.4 : 0.78) * dim * sat.appear, 0, 1),
        );
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, Math.max(0.6, sat.r * sat.appear), 0, TAU);
        ctx.fill();
        if (sat.id === view.selected) {
          ctx.strokeStyle = rgba(COLORS.gold100, 0.85);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, sat.r + 3.3, 0, TAU);
          ctx.stroke();
        }
      }

      // —— 状态双编码（颜色 + 形状）
      const color = offline ? COLORS.bone400 : STATE_COLOR[s.state];
      if (s.state === 'ended' || offline) {
        const fillA = this.trackAlpha(star, 0.42 * dim * appear);
        ctx.fillStyle = rgba(offline ? COLORS.bone500 : COLORS.bone400, fillA);
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, rDraw, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = rgba(COLORS.bone300, clamp(0.5 * dim * appear, 0.05, 0.7));
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, Math.max(1.4, rDraw) + (env.mobile ? 1.1 : 1.7), 0, TAU);
        ctx.stroke();
      } else {
        const breath =
          s.state === 'live'
            ? 0.72 + 0.32 * (env.reducedMotion ? pulse * 0.4 : pulse)
            : 0.7 + 0.05 * pulse;
        const bodyA = this.trackAlpha(star, clamp(breath * dim * appear, 0.1, 1));
        ctx.fillStyle = rgba(color, bodyA * 0.55);
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, rDraw, 0, TAU);
        ctx.fill();
        const core = s.state === 'live' ? COLORS.gold100 : COLORS.bone100;
        ctx.fillStyle = rgba(core, bodyA);
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, rDraw * 0.52, 0, TAU);
        ctx.fill();
        if (s.state === 'live') {
          const ringA = clamp((0.22 + 0.3 * star.glow + 0.12 * pulse) * dim * appear, 0.05, 0.9);
          ctx.strokeStyle = rgba(COLORS.gold200, ringA);
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.arc(wp.x, wp.y, rDraw + 2.6 + pulse * 0.8, 0, TAU);
          ctx.stroke();
        }
      }

      // —— 来源断环（§19.1：1px 识别弧，不做大色块）
      if (env.sourceCount >= 2 && !offline && appear > 0.4) {
        const rot = rand01(`src:${star.id}`) * TAU;
        ctx.strokeStyle = rgba(sourceTint(s.source), clamp(0.42 * dim * appear, 0.04, 0.6));
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, Math.max(2.2, rDraw) + 3.4, rot, rot + TAU * 0.2);
        ctx.stroke();
      }

      // —— error：三角缺口（色盲可辨）
      const errAge = now - star.errorAt;
      if (star.errorAt > 0 && errAge < 12000) {
        const k = 1 - errAge / 12000;
        const ang = star.angle - 0.55;
        const size = 2.4 + 1.6 * k;
        ctx.save();
        ctx.translate(wp.x + Math.sin(ang) * (rDraw + 1.4), wp.y - Math.cos(ang) * (rDraw + 1.4));
        ctx.rotate(ang + Math.PI / 2);
        ctx.fillStyle = rgba(STATE_COLOR.error, clamp(k * 0.95, 0.1, 0.95) * dim);
        ctx.beginPath();
        ctx.moveTo(0, -size);
        ctx.lineTo(size * 0.9, size * 0.75);
        ctx.lineTo(-size * 0.9, size * 0.75);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      // —— approval：玉色双环
      const appAge = now - star.approvalAt;
      if (star.approvalAt > 0 && appAge < 1600) {
        const k = 1 - appAge / 1600;
        ctx.strokeStyle = rgba(STATE_COLOR.approval, clamp(k * 0.85, 0.05, 0.9) * dim);
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, rDraw + 4.5 + (1 - k) * 5, 0, TAU * 0.82);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, rDraw + 7.4 + (1 - k) * 7, Math.PI, Math.PI + TAU * 0.68);
        ctx.stroke();
      }

      // —— 卷帙压力外环（contextPressure > 0.5）
      const cp = s.contextPressure;
      if (cp > 0.5) {
        const ratio = clamp01((cp - 0.5) / 0.5);
        const col = cp > 0.88 ? STATE_COLOR.error : cp > 0.72 ? COLORS.gold400 : COLORS.gold300;
        ctx.strokeStyle = rgba(col, (0.28 + 0.5 * ratio) * dim * appear);
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, rDraw + 5.4, -Math.PI / 2, -Math.PI / 2 + ratio * TAU * 0.92);
        ctx.stroke();
      }

      // —— todos 小刻点（2–4）
      const todos = s.todos;
      if (todos && todos.length > 0) {
        const tn = Math.min(4, todos.length);
        for (let i = 0; i < tn; i += 1) {
          const a = -Math.PI / 2 + ((i - (tn - 1) / 2) / Math.max(1, tn)) * 0.9;
          const dx = wp.x + Math.sin(a) * (rDraw + 8.6);
          const dy = wp.y - Math.cos(a) * (rDraw + 8.6);
          const done = todos[i]?.done ?? false;
          if (done) {
            ctx.fillStyle = rgba(COLORS.bone300, 0.5 * dim * appear);
            ctx.fillRect(dx - 0.8, dy - 0.8, 1.6, 1.6);
          } else {
            ctx.strokeStyle = rgba(COLORS.bone400, 0.45 * dim * appear);
            ctx.lineWidth = 0.7;
            ctx.strokeRect(dx - 0.9, dy - 0.9, 1.8, 1.8);
          }
        }
      }

      // —— 筹划中：外括弧刻度
      if (s.planActive) {
        ctx.strokeStyle = rgba(COLORS.gold400, 0.5 * dim * appear);
        ctx.lineWidth = 0.9;
        const rr = rDraw + 8.2;
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, rr, -0.9, 0.55);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, rr, Math.PI - 0.9, Math.PI + 0.55);
        ctx.stroke();
      }

      // —— 选中：亮环 + 四角刻
      if (isSelected) {
        const selectedR = rDraw + 9.5 + pulse * 1.6;
        ctx.strokeStyle = rgba(COLORS.gold100, 0.92);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, selectedR, 0, TAU);
        ctx.stroke();
        ctx.strokeStyle = rgba(COLORS.gold200, 0.4);
        ctx.lineWidth = 0.8;
        for (let i = 0; i < 4; i += 1) {
          const a = (i / 4) * TAU + phaseOf(now);
          ctx.beginPath();
          ctx.moveTo(wp.x + Math.sin(a) * (selectedR + 3), wp.y - Math.cos(a) * (selectedR + 3));
          ctx.lineTo(wp.x + Math.sin(a) * (selectedR + 6), wp.y - Math.cos(a) * (selectedR + 6));
          ctx.stroke();
        }
      }

      // —— hover：外点圈
      if (isHover && !isSelected) {
        ctx.strokeStyle = rgba(COLORS.bone200, 0.5);
        ctx.lineWidth = 0.8;
        ctx.setLineDash([1.5, 2.5]);
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, rDraw + 6.5, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  drawGlow(
    glowCtx: CanvasRenderingContext2D,
    view: View,
    dimOthers: number,
    focusId: string | null,
    camera?: CameraSystem,
  ): void {
    const env = view.env;
    const now = env.now;
    const pulse = view.beat.pulse;
    const tw = env.params.twinkle;
    for (const star of this.stars) {
      if (star.session.state !== 'live' || star.vanishing) continue;
      const appear = star.appear * (1 - (star.vanishStep ?? 0));
      if (appear < 0.4) continue;
      const wp = this.worldPos(star);
      if (camera && (env.zoom > 1.4 || this.stars.length > 140)) {
        const p = camera.worldToScreen(env, wp.x, wp.y);
        if (p.x < -80 || p.x > env.w + 80 || p.y < -80 || p.y > env.h + 80) continue;
      }
      const isFocus = !!focusId && star.id === focusId;
      let dim = env.connection === 'reconnecting' ? 0.8 : 1;
      if (focusId) dim *= isFocus ? 1 : dimOthers;
      const radius = star.r * (2.1 + 2.1 * star.glow) * (isFocus ? 1.18 : 1);
      // §22.1 twinkle：多倍频正弦（0.31/0.53/0.87Hz + id 相位），幅度 ≤8%
      const twk =
        1 +
        tw *
          0.08 *
          (0.5 * Math.sin((now / 1000) * TAU * 0.31 + rand01(`twp:${star.id}`) * TAU) +
            0.3 * Math.sin((now / 1000) * TAU * 0.53 + rand01(`twq:${star.id}`) * TAU) +
            0.2 * Math.sin((now / 1000) * TAU * 0.87 + rand01(`twr:${star.id}`) * TAU));
      const alpha =
        clamp((0.1 + 0.26 * star.glow) * env.params.glow * 1.25, 0, 0.42) *
        dim *
        (0.7 + 0.55 * pulse) *
        twk *
        (isFocus ? 1.5 : 1) *
        clamp01(env.fxWeight);
      const g = glowSprite(COLORS.gold200);
      glowCtx.globalAlpha = clamp(alpha, 0, 0.6);
      glowCtx.drawImage(g, wp.x - radius, wp.y - radius, radius * 2, radius * 2);
      glowCtx.globalAlpha = 1;
    }
  }

  drawLabels(
    ctx: CanvasRenderingContext2D,
    env: Env,
    view: View,
    camera: CameraSystem,
  ): void {
    const ids = new Set<string>();
    if (view.hovered) ids.add(view.hovered);
    if (view.selected) ids.add(view.selected);
    if (view.focusId) ids.add(view.focusId);
    if (ids.size === 0) return;
    // v2.4.1：这些标签画在「屏幕坐标」里（worldToScreen 后 translate），不能再用世界反向系数，
    // 否则放大时字反而变小。直接用屏幕倍数：2× → +22%、6× → +60%。
    const grow = textScreenGrow(env);
    const font = Math.round(12 * grow);
    const stateWord: Record<string, string> = { live: '行', idle: '驻', ended: '藏' };
    for (const id of ids) {
      const loc = this.locate(id);
      if (!loc) continue;
      const star = loc.star;
      if (loc.satellite && loc.satellite.appear <= 0.3) continue;
      const pos = loc.satellite ? this.satellitePos(star, loc.satellite) : this.worldPos(star);
      const p = camera.worldToScreen(env, pos.x, pos.y);
      if (p.x < -40 || p.x > env.w + 40 || p.y < -40 || p.y > env.h + 40) continue;
      const session = loc.satellite
        ? this.sessions.get(loc.satellite.id) ?? star.session
        : star.session;
      const title = truncate(session.title || session.id, 14);
      const word = stateWord[session.state] ?? '行';
      const stateColor = STATE_COLOR[session.state];
      ctx.save();
      ctx.font = `500 ${font}px ${FONTS.display}`;
      const w = ctx.measureText(title).width;
      const lx = Math.round(p.x + 14);
      const ly = Math.round(p.y - 12);
      ctx.strokeStyle = rgba(COLORS.gold300, 0.3);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(p.x + 6, p.y - 6);
      ctx.lineTo(lx - 3, ly + 4);
      ctx.stroke();
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = rgba(COLORS.inkVoid, 0.9);
      ctx.strokeText(title, lx, ly);
      ctx.fillStyle = rgba(COLORS.bone100, 0.92);
      ctx.fillText(title, lx, ly);
      ctx.font = `500 ${Math.max(8, Math.round(9 * grow))}px ${FONTS.mono}`;
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = rgba(COLORS.inkVoid, 0.9);
      ctx.strokeText(word, lx + w + 6, ly);
      ctx.fillStyle = rgba(stateColor, 0.86);
      ctx.fillText(word, lx + w + 6, ly);
      ctx.restore();
    }
  }

  // ————————————————————————————————————————————— 调试 / 验收

  debugOrbits(): {
    zones: Array<{ index: number; speed: number }>;
    stars: number;
    minPairDist: number;
    speedSpread: number;
  } {
    const zones = this.zoneSpeed.map((speed, index) => ({ index, speed }));
    let minD = Infinity;
    const pts = this.stars.map((s) => this.worldPos(s));
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const dx = (pts[i]?.x ?? 0) - (pts[j]?.x ?? 0);
        const dy = (pts[i]?.y ?? 0) - (pts[j]?.y ?? 0);
        const d = dx * dx + dy * dy;
        if (d < minD) minD = d;
      }
    }
    let minS = Infinity;
    let maxS = 0;
    for (const s of this.stars) {
      const v = (0.12 + 0.88 * s.activity) * s.speedK;
      if (v < minS) minS = v;
      if (v > maxS) maxS = v;
    }
    return {
      zones,
      stars: this.stars.length,
      minPairDist: Number.isFinite(minD) ? Math.sqrt(minD) : 0,
      speedSpread: Number.isFinite(minS) && minS > 0 ? maxS / minS : 0,
    };
  }

  debugMotion(): { teleports: number; maxAlphaStep: number; frames: number; brightness: number } {
    let teleports = 0;
    let maxAlphaStep = this.frameAlphaStep;
    for (const row of this.motionLog) {
      teleports += row.tele;
      if (row.alpha > maxAlphaStep) maxAlphaStep = row.alpha;
    }
    return {
      teleports,
      maxAlphaStep,
      frames: this.motionLog.length,
      brightness: this.brightnessEstimate,
    };
  }

  debugHierarchy(): {
    spearman: number;
    innerAvgWeight: number;
    outerAvgWeight: number;
    stars: number;
  } {
    const stars = this.stars.filter((s) => !s.vanishing);
    if (stars.length < 3) {
      return { spearman: 0, innerAvgWeight: 0, outerAvgWeight: 0, stars: stars.length };
    }
    const radii = stars.map((s) => s.radius).sort((a, b) => a - b);
    const mid = radii[Math.floor(radii.length / 2)] ?? 0;
    let innerSum = 0;
    let innerN = 0;
    let outerSum = 0;
    let outerN = 0;
    for (const s of stars) {
      if (s.radius < mid) {
        innerSum += s.weight;
        innerN += 1;
      } else {
        outerSum += s.weight;
        outerN += 1;
      }
    }
    return {
      spearman: spearman(stars.map((s) => ({ a: s.weight, b: s.radius }))),
      innerAvgWeight: innerN > 0 ? innerSum / innerN : 0,
      outerAvgWeight: outerN > 0 ? outerSum / outerN : 0,
      stars: stars.length,
    };
  }
}
