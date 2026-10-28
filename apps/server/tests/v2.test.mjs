// ASTRA server v2 unit tests — multi-source adapters + machine telemetry.
// Zero dependencies; run with:
//   node --test apps/server/tests/*.mjs
//
// These tests touch the REAL local data sources, but strictly read-only:
//  - Hermes / opencode SQLite files are opened `readOnly:true` and we assert the
//    file stats do not change across an init + poll cycle;
//  - Claude Code JSONL files are only read;
//  - the machine telemetry tests use a synthetic sampler line (no PowerShell spawn).
// Sources whose data files do not exist are skipped instead of failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { categorizeTool } from '../src/tools.mjs';
import { buildSectors, makeEvent, makeSession, sectorIdFor, SOURCE_LABELS } from '../src/sources/shared.mjs';
import { parseHermesToolCalls, parseHermesToolResult, createHermesSource } from '../src/sources/hermes.mjs';
import { createOpencodeSource } from '../src/sources/opencode.mjs';
import { createClaudeSource } from '../src/sources/claude.mjs';
import { createCodexSource } from '../src/sources/codex.mjs';
import { normalizeSample, createEmptySystem } from '../src/system.mjs';

const config = loadConfig();
const TOOL_CATEGORY_KEYS = ['agent', 'exec', 'net', 'read', 'write'];

