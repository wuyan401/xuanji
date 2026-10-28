// XUANJI · 璇玑 — 整机仪象（观机盘面）。同一台仪器的第二套盘面：
// 中枢（CPU 核 + 核心辐条）/ 内存带 / 磁盘轨 / 网络轨 / 进程刻度 / 授时环（uptime）。
// 规则（BIBLE §19.2）：颜色仍用墨 / 金 / 铜锈 / 骨白 / 朱砂，不新增蓝光；
// 遥测 2s 一帧，显示值用 damp 平滑插值（不做 sin 假动）；不可用时仪器完整但静止、全盘 alpha .35。

import { COLORS, FONTS, withAlpha } from '../design/tokens';
import { rgba } from './paint';
import { TAU, clamp, clamp01, damp, lerp } from '../lib/math';
import { rand01 } from './rand';
import { textScale, textScreenGrow, type Env, type View } from './types';
import type { SystemSnapshot } from '../state/types';

const SG = {
  hub: 0.13,
  memIn: 0.17,
  memOut: 0.3,
  diskIn: 0.34,
  diskOut: 0.46,
  netIn: 0.5,
  netOut: 0.62,
  procIn: 0.66,
  procOut: 0.78,
  tickIn: 0.82,
  tickOut: 0.9,
};

/**
 * v2.8 §27.2：整机核心忙闲因子。
 * gpuN = clamp01(utilPct*0.6 + memPct*0.4)；gpu 为 null 时退回 cpuN；
 * busyN = max(cpuN, gpuN, 0.25)（下限 0.25，避免空载时核心完全不动）。
 */
export function coreBusyN(
  cpuUsage: number,
  gpu: { utilPct: number; memPct: number } | null,
): number {
  const cpuN = clamp01(cpuUsage);
  const gpuN = gpu ? clamp01(gpu.utilPct * 0.6 + gpu.memPct * 0.4) : cpuN;
  return Math.max(cpuN, gpuN, 0.25);
}

interface ProcView {
  pid: number;
  name: string;
  cpuPct: number;
  memBytes: number;
}

interface Disp {
  cpu: number;
  perCore: number[];
  memPct: number;
  memUsed: number;
  memTotal: number;
  disks: Array<{ usedPct: number; totalBytes: number; freeBytes: number; name: string }>;
  rx: number;
  tx: number;
  procs: ProcView[];
  uptime: number;
  battery: { percent: number; charging: boolean } | null;
}

function emptyDisp(): Disp {
  return {
    cpu: 0,
    perCore: [],
    memPct: 0,
    memUsed: 0,
    memTotal: 0,
    disks: [],
    rx: 0,
    tx: 0,
    procs: [],
    uptime: 0,
    battery: null,
  };
}

function clampSigned(v: number): number {
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}

/** 把字节数写成人类可读（整数 GB/MB，不造假精度）。 */
function bytesLabel(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0';
  const gb = v / 1024 ** 3;
  if (gb >= 1) return gb.toFixed(1);
  const mb = v / 1024 ** 2;
  return `${Math.round(mb)}M`;
}

/** 速率对数归一：1 KB/s→~.18，1 MB/s→~.45，100 MB/s→~.95。 */
function rateLevel(bps: number): number {
  if (!Number.isFinite(bps) || bps <= 1024) return 0;
  return clamp01(Math.log10(bps / 1024) / 2.1);
}

/** 在极坐标处画一行不旋转的文字（世界内标注，底部自动翻正）。 */
function radialText(
  ctx: CanvasRenderingContext2D,
  angle: number,
  radius: number,
  text: string,
  font: string,
  color: string,
  maxW: number,
  ts = 1,
): void {
  ctx.save();
  ctx.rotate(angle);
  ctx.translate(0, -radius);
  if (Math.cos(angle) < -0.2) ctx.rotate(Math.PI);
  // v2.1 §20.2：深度放大时世界内文字按 1/zoom 反向缩放，屏幕字号稳定
  if (ts !== 1) ctx.scale(ts, ts);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let out = text;
  let w = ctx.measureText(out).width;
  while (w > maxW && out.length > 3) {
    out = `${out.slice(0, -2)}…`;
    w = ctx.measureText(out).width;
  }
  ctx.fillStyle = color;
  ctx.fillText(out, 0, 0);
  ctx.restore();
}

export interface SystemDrawOpts {
  /** 整盘 alpha（视图转场用） */
  alpha: number;
  /** 新盘面逐圈亮起进度 0..1（§19.4 展开阶段） */
  reveal: number;
}

