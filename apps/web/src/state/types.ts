// XUANJI · 璇玑 — 前端数据契约（与 docs/DATA-CONTRACT.md 保持一致）
// 所有可视化只允许依赖这里定义的字段；如需新字段，先改后端契约再改这里。

export type AgentState = 'live' | 'idle' | 'ended';
export type ToolCategory = 'read' | 'write' | 'exec' | 'net' | 'agent';
export type ViewMode = 'survey' | 'track' | 'dossier' | 'ledger' | 'orrery' | 'scan' | 'vigil';
/** 顶层视图：智能体观测 / 整机仪象 / 百工器群（全进程） */
export type ViewKind = 'agents' | 'system' | 'processes';
export type SourceKind = 'live' | 'demo' | 'replay';
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** agent 数据来源 id（可扩展；未知来源回退 'other'） */
export type SourceId = string;

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface OpenStep {
  turn: number;
  step: number;
  /** epoch ms */
  startedAt: number;
  /** epoch ms；模型已吐首 token 时的时间 */
  firstTokenAt: number | null;
}

export interface TodoItem {
  text: string;
  done: boolean;
}

export interface AgentTeamInfo {
  memberIds: string[];
  tasks: number;
}

/** 一个本机 agent 来源（DSH / Hermes / opencode / Claude Code / Codex / …） */
export interface AgentSourceInfo {
  id: SourceId;
  label: string;
  /** detected = 本机找到数据；absent = 未安装/无记录（仍列出，便于用户知道看过） */
  state: 'detected' | 'absent';
  sessions: number;
  live: number;
  /** epoch ms；无记录为 null */
  lastActivityAt: number | null;
  /** 数据位置或版本说明 */
  detail: string;
}

export interface AgentSession {
  id: string;
  /** 来源 id：'dsh' | 'hermes' | 'opencode' | 'claude' | 'codex' … */
  source: SourceId;
  /** 来源显示名：'DSH' | 'Hermes' | 'opencode' | 'Claude Code' | 'Codex' … */
  sourceLabel: string;
  title: string;
  workspace: string;
  cwd: string;
  state: AgentState;
  parentId: string | null;
  depth: number;
  model: string | null;
  reasoningEffort: string | null;
  preset: string | null;
  /** epoch ms */
  createdAt: number;
  /** epoch ms */
  lastActivityAt: number;
  turns: number;
  steps: number;
  tokens: Tokens;
  /** tokens/s，后端平滑后的近期输出速率 */
  recentTokenRate: number;
  /** 0..1 */
  contextPressure: number;
  contextWindow: number;
  openStep: OpenStep | null;
  pendingCalls: string[];
  toolCounts: Record<ToolCategory, number>;
  todos: TodoItem[] | null;
  planActive: boolean;
  team: AgentTeamInfo;
  lastPrompt: string | null;
  lastResponse: string | null;
}

export interface Sector {
  id: string;
  /** 工作区显示名 */
  name: string;
  /** 工作区路径 */
  path: string;
  /** 来源 id */
  source: SourceId;
  sessionIds: string[];
  liveCount: number;
}

export interface Aggregates {
  liveCount: number;
  idleCount: number;
  endedCount: number;
  /** tokens/s */
  tokenRate: number;
  /** tool calls/s */
  toolRate: number;
  errorCount: number;
  /** 0..1 */
  maxContextPressure: number;
  /** epoch ms */
  stamp: number;
}

export type EventKind =
  | 'turn/start'
  | 'turn/end'
  | 'step/start'
  | 'step/end'
  | 'tool/call'
  | 'tool/result'
  | 'approval'
  | 'error'
  | 'session/live'
  | 'session/ended';

export interface AstroEvent {
  id: string;
  /** epoch ms */
  at: number;
  kind: EventKind;
  /** 来源 id */
  source: SourceId;
  sessionId: string;
  sessionTitle: string;
  tool: string | null;
  toolCategory: ToolCategory | null;
  /** ≤120 字摘要 */
  detail: string | null;
  isError: boolean | null;
  turn: number | null;
  step: number | null;
  durationMs: number | null;
}

export interface FleetSnapshot {
  generatedAt: number;
  source: SourceKind;
  sessions: AgentSession[];
  sectors: Sector[];
  sources: AgentSourceInfo[];
  aggregates: Aggregates;
  events: AstroEvent[];
}

/** 客户端在快照上附加的连接态（服务端不下发） */
export interface ClientFleetSnapshot extends FleetSnapshot {
  connection: ConnectionState;
  receivedAt: number;
}

