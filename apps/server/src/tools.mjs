// Tool name -> visual category mapping.
//
// This is the ONE place where tool names become the five beam layers the
// renderer draws (read / write / exec / net / agent). The mapping is part of
// the front-end contract (docs/DATA-CONTRACT.md) and must stay in sync with
// apps/web/src/state/types.ts.
//
// Rules:
//  1. exact match in TABLE wins;
//  2. exact match after lowercasing (Claude Code's Read/Glob/Bash/…);
//  3. `mcp__<server>__<tool>` is reduced to <tool> then re-resolved;
//  4. prefix rules (see PREFIX_RULES) apply;
//  5. keyword fallback (see KEYWORD_RULES) catches tool names from other agents;
//  6. anything else is `null` (kept on events as tool:null, not in toolCounts).

/** @typedef {'read'|'write'|'exec'|'net'|'agent'} ToolCategory */

/** The five beam layers, in canonical order. */
export const TOOL_CATEGORIES = /** @type {ToolCategory[]} */ (['read', 'write', 'exec', 'net', 'agent']);

/** @type {Record<string, ToolCategory>} */
export const TOOL_CATEGORY_TABLE = {
  // --- read / inspect ---
  read: 'read',
  glob: 'read',
  grep: 'read',
  ls: 'read',
  list: 'read',
  tree: 'read',
  read_image: 'read',
  read_mcp_resource: 'read',
  list_mcp_resources: 'read',
  list_mcp_resource_templates: 'read',
  analyze_project: 'read',
  analyze_image: 'read',
  query_map: 'read',
  query_database: 'read',
  get_project_context: 'read',
  acp_status: 'read',
  acp_cache: 'read',
  acp_read_original_image: 'read',
  search_context: 'read',
  decompress: 'read',
  team_task_list: 'read',
  team_task_get: 'read',
  list_agents: 'read',
  get_goal: 'read',
  job_list: 'read',
  job_output: 'read',
  list_skills: 'read',
  get_session_info: 'read',
  // Hermes reads
  read_file: 'read',
  search_files: 'read',
  skill_view: 'read',
  skills_list: 'read',
  vision_analyze: 'read',
  session_search: 'read',
  // opencode reads
  todoread: 'read',
  // Claude Code / Codex reads
  notebookread: 'read',
  lsp_diagnostics: 'read',

  // --- write / mutate ---
  write: 'write',
  edit: 'write',
  multi_edit: 'write',
  apply_patch: 'write',
  notebook_edit: 'write',
  todo_write: 'write',
  compress: 'write',
  create_database_entry: 'write',
  update_database_entry: 'write',
  delete_database_entry: 'write',
  manage_map_event: 'write',
  edit_map: 'write',
  generate_map: 'write',
  manage_system: 'write',
  present: 'write',
  // Hermes writes
  patch: 'write',
  write_file: 'write',
  memory: 'write',
  todo: 'write',
  image_generate: 'write',
  open_preview: 'write',
  text_to_speech: 'write',
  // opencode writes
  todowrite: 'write',
  multiedit: 'write',
  // Claude Code writes
  notebookedit: 'write',

  // --- exec / local process ---
  bash: 'exec',
  pwsh: 'exec',
  shell: 'exec',
  exec: 'exec',
  run: 'exec',
  command: 'exec',
  powershell: 'exec',
  job_kill: 'exec',
  // Hermes exec
  terminal: 'exec',
  execute_code: 'exec',
  process: 'exec',
  close_terminal: 'exec',

  // --- net / external ---
  web_search: 'net',
  web_fetch: 'net',
  fetch: 'net',
  curl: 'net',
  http: 'net',
  // Hermes net
  browser_navigate: 'net',
  browser_console: 'net',
  browser_vision: 'net',
  // opencode net
  webfetch: 'net',
  websearch: 'net',

  // --- agent orchestration ---
  subagent: 'agent',
  subagent_fork: 'agent',
  spawn_teammate: 'agent',
  send_message: 'agent',
  wait_agent: 'agent',
  interrupt_agent: 'agent',
  create_goal: 'agent',
  update_goal: 'agent',
  workflow: 'agent',
  magi_review: 'agent',
  ask_user_question: 'agent',
  team_task_create: 'agent',
  team_task_update: 'agent',
  team_task_reassign: 'agent',
  skill: 'agent',
  // Hermes agent
  skill_manage: 'agent',
  delegate_task: 'agent',
  clarify: 'agent',
  cronjob: 'agent',
  // opencode / Claude Code agent
  task: 'agent',
};

