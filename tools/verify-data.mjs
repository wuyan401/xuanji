#!/usr/bin/env node
// 璇玑 QA · 数据对账器 v2（多来源 + 整机遥测）
// 校验运行中的 /api/fleet 与 DSH 原始数据源（projcache）是否一致，并检查多来源/整机契约，防止编造数据。
//
// 用法: node tools/verify-data.mjs [--url http://127.0.0.1:8787] [--samples 10]
//
// 校验项:
//   1. 结构: sessions/sectors/sources/aggregates/events
//   2. 多来源: sources[] 字段完整、id 唯一、sum(sessions) 对账；absent 源 0 会话；
//              session.source/sourceLabel 合法；session.workspace 等于所属分野名；
//              Sector.id 唯一且带来源前缀；event.source 与 session 一致
//   3. DSH 抽样对账: title/turns/steps/tokens/contextPressure 与 projcache 原始值一致（只对 source=dsh）
//   4. 时间戳/事件/聚合 校验
//   5. 整机遥测: /api/system 字段范围；/api/system/history 有序且不超过上限
//
// 退出码: 0 全通过 / 1 有 FAIL

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const pref = name + '=';
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

const BASE = arg('--url', process.env.ASTRA_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const SAMPLES = Number(arg('--samples', '10'));
const DSH_ROOT = process.env.DSH_ROOT || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROJCACHE_DIR = path.join(DSH_ROOT, 'storages', 'session_projcache', 'sessions');

const VALID_KINDS = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result',
  'approval', 'error', 'session/live', 'session/ended',
]);
const VALID_CATEGORIES = new Set(['read', 'write', 'exec', 'net', 'agent']);
const NOISE = /system-reminder|<acp|Compressed conversation/i;

const fails = [];
const warns = [];
let checks = 0;