export interface FleetTickFrame {
  type: 'tick';
  at: number;
  events: AstroEvent[];
  sessions?: AgentSession[];
  aggregates?: Aggregates;
  sources?: AgentSourceInfo[];
}

export interface FleetFrame extends FleetSnapshot {
  type: 'fleet';
}

/* ------------------------------ 整机仪象 ------------------------------ */

export interface CpuInfo {
  /** 0..1 */
  usage: number;
  perCore: number[];
}

export interface MemInfo {
  /** 0..1 */
  usedPct: number;
  usedBytes: number;
  totalBytes: number;
}

export interface DiskInfo {
  name: string;
  totalBytes: number;
  freeBytes: number;
  /** 0..1 */
  usedPct: number;
}

export interface NetInfo {
  rxBps: number;
  txBps: number;
  totalRxBytes: number;
  totalTxBytes: number;
}

export interface ProcInfo {
  pid: number;
  name: string;
  /** 0..100（相对单核） */
  cpuPct: number;
  memBytes: number;
  /** 线程数（可选；Windows 采样器提供，历史样本可能缺失） */
  threads?: number;
}

export interface BatteryInfo {
  /** 0..100 */
  percent: number;
  charging: boolean;
}

export interface SystemSnapshot {
  /** epoch ms */
  at: number;
  available: boolean;
  cpu: CpuInfo;
  mem: MemInfo;
  disks: DiskInfo[];
  net: NetInfo;
  procs: ProcInfo[];
  uptimeSec: number;
  battery: BatteryInfo | null;
}

export interface SystemFrame extends SystemSnapshot {
  type: 'system';
  /** true 表示这是历史回填（客户端拉 /api/system/history） */
  history?: boolean;
}

export type SseFrame = FleetFrame | FleetTickFrame | SystemFrame;

export const EMPTY_AGGREGATES: Aggregates = {
  liveCount: 0,
  idleCount: 0,
  endedCount: 0,
  tokenRate: 0,
  toolRate: 0,
  errorCount: 0,
  maxContextPressure: 0,
  stamp: 0,
};

export const EMPTY_SYSTEM: SystemSnapshot = {
  at: 0,
  available: false,
  cpu: { usage: 0, perCore: [] },
  mem: { usedPct: 0, usedBytes: 0, totalBytes: 0 },
  disks: [],
  net: { rxBps: 0, txBps: 0, totalRxBytes: 0, totalTxBytes: 0 },
  procs: [],
  uptimeSec: 0,
  battery: null,
};

export const EMPTY_SNAPSHOT: ClientFleetSnapshot = {
  generatedAt: 0,
  source: 'live',
  sessions: [],
  sectors: [],
  sources: [],
  aggregates: EMPTY_AGGREGATES,
  events: [],
  connection: 'connecting',
  receivedAt: 0,
};

export const TOOL_CATEGORY_LABEL: Record<ToolCategory, string> = {
  read: '读取',
  write: '书写',
  exec: '执行',
  net: '通问',
  agent: '遣使',
};

export const VIEW_MODE_LABEL: Record<ViewMode, string> = {
  survey: '云图',
  track: '逐星',
  dossier: '勘验',
  ledger: '起居注',
  orrery: '浑仪',
  scan: '拂扫',
  vigil: '守夜',
};

export const VIEW_MODE_ORDER: ViewMode[] = [
  'survey',
  'track',
  'dossier',
  'ledger',
  'orrery',
  'scan',
  'vigil',
];

export const VIEW_KIND_LABEL: Record<ViewKind, string> = {
  agents: '智能体',
  system: '整机',
  processes: '百工',
};

/** 视图轮换顺序（0 键 / 顶栏铭牌） */
export const VIEW_KIND_ORDER: readonly ViewKind[] = ['agents', 'system', 'processes'];

/** 来源短名（分野标签、星环、图例用） */
export const SOURCE_SHORT: Record<SourceId, string> = {
  dsh: 'DSH',
  hermes: 'Hermes',
  opencode: 'opencode',
  claude: 'Claude',
  codex: 'Codex',
  other: '其它',
};

/** 来源色（低饱和，只作 1px 识别环与图例，不参与五行面积预算） */
export const SOURCE_TINT: Record<SourceId, string> = {
  dsh: '#d8b26a',
  hermes: '#7fae98',
  opencode: '#4e6e8e',
  claude: '#b98a4e',
  codex: '#8b8474',
  other: '#6f6a5e',
};

export function sourceShort(id: SourceId): string {
  return SOURCE_SHORT[id] ?? id.toUpperCase();
}

export function sourceTint(id: SourceId): string {
  return SOURCE_TINT[id] ?? SOURCE_TINT.other;
}
