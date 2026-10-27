// ASTRA server smoke tests — zero dependencies, run with:
//   node --test apps/server/tests/smoke.mjs
//
// The suite boots one real server on a random port, then exercises the REST
// surface, the SSE stream, demo mode, the collector's performance budget, the
// v2 multi-source fleet and the machine telemetry endpoints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { Collector } from '../src/collector.mjs';
import { categorizeTool } from '../src/tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'src', 'server.mjs');
const PORT = 8800 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;
let bootError = null;

function getJson(urlPath, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${urlPath}`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(body) });
        } catch (err) {
          reject(new Error(`bad json from ${urlPath}: ${err.message} · ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout: ${urlPath}`)));
    req.on('error', reject);
  });
}

async function waitForHealth(deadlineMs = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await getJson('/api/health', 1500);
      // v2 boots the multi-source collector asynchronously after `listen`; wait
      // until the first projection is available instead of just "ok:true".
      if (res.status === 200 && res.json?.ok && (res.json.sessions?.total ?? 0) >= 1) return res.json;
    } catch {
      // server not listening yet
    }
    if (Date.now() - start > deadlineMs) throw new Error('server did not become healthy in time');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Wait until the merged fleet carries at least one session. */
async function waitForFleet(deadlineMs = 30000) {
  const start = Date.now();
  for (;;) {
    const res = await getJson('/api/fleet');
    if (res.json?.sessions?.length >= 1) return res.json;
    if (Date.now() - start > deadlineMs) throw new Error('fleet stayed empty');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Resolve with the first SSE frames seen (text), then close the stream. */
function readSse(urlPath, wantFrames = 1, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const req = http.get(`${BASE}${urlPath}`, { timeout: timeoutMs }, (res) => {
      let buf = '';
      const timer = setTimeout(() => {
        req.destroy();
        if (frames.length >= wantFrames) resolve(frames);
        else reject(new Error(`only saw ${frames.length} SSE frames: ${buf.slice(0, 300)}`));
      }, timeoutMs);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.startsWith('event:') || frame.startsWith(':') || frame.startsWith('retry:')) {
            frames.push(frame);
            if (frames.filter((f) => f.startsWith('event:')).length >= wantFrames) {
              clearTimeout(timer);
              req.destroy();
              resolve(frames);
              return;
            }
          }
        }
      });
      res.on('error', () => {});
    });
    req.on('timeout', () => req.destroy(new Error('sse timeout')));
    req.on('error', (err) => {
      if (!frames.length) reject(err);
    });
  });
}

before(async () => {
  child = spawn(process.execPath, [SERVER], {
    cwd: path.join(HERE, '..'),
    env: { ...process.env, PORT: String(PORT), LOG_POLL: '0', EVENT_TAIL_BYTES: '131072' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', () => {});
  try {
    await waitForHealth();
  } catch (err) {
    bootError = new Error(`${err.message}\nserver stderr:\n${stderr.slice(0, 2000)}`);
  }
});

after(async () => {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise((r) => {
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} r(); }, 3000);
    child.once('exit', () => { clearTimeout(t); r(); });
  });
});

test('server boots and reports health', async () => {
  assert.equal(bootError, null, bootError?.message);
  const { status, json } = await getJson('/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(Number.isFinite(json.uptimeMs) && json.uptimeMs >= 0);
  assert.ok(Number(json.sessions?.total) >= 1, `expected sessions, got ${json.sessions?.total}`);
  // v2: /api/health aggregates the DSH collector plus every secondary adapter.
  assert.ok(json.sources && typeof json.sources === 'object', 'health.sources registry');
  for (const id of ['dsh', 'hermes', 'opencode', 'claude', 'codex']) {
    assert.ok(id in json.sources, `health.sources.${id} missing`);
  }
  assert.ok(Array.isArray(json.sourceInfo) && json.sourceInfo.length === 5, 'health.sourceInfo registry');
  // Steady-state collection rounds stay well under the 80ms budget.
  const lastPollMs = json.poll?.lastPollMs ?? json.sources?.dsh?.poll?.lastMs ?? 0;
  assert.ok(lastPollMs < 80, `collection round should stay under 80ms, got ${lastPollMs}ms`);
});

test('collector produces a fleet from real data within 3s', async () => {
  const config = loadConfig();
  const collector = new Collector({ ...config, pollMs: 500 }, { log: () => {} });
  await collector.init();
  await new Promise((r) => setTimeout(r, 1000));
  const started = performance.now();
  await collector.tickOnce();
  const tickMs = performance.now() - started;
  collector.stop();
  const fleet = collector.getFleet();
  assert.ok(fleet.sessions.length >= 1, 'fleet should contain at least one session');
  assert.equal(fleet.source, 'live');
  assert.ok(Array.isArray(fleet.sectors) && fleet.sectors.length >= 1);
  assert.ok(Array.isArray(fleet.events));
  // The v2 collection budget is one 80ms round (it also runs while other test
  // files hit the same disk); 50ms was tight enough to flake under load.
  assert.ok(tickMs < 80, `one collector tick should stay under 80ms, got ${tickMs.toFixed(1)}ms`);
});

test('GET /api/fleet matches the frontend contract', async () => {
  const json = await waitForFleet();
  assert.deepEqual(Object.keys(json).sort(), ['aggregates', 'events', 'generatedAt', 'sectors', 'sessions', 'source', 'sources']);
  assert.equal(typeof json.generatedAt, 'number');
  assert.ok(['live', 'demo', 'replay'].includes(json.source));
  assert.ok(json.sessions.length >= 1);

  const session = json.sessions[0];
  const required = [
    'id', 'title', 'workspace', 'cwd', 'source', 'sourceLabel', 'state', 'parentId', 'depth', 'model',
    'reasoningEffort', 'preset', 'createdAt', 'lastActivityAt', 'turns', 'steps', 'tokens', 'recentTokenRate',
    'contextPressure', 'contextWindow', 'openStep', 'pendingCalls', 'toolCounts', 'todos',
    'planActive', 'team', 'lastPrompt', 'lastResponse',
  ];
  for (const key of required) assert.ok(key in session, `session missing "${key}"`);
  assert.ok(['live', 'idle', 'ended'].includes(session.state));
  assert.ok(session.tokens && ['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => Number.isFinite(session.tokens[k])));
  assert.ok(session.contextPressure >= 0 && session.contextPressure <= 1);
  assert.ok(Number.isFinite(session.lastActivityAt) && session.lastActivityAt > 0);
  assert.deepEqual(Object.keys(session.toolCounts).sort(), ['agent', 'exec', 'net', 'read', 'write']);
  assert.ok(Array.isArray(session.pendingCalls) && session.pendingCalls.length <= 8);

  // v2: ids are globally unique with a source prefix, and workspace is the
  // name of the sector the session belongs to.
  assert.ok(json.sessions.every((s) => typeof s.source === 'string' && s.source.length > 0));
  assert.ok(json.sessions.every((s) => s.id.startsWith(`${s.source}:`) || s.source === 'dsh'));
  const sectorOf = new Map();
  for (const sector of json.sectors) for (const id of sector.sessionIds) sectorOf.set(id, sector);
  for (const s of json.sessions) {
    const sector = sectorOf.get(s.id);
    assert.ok(sector, `session ${s.id} is missing from every sector`);
    assert.equal(s.workspace, sector.name, `workspace !== sector.name for ${s.id}`);
  }
  assert.equal(sectorOf.size, json.sessions.length, 'every session must belong to exactly one sector');

  const sector = json.sectors[0];
  for (const key of ['id', 'name', 'path', 'source', 'sessionIds', 'liveCount']) assert.ok(key in sector, `sector missing "${key}"`);

  // v2 source registry: 5 known adapters, counted consistently with the sessions.
  assert.ok(Array.isArray(json.sources) && json.sources.length >= 4);
  const sourceIds = json.sources.map((s) => s.id).sort();
  assert.deepEqual(sourceIds, ['claude', 'codex', 'dsh', 'hermes', 'opencode']);
  for (const info of json.sources) {
    for (const key of ['id', 'label', 'state', 'sessions', 'live', 'lastActivityAt', 'detail']) {
      assert.ok(key in info, `source info missing "${key}"`);
    }
    assert.ok(['detected', 'absent'].includes(info.state));
    const actual = json.sessions.filter((s) => s.source === info.id).length;
    assert.equal(info.sessions, actual, `source ${info.id} session count drift`);
  }

  const agg = json.aggregates;
  for (const key of ['liveCount', 'idleCount', 'endedCount', 'tokenRate', 'toolRate', 'errorCount', 'maxContextPressure', 'stamp']) {
    assert.ok(key in agg, `aggregates missing "${key}"`);
  }
  assert.equal(agg.liveCount + agg.idleCount + agg.endedCount, json.sessions.length);

  assert.ok(json.events.length > 0, 'first screen should carry a backfilled ledger');
  const evt = json.events[json.events.length - 1];
  for (const key of ['id', 'at', 'kind', 'source', 'sessionId', 'sessionTitle', 'tool', 'toolCategory', 'detail', 'isError', 'turn', 'step', 'durationMs']) {
    assert.ok(key in evt, `event missing "${key}"`);
  }
  assert.ok(json.events.every((e) => e.id.startsWith('evt-')));
  // v2: every event names the agent source that produced it.
  const sourceOfSession = new Map(json.sessions.map((s) => [s.id, s.source]));
  for (const e of json.events) {
    assert.ok(typeof e.source === 'string' && e.source.length > 0, `event ${e.id} has no source`);
    if (sourceOfSession.has(e.sessionId)) assert.equal(e.source, sourceOfSession.get(e.sessionId));
  }
  assert.ok(json.events.length <= 300);
  assert.deepEqual(
    [...json.events].map((e) => e.at),
    [...json.events].map((e) => e.at).sort((a, b) => a - b),
    'events must be sorted by at ascending',
  );
});

test('GET /api/system and /api/system/history expose machine telemetry', async () => {
  // The PowerShell sampler needs a moment to warm up; poll for it on Windows.
  let system = (await getJson('/api/system')).json;
  const deadline = Date.now() + 12000;
  while (!system.available && process.platform === 'win32' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    system = (await getJson('/api/system')).json;
  }
  assert.equal(typeof system.at, 'number');
  assert.equal(typeof system.available, 'boolean');
  for (const key of ['cpu', 'mem', 'disks', 'net', 'procs', 'uptimeSec', 'battery']) {
    assert.ok(key in system, `system missing "${key}"`);
  }
  assert.ok(system.cpu.usage >= 0 && system.cpu.usage <= 1);
  assert.ok(Array.isArray(system.cpu.perCore));
  assert.ok(system.mem.usedPct >= 0 && system.mem.usedPct <= 1);
  assert.ok(Array.isArray(system.disks) && Array.isArray(system.procs));
  assert.ok(system.procs.length <= 12, 'system.procs must be trimmed to 12');
  if (system.available) assert.ok(system.mem.totalBytes > 0, 'a live sample must report total memory');

  const hist = await getJson('/api/system/history?limit=999');
  assert.equal(hist.status, 200);
  assert.equal(typeof hist.json.generatedAt, 'number');
  assert.ok(Array.isArray(hist.json.history), 'history endpoint returns { generatedAt, history[] }');
  assert.ok(hist.json.history.length <= 120, 'limit is clamped to the 120-sample ring');
  for (const sample of hist.json.history) assert.equal(typeof sample.at, 'number');
  const small = await getJson('/api/system/history?limit=3');
  assert.ok(small.json.history.length <= 3);
});

test('GET /api/sessions, /api/sessions/:id and /api/events work', async () => {
  const list = await getJson('/api/sessions');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.sessions) && list.json.sessions.length >= 1);

  const id = list.json.sessions[0].id;
  const one = await getJson(`/api/sessions/${encodeURIComponent(id)}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.id, id);

  const missing = await getJson('/api/sessions/does-not-exist');
  assert.equal(missing.status, 404);

  const events = await getJson('/api/events?limit=3');
  assert.equal(events.status, 200);
  assert.ok(events.json.events.length <= 3);
});

