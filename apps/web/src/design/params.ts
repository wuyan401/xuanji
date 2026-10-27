// 视觉参数：调参台 / URL / localStorage 共用一份定义。
// 参数 key 与 docs/ARCHITECTURE.md §10 对应；场景与 HUD 都只读这个结构。

export interface VisualParams {
  // 节拍 Beat
  beatEnergy: number; // 0..1.5
  tempoGain: number; // 0.2..3
  jitter: number; // 0..0.4
  pulseDecay: number; // 0.1..1
  // 浑仪 Orrery
  ringSpeed: number; // 0..0.6
  ringCount: number; // 1..5
  ticks: number; // 0..1.5
  engravingDepth: number; // 0..1
  // 星场 Stars
  starDensity: number; // 0..1
  dust: number; // 0..1
  parallax: number; // 0..0.8
  twinkle: number; // 0..1
  // 光束 Beams
  beamLayers: number; // 1..5
  beamLength: number; // 0.2..1.2
  beamFade: number; // 0.1..1
  toolGlow: number; // 0..1
  // 质感 Post
  glow: number; // 0..1
  dof: number; // 0..1
  grain: number; // 0..0.6
  vignette: number; // 0..0.8
  aberration: number; // 0..0.6
  // v2.4.2：画布内文字整体倍数（放大后字更大的直接旋钮）；v2.4.3 默认 1 → 1.4（用户「再大一截」）
  textBoost: number; // 0.8..2.4
  // 运镜 Camera
  autoDirector: number; // 0|1
  dwell: number; // 6..24 秒
  pushIn: number; // 0..1
  manualReturn: number; // 3..20 秒
}

export const DEFAULT_PARAMS: VisualParams = {
  beatEnergy: 0.6,
  tempoGain: 1.4,
  jitter: 0.12,
  pulseDecay: 0.7,
  ringSpeed: 0.18,
  ringCount: 3,
  ticks: 1,
  engravingDepth: 0.5,
  starDensity: 0.5,
  dust: 0.35,
  parallax: 0.3,
  twinkle: 0.4,
  beamLayers: 5,
  beamLength: 0.7,
  beamFade: 0.5,
  toolGlow: 0.6,
  glow: 0.55,
  dof: 0.4,
  grain: 0.25,
  vignette: 0.5,
  aberration: 0.2,
  textBoost: 1.4,
  // v2.1 视野主权（BIBLE §20）：默认不自动运镜，人不动则镜头不动；Space 或调参台显式开启。
  autoDirector: 0,
  dwell: 12,
  pushIn: 0.7,
  manualReturn: 8,
};

export interface ParamSpec {
  key: keyof VisualParams;
  group: string;
  label: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
}

export const PARAM_SPECS: ParamSpec[] = [
  { key: 'beatEnergy', group: '节拍', label: '脉冲强度', min: 0, max: 1.5, step: 0.01 },
  { key: 'tempoGain', group: '节拍', label: '节拍增益', min: 0.2, max: 3, step: 0.01 },
  { key: 'jitter', group: '节拍', label: '拍点抖动', min: 0, max: 0.4, step: 0.005 },
  { key: 'pulseDecay', group: '节拍', label: '脉冲衰减', min: 0.1, max: 1, step: 0.01 },
  { key: 'ringSpeed', group: '浑仪', label: '环速', min: 0, max: 0.6, step: 0.005 },
  { key: 'ringCount', group: '浑仪', label: '环数', min: 1, max: 5, step: 1 },
  { key: 'ticks', group: '浑仪', label: '刻度密度', min: 0, max: 1.5, step: 0.01 },
  { key: 'engravingDepth', group: '浑仪', label: '錾刻深度', min: 0, max: 1, step: 0.01 },
  { key: 'starDensity', group: '星场', label: '星野密度', min: 0, max: 1, step: 0.01 },
  { key: 'dust', group: '星场', label: '尘埃', min: 0, max: 1, step: 0.01 },
  { key: 'parallax', group: '星场', label: '视差', min: 0, max: 0.8, step: 0.01 },
  { key: 'twinkle', group: '星场', label: '星闪', min: 0, max: 1, step: 0.01 },
  { key: 'beamLayers', group: '光束', label: '光束层数', min: 1, max: 5, step: 1 },
  { key: 'beamLength', group: '光束', label: '光束长度', min: 0.2, max: 1.2, step: 0.01 },
  { key: 'beamFade', group: '光束', label: '光束余晖', min: 0.1, max: 1, step: 0.01 },
  { key: 'toolGlow', group: '光束', label: '器用辉光', min: 0, max: 1, step: 0.01 },
  { key: 'glow', group: '质感', label: '辉光', min: 0, max: 1, step: 0.01 },
  { key: 'dof', group: '质感', label: '景深', min: 0, max: 1, step: 0.01 },
  { key: 'grain', group: '质感', label: '颗粒', min: 0, max: 0.6, step: 0.01 },
  { key: 'vignette', group: '质感', label: '暗角', min: 0, max: 0.8, step: 0.01 },
  { key: 'aberration', group: '质感', label: '色散', min: 0, max: 0.6, step: 0.01 },
  // v2.4.2：画布内文字（分野名/宿名/星名/五行字/进程标签）整体倍数；放大时字会随 zoom 增大，此值再叠加放大。
  { key: 'textBoost', group: '质感', label: '字号', min: 0.8, max: 2.4, step: 0.1, hint: '画布内文字整体倍数 · 默认 1.4' },
  { key: 'autoDirector', group: '运镜', label: '自动运镜', min: 0, max: 1, step: 1, hint: '默认关 · Space 开关' },
  { key: 'dwell', group: '运镜', label: '镜头停留', min: 6, max: 24, step: 0.5 },
  { key: 'pushIn', group: '运镜', label: '推近幅度', min: 0, max: 1, step: 0.01 },
  { key: 'manualReturn', group: '运镜', label: '手动回归', min: 3, max: 20, step: 0.5 },
];