/** 整机仪象：遥测驱动的第二套盘面。 */
export class SystemPlate {
  snapshot: SystemSnapshot | null = null;
  /** 最近一次遥测到达时间（断流检测用） */
  lastAt = 0;
  hoverPid: number | null = null;

  private disp: Disp = emptyDisp();
  private hasDisp = false;
  private phaseRx = 0;
  private phaseTx = 0;
  private meteorAt = 0;
  private meteorAngle = 0;
  private tickCache: { canvas: HTMLCanvasElement; size: number; dpr: number; key: string } | null = null;
  /** v2.2 跨档交叉淡入：旧拨盘缓存 180ms 淡出（§21.1 禁止清晰度硬切） */
  private fadeCache: { canvas: HTMLCanvasElement; size: number; dpr: number; key: string } | null = null;
  private fadeAt = -1e9;
  /** v2.8 §27.2：中枢核心的忙闲因子与累计转角（busyN = max(cpuN,gpuN,0.25)） */
  private hubBusy = 0.25;
  private hubSpin = 0;

  setSystem(snapshot: SystemSnapshot | null): void {
    if (!snapshot) {
      this.snapshot = null;
      return;
    }
    this.snapshot = snapshot;
    this.lastAt = performance.now();
    if (!snapshot.available) return;
    if (!this.hasDisp) {
      // 第一帧直接对齐目标（不从 0 慢慢爬，避免「假增长」观感）
      this.disp = this.readDisp(snapshot);
      this.hasDisp = true;
    }
  }
  get available(): boolean {
    return !!this.snapshot && this.snapshot.available;
  }

  private readDisp(s: SystemSnapshot): Disp {
    return {
      cpu: clamp01(clampSigned(s.cpu?.usage)),
      perCore: (s.cpu?.perCore ?? []).map((v) => clamp01(clampSigned(v))),
      memPct: clamp01(clampSigned(s.mem?.usedPct)),
      memUsed: clampSigned(s.mem?.usedBytes),
      memTotal: clampSigned(s.mem?.totalBytes),
      disks: (s.disks ?? []).map((d) => ({
        usedPct: clamp01(clampSigned(d.usedPct)),
        totalBytes: clampSigned(d.totalBytes),
        freeBytes: clampSigned(d.freeBytes),
        name: d.name ?? '?',
      })),
      rx: clampSigned(s.net?.rxBps),
      tx: clampSigned(s.net?.txBps),
      procs: (s.procs ?? []).slice(0, 8).map((p) => ({
        pid: p.pid,
        name: p.name ?? '?',
        cpuPct: clampSigned(p.cpuPct),
        memBytes: clampSigned(p.memBytes),
      })),
      uptime: clampSigned(s.uptimeSec),
      battery: s.battery ? { percent: clamp(s.battery.percent, 0, 100), charging: !!s.battery.charging } : null,
    };
  }