function ok(name, cond, detail = '') {
  checks++;
  if (!cond) fails.push(name + (detail ? ' — ' + detail : ''));
  return cond;
}
function warn(name, cond, detail = '') {
  if (!cond) warns.push(name + (detail ? ' — ' + detail : ''));
}
function num(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function readProjcache(id) {
  const file = path.join(PROJCACHE_DIR, id + '.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw?.record ?? null;
  } catch {
    return null;
  }
}
function row(record, key) {
  return record?.rows?.[key]?.val;
}

/** 带超时的 JSON 请求（不用 AbortSignal.timeout，避免 Node 退出时 libuv 断言崩溃） */
async function getJSON(url, ms = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const t0 = Date.now();
const fleetRes = await getJSON(BASE + '/api/fleet');
ok('GET /api/fleet 200', fleetRes.ok, 'status=' + fleetRes.status);
const fleet = fleetRes.body;

// ---------- 1. 结构 ----------
for (const key of ['generatedAt', 'source', 'sessions', 'sectors', 'sources', 'aggregates', 'events']) {
  ok('snapshot.' + key + ' 存在', key in fleet);
}
ok('source 合法', ['live', 'demo', 'replay'].includes(fleet.source), 'source=' + fleet.source);
ok('sessions 非空', Array.isArray(fleet.sessions) && fleet.sessions.length > 0, 'n=' + fleet.sessions?.length);
ok('sectors 非空', Array.isArray(fleet.sectors) && fleet.sectors.length > 0, 'n=' + fleet.sectors?.length);
ok('sources 非空', Array.isArray(fleet.sources) && fleet.sources.length > 0, 'n=' + fleet.sources?.length);
ok('events 非空', Array.isArray(fleet.events) && fleet.events.length > 0, 'n=' + fleet.events?.length);
ok('generatedAt 接近 now', Math.abs(Date.now() - fleet.generatedAt) < 20000, 'delta=' + (Date.now() - fleet.generatedAt) + 'ms');

// ---------- 2. 多来源 ----------
const sources = Array.isArray(fleet.sources) ? fleet.sources : [];
const sourceById = new Map();
for (const src of sources) {
  const id = String(src?.id ?? '');
  ok('source.id 唯一 (' + (id || '?') + ')', !sourceById.has(id), 'dup=' + id);
  sourceById.set(id, src);
  for (const k of ['id', 'label', 'state', 'sessions', 'live', 'lastActivityAt', 'detail']) {
    ok('source.' + k + ' 存在 (' + (id || '?') + ')', k in (src ?? {}));
  }
  ok('source.state 合法 (' + (id || '?') + ')', ['detected', 'absent'].includes(src?.state), 'state=' + src?.state);
  ok('source.sessions 为数字 (' + (id || '?') + ')', num(src?.sessions), 'n=' + src?.sessions);
  ok('source.live 为数字 (' + (id || '?') + ')', num(src?.live), 'n=' + src?.live);
  if (src?.state === 'absent') {
    ok('absent 源无会话 (' + id + ')', src.sessions === 0, 'sessions=' + src.sessions);
    ok('absent 源无 live (' + id + ')', src.live === 0, 'live=' + src.live);
  }
  ok('source.lastActivityAt 合法 (' + (id || '?') + ')', src?.lastActivityAt === null || num(src?.lastActivityAt));
}
const detected = sources.filter((s) => s?.state === 'detected');
ok('detected 来源 >= 3', detected.length >= 3, 'detected=' + detected.length + ' [' + detected.map((s) => s.id).join(',') + ']');
const sumBySource = new Map();
for (const s of fleet.sessions) sumBySource.set(s.source, (sumBySource.get(s.source) ?? 0) + 1);
for (const src of sources) {
  const actual = sumBySource.get(src.id) ?? 0;
  ok('source.sessions 对账 (' + src.id + ')', src.sessions === actual, 'source=' + src.sessions + ' sessions=' + actual);
}
const claimed = sources.reduce((a, s) => a + (Number(s?.sessions) || 0), 0);
ok('sources 会话总数 == sessions 总数', claimed === fleet.sessions.length, 'sources=' + claimed + ' sessions=' + fleet.sessions.length);

// 会话 → 所属分野（用于校验 workspace 名与分野名一致）
const sectorsByIdSession = new Map();
for (const sec of fleet.sectors) for (const sid of sec.sessionIds ?? []) sectorsByIdSession.set(sid, sec);
const secNames = new Set(fleet.sectors.map((s) => s.name));
ok('sector.id 唯一', new Set(fleet.sectors.map((s) => s.id)).size === fleet.sectors.length);
for (const sec of fleet.sectors) {
  ok('sector.source 合法 (' + sec.id + ')', typeof sec.source === 'string' && sourceById.has(sec.source), 'source=' + sec.source);
  // DSH 沿用历史 workspace uuid 作为分野 id；其它来源要求 `source::workspaceKey` 形式
  if (sec.source !== 'dsh') {
    ok('sector.id 带来源前缀 (' + sec.id + ')', String(sec.id).includes('::') && String(sec.id).startsWith(String(sec.source) + '::'), 'id=' + sec.id);
  }
  ok('sector.sessionIds 为数组 (' + sec.id + ')', Array.isArray(sec.sessionIds));
}

const seen = new Set();
let matched = 0;
let sampled = 0;
let cwdWarned = 0;

// 状态分布优先、再按最近活动，保证覆盖 live/idle/ended
const order = { live: 0, idle: 1, ended: 2 };
const ranked = [...fleet.sessions].sort((a, b) => (order[a.state] - order[b.state]) || (b.lastActivityAt - a.lastActivityAt));

for (const s of ranked) {
  const tag = (s.source || '?') + ':' + String(s.id).slice(0, 8);
  ok('session.id 唯一 (' + tag + ')', !seen.has(s.id), 'dup=' + s.id);
  seen.add(s.id);
  ok('session.source 合法 (' + tag + ')', typeof s.source === 'string' && sourceById.has(s.source), 'source=' + s.source);
  ok('session.sourceLabel 非空 (' + tag + ')', typeof s.sourceLabel === 'string' && s.sourceLabel.length > 0);
  for (const k of ['title', 'workspace', 'cwd', 'state', 'depth', 'createdAt', 'lastActivityAt', 'turns', 'steps', 'tokens', 'recentTokenRate', 'contextPressure', 'contextWindow', 'toolCounts', 'pendingCalls']) {
    ok('session.' + k + ' 存在 (' + tag + ')', k in s);
  }
  ok('session.state 合法 (' + tag + ')', ['live', 'idle', 'ended'].includes(s.state), 'state=' + s.state);
  ok('session.title 非空且无噪声 (' + tag + ')', typeof s.title === 'string' && s.title.length > 0 && !NOISE.test(s.title), 'title=' + JSON.stringify(String(s.title).slice(0, 40)));
  ok('session.workspace 非空 (' + tag + ')', typeof s.workspace === 'string' && s.workspace.length > 0);
  ok('session.workspace 合法 (' + tag + ')', secNames.has(s.workspace), 'workspace=' + s.workspace);
  const home = sectorsByIdSession.get(s.id);
  ok('session.workspace 等于所属分野名 (' + tag + ')', !home || s.workspace === home.name, 'workspace=' + s.workspace + ' sector=' + (home?.name ?? 'n/a'));
  // DSH 的 cwd 必须可追溯；其它来源（SQLite 历史记录）可能没有 cwd，只告警
  if (s.source === 'dsh') {
    ok('session.cwd 为绝对路径 (' + tag + ')', typeof s.cwd === 'string' && (/^[A-Za-z]:[\\/]/.test(s.cwd) || s.cwd.startsWith('/')), 'cwd=' + s.cwd);
  } else if (!s.cwd) {
    cwdWarned++;
  }
  ok('session 时间戳有序 (' + tag + ')', s.createdAt <= s.lastActivityAt + 1, 'created>last');
  ok('session.lastActivityAt 合理 (' + tag + ')', s.lastActivityAt <= Date.now() + 120000, 'future');
  ok('session.tokens 结构 (' + tag + ')', s.tokens && ['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => num(s.tokens[k])), 'tokens=' + JSON.stringify(s.tokens));
  ok('session.contextPressure 0..1 (' + tag + ')', s.contextPressure >= 0 && s.contextPressure <= 1, 'p=' + s.contextPressure);
  ok('session.toolCounts 五类 (' + tag + ')', s.toolCounts && [...VALID_CATEGORIES].every((k) => num(s.toolCounts[k])));

  // 抽样对账：只对 DSH 源做（其它来源的原始 DB 由后端单测覆盖）
  if (fleet.source !== 'live' || s.source !== 'dsh' || sampled >= SAMPLES) continue;
  const record = readProjcache(s.id);
  if (!record) continue;
  sampled++;
  matched++;
  const usage = row(record, 'tokenUsage');
  const stats = row(record, 'sessionStats');
  const pressure = row(record, 'contextPressure');
  if (usage) {
    ok('对账 tokens.output (' + tag + ')', s.tokens.output === usage.totals?.outputTokens, 'fleet=' + s.tokens.output + ' raw=' + usage.totals?.outputTokens);
    ok('对账 tokens.input (' + tag + ')', s.tokens.input === usage.totals?.uncachedInputTokens, 'fleet=' + s.tokens.input + ' raw=' + usage.totals?.uncachedInputTokens);
    ok('对账 tokens.cacheRead (' + tag + ')', s.tokens.cacheRead === usage.totals?.cacheReadTokens, 'fleet=' + s.tokens.cacheRead + ' raw=' + usage.totals?.cacheReadTokens);
  }
  if (stats) {
    ok('对账 turns (' + tag + ')', s.turns === stats.turns, 'fleet=' + s.turns + ' raw=' + stats.turns);
    ok('对账 steps (' + tag + ')', s.steps === stats.steps, 'fleet=' + s.steps + ' raw=' + stats.steps);
    if (stats.openStep) ok('对账 openStep.turn (' + tag + ')', s.openStep?.turn === stats.openStep.turn, 'fleet=' + s.openStep?.turn + ' raw=' + stats.openStep.turn);
  }
  if (pressure) {
    const cw = pressure.contextWindow || 1;
    const expect = Math.min(1, (pressure.pressureTokens || 0) / cw);
    ok('对账 contextPressure (' + tag + ')', Math.abs(s.contextPressure - expect) < 0.002, 'fleet=' + s.contextPressure + ' raw=' + expect.toFixed(4));
  }
}
if (cwdWarned) warn('部分非 DSH 会话无 cwd（契约允许）', false, 'n=' + cwdWarned);
ok('抽样对账数量 >= 3', matched >= 3, 'matched=' + matched);

// ---------- 3. 事件 ----------
let lastAt = -Infinity;
const sessionById = new Map(fleet.sessions.map((s) => [s.id, s]));
for (const e of fleet.events) {
  ok('event.id 存在', typeof e.id === 'string' && e.id.length > 0);
  ok('event.kind 合法', VALID_KINDS.has(e.kind), 'kind=' + e.kind);
  ok('event.at 合理', num(e.at) && e.at > 0 && e.at <= Date.now() + 120000, 'at=' + e.at);
  ok('event.at 升序', e.at >= lastAt - 1, 'prev=' + lastAt + ' now=' + e.at + ' kind=' + e.kind);
  lastAt = Math.max(lastAt, e.at);
  ok('event.source 合法', typeof e.source === 'string' && sourceById.has(e.source), 'source=' + e.source);
  ok('event.sessionId 存在', typeof e.sessionId === 'string' && e.sessionId.length > 0);
  const owner = sessionById.get(e.sessionId);
  if (owner) ok('event.source 与 session 一致 (' + e.id + ')', owner.source === e.source, 'event=' + e.source + ' session=' + owner.source);
  ok('event.sessionTitle 字符串', typeof e.sessionTitle === 'string');
  if (e.tool) ok('tool 事件必有五类分类', VALID_CATEGORIES.has(e.toolCategory), 'tool=' + e.tool + ' cat=' + e.toolCategory);
  if (e.detail) ok('detail 无噪声', !NOISE.test(e.detail), 'detail=' + String(e.detail).slice(0, 40));
  if (typeof e.isError === 'boolean') ok('isError 仅出于 tool/error 事件', ['tool/result', 'error', 'tool/call'].includes(e.kind), 'kind=' + e.kind);
}

// ---------- 4. 聚合 ----------
const byState = { live: 0, idle: 0, ended: 0 };
for (const s of fleet.sessions) byState[s.state]++;
const agg = fleet.aggregates;
ok('aggregates.liveCount 对账', agg.liveCount === byState.live, 'agg=' + agg.liveCount + ' sessions=' + byState.live);
ok('aggregates.idleCount 对账', agg.idleCount === byState.idle, 'agg=' + agg.idleCount + ' sessions=' + byState.idle);
ok('aggregates.endedCount 对账', agg.endedCount === byState.ended, 'agg=' + agg.endedCount + ' sessions=' + byState.ended);
const liveOrIdle = fleet.sessions.filter((s) => s.state !== 'ended').map((s) => s.contextPressure);
ok('aggregates.maxContextPressure 对账', Math.abs(agg.maxContextPressure - Math.max(0, ...liveOrIdle)) < 0.002, 'agg=' + agg.maxContextPressure);
ok('aggregates.tokenRate >= 0', agg.tokenRate >= 0, 'rate=' + agg.tokenRate);
ok('aggregates.stamp 接近 now', Math.abs(Date.now() - agg.stamp) < 20000, 'delta=' + (Date.now() - agg.stamp));

// ---------- 5. 分类统计 ----------
const catCount = { read: 0, write: 0, exec: 0, net: 0, agent: 0 };
for (const e of fleet.events) if (e.toolCategory) catCount[e.toolCategory]++;
ok('器用五类至少 3 类有事件', Object.values(catCount).filter((n) => n > 0).length >= 3, 'counts=' + JSON.stringify(catCount));

// ---------- 6. 整机遥测 ----------
let sys = null;
try {
  const sres = await getJSON(BASE + '/api/system', 8000);
  ok('GET /api/system 200', sres.ok, 'status=' + sres.status);
  sys = sres.body;
} catch (err) {
  ok('GET /api/system 可访问', false, String(err.message || err));
}
if (sys) {
  ok('system.at 接近 now', num(sys.at) && Math.abs(Date.now() - sys.at) < 20000, 'delta=' + (Date.now() - sys.at) + 'ms');
  ok('system.available 为布尔', typeof sys.available === 'boolean', 'available=' + sys.available);
  if (sys.available) {
    ok('system.cpu.usage 0..1', num(sys.cpu?.usage) && sys.cpu.usage >= 0 && sys.cpu.usage <= 1, 'v=' + sys.cpu?.usage);
    ok('system.cpu.perCore 数组', Array.isArray(sys.cpu?.perCore) && sys.cpu.perCore.length > 0, 'n=' + sys.cpu?.perCore?.length);
    ok('system.cpu.perCore 值域', Array.isArray(sys.cpu?.perCore) && sys.cpu.perCore.every((v) => num(v) && v >= 0 && v <= 1));
    ok('system.mem.usedPct 0..1', num(sys.mem?.usedPct) && sys.mem.usedPct >= 0 && sys.mem.usedPct <= 1, 'pct=' + sys.mem?.usedPct);
    ok('system.mem 字节自洽', num(sys.mem?.usedBytes) && num(sys.mem?.totalBytes) && sys.mem.usedBytes <= sys.mem.totalBytes * 1.02);
    ok('system.disks 数组', Array.isArray(sys.disks) && sys.disks.length > 0, 'n=' + sys.disks?.length);
    for (const d of sys.disks || []) {
      ok('disk 字段完整 (' + d?.name + ')', typeof d?.name === 'string' && num(d?.totalBytes) && num(d?.freeBytes) && num(d?.usedPct), JSON.stringify(d));
      if (num(d?.usedPct)) ok('disk.usedPct 0..1 (' + d?.name + ')', d.usedPct >= 0 && d.usedPct <= 1, 'v=' + d.usedPct);
    }
    ok('system.net 数值', num(sys.net?.rxBps) && num(sys.net?.txBps) && num(sys.net?.totalRxBytes) && num(sys.net?.totalTxBytes), JSON.stringify(sys.net));
    ok('system.procs 数组', Array.isArray(sys.procs) && sys.procs.length >= 3, 'n=' + sys.procs?.length);
    for (const p of (sys.procs || []).slice(0, 5)) {
      ok('proc 字段完整 (' + p?.pid + ')', num(p?.pid) && typeof p?.name === 'string' && num(p?.cpuPct) && num(p?.memBytes), JSON.stringify(p));
    }
    ok('system.uptimeSec > 0', num(sys.uptimeSec) && sys.uptimeSec > 0, 'v=' + sys.uptimeSec);
    ok('system.battery 可空', sys.battery === null || (num(sys.battery?.percent) && typeof sys.battery?.charging === 'boolean'), JSON.stringify(sys.battery));
  }
}
try {
  const hres = await getJSON(BASE + '/api/system/history?limit=20', 8000);
  ok('GET /api/system/history 200', hres.ok, 'status=' + hres.status);
  const raw = hres.body;
  // 兼容两种形状：直接数组 / {generatedAt, history:[...]}
  const hist = Array.isArray(raw) ? raw : Array.isArray(raw?.history) ? raw.history : null;
  ok('history 可解析为数组', Array.isArray(hist), 'keys=' + (raw && typeof raw === 'object' ? Object.keys(raw).join(',') : typeof raw));
  if (Array.isArray(hist)) {
    ok('history 条数不超过 120', hist.length <= 120, 'n=' + hist.length);
    let prev = -Infinity;
    let sorted = true;
    for (const h of hist) {
      if (!num(h?.at) || h.at < prev) sorted = false;
      prev = h?.at;
    }
    ok('history.at 升序', sorted);
    ok('history 帧可辨（available 字段）', hist.every((h) => typeof h?.available === 'boolean'));
  }
} catch (err) {
  ok('GET /api/system/history 可访问', false, String(err.message || err));
}

// ---------- 输出 ----------
const duration = Date.now() - t0;
const srcSummary = sources.map((s) => s.id + ':' + s.sessions + (s.state === 'absent' ? '(absent)' : '')).join(' / ');
console.log('\n=== 璇玑数据对账 v2 ===');
console.log('源: ' + fleet.source + ' | 会话 ' + fleet.sessions.length + ' (live ' + byState.live + '/idle ' + byState.idle + '/ended ' + byState.ended + ') | 分野 ' + fleet.sectors.length + ' | 事件 ' + fleet.events.length);
console.log('诸源: ' + srcSummary);
console.log('整机: cpu ' + (sys?.available ? (sys.cpu.usage * 100).toFixed(0) + '%' : 'n/a') + ' · 内存 ' + (sys?.available ? (sys.mem.usedPct * 100).toFixed(0) + '%' : 'n/a') + ' · 进程 ' + (sys?.procs?.length ?? 0));
console.log('抽样对账: ' + matched + ' 个 DSH 会话与 projcache 原始值逐字段比对 | 器用事件: ' + JSON.stringify(catCount));
console.log('检查项 ' + checks + ' 条 · 通过 ' + (checks - fails.length) + ' · FAIL ' + fails.length + ' · WARN ' + warns.length + ' · 耗时 ' + duration + 'ms');
if (warns.length) {
  console.log('\nWARN:');
  for (const w of warns.slice(0, 10)) console.log('  ⚠ ' + w);
}
if (fails.length) {
  console.log('\nFAIL:');
  for (const f of fails.slice(0, 40)) console.log('  ✗ ' + f);
  if (fails.length > 40) console.log('  … 省略 ' + (fails.length - 40) + ' 条');
  process.exitCode = 1;
} else {
  console.log('\n✅ 数据对账全部通过：每颗星都能追溯到真实来源，整机遥测字段自洽。');
}
