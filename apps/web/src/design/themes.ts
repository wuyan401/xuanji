// v2.3 双主题：璇玑（青铜史书，默认） / 深空（科幻，参考群星·绝区零·2077 的「仪表/霓虹/扫描」语法，
// 只借机制不搬图形）。主题由 design/themes.ts 的 applyTheme() 同时改：
//  ① canvas 侧 token（COLORS / CATEGORY_COLOR / STATE_COLOR 原地改写）
//  ② DOM 侧 <html data-theme="...">，由 design/themes.css 覆盖 CSS 变量
// HUD / scene 都不得硬编码颜色，一律读 token。

import type { ColorToken } from './tokens';
import { COLORS, CATEGORY_COLOR, STATE_COLOR } from './tokens';
import type { SourceId } from '../state/types';
import { SOURCE_TINT } from '../state/types';

export type ThemeId = 'xuanji' | 'scifi';

/** 来源识别色（星环/分野来源小签/账本来源小签；只做 1px 识别，不参与面积预算） */
export type ThemeSource = Record<SourceId, string>;

/** v2.4 星→中枢工作光流与工具光束的调色板 */
export interface BeamPalette {
  /** 工作光流底色（1–2px 低 alpha 的长连线） */
  stream: string;
  /** 沿流匀速流动的粒子/光点 */
  particle: string;
  /** 连接动画的亮头（星侧向中枢画入的那一笔） */
  connect: string;
  /** 断开动画的回收色（中枢侧向星侧淡出） */
  disconnect: string;
  /** 工具光束的默认色（分类色缺省时兜底） */
  tool: string;
}

export interface ThemePalette {
  id: ThemeId;
  /** 界面名（中文） */
  label: string;
  /** 一句话气质 */
  mood: string;
  colors: Record<ColorToken, string>;
  category: Record<'read' | 'write' | 'exec' | 'net' | 'agent', string>;
  state: Record<'live' | 'idle' | 'ended' | 'error' | 'approval', string>;
  /** v2.4：来源识别色（主题化，scifi 下必须为冷色） */
  source: ThemeSource;
  /** v2.4：工作光流/工具光束调色板 */
  beam: BeamPalette;
}

export const THEME_LABEL: Record<ThemeId, string> = {
  xuanji: '璇玑',
  scifi: '深空',
};

