// XUANJI · 璇玑 — 中文格式化（时辰/刻/文数/卷帙/时长）。Lead 维护，scene 与 hud 共用。
// 纪律：账本与面板只展示真实字段，不编造；单位与用词见 DESIGN-BIBLE §14。

const CN_DIGIT = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

const SHICHEN = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const KE_LABEL = ['初', '一', '二', '三', '四', '五', '六', '七'];

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** 单字汉字数字（0–9） */
export function cnDigit(n: number): string {
  return CN_DIGIT[Math.abs(Math.trunc(n)) % 10] ?? '〇';
}

/** 整数 → 汉字数字（支持到万位，够用即可） */
export function cnNumber(n: number): string {
  const v = Math.trunc(n);
  if (v === 0) return '〇';
  if (v < 0) return '负' + cnNumber(-v);
  if (v >= 10000) {
    const w = Math.floor(v / 10000);
    const r = v % 10000;
    return `${cnNumber(w)}万${r ? cnNumber(r) : ''}`;
  }
  const units = ['', '十', '百', '千'];
  let out = '';
  let started = false;
  for (let i = 3; i >= 0; i--) {
    const d = Math.floor(v / Math.pow(10, i)) % 10;
    if (d === 0) {
      if (started && out) out += '〇';
      continue;
    }
    // 一十X → 十X
    if (!(d === 1 && i === 1 && !started)) out += CN_DIGIT[d];
    out += units[i];
    started = true;
  }
  return out.replace(/〇+$/, '');
}

/** 一位小数的汉字写法：4.2 → 四·二（账本时长用） */
export function cnDecimal(v: number, unit: string): string {
  const whole = Math.trunc(v);
  const frac = Math.round((v - whole) * 10);
  const wholeStr = whole === 0 ? '' : cnNumber(whole);
  if (frac === 0) return `${wholeStr || '〇'}${unit}`;
  return `${wholeStr}·${CN_DIGIT[frac]}${unit}`;
}

export interface ShichenInfo {
  index: number;
  name: string;
  /** 刻 0–7 */
  ke: number;
  keName: string;
}

/** 根据真实时间求时辰与刻（子时 23:00–01:00，每时辰 8 刻，每刻 15 分钟） */
export function getShichen(date: Date = new Date()): ShichenInfo {
  const h = date.getHours();
  const m = date.getMinutes();
  const index = Math.floor(((h + 1) % 24) / 2) % 12;
  const ke = Math.min(7, Math.floor(m / 15));
  return { index, name: SHICHEN[index], ke, keName: KE_LABEL[ke] };
}

/** 申时三刻 / 子时初刻 */
export function formatShichen(date: Date = new Date()): string {
  const s = getShichen(date);
  return s.ke === 0 ? `${s.name}时初刻` : `${s.name}时${s.keName}刻`;
}

/** 只取时辰（顶栏用）：申时 */
export function formatShichenShort(date: Date = new Date()): string {
  return `${getShichen(date).name}时`;
}

/** HH:MM:SS（mono 小字） */
export function formatClock(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** 二〇二六年十月廿七 · 星期二 */
export function formatDateCN(date: Date = new Date()): string {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${date.getFullYear()}年${cnNumber(m)}月${cnNumber(d)}日 星期${WEEKDAY[date.getDay()]}`;
}

/** 时长（ms）→ 四·二秒 / 一·二分 / 四十六秒 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `〇·${CN_DIGIT[Math.max(1, Math.round(ms / 100))]}秒`;
  const sec = ms / 1000;
  if (sec < 10) return cnDecimal(sec, '秒');
  if (sec < 60) return `${cnNumber(Math.round(sec))}秒`;
  const min = sec / 60;
  if (min < 60) return `${cnNumber(Math.floor(min))}分${cnNumber(Math.round(sec % 60))}秒`;
  return `${cnNumber(Math.floor(min / 60))}时${cnNumber(Math.round(min % 60))}分`;
}

/** 上下文压力 0..1 → 九·二成（成=10%） */
export function formatCheng(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '——';
  const v = Math.max(0, Math.min(1, ratio)) * 10;
  return cnDecimal(v, '成');
}

/** 千分位整数 */
export function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/** 紧凑数字：1234 → 1.2k；123456 → 12.3万 */
export function formatCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Math.round(n);
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

/** 文件路径缩略：保留尾部 2 段，过长加省略 */
export function shortenPath(path: string | null | undefined, max = 34): string {
  if (!path) return '';
  const norm = path.replace(/\\/g, '/');
  if (norm.length <= max) return norm;
  const parts = norm.split('/');
  const tail = parts.slice(-2).join('/');
  return tail.length <= max ? `…/${tail}` : `…/${tail.slice(-(max - 2))}`;
}

/** 纯文本截断（按字符数，中文安全） */
export function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + '…';
}