  /** 静态缓存：uptime 拨盘（24 小时 = 一整圈）。v2.1：sharp = 深度缩放档位重渲染。 */
  build(env: Env, sharp = 1): void {
    const dpr = clamp(env.dpr * sharp, 1, 3.6);
    const size = Math.ceil((env.R * SG.tickOut + 22) * 2);
    const key = `${size}:${dpr.toFixed(2)}:${env.params.ticks.toFixed(2)}`;
    if (this.tickCache && this.tickCache.key === key) return;
    // v2.2 §21.1：跨清晰度档位时不硬切，旧缓存保留 180ms 交叉淡出
    if (this.tickCache && this.tickCache.key !== key) {
      this.fadeCache = this.tickCache;
      this.fadeAt = env.now;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = Math.max(1, Math.round(size * dpr));
    const g = canvas.getContext('2d');
    if (!g) {
      this.tickCache = { canvas, size, dpr, key };
      return;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.translate(size / 2, size / 2);
    const R = env.R;
    const rIn = R * SG.tickIn;
    const rOut = R * SG.tickOut;
    const ticksK = clamp(env.params.ticks, 0.4, 1.5);
    const eng = env.params.engravingDepth;
    // 环带浅洗 + 内外界
    g.fillStyle = rgba(COLORS.gold400, 0.022 + 0.018 * eng);
    g.beginPath();
    g.arc(0, 0, rOut, 0, TAU);
    g.arc(0, 0, rIn, 0, TAU, true);
    g.fill();
    g.strokeStyle = rgba(COLORS.gold400, 0.3 + 0.16 * eng);
    g.lineWidth = 1;
    g.beginPath();
    g.arc(0, 0, rOut, 0, TAU);
    g.stroke();
    g.strokeStyle = rgba(COLORS.gold500, 0.26 + 0.14 * eng);
    g.beginPath();
    g.arc(0, 0, rIn, 0, TAU);
    g.stroke();
    // 内三环
    for (let k = 1; k <= 3; k += 1) {
      g.strokeStyle = rgba(COLORS.gold500, 0.1 + 0.06 * eng);
      g.lineWidth = 0.75;
      g.beginPath();
      g.arc(0, 0, rIn + ((rOut - rIn) * k) / 4, 0, TAU);
      g.stroke();
    }
    // 96 刻（每 15 分钟）
    g.strokeStyle = rgba(COLORS.gold500, 0.12);
    g.lineWidth = 0.5;
    g.beginPath();
    for (let i = 0; i < 96; i += 1) {
      const a = (i / 96) * TAU;
      const sin = Math.sin(a);
      const cos = Math.cos(a);
      g.moveTo(sin * (rOut - 1.5), -cos * (rOut - 1.5));
      g.lineTo(sin * (rOut - 3.2), -cos * (rOut - 3.2));
    }
    g.stroke();
    // 24 小时主刻
    g.strokeStyle = rgba(COLORS.gold300, 0.42 + 0.14 * eng);
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < 24; i += 1) {
      const a = (i / 24) * TAU;
      const len = i % 6 === 0 ? 8.5 : 5;
      const sin = Math.sin(a);
      const cos = Math.cos(a);
      g.moveTo(sin * rOut, -cos * rOut);
      g.lineTo(sin * (rOut - len * ticksK), -cos * (rOut - len * ticksK));
    }
    g.stroke();
    // 四正时标签（仅宽屏由调用方决定是否画：缓存里画上，绘制时用宽屏参数控制 alpha 不可行——
    // 这里只存刻线，标签在热循环里按宽度决定是否绘制，避免缓存按宽度分裂）
    this.tickCache = { canvas, size, dpr, key };
  }

  /** 2s 采样 → 平滑插值；同时检测网络尖峰触发单颗流星（§19.2⑦）。 */
  update(env: Env): void {
    const s = this.snapshot;
    if (!s || !s.available) {
      // 遥测不可用：显示值缓慢归零（但 UI 显示的是「不可用」文案，不显示 0 值假数据）
      const k = 1 - Math.exp(-1.6 * env.dt);
      this.disp.cpu = lerp(this.disp.cpu, 0, k);
      this.disp.memPct = lerp(this.disp.memPct, 0, k);
      return;
    }
    const t = this.readDisp(s);
    const k = 1 - Math.exp(-2.4 * env.dt);
    const prev = this.disp;
    // 网络流速相位（对数归一 → 弧上流动速度）
    const rxSpeed = 0.25 + rateLevel(t.rx) * 1.9;
    const txSpeed = 0.25 + rateLevel(t.tx) * 1.9;
    this.phaseRx = (this.phaseRx + env.dt * rxSpeed) % 1;
    this.phaseTx = (this.phaseTx + env.dt * txSpeed) % 1;
    // 尖峰检测（采样间增量）：只触发一次流星
    if (env.now - this.meteorAt > 5200) {
      const jump = t.rx + t.tx;
      const base = prev.rx + prev.tx;
      if (jump > 1.6 * 1024 * 1024 && jump > base * 2.1) {
        this.meteorAt = env.now;
        this.meteorAngle = rand01(`meteor:${Math.floor(env.now / 5200)}`) * TAU;
      }
    }
    // 逐项 damp
    const d = this.disp;
    d.cpu = lerp(d.cpu, t.cpu, k);
    if (d.perCore.length !== t.perCore.length) {
      d.perCore = t.perCore.map((_, i) => d.perCore[i] ?? 0);
    }
    for (let i = 0; i < t.perCore.length; i += 1) {
      d.perCore[i] = lerp(d.perCore[i] ?? 0, t.perCore[i] ?? 0, k);
    }
    d.memPct = lerp(d.memPct, t.memPct, k);
    d.memUsed = lerp(d.memUsed, t.memUsed, k);
    d.memTotal = lerp(d.memTotal, t.memTotal, k * 0.4);
    d.rx = lerp(d.rx, t.rx, k);
    d.tx = lerp(d.tx, t.tx, k);
    d.uptime = t.uptime; // 时间不插值
    d.battery = t.battery;
    d.procs = t.procs;
    // 磁盘列表变化时重建，否则平滑 used
    if (d.disks.length !== t.disks.length) d.disks = t.disks.map((x) => ({ ...x }));
    else for (let i = 0; i < t.disks.length; i += 1) d.disks[i]!.usedPct = lerp(d.disks[i]!.usedPct, t.disks[i]!.usedPct, k);
  }

  // ———————————————————————————————— 绘制（世界坐标，调用方已 apply 相机）

  draw(ctx: CanvasRenderingContext2D, view: View, opts: SystemDrawOpts): void {
    const env = view.env;
    const R = env.R;
    ctx.save();
    ctx.globalAlpha = clamp01(opts.alpha);

    if (!this.available) {
      this.drawUnavailable(ctx, env);
      ctx.restore();
      return;
    }

    const d = this.disp;
    const reveal = opts.reveal;
    // v2.8 §27.2：核心忙闲因子 = max(cpuN, gpuN, 0.25)；gpu 缺失时退回 CPU
    this.hubBusy = damp(this.hubBusy, coreBusyN(d.cpu, env.system?.gpu ?? null), 2.5, env.dt);
    this.hubSpin = (this.hubSpin + env.dt * (0.06 + 0.42 * this.hubBusy)) % TAU;
    const layerA = (lo: number, hi: number): number => clamp01((reveal - lo) / (hi - lo));
    const hubA = layerA(0, 0.28);
    const memA = layerA(0.12, 0.42);
    const diskA = layerA(0.28, 0.58);
    const netA = layerA(0.44, 0.72);
    const procA = layerA(0.58, 0.88);
    const tickA = layerA(0.72, 1);

    // ① 中枢：CPU 核 + 核心辐条（呼吸来自 2s 采样插值，不是 sin）
    this.drawHub(ctx, env, d, hubA);

    // ② 内存带
    if (memA > 0.01) this.drawMemory(ctx, env, d, memA);

    // ③ 磁盘轨
    if (diskA > 0.01) this.drawDisks(ctx, env, d, diskA);

    // ④ 网络轨
    if (netA > 0.01) this.drawNet(ctx, env, d, netA);

    // ⑤ 进程刻度
    if (procA > 0.01) this.drawProcs(ctx, env, d, procA);

    // ⑥ 授时环（uptime 刻度）+ 当前刻标 + 文案
    if (tickA > 0.01) this.drawUptimeRing(ctx, env, d, tickA);

    // ⑦ 机箱尘点流星（有 I/O 尖峰才划过一次，不循环）
    const meteorAge = env.now - this.meteorAt;
    if (this.meteorAt > 0 && meteorAge < 620) {
      const k = meteorAge / 620;
      const a0 = this.meteorAngle + k * 0.42;
      const rr = R * (1.16 - 0.16 * k);
      const sin = Math.sin(a0);
      const cos = Math.cos(a0);
      const len = R * 0.12 * (1 - k * 0.5);
      ctx.strokeStyle = rgba(COLORS.bone200, 0.5 * (1 - k) * opts.alpha);
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(sin * rr, -cos * rr);
      ctx.lineTo(sin * (rr + len), -cos * (rr + len));
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawUnavailable(ctx: CanvasRenderingContext2D, env: Env): void {
    const R = env.R;
    // 仪器完整：紫宫双环 + 授时环 + 内外界，全部 alpha .35、静止
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = rgba(COLORS.gold400, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, R * SG.hub, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, R * SG.hub * 0.84, 0, TAU);
    ctx.stroke();
    const rIn = R * SG.tickIn;
    const rOut = R * SG.tickOut;
    ctx.beginPath();
    ctx.arc(0, 0, rOut, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, rIn, 0, TAU);
    ctx.stroke();
    for (const rr of [SG.memOut, SG.diskOut, SG.netOut, SG.procOut]) {
      ctx.strokeStyle = rgba(COLORS.gold500, 0.24);
      ctx.beginPath();
      ctx.arc(0, 0, R * rr, 0, TAU);
      ctx.stroke();
    }
    if (this.tickCache) {
      this.drawTicks(ctx, env);
    }
    ctx.restore();
    // 一行提示（不显示 0 值假数据）；v2.1 深度缩放时保持屏幕字号
    const ts = textScale(env);
    ctx.save();
    ctx.translate(0, R * SG.memIn + 16);
    if (ts !== 1) ctx.scale(ts, ts);
    ctx.font = `400 12px ${FONTS.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = rgba(COLORS.bone300, 0.72);
    ctx.fillText('遥测不可用 · 检查采样器', 0, 0);
    ctx.restore();
  }

  private drawHub(ctx: CanvasRenderingContext2D, env: Env, d: Disp, alpha: number): void {
    if (alpha <= 0.01) return;
    const R = env.R;
    const hubR = R * SG.hub;
    const breathe = 0.94 + 0.08 * d.cpu;
    const r = hubR * breathe;
    // 径向柔光（预生成精灵，非 shadowBlur）
    ctx.save();
    ctx.globalAlpha = alpha;
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, hubR * 1.5);
    glow.addColorStop(0, rgba(COLORS.gold300, 0.16 + 0.16 * d.cpu));
    glow.addColorStop(0.45, rgba(COLORS.gold400, 0.08));
    glow.addColorStop(1, rgba(COLORS.gold400, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, hubR * 1.5, 0, TAU);
    ctx.fill();
    // 核体双环
    ctx.strokeStyle = rgba(COLORS.gold300, 0.55);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = rgba(COLORS.gold400, 0.32);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.82, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = rgba(COLORS.gold200, 0.1 + 0.18 * d.cpu);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.82, 0, TAU);
    ctx.fill();
    // 中心珠
    ctx.fillStyle = rgba(COLORS.gold100, 0.9);
    ctx.beginPath();
    ctx.arc(0, 0, 2.1, 0, TAU);
    ctx.fill();
    // 核心辐条：数量 = 物理核心数，长度 ∝ perCore[i]
    const cores = d.perCore;
    const n = cores.length;
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * TAU + this.hubSpin;
      const v = clamp01(cores[i] ?? 0);
      const len = hubR * (0.2 + 0.62 * v);
      const sin = Math.sin(a);
      const cos = Math.cos(a);
      const active = v > 0.25;
      ctx.strokeStyle = rgba(active ? COLORS.gold200 : COLORS.bone300, (active ? 0.62 : 0.25) * alpha);
      ctx.lineWidth = active ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(sin * r * 0.86, -cos * r * 0.86);
      ctx.lineTo(sin * (r * 0.86 + len), -cos * (r * 0.86 + len));
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    // CPU 百分比（等宽小字，核下方）；v2.1 深度缩放时保持屏幕字号
    const ts = textScale(env);
    ctx.save();
    ctx.translate(0, r + 13);
    if (ts !== 1) ctx.scale(ts, ts);
    ctx.font = `400 10px ${FONTS.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = rgba(COLORS.bone200, 0.82 * alpha);
    ctx.fillText(`CPU ${(d.cpu * 100).toFixed(1)}%`, 0, 0);
    ctx.restore();
    ctx.restore();
  }

  private drawMemory(ctx: CanvasRenderingContext2D, env: Env, d: Disp, alpha: number): void {
    if (alpha <= 0.01) return;
    const R = env.R;
    const rIn = R * SG.memIn;
    const rOut = R * SG.memOut;
    const start = -Math.PI / 2; // 12 点方向
    const k = clamp01(d.memPct);
    ctx.save();
    ctx.globalAlpha = alpha;
    // 未用段：极淡轨
    ctx.strokeStyle = rgba(COLORS.bone400, 0.1);
    ctx.lineWidth = rOut - rIn;
    ctx.beginPath();
    ctx.arc(0, 0, (rIn + rOut) / 2, 0, TAU);
    ctx.stroke();
    // 填充段：骨白 → 金 的径向短渐变
    if (k > 0.004) {
      const grad = ctx.createRadialGradient(0, 0, rIn, 0, 0, rOut);
      grad.addColorStop(0, rgba(COLORS.gold300, 0.28));
      grad.addColorStop(0.55, rgba(COLORS.bone200, 0.46));
      grad.addColorStop(1, rgba(COLORS.gold200, 0.38));
      ctx.strokeStyle = grad;
      ctx.lineWidth = (rOut - rIn) * 0.92;
      ctx.beginPath();
      ctx.arc(0, 0, (rIn + rOut) / 2, start, start + k * TAU);
      ctx.stroke();
      // 前沿亮点
      const ea = start + k * TAU;
      ctx.fillStyle = rgba(COLORS.gold100, 0.9);
      ctx.beginPath();
      ctx.arc(Math.sin(ea) * (rOut - 2), -Math.cos(ea) * (rOut - 2), 1.6, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = rgba(COLORS.gold400, 0.34);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, rIn, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, rOut, 0, TAU);
    ctx.stroke();
    // 带内小字：61.8% · 41.5 / 64.0 GB（等宽、居中不跳动）
    const text = `${(d.memPct * 100).toFixed(1)}% · ${bytesLabel(d.memUsed)} / ${bytesLabel(d.memTotal)} GB`;
    radialText(
      ctx,
      start + Math.PI * 0.25,
      (rIn + rOut) / 2,
      text,
      `400 10px ${FONTS.mono}`,
      rgba(COLORS.bone100, 0.82),
      R * 0.34,
      textScale(env),
    );
    ctx.restore();
  }

  private drawDisks(ctx: CanvasRenderingContext2D, env: Env, d: Disp, alpha: number): void {
    if (alpha <= 0.01 || d.disks.length === 0) return;
    const R = env.R;
    const rIn = R * SG.diskIn;
    const rOut = R * SG.diskOut;
    const total = d.disks.reduce((acc, x) => acc + Math.max(1, x.totalBytes), 0);
    const gap = 0.03;
    const avail = TAU - gap * d.disks.length;
    let acc = -Math.PI / 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < d.disks.length; i += 1) {
      const disk = d.disks[i]!;
      const span = (Math.max(1, disk.totalBytes) / total) * avail;
      const a0 = acc + gap / 2;
      const a1 = a0 + span;
      // 底轨
      ctx.strokeStyle = rgba(COLORS.bone400, 0.1);
      ctx.lineWidth = 3; // 薄轨：磁盘是「轨道」不是「带」
      ctx.beginPath();
      ctx.arc(0, 0, (rIn + rOut) / 2, a0, a1);
      ctx.stroke();
      // 已用比例：段内深浅
      const used = clamp01(disk.usedPct);
      const col = used > 0.92 ? COLORS.gold100 : used > 0.8 ? COLORS.gold200 : COLORS.gold300;
      ctx.strokeStyle = rgba(col, 0.5 + 0.24 * used);
      ctx.lineWidth = 2.1;
      ctx.beginPath();
      ctx.arc(0, 0, (rIn + rOut) / 2, a0, a0 + span * used);
      ctx.stroke();
      // 每盘一段的端刻
      ctx.strokeStyle = rgba(COLORS.gold500, 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.sin(a0) * rIn, -Math.cos(a0) * rIn);
      ctx.lineTo(Math.sin(a0) * rOut, -Math.cos(a0) * rOut);
      ctx.stroke();
      // 标签（仅 ≥1440 宽）
      if (env.w >= 1440) {
        const mid = (a0 + a1) / 2;
        radialText(
          ctx,
          mid,
          (rIn + rOut) / 2,
          `${disk.name}: ${(disk.usedPct * 100).toFixed(1)}%`,
          `400 10px ${FONTS.mono}`,
          rgba(COLORS.bone200, 0.7),
          R * 0.2,
          textScale(env),
        );
      }
      acc = a1 + gap / 2;
    }
    ctx.restore();
  }

  private drawNet(ctx: CanvasRenderingContext2D, env: Env, d: Disp, alpha: number): void {
    if (alpha <= 0.01) return;
    const R = env.R;
    const rRx = R * (SG.netIn + 0.01);
    const rTx = R * (SG.netOut - 0.01);
    const rxL = rateLevel(d.rx);
    const txL = rateLevel(d.tx);
    const col = COLORS.indigo400; // 唯一冷色：网络流靛（面积 < 5%）
    ctx.save();
    ctx.globalAlpha = alpha;
    // 底轨
    ctx.strokeStyle = rgba(col, 0.13);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, rRx, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, rTx, 0, TAU);
    ctx.stroke();
    // 两道反向细流：长度与流速 ∝ 速率（对数归一）；无数据时静止
    const drawFlow = (radius: number, level: number, dir: 1 | -1, phase: number, y: number): void => {
      if (level <= 0.02) return;
      const segs = 3;
      const segLen = 0.1 + level * 0.3;
      for (let i = 0; i < segs; i += 1) {
        const base = (phase + i / segs) % 1;
        const a = -Math.PI / 2 + dir * base * TAU;
        const a2 = a + dir * segLen;
        ctx.strokeStyle = rgba(col, (0.18 + 0.4 * level) * (1 - i * 0.22));
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(0, 0, radius, Math.min(a, a2), Math.max(a, a2));
        ctx.stroke();
        // 流头 2px 骨白点
        ctx.fillStyle = rgba(COLORS.bone100, 0.75 * level);
        ctx.beginPath();
        ctx.arc(Math.sin(a2) * radius, -Math.cos(a2) * radius, 1.3, 0, TAU);
        ctx.fill();
      }
      // 极小的方向标记（↑ 外圈 / ↓ 内圈）——世界内标注
      ctx.font = `400 9px ${FONTS.mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = rgba(COLORS.bone300, 0.5);
      ctx.fillText(dir > 0 ? '↑' : '↓', 0, y);
    };
    drawFlow(rRx, rxL, 1, this.phaseRx, -rRx - 7);
    drawFlow(rTx, txL, -1, this.phaseTx, rTx + 8);
    ctx.restore();
  }

  private drawProcs(ctx: CanvasRenderingContext2D, env: Env, d: Disp, alpha: number): void {
    if (alpha <= 0.01 || d.procs.length === 0) return;
    const R = env.R;
    const rIn = R * SG.procIn;
    const rOut = R * SG.procOut;
    const maxCpu = Math.max(4, ...d.procs.map((p) => p.cpuPct));
    ctx.save();
    ctx.globalAlpha = alpha;
    // 内外界：进程刻度是「刻度列」，两侧细线界定
    ctx.strokeStyle = rgba(COLORS.gold500, 0.22);
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.arc(0, 0, rIn, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, rOut, 0, TAU);
    ctx.stroke();
    ctx.lineCap = 'butt';
    for (let i = 0; i < d.procs.length; i += 1) {
      const p = d.procs[i]!;
      const a = -Math.PI / 2 + rand01(`proc:${p.pid}`) * TAU;
      const v = clamp01(p.cpuPct / maxCpu);
      const len = R * (0.014 + 0.09 * v);
      const hot = p.cpuPct > 18;
      ctx.strokeStyle = rgba(hot ? COLORS.gold200 : COLORS.bone300, (hot ? 0.62 : 0.36) * alpha);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(Math.sin(a) * rIn, -Math.cos(a) * rIn);
      ctx.lineTo(Math.sin(a) * (rIn + len), -Math.cos(a) * (rIn + len));
      ctx.stroke();
      if (this.hoverPid === p.pid) {
        ctx.strokeStyle = rgba(COLORS.gold100, 0.9);
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(Math.sin(a) * rIn, -Math.cos(a) * rIn);
        ctx.lineTo(Math.sin(a) * (rIn + len), -Math.cos(a) * (rIn + len));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** v2.2 §21.1：静态拨盘绘制（跨清晰度档位时旧缓存 180ms 交叉淡出，禁止硬切）。 */
  private drawTicks(ctx: CanvasRenderingContext2D, env: Env): void {
    if (this.tickCache) gDrawCache(ctx, this.tickCache);
    if (!this.fadeCache) return;
    const t = clamp01((env.now - this.fadeAt) / 180);
    if (t >= 1) {
      this.fadeCache = null;
      return;
    }
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * (1 - t);
    gDrawCache(ctx, this.fadeCache);
    ctx.globalAlpha = prev;
  }

  private drawUptimeRing(ctx: CanvasRenderingContext2D, env: Env, d: Disp, alpha: number): void {
    if (alpha <= 0.01) return;
    const R = env.R;
    ctx.save();
    ctx.globalAlpha = alpha;
    this.drawTicks(ctx, env);
    // 24 小时 = 一整圈：当前时刻标记 + uptime 文案
    const dayFrac = ((d.uptime / 3600) % 24) / 24;
    const a = -Math.PI / 2 + dayFrac * TAU;
    const rIn = R * SG.tickIn;
    const rOut = R * SG.tickOut;
    ctx.strokeStyle = rgba(COLORS.gold200, 0.9);
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(Math.sin(a) * (rOut + 1.5), -Math.cos(a) * (rOut + 1.5));
    ctx.lineTo(Math.sin(a) * (rIn - 1), -Math.cos(a) * (rIn - 1));
    ctx.stroke();
    // 文案：已行 3 日 2 时
    const days = Math.floor(d.uptime / 86400);
    const hours = Math.floor((d.uptime % 86400) / 3600);
    const mins = Math.floor((d.uptime % 3600) / 60);
    const upText = days > 0 ? `已行 ${days} 日 ${hours} 时` : `已行 ${hours} 时 ${mins} 分`;
    radialText(
      ctx,
      a + Math.PI,
      (rIn + rOut) / 2,
      upText,
      `500 11px ${FONTS.display}`,
      rgba(COLORS.gold200, 0.9),
      R * 0.3,
      textScale(env),
    );
    // 四正时（仅 ≥1440 宽；文案用 uptime 的 0/6/12/18 时）
    if (env.w >= 1440) {
      for (let i = 0; i < 4; i += 1) {
        const ang = -Math.PI / 2 + (i / 4) * TAU;
        radialText(
          ctx,
          ang,
          rOut + 12,
          `${i * 6} 时`,
          `400 10px ${FONTS.mono}`,
          rgba(COLORS.bone300, 0.55),
          R * 0.1,
          textScale(env),
        );
      }
    }
    // 电池（有才画，不编造）
    if (d.battery) {
      const b = d.battery;
      radialText(
        ctx,
        Math.PI / 2,
        (rIn + rOut) / 2,
        `电 ${Math.round(b.percent)}%${b.charging ? ' · 充' : ''}`,
        `400 10px ${FONTS.mono}`,
        rgba(b.percent < 20 && !b.charging ? COLORS.gold200 : COLORS.bone300, 0.72),
        R * 0.2,
        textScale(env),
      );
    }
    ctx.restore();
  }

  /** 悬停命中：进程刻度端点附近 12px。 */
  hoverAt(env: Env, camera: { worldToScreen(e: Env, x: number, y: number): { x: number; y: number } }, sx: number, sy: number): ProcView | null {
    if (!this.available) return null;
    const d = this.disp;
    const R = env.R;
    const rIn = R * SG.procIn;
    const maxCpu = Math.max(4, ...d.procs.map((p) => p.cpuPct));
    let best: ProcView | null = null;
    let bestD = 12;
    for (const p of d.procs) {
      const a = -Math.PI / 2 + rand01(`proc:${p.pid}`) * TAU;
      const v = clamp01(p.cpuPct / maxCpu);
      const len = R * (0.014 + 0.09 * v);
      const wx = Math.sin(a) * (rIn + len);
      const wy = -Math.cos(a) * (rIn + len);
      const sp = camera.worldToScreen(env, wx, wy);
      const dist = Math.hypot(sp.x - sx, sp.y - sy);
      if (dist < bestD) {
        bestD = dist;
        best = p;
      }
    }
    return best;
  }

  /** 悬停标签（屏幕坐标）。 */
  drawLabels(ctx: CanvasRenderingContext2D, env: Env, camera: { worldToScreen(e: Env, x: number, y: number): { x: number; y: number } }): void {
    if (!this.available || this.hoverPid === null) return;
    const p = this.disp.procs.find((x) => x.pid === this.hoverPid);
    if (!p) return;
    const R = env.R;
    const rIn = R * SG.procIn;
    const maxCpu = Math.max(4, ...this.disp.procs.map((x) => x.cpuPct));
    const a = -Math.PI / 2 + rand01(`proc:${p.pid}`) * TAU;
    const v = clamp01(p.cpuPct / maxCpu);
    const len = R * (0.014 + 0.09 * v);
    const wp = camera.worldToScreen(env, Math.sin(a) * (rIn + len), -Math.cos(a) * (rIn + len));
    const text = `${p.name} · ${p.cpuPct.toFixed(1)}% · ${
      p.memBytes >= 1024 ** 3 ? `${(p.memBytes / 1024 ** 3).toFixed(1)}G` : `${Math.round(p.memBytes / 1024 ** 2)}M`
    }`;
    ctx.save();
    // v2.4.1：进程悬停标签在屏幕坐标里画，随 zoom 温和放大（2× +22%、6× +60%）
    ctx.font = `400 ${Math.round(10 * textScreenGrow(env))}px ${FONTS.mono}`;
    const w = ctx.measureText(text).width;
    const x = clamp(wp.x + 10, 8, env.w - w - 10);
    const y = clamp(wp.y - 10, 14, env.h - 10);
    ctx.fillStyle = 'rgba(5,7,11,0.82)';
    ctx.fillRect(x - 4, y - 9, w + 8, 16);
    ctx.strokeStyle = rgba(COLORS.gold500, 0.6);
    ctx.lineWidth = 0.75;
    ctx.strokeRect(x - 4, y - 9, w + 8, 16);
    ctx.fillStyle = rgba(COLORS.bone100, 0.92);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - 0.5);
    ctx.restore();
  }

  /** 辉光层（1/3 分辨率）：CPU 核 + 内存前沿。 */
  drawGlow(ctx: CanvasRenderingContext2D, view: View, alpha: number): void {
    if (!this.available || alpha <= 0.01) return;
    const d = this.disp;
    const env = view.env;
    const hubR = env.R * SG.hub;
    ctx.save();
    ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, hubR * 1.8);
    g.addColorStop(0, rgba(COLORS.gold200, 0.14 + 0.18 * d.cpu));
    g.addColorStop(1, rgba(COLORS.gold300, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, hubR * 1.8, 0, TAU);
    ctx.fill();
    const memR = env.R * (SG.memIn + SG.memOut) / 2;
    const ma = -Math.PI / 2 + clamp01(d.memPct) * TAU;
    const gg = ctx.createRadialGradient(Math.sin(ma) * memR, -Math.cos(ma) * memR, 0, Math.sin(ma) * memR, -Math.cos(ma) * memR, 26);
    gg.addColorStop(0, rgba(COLORS.gold200, 0.16));
    gg.addColorStop(1, rgba(COLORS.gold300, 0));
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.arc(Math.sin(ma) * memR, -Math.cos(ma) * memR, 26, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

/** 以 canvas 像素尺寸居中对齐绘制离屏缓存（世界坐标原点）。 */
function gDrawCache(ctx: CanvasRenderingContext2D, cache: { canvas: HTMLCanvasElement; size: number }): void {
  const full = cache.size;
  ctx.drawImage(cache.canvas, -full / 2, -full / 2, full, full);
}