test('GET /api/stream delivers fleet/tick/system frames', async (t) => {
  const health = (await getJson('/api/health')).json;
  const frames = await readSse('/api/stream', 3, 6000);
  const fleetFrame = frames.find((f) => f.startsWith('event: fleet'));
  assert.ok(fleetFrame, `expected a fleet frame, saw: ${JSON.stringify(frames)}`);
  assert.ok(frames.some((f) => f.startsWith('retry:') || f.startsWith(':')), 'expected retry/comment preamble');
  assert.equal(JSON.parse(fleetFrame.split('\ndata: ')[1]).type, 'fleet');

  if (!health.system?.available) {
    t.skip('machine telemetry unavailable on this host');
    return;
  }
  // The system frame is emitted every sampler interval (2s); wait long enough
  // for at least one, then validate the compact frame shape.
  const systemFrames = await readSse('/api/stream', 6, 7000);
  const systemFrame = systemFrames.find((f) => f.startsWith('event: system'));
  assert.ok(systemFrame, 'expected an SSE `system` frame while telemetry is available');
  const data = JSON.parse(systemFrame.split('\ndata: ')[1]);
  assert.equal(data.type, 'system');
  assert.equal(typeof data.at, 'number');
  assert.ok(Array.isArray(data.procs) && data.procs.length <= 12);
  assert.ok(data.cpu && typeof data.cpu.usage === 'number');
});

