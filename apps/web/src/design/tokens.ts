// 与 tokens.css 同步的 TS 侧 token：canvas 无法读 CSS 变量，颜色/动效常量在此。
// 权威来源：docs/DESIGN-BIBLE.md §3 色彩系统 / §4 字体 / §11 动效 / §22.6 双主题。改色两处一起改。
// 注意：COLORS / CATEGORY_COLOR / STATE_COLOR 是「可变」对象——v2.3 主题切换由 design/themes.ts
// 的 applyTheme() 直接 Object.assign 改写（画布侧每帧读取这些字段，因此切换即时生效）。

export type ColorToken =
  | 'inkVoid' | 'inkDeep' | 'inkRaise' | 'inkVeil' | 'inkPanel' | 'inkLine' | 'inkLineStrong'
  | 'gold100' | 'gold200' | 'gold300' | 'gold400' | 'gold500'
  | 'patina300' | 'patina500'
  | 'bone100' | 'bone200' | 'bone300' | 'bone400' | 'bone500'
  | 'cold300' | 'indigo400';

export const COLORS: Record<ColorToken, string> = {
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
};

/** 五行器用色（canvas 光束 / DOM 小字共用；面积占比须 <8%） */
export const CATEGORY_COLOR: Record<'read' | 'write' | 'exec' | 'net' | 'agent', string> = {
  read: '#5e9c7e', // 木
  write: '#c0532f', // 火
  exec: '#b98a4e', // 土
  net: '#4e6e8e', // 水
  agent: '#c9bfa6', // 金
};

/** 五行名（用于 tooltip / 账本） */
export const CATEGORY_ELEMENT: Record<'read' | 'write' | 'exec' | 'net' | 'agent', string> = {
  read: '木',
  write: '火',
  exec: '土',
  net: '水',
  agent: '金',
};

/** agent 状态色（另配形状编码：live 实心+环 / idle 实心 / ended 空心 / error 三角 / approval 双环） */
export const STATE_COLOR: Record<'live' | 'idle' | 'ended' | 'error' | 'approval', string> = {
  live: '#e8c878',
  idle: '#b3ab98',
  ended: '#5f5a4f',
  error: '#c4553d',
  approval: '#7fbf9e',
};

/** 字体族（canvas 的 ctx.font 需要完整字符串） */
export const FONTS = {
  display: "'Xuanji Display', 'LXGW WenKai', 'Noto Serif SC', serif",
  body: "'Noto Serif SC', 'Songti SC', 'SimSun', serif",
  mono: "'JetBrains Mono', 'Cascadia Mono', 'Consolas', monospace",
} as const;

export const MOTION = {
  instant: 90,
  fast: 180,
  mid: 320,
  slow: 620,
  cinematic: 1100,
} as const;

/** CSS cubic-bezier 对应的 JS 缓动（scene 用；DOM 用 CSS 的 --ease-*） */
export const EASE = {
  /** ≈ cubic-bezier(.16,1,.3,1) */
  out: (t: number): number => 1 - Math.pow(1 - t, 5),
  /** ≈ cubic-bezier(.22,.9,.24,1) 落墨/錾刻 */
  engrave: (t: number): number => 1 - Math.pow(1 - t, 3),
  /** ≈ cubic-bezier(.65,0,.35,1) 运镜 */
  inOut: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  /** 带 8% 过冲的擒纵回弹 */
  overshoot: (t: number): number => {
    const s = 1.08;
    const u = t - 1;
    return 1 + (s + 1) * u * u * u + s * u * u;
  },
} as const;

/** 从 #rrggbb + alpha 生成 rgba() */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h,
    16,
  );
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}