export type PresetName = '仪轨·夜航' | '静观' | '疾录' | '勘验' | '守夜';

export const PRESETS: Record<PresetName, Partial<VisualParams>> = {
  '仪轨·夜航': { ...DEFAULT_PARAMS },
  静观: {
    beatEnergy: 0.3,
    tempoGain: 0.8,
    ringSpeed: 0.08,
    starDensity: 0.65,
    twinkle: 0.25,
    beamLayers: 3,
    beamLength: 0.5,
    glow: 0.4,
    dof: 0.65,
    grain: 0.35,
    pushIn: 0.35,
    dwell: 18,
  },
  疾录: {
    beatEnergy: 1.05,
    tempoGain: 2.3,
    jitter: 0.2,
    ringSpeed: 0.34,
    starDensity: 0.4,
    beamLayers: 5,
    beamLength: 0.95,
    toolGlow: 0.9,
    glow: 0.7,
    aberration: 0.32,
    pushIn: 0.9,
    dwell: 9,
  },
  勘验: {
    beatEnergy: 0.35,
    ringSpeed: 0.1,
    ticks: 1.4,
    engravingDepth: 0.9,
    starDensity: 0.3,
    beamLayers: 2,
    glow: 0.25,
    dof: 0.2,
    grain: 0.12,
    vignette: 0.65,
    aberration: 0.05,
    autoDirector: 0,
  },
  守夜: {
    beatEnergy: 0.12,
    tempoGain: 0.5,
    ringSpeed: 0.03,
    starDensity: 0.8,
    dust: 0.6,
    twinkle: 0.55,
    beamLayers: 1,
    beamLength: 0.3,
    glow: 0.3,
    dof: 0.8,
    grain: 0.3,
    vignette: 0.7,
    autoDirector: 0,
    dwell: 24,
  },
};

const STORAGE_KEY = 'astra.visualParams.v3'; // v2.4.3：默认字号 1.4，旧 v2 键作废（避免用户旧存档里 textBoost=1 覆盖新默认）

export function loadParams(): VisualParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PARAMS };
    const parsed = JSON.parse(raw) as Partial<VisualParams>;
    return clampParams({ ...DEFAULT_PARAMS, ...parsed });
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}

export function saveParams(params: VisualParams): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
  } catch {
    /* ignore quota errors */
  }
}

export function clampParams(params: VisualParams): VisualParams {
  const out = { ...params };
  for (const spec of PARAM_SPECS) {
    const v = Number(out[spec.key]);
    if (!Number.isFinite(v)) {
      (out[spec.key] as number) = DEFAULT_PARAMS[spec.key] as number;
    } else {
      (out[spec.key] as number) = Math.min(spec.max, Math.max(spec.min, v));
    }
  }
  return out;
}

/** ?preset=疾录 或 ?preset=jilu（简单键值均可，做模糊匹配） */
export function applyUrlPreset(params: VisualParams, search: string): VisualParams {
  const sp = new URLSearchParams(search);
  const preset = sp.get('preset');
  if (!preset) return params;
  const hit = (Object.keys(PRESETS) as PresetName[]).find(
    (k) => k === preset || k.includes(preset) || k.replace('·', '').includes(preset),
  );
  if (!hit) return params;
  return clampParams({ ...params, ...PRESETS[hit] });
}

/** ?p=beatEnergy:1.2,glow:0.8 的直改 */
export function applyUrlParamOverrides(params: VisualParams, search: string): VisualParams {
  const sp = new URLSearchParams(search);
  const raw = sp.get('p');
  if (!raw) return params;
  const next = { ...params } as Record<string, number>;
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split(':');
    if (k && v && k in DEFAULT_PARAMS) {
      const num = Number(v);
      if (Number.isFinite(num)) next[k] = num;
    }
  }
  return clampParams(next as unknown as VisualParams);
}

export function exportParams(params: VisualParams): string {
  return JSON.stringify({ v: 1, params }, null, 2);
}

export function importParams(json: string): VisualParams | null {
  try {
    const obj = JSON.parse(json) as { params?: Partial<VisualParams> } | Partial<VisualParams>;
    const raw = (obj as { params?: Partial<VisualParams> }).params ?? (obj as Partial<VisualParams>);
    if (!raw || typeof raw !== 'object') return null;
    return clampParams({ ...DEFAULT_PARAMS, ...raw });
  } catch {
    return null;
  }
}