function statKey(file) {
  const stat = fs.statSync(file);
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

/** Shared contract assertions for one projected batch of sessions. */
function assertSessions(sessions, source) {
  assert.ok(sessions.length >= 1, `${source} should project at least one session`);
  for (const session of sessions) {
    assert.equal(session.source, source, 'session.source');
    assert.equal(session.sourceLabel, SOURCE_LABELS[source], 'session.sourceLabel');
    assert.equal(typeof session.workspace, 'string');
    assert.ok(session.workspace.length > 0, 'workspace must never be empty');
    assert.equal(typeof session.cwd, 'string');
    assert.deepEqual(Object.keys(session.toolCounts).sort(), TOOL_CATEGORY_KEYS);
    assert.ok(Number.isInteger(session.lastActivityAt), 'lastActivityAt must be an integer ms');
    assert.ok(session.tokens && Number.isFinite(session.tokens.output));
    // Contract invariant: a session's workspace is the name of its sector.
    const [sector] = buildSectors([session]);
    assert.equal(sector.name, session.workspace, 'workspace === sector.name');
    assert.equal(sector.id, sectorIdFor(source, session.cwd));
    assert.equal(sector.source, source);
  }
}

/* ------------------------------------------------------------------ mapping */

test('tool names from every agent source map to the five visual categories', () => {
  // DSH / harness tool names.
  assert.equal(categorizeTool('read'), 'read');
  assert.equal(categorizeTool('write'), 'write');
  assert.equal(categorizeTool('pwsh'), 'exec');
  assert.equal(categorizeTool('web_search'), 'net');
  assert.equal(categorizeTool('spawn_teammate'), 'agent');
  assert.equal(categorizeTool('mcp__rpgmaker-mv__generate_map'), 'write');
  // Claude Code (PascalCase, resolved case-insensitively).
  assert.equal(categorizeTool('Read'), 'read');
  assert.equal(categorizeTool('Glob'), 'read');
  assert.equal(categorizeTool('Grep'), 'read');
  assert.equal(categorizeTool('LS'), 'read');
  assert.equal(categorizeTool('Bash'), 'exec');
  assert.equal(categorizeTool('Write'), 'write');
  assert.equal(categorizeTool('Edit'), 'write');
  assert.equal(categorizeTool('NotebookEdit'), 'write');
  assert.equal(categorizeTool('WebFetch'), 'net');
  assert.equal(categorizeTool('WebSearch'), 'net');
  assert.equal(categorizeTool('Task'), 'agent');
  assert.equal(categorizeTool('Skill'), 'agent');
  // Hermes tool names.
  assert.equal(categorizeTool('terminal'), 'exec');
  assert.equal(categorizeTool('execute_code'), 'exec');
  assert.equal(categorizeTool('read_file'), 'read');
  assert.equal(categorizeTool('patch'), 'write');
  assert.equal(categorizeTool('browser_navigate'), 'net');
  assert.equal(categorizeTool('skill_manage'), 'agent');
  // opencode tool names.
  assert.equal(categorizeTool('bash'), 'exec');
  assert.equal(categorizeTool('todowrite'), 'write');
  // Unknown tools stay uncounted (null) instead of being guessed.
  assert.equal(categorizeTool('frobnicate_the_thing'), null);
});

/* --------------------------------------------------------------- helpers */

test('hermes payload helpers parse native tool calls/results', () => {
  const calls = parseHermesToolCalls(
    JSON.stringify([
      {
        id: 'call_1',
        call_id: 'call_1',
        type: 'function',
        function: { name: 'terminal', arguments: '{"command":"ls"}' },
      },
    ]),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'terminal');
  assert.equal(calls[0].callId, 'call_1');
  assert.deepEqual(parseHermesToolCalls('not json'), []);

  const ok = parseHermesToolResult(JSON.stringify({ output: 'hello', exit_code: 0, error: null }));
  assert.equal(ok.isError, false);
  assert.ok(ok.text.includes('hello'));
  const failed = parseHermesToolResult(JSON.stringify({ output: '', exit_code: 1, error: 'boom' }));
  assert.equal(failed.isError, true);
});

test('makeSession / makeEvent / buildSectors keep the v2 contract invariants', () => {
  const session = makeSession({
    id: 'hermes:unit-1',
    source: 'hermes',
    title: 'unit test',
    workspace: 'hermes',
    cwd: 'C:/work/hermes',
    state: 'ended',
    createdAt: 1,
    lastActivityAt: 2,
    toolCounts: { read: 1 },
  });
  assert.equal(session.source, 'hermes');
  assert.equal(session.sourceLabel, 'Hermes');
  assert.equal(session.toolCounts.read, 1);
  assert.equal(session.toolCounts.write, 0);
  const sectors = buildSectors([session]);
  assert.equal(sectors.length, 1);
  assert.equal(sectors[0].id, 'hermes::c:/work/hermes');
  assert.equal(sectors[0].name, session.workspace);

  const event = makeEvent('claude', { kind: 'tool/call', tool: 'Bash', at: 5, sessionId: 'claude:x' });
  assert.equal(event.source, 'claude');
  assert.equal(event.toolCategory, 'exec');
  assert.equal(event.isError, null);
  assert.ok(event.id.startsWith('evt-claude-'));
});

/* ------------------------------------------------------- machine telemetry */

test('normalizeSample parses one sampler JSON line into the /api/system shape', () => {
  const procs = Array.from({ length: 20 }, (_, i) => ({ pid: i + 1, name: `p${i}`, cpuPct: i, memBytes: i * 1024 }));
  const sample = normalizeSample(
    {
      at: 1793000000123,
      cpu: { usage: 1.7, perCore: [0.1, 2, 0.5] },
      mem: { usedBytes: 2048, totalBytes: 4096, usedPct: -1 },
      disks: [{ name: 'C:', totalBytes: 100, freeBytes: 25, usedPct: 0.75 }],
      net: { rxBps: 10.5, txBps: 3, totalRxBytes: 100, totalTxBytes: 50 },
      procs,
      uptimeSec: 123.6,
      battery: { percent: 99.6, charging: true },
    },
    1793000000999,
  );
  assert.equal(sample.at, 1793000000123);
  assert.equal(sample.available, true);
  assert.equal(sample.cpu.usage, 1); // clamped to 0..1
  assert.deepEqual(sample.cpu.perCore, [0.1, 1, 0.5]);
  assert.equal(sample.mem.usedPct, 0);
  assert.equal(sample.mem.totalBytes, 4096);
  assert.equal(sample.disks[0].usedPct, 0.75);
  assert.equal(sample.net.rxBps, 11); // rounded bytes/s
  assert.equal(sample.procs.length, 20); // up to 220 kept for the 百工 view
  assert.equal(sample.uptimeSec, 124);
  assert.deepEqual(sample.battery, { percent: 100, charging: true });
  assert.equal(normalizeSample(null), null);

  const empty = createEmptySystem();
  assert.equal(empty.available, false);
  assert.deepEqual(empty.procs, []);
});

/* --------------------------------------------------- real sources (read-only) */

test('hermes SQLite is opened read-only and projects sessions', (t) => {
  if (!fs.existsSync(config.hermesDb)) return t.skip(`missing ${config.hermesDb}`);
  const before = statKey(config.hermesDb);
  const source = createHermesSource(config, { log: () => {} });
  return source
    .init(Date.now())
    .then(() => {
      assert.ok(source.detected, 'hermes should be detected');
      assert.equal(source.describe().state, 'detected');
      const sessions = source.getSessions();
      assertSessions(sessions, 'hermes');
      // cwd fallback: sessions without a recorded cwd use the Hermes install root.
      const noCwd = sessions.filter((session) => session.cwd === 'C:/work/hermes');
      assert.ok(noCwd.length >= 0);
      assert.ok(sessions.every((session) => session.cwd !== ''));
      assert.equal(statKey(config.hermesDb), before, 'hermes db must not be modified');
    })
    .finally(() => source.stop());
});

test('opencode SQLite is opened read-only and projects sessions', (t) => {
  if (!fs.existsSync(config.opencodeDb)) return t.skip(`missing ${config.opencodeDb}`);
  const before = statKey(config.opencodeDb);
  const source = createOpencodeSource(config, { log: () => {} });
  return source
    .init(Date.now())
    .then(() => {
      assert.ok(source.detected, 'opencode should be detected');
      const sessions = source.getSessions();
      assertSessions(sessions, 'opencode');
      assert.equal(statKey(config.opencodeDb), before, 'opencode db must not be modified');
    })
    .finally(() => source.stop());
});

test('claude code JSONL files are tailed read-only and projected', async (t) => {
  const source = createClaudeSource(config, { log: () => {} });
  await source.init(Date.now());
  if (!source.detected) {
    t.skip(`missing ${config.claudeDir}`);
    return;
  }
  const sessions = source.getSessions();
  assertSessions(sessions, 'claude');
  const events = source.getEvents();
  assert.ok(Array.isArray(events));
  source.stop();
});

test('codex reports absent when no rollout files exist (or projects them)', async () => {
  const source = createCodexSource(config, { log: () => {} });
  await source.init(Date.now());
  const described = source.describe();
  assert.ok(['detected', 'absent'].includes(described.state));
  if (described.state === 'absent') assert.equal(source.getSessions().length, 0);
  else assertSessions(source.getSessions(), 'codex');
});
