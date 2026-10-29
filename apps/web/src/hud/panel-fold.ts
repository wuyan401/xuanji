// XUANJI · 璇玑 — 面板收放状态（BIBLE §28.2）
// 只做「桌面端四块常驻面板」的本地记忆；移动端沿用既有抽屉/sheet 逻辑，不读不写。
// key: xuanji.panels.v1 = { ledger, system, worklist, procdetail }：'open' | 'closed'
const STORAGE_KEY = 'xuanji.panels.v1';

export type FoldPanelKey = 'ledger' | 'system' | 'worklist' | 'procdetail';
export type FoldValue = 'open' | 'closed';
export type PanelFoldState = Record<FoldPanelKey, FoldValue>;

interface FoldOptions {
  /** 面板收放动画时长（ms）；data-reduced 时由 CSS 压到 100ms */
  duration: number;
}

export const FOLD_DURATION = 220;

export function isDesktopViewport(): boolean {
  return window.matchMedia('(min-width: 721px)').matches;
}

/** ?reset=1 —— 与视野记忆同一个重置开关；忽略已存档的收放状态 */
export function foldResetRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('reset') === '1';
  } catch {
    return false;
  }
}

function defaults(): PanelFoldState {
  return { ledger: 'open', system: 'open', worklist: 'open', procdetail: 'open' };
}

function isFoldValue(value: unknown): value is FoldValue {
  return value === 'open' || value === 'closed';
}

/** 读桌面端收放记忆：移动端 / 重置参数 / 读写失败 → 默认全展开 */
export function loadFold(): PanelFoldState {
  const state = defaults();
  if (!isDesktopViewport() || foldResetRequested()) return state;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return state;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return state;
    const record = parsed as Record<string, unknown>;
    for (const key of Object.keys(state) as FoldPanelKey[]) {
      const value = record[key];
      if (isFoldValue(value)) state[key] = value;
    }
  } catch {
    /* 存档损坏 / 隐私模式 → 用默认值，不抛错 */
  }
  return state;
}

/** 写桌面端收放记忆：移动端 / 重置参数不写 */
export function saveFold(state: PanelFoldState): void {
  if (!isDesktopViewport() || foldResetRequested()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* 配额/隐私模式：静默失败，收放本身仍然生效 */
  }
}

/** 收起 / 展开时长：数据减少动效时压缩到 100ms（BIBLE §28.1） */
export function foldDuration(reduced: boolean, opts: FoldOptions = { duration: FOLD_DURATION }): number {
  return reduced ? 100 : opts.duration;
}

void foldDuration;