test('demo mode returns 5+ agents, a source registry and live events', async () => {
  const { status, json } = await getJson('/api/fleet?demo=1');
  assert.equal(status, 200);
  assert.equal(json.source, 'demo');
  assert.ok(json.sessions.length >= 5, `expected 5+ demo agents, got ${json.sessions.length}`);
  assert.ok(json.aggregates.liveCount >= 1);
  assert.ok(json.events.length >= 5, `demo first frame should have a ledger, got ${json.events.length}`);
  assert.ok(json.sessions.some((s) => s.parentId), 'demo should include a child agent tree');
  assert.ok(json.sessions.some((s) => s.state === 'ended'), 'demo should include ended agents');
  // v2 demo: mixed sources, codex intentionally absent so the UI can show 4/5.
  assert.equal(json.sources.length, 5);
  assert.equal(json.sources.find((s) => s.id === 'codex').state, 'absent');
  const demoSourceIds = new Set(json.sessions.map((s) => s.source));
  assert.ok(demoSourceIds.size >= 3, `demo should mix sources, got ${[...demoSourceIds]}`);
  assert.ok(json.events.every((e) => typeof e.source === 'string' && e.source));
});

test('tool names map to the five visual categories', () => {
  assert.equal(categorizeTool('read'), 'read');
  assert.equal(categorizeTool('write'), 'write');
  assert.equal(categorizeTool('pwsh'), 'exec');
  assert.equal(categorizeTool('web_search'), 'net');
  assert.equal(categorizeTool('spawn_teammate'), 'agent');
  assert.equal(categorizeTool('mcp__rpgmaker-mv__generate_map'), 'write');
  assert.equal(categorizeTool('mystery_tool_xyz'), null);
});
