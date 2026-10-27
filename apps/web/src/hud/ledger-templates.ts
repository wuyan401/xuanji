// XUANJI · 璇玑 — 《起居注》行文模板（史官落墨的唯一之处）
// 所有字段都来自真实 AstroEvent / 会话快照，不做任何完成/成功/失败的无来源判断。
// §17.3 档案行：单行、无竖线、无斑马纹、时间/数字列右对齐。
import type { AgentSession, AstroEvent, SourceKind, ToolCategory } from '../state/types';
import { formatDuration, formatShichen, formatShichenShort, shortenPath, truncate } from '../lib/format';

/** 十二次（分野）：与浑仪分野弧一一对应，由 Sector 顺序决定 */
export const SHIERCI = [
  '星纪',
  '玄枵',
  '诹訾',
  '降娄',
  '大梁',
  '实沈',
  '鹑首',
  '鹑火',
  '鹑尾',
  '寿星',
  '大火',
  '析木',
] as const;

/** 五行类别字标：览 / 书 / 作 / 讯 / 遣 */
export const TOOL_MARK: Record<ToolCategory, string> = {
  read: '览',
  write: '书',
  exec: '作',
  net: '讯',
  agent: '遣',
};

export const TOOL_CATEGORY_ORDER: ToolCategory[] = ['read', 'write', 'exec', 'net', 'agent'];

/** 每 30 分钟为一卷 */
export const DIVIDER_INTERVAL = 30 * 60 * 1000;
/** 已归档判定：ended 且静置超过 30 分钟 */
export const ARCHIVE_AFTER = 30 * 60 * 1000;

export interface LedgerContext {
  sessions: Map<string, AgentSession>;
  /** sessionId → 分野（十二次之一） */
  domains: Map<string, string>;
  source: SourceKind | null;
  now: number;
}

export interface LedgerRow {
  eventId: string;
  sessionId: string;
  at: number;
  kind: AstroEvent['kind'];
  /** 左侧时间列（时辰，如「申时三刻」，等宽右对齐） */
  time: string;
  /** aria / tooltip 用的紧凑时刻 HH:MM:SS */
  clock: string;
  /** 分野二字 */
  domain: string;
  /** 工作区（窄屏隐藏） */
  workspace: string;
  /** 会话标题（tooltip 用） */
  sessionTitle: string;
  /** 五行字标（非动作行为 null） */
  mark: string | null;
  cat: ToolCategory | null;
  /** 校验正文（器用名 + 参数摘要） */
  text: string;
  /** 右列：时长 / 轮次等数字 */
  meta: string;
  /** 朱批 / 钤印 */
  seal: 'zhu' | 'yin' | null;
  /** 错误行：3px 朱线 + 朱批 */
  isError: boolean;
  /** 轻行（还报、一步既毕）：视觉上退到背景，形成涟漪 */
  isRipple: boolean;
  /** 已归档：整块降饱和 */
  isArchived: boolean;
  /** 演练数据：行尾「演」字 */
  demo: boolean;
  /** aria-live 摘要的一句话 */
  summary: string;
  /** 完整细节（tooltip） */
  detail: string;
}

export function domainIndex(sessionId: string): number {
  let h = 0;
  for (let i = 0; i < sessionId.length; i += 1) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  return h % SHIERCI.length;
}

export function domainFor(sessionId: string, ctx: LedgerContext): string {
  const found = ctx.domains.get(sessionId);
  if (found) return found;
  return SHIERCI[domainIndex(sessionId)];
}

/** 参数摘要：路径缩略、命令截断、多行取首行 */
export function detailText(detail: string | null, max = 34): string {
  if (!detail) return '';
  const firstLine = detail.split(/\r?\n/)[0]?.trim() ?? '';
  if (!firstLine) return '';
  if (/[\\/]/.test(firstLine) || /\.[a-z0-9]{1,5}\b/i.test(firstLine)) {
    return shortenPath(firstLine, max);
  }
  return truncate(firstLine, max);
}

function workspaceOf(session: AgentSession | undefined, ev: AstroEvent): string {
  if (session) {
    if (session.workspace) return session.workspace;
    if (session.cwd) return shortenPath(session.cwd, 28);
  }
  return ev.sessionTitle || '';
}