export const THEMES: Record<ThemeId, ThemePalette> = {
  xuanji: {
    id: 'xuanji',
    label: '璇玑',
    mood: '铜器与史书：暖金仪器 + 骨白纸账本 + 冷月蓝远景',
    colors: {
      inkVoid: '#05070b',
      inkDeep: '#0a0d14',
      inkRaise: 'rgba(14,17,25,0.86)',
      inkVeil: 'rgba(5,7,11,0.62)',
      inkPanel: 'rgba(10,13,20,0.72)',
      inkLine: 'rgba(200,182,142,0.16)',
      inkLineStrong: 'rgba(200,182,142,0.34)',
      gold100: '#f4e3bc',
      gold200: '#e8c878',
      gold300: '#d8b26a',
      gold400: '#a8823f',
      gold500: '#6f5527',
      patina300: '#7fae98',
      patina500: '#3f5f53',
      bone100: '#ede6d4',
      bone200: '#d3cbb6',
      bone300: '#b3ab98',
      bone400: '#8b8474',
      bone500: '#5f5a4f',
      cold300: '#8fa0b8',
      indigo400: '#6c7fa0',
    },
    category: { read: '#5e9c7e', write: '#c0532f', exec: '#b98a4e', net: '#4e6e8e', agent: '#c9bfa6' },
    state: { live: '#e8c878', idle: '#b3ab98', ended: '#5f5a4f', error: '#c4553d', approval: '#7fbf9e' },
    source: {
      dsh: '#d8b26a',
      hermes: '#7fae98',
      opencode: '#4e6e8e',
      claude: '#b98a4e',
      codex: '#8b8474',
      other: '#6f6a5e',
    },
    beam: {
      stream: '#a8823f',
      particle: '#f4e3bc',
      connect: '#fdf1d4',
      disconnect: '#6f5527',
      tool: '#d8b26a',
    },
  },
  scifi: {
    id: 'scifi',
    label: '深空',
    mood: '舰桥仪表：青蓝扫描光 + 靛紫算力 + 琥珀警示，深空底上跑数据流',
    colors: {
      inkVoid: '#03060c',
      inkDeep: '#061019',
      inkRaise: 'rgba(8,20,32,0.86)',
      inkVeil: 'rgba(3,8,14,0.62)',
      inkPanel: 'rgba(6,16,26,0.74)',
      inkLine: 'rgba(110,196,224,0.18)',
      inkLineStrong: 'rgba(110,196,224,0.38)',
      // 主色位（原「金」）：青蓝扫描光
      gold100: '#e8fcff',
      gold200: '#9fe9ff',
      gold300: '#5fd0ea',
      gold400: '#2f9fbe',
      gold500: '#185a70',
      // 副色位（原「铜锈」）：荧光青绿
      patina300: '#7df0c4',
      patina500: '#2c7f66',
      // 正文位（原「骨白」）：冷白
      bone100: '#f2f9ff',
      bone200: '#d5e6f3',
      bone300: '#a8bccc',
      bone400: '#7a8fa2',
      bone500: '#4b5a6a',
      // 远景冷色 + 算力靛（AI 蓝）
      cold300: '#7fb8ff',
      indigo400: '#5b6cf0',
    },
    category: {
      read: '#58e0c0', // 木 → 荧光绿
      write: '#ff7a4d', // 火 → 警示橙
      exec: '#ffc247', // 土 → 琥珀
      net: '#4d9bff', // 水 → 电蓝
      agent: '#c9a6ff', // 金 → 靛紫
    },
    state: {
      live: '#6ee7ff',
      idle: '#a8bccc',
      ended: '#4b5a6a',
      error: '#ff5c5c',
      approval: '#b98cff',
    },
    source: {
      dsh: '#5fd0ea',
      hermes: '#7df0c4',
      opencode: '#4d9bff',
      claude: '#9fe9ff',
      codex: '#7a8fa2',
      other: '#4b5a6a',
    },
    beam: {
      stream: '#2f9fbe',
      particle: '#bff4ff',
      connect: '#e8fcff',
      disconnect: '#185a70',
      tool: '#6ff0c8',
    },
  },
};

/** 默认主题 */
export const DEFAULT_THEME: ThemeId = 'xuanji';

/** v2.4 当前主题的 BeamPalette（applyTheme 原地改写；scene 每帧读字段，切主题即时生效） */
export const BEAM_TINT: BeamPalette = { ...THEMES[DEFAULT_THEME].beam };

export function isThemeId(v: unknown): v is ThemeId {
  return v === 'xuanji' || v === 'scifi';
}

/**
 * 应用主题（v2.3）：
 * - canvas 侧：原地改写 tokens.ts 的三个颜色对象（scene 每帧读字段，切换即时生效，无需重建）
 * - DOM 侧：`<html data-theme="...">`，design/themes.css 里覆盖 ink/gold/bone 等 CSS 变量
 */
export function applyTheme(theme: ThemeId): void {
  const p = THEMES[theme] ?? THEMES[DEFAULT_THEME];
  Object.assign(COLORS, p.colors);
  Object.assign(CATEGORY_COLOR, p.category);
  Object.assign(STATE_COLOR, p.state);
  // v2.4：来源识别色与工作光流/光束调色板一并主题化（scifi 下光束必须是冷色）
  Object.assign(SOURCE_TINT, p.source);
  Object.assign(BEAM_TINT, p.beam);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = p.id;
  }
}

const THEME_STORAGE_KEY = 'xuanji.theme.v1';

export function loadTheme(): ThemeId {
  if (typeof localStorage === 'undefined') return DEFAULT_THEME;
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveTheme(theme: ThemeId): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
}

/** 主题循环：璇玑 → 深空 → 璇玑 */
export function nextTheme(theme: ThemeId): ThemeId {
  return theme === 'xuanji' ? 'scifi' : 'xuanji';
}