/** @type {Array<[RegExp, ToolCategory]>} */
const PREFIX_RULES = [
  [/^(subagent|agent)/, 'agent'],
  [/^team_/, 'agent'],
  [/^(send_message|wait_agent|spawn_teammate|interrupt_agent)/, 'agent'],
  [/^(web_|http_|net_|fetch|curl)/, 'net'],
  [/^(bash|pwsh|shell|exec|run_|command|powershell)/, 'exec'],
  [/^(write|edit|multi_edit|apply_patch|notebook_edit|create_|update_|delete_|manage_|generate_|fill_)/, 'write'],
  [/^(read|glob|grep|ls|list|query_|get_|analyze_|acp_|search_)/, 'read'],
];

/**
 * Last-resort keyword classifier for tool names we have never seen (new MCP
 * servers, new agent CLIs). Order matters: the first matching row wins.
 * @type {Array<[RegExp, ToolCategory]>}
 */
const KEYWORD_RULES = [
  [/(web|browser|fetch|http|url|curl|network)/, 'net'],
  [/(bash|shell|exec|command|terminal|process|spawn|run)/, 'exec'],
  [/(subagent|agent|team|delegate|teammate|skill|task)/, 'agent'],
  [/(write|edit|patch|apply|create|update|delete|save|generate|todo|memory|notebook)/, 'write'],
  [/(read|view|search|grep|glob|ls|list|find|query|get|inspect|show|status|diagnostic)/, 'read'],
];

/** @type {Map<string, ToolCategory|null>} */
const cache = new Map();

/**
 * Resolve the category of a raw tool name.
 * @param {string|null|undefined} rawName
 * @returns {ToolCategory|null}
 */
export function categorizeTool(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  if (cache.has(rawName)) return cache.get(rawName);
  const result = resolve(rawName);
  if (cache.size > 500) cache.clear();
  cache.set(rawName, result);
  return result;
}

function resolve(name) {
  const direct = TOOL_CATEGORY_TABLE[name];
  if (direct) return direct;
  // Claude Code style names: Read / Glob / Bash / WebFetch / TodoWrite …
  const lower = name.toLowerCase();
  if (lower !== name) {
    const byLower = TOOL_CATEGORY_TABLE[lower];
    if (byLower) return byLower;
  }
  // MCP tools are named `mcp__<server>__<tool>`; classify by the inner name.
  if (name.startsWith('mcp__')) {
    const inner = name.split('__').pop();
    if (inner && inner !== name) {
      const byInner = TOOL_CATEGORY_TABLE[inner] || TOOL_CATEGORY_TABLE[inner.toLowerCase()];
      if (byInner) return byInner;
      const byInnerPrefix = applyPrefix(inner);
      if (byInnerPrefix) return byInnerPrefix;
    }
  }
  const byPrefix = applyPrefix(name) ?? applyPrefix(lower);
  if (byPrefix) return byPrefix;
  return applyKeywords(lower);
}

function applyPrefix(name) {
  for (const [re, cat] of PREFIX_RULES) {
    if (re.test(name)) return cat;
  }
  return null;
}

function applyKeywords(name) {
  for (const [re, cat] of KEYWORD_RULES) {
    if (re.test(name)) return cat;
  }
  return null;
}

/** Empty per-category counter, used for AgentSession.toolCounts. */
export function emptyToolCounts() {
  return { read: 0, write: 0, exec: 0, net: 0, agent: 0 };
}