/** 事件 → 史官的一笔。返回 null 表示这一类事件不落墨。 */
export function buildRow(ev: AstroEvent, ctx: LedgerContext): LedgerRow | null {
  const session = ctx.sessions.get(ev.sessionId);
  const domain = domainFor(ev.sessionId, ctx);
  const time = formatShichen(new Date(ev.at));
  const clock = new Date(ev.at).toTimeString().slice(0, 8);
  const demo = ctx.source === 'demo';
  const isArchived =
    session != null && session.state === 'ended' && ctx.now - session.lastActivityAt > ARCHIVE_AFTER;

  const base: Omit<LedgerRow, 'kind' | 'mark' | 'cat' | 'text' | 'meta' | 'seal' | 'isError' | 'isRipple' | 'summary'> = {
    eventId: ev.id,
    sessionId: ev.sessionId,
    at: ev.at,
    time,
    clock,
    domain,
    workspace: workspaceOf(session, ev),
    sessionTitle: ev.sessionTitle || session?.title || '',
    isArchived,
    demo,
    detail: ev.detail ?? '',
  };

  const marked = (cat: ToolCategory): string => TOOL_MARK[cat];
  const dur = ev.durationMs != null && ev.durationMs > 0 ? formatDuration(ev.durationMs) : '';

  switch (ev.kind) {
    case 'session/live': {
      const ws = workspaceOf(session, ev);
      return {
        ...base,
        kind: ev.kind,
        mark: null,
        cat: null,
        text: ws ? `入案 · ${truncate(ws, 22)}` : '入案',
        meta: '',
        seal: null,
        isError: false,
        isRipple: false,
        summary: `${domain} 入案`,
      };
    }
    case 'session/ended':
      return {
        ...base,
        kind: ev.kind,
        mark: null,
        cat: null,
        text: '入档',
        meta: '',
        seal: null,
        isError: false,
        isRipple: false,
        summary: `${domain} 入档`,
      };
    case 'turn/start':
      return {
        ...base,
        kind: ev.kind,
        mark: null,
        cat: null,
        text: ev.turn != null ? `受命 · 第 ${ev.turn} 轮启` : '受命 · 轮启',
        meta: '',
        seal: null,
        isError: false,
        isRipple: false,
        summary: `${domain} 受命`,
      };
    case 'turn/end':
      return {
        ...base,
        kind: ev.kind,
        mark: null,
        cat: null,
        text: '本轮告成',
        meta: ev.turn != null ? `第 ${ev.turn} 轮` : '',
        seal: 'yin',
        isError: false,
        isRipple: false,
        summary: `${domain} 本轮告成`,
      };
    case 'step/start':
      return {
        ...base,
        kind: ev.kind,
        mark: null,
        cat: null,
        text: ev.step != null ? `第 ${ev.step} 步 · 推演中` : '推演中',
        meta: '',
        seal: null,
        isError: false,
        isRipple: true,
        summary: `${domain} 第 ${ev.step ?? '—'} 步推演`,
      };
    case 'step/end':
      return {
        ...base,
        kind: ev.kind,
        mark: null,
        cat: null,
        text: ev.step != null ? `第 ${ev.step} 步毕` : '一步既毕',
        meta: dur,
        seal: null,
        isError: false,
        isRipple: true,
        summary: `${domain} 第 ${ev.step ?? '—'} 步毕`,
      };
    case 'tool/call': {
      const cat = ev.toolCategory ?? 'exec';
      const d = detailText(ev.detail, 38);
      return {
        ...base,
        kind: ev.kind,
        mark: marked(cat),
        cat,
        text: d ? `${ev.tool ?? '器用'} · ${d}` : (ev.tool ?? '器用'),
        meta: '',
        seal: null,
        isError: false,
        isRipple: false,
        summary: `${domain} 器用 ${TOOL_MARK[cat]} ${ev.tool ?? ''}`.trim(),
      };
    }
    case 'tool/result': {
      const cat = ev.toolCategory ?? 'exec';
      if (ev.isError) {
        const d = detailText(ev.detail, 30);
        return {
          ...base,
          kind: ev.kind,
          mark: marked(cat),
          cat,
          text: d ? `器用受阻 · ${d}` : '器用受阻',
          meta: '',
          seal: 'zhu',
          isError: true,
          isRipple: false,
          summary: `${domain} 器用受阻`,
        };
      }
      return {
        ...base,
        kind: ev.kind,
        mark: marked(cat),
        cat,
        text: `${ev.tool ?? '器用'} 还报`,
        meta: dur,
        seal: null,
        isError: false,
        isRipple: true,
        summary: `${domain} ${ev.tool ?? '器用'} 还报`,
      };
    }
    case 'error': {
      const d = detailText(ev.detail, 30);
      return {
        ...base,
        kind: ev.kind,
        mark: null,
        cat: null,
        text: d ? `有误 · ${d}` : '有误',
        meta: '',
        seal: 'zhu',
        isError: true,
        isRipple: false,
        summary: `${domain} 有误`,
      };
    }
    case 'approval': {
      const d = detailText(ev.detail, 28);
      const tool = ev.tool ?? '';
      return {
        ...base,
        kind: ev.kind,
        mark: null,
        cat: null,
        text: tool ? `候旨 · ${tool} 待办` : d ? `候旨 · ${d}` : '候旨',
        meta: '',
        seal: 'yin',
        isError: false,
        isRipple: false,
        summary: `${domain} 候旨`,
      };
    }
    default:
      return null;
  }
}

/** 卷序号：壹…玖、〇一…壹贰（与卷〇七 同体的两位写法） */
export function volumeLabel(n: number): string {
  const digits = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n <= 0) return '〇一';
  if (n < 10) return `〇${digits[n]}`;
  if (n < 20) return `一${digits[n - 10]}`;
  return String(n);
}

/** 卷分隔上的时辰（只到时辰，不含刻） */
export function dividerTime(at: number): string {
  return formatShichenShort(new Date(at));
}
