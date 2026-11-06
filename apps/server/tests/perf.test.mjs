// Performance / delivery-protocol regression tests for the ASTRA data service.
//
// These exercise the pieces that the performance work touched:
//   - the hub-wide fleet frame cache (all clients of one mode share one build)
//   - the optional ?delta=1 stream (full first frame, then compact deltas;
//     structure changes fall back to a full frame)
//   - backpressure: a skipped frame must not advance the delta baseline, and
//     recovery has to resynchronise with a full frame
//   - fs.watch accelerated discovery of brand-new session logs / projcache files
//
// They drive the hub in-process (no browser), which keeps them fast and lets us
// inject fake slow clients for the backpressure cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';

// Keep the test server lean: no PowerShell sampler, no poll logging.
process.env.SYSTEM_TELEMETRY = '0';
process.env.LOG_POLL = '0';

const { loadConfig } = await import('../src/config.mjs');
const { startServer } = await import('../src/server.mjs');
const { EventLogTailer } = await import('../src/eventlog.mjs');
const { ProjCache } = await import('../src/projcache.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let hub;

test.before(async () => {
  const config = { ...loadConfig(), port: 0, system: false, logPoll: false };
  hub = await startServer(config, { log: () => {} });
  // Wait for the composite live source to come up (DSH + secondary sources).
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (hub.primaryReady) return;
    await sleep(100);
  }
});

test.after(async () => {
  if (hub) await hub.close();
});

/** Minimal stand-in for a connected SSE response. */
function fakeClient({ delta = false, buffered = 0 } = {}) {
  const writes = [];
  const res = {
    writableEnded: false,
    writableLength: buffered,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    end() {},
    destroy() {},
  };
  return {
    res,
    wantDemo: false,
    delta,
    needsFull: true,
    baselineAt: 0,
    closed: false,
    lastFleetAt: 0,
    lastTickAt: 0,
    dropped: 0,
    writes,
  };
}

function fleetFromChunk(chunk) {
  assert.match(chunk, /^event: fleet\ndata: /);
  const json = chunk.slice('event: fleet\ndata: '.length).trimEnd();
  return JSON.parse(json);
}

function deltaFromChunk(chunk) {
  assert.match(chunk, /^event: delta\ndata: /);
  const json = chunk.slice('event: delta\ndata: '.length).trimEnd();
  return JSON.parse(json);
}

test('all legacy clients of one mode share the same serialized fleet frame', () => {
  const a = fakeClient();
  const b = fakeClient();
  hub.clients.add(a);
  hub.clients.add(b);
  try {
    hub.tickFleet();
    assert.ok(a.writes.length >= 1, 'legacy client receives a frame');
    assert.ok(b.writes.length >= 1, 'second client receives a frame');
    assert.equal(a.writes[0], b.writes[0], 'one build/serialization is shared by both clients');
    const fleet = fleetFromChunk(a.writes[0]);
    assert.equal(fleet.type, 'fleet');
    assert.ok(Array.isArray(fleet.sessions) && fleet.sessions.length > 0);
    assert.ok(Array.isArray(fleet.sources));
  } finally {
    hub.clients.delete(a);
    hub.clients.delete(b);
  }
});

test('a joining delta client is aligned to the hub baseline before receiving deltas', () => {
  const client = fakeClient({ delta: true });
  const originalFleetFrame = hub.fleetFrame;
  const originalDeltaState = hub.deltaState;
  const makeEntry = (at, title) => {
    const snapshot = {
      source: 'live',
      generatedAt: at,
      sessions: [{ id: 'session-baseline', title }],
      sectors: [],
      sources: [],
      aggregates: { sessions: 1 },
      events: [],
    };
    return { at, snapshot, frame: JSON.stringify({ type: 'fleet', ...snapshot }), json: JSON.stringify(snapshot) };
  };
  const baseline = makeEntry(100, 'baseline');
  const intermediate = makeEntry(200, 'intermediate');
  const reverted = makeEntry(300, 'baseline');
  const next = makeEntry(400, 'next');
  let frameIndex = 0;
  hub.fleetFrame = () => [intermediate, reverted, next][Math.min(frameIndex++, 2)];
  hub.deltaState = new Map([['live', {
    sessions: new Map([['session-baseline', JSON.stringify(baseline.snapshot.sessions[0])]]),
    shape: hub.structureSignature(baseline.snapshot),
    sourcesSig: '[]',
    at: baseline.at,
  }]]);
  hub.clients.add(client);
  try {
    hub.sendFleet(client);
    assert.equal(fleetFromChunk(client.writes[0]).sessions[0].title, 'intermediate');
    hub.tickFleet();
    assert.equal(client.writes.length, 2);
    assert.equal(fleetFromChunk(client.writes[1]).sessions[0].title, 'baseline',
      'the first hub tick must be full when the immediate snapshot was newer than its shared baseline');
    assert.equal(client.needsFull, false);

    hub.tickFleet();
    assert.equal(client.writes.length, 3);
    const delta = deltaFromChunk(client.writes[2]);
    assert.equal(delta.sessions[0].title, 'next', 'compact deltas resume after the client is aligned');
  } finally {
    hub.clients.delete(client);
    hub.fleetFrame = originalFleetFrame;
    hub.deltaState = originalDeltaState;
  }
});

test('delta clients get a full first frame and compact deltas afterwards', () => {
  const client = fakeClient({ delta: true });
  hub.clients.add(client);
  try {
    hub.tickFleet();
    assert.equal(client.writes.length, 1, 'first frame is delivered immediately');
    const first = fleetFromChunk(client.writes[0]);
    assert.equal(first.type, 'fleet');
    assert.equal(client.needsFull, false);

    // Later ticks must be deltas while the fleet structure is unchanged. In
    // theory a session/sector transition could force a full frame, so allow a
    // couple of attempts before declaring failure.
    let delta = null;
    for (let i = 0; i < 6 && !delta; i += 1) {
      hub.tickFleet();
      const chunk = client.writes[client.writes.length - 1];
      if (chunk.startsWith('event: delta\ndata: ')) delta = deltaFromChunk(chunk);
    }
    assert.ok(delta, 'delta client receives a compact delta frame');
    assert.equal(delta.type, 'delta');
    assert.equal(typeof delta.at, 'number');
    assert.ok(Array.isArray(delta.sessions));
    assert.ok(Array.isArray(delta.removed));
    assert.ok(delta.aggregates && typeof delta.aggregates === 'object');
  } finally {
    hub.clients.delete(client);
  }
});

test('backpressure skips frames without advancing the delta baseline and resent full on recovery', () => {
  const client = fakeClient({ delta: true, buffered: 3 * 1024 * 1024 });
  hub.clients.add(client);
  try {
    // Pretend the client is already in sync so a skip is detectable.
    client.needsFull = false;
    client.baselineAt = Date.now();
    hub.tickFleet();
    assert.equal(client.writes.length, 0, 'no write while the socket is over the buffer limit');
    assert.equal(client.needsFull, true, 'skipped frame marks the client for a full resync');

    // Drain the socket: the next frame must be a full fleet frame again.
    client.res.writableLength = 0;
    hub.tickFleet();
    assert.ok(client.writes.length >= 1, 'recovery frame is written');
    const fleet = fleetFromChunk(client.writes[0]);
    assert.equal(fleet.type, 'fleet');
    assert.equal(client.needsFull, false);
  } finally {
    hub.clients.delete(client);
  }
});

test('demo mode keeps the delta protocol working on its own source', async () => {
  await hub.ensureDemo();
  const client = fakeClient({ delta: true });
  client.wantDemo = true;
  hub.clients.add(client);
  try {
    hub.tickFleet();
    const firstNew = client.writes.find((chunk) => chunk.startsWith('event: fleet\ndata: '));
    assert.ok(firstNew, 'demo delta client starts with a full frame');
    const fleet = fleetFromChunk(firstNew);
    assert.equal(fleet.type, 'fleet');
    assert.equal(fleet.source, 'demo');
    assert.ok(fleet.sources.length >= 4, 'demo exposes the multi-source registry');

    let delta = null;
    for (let i = 0; i < 6 && !delta; i += 1) {
      hub.tickFleet();
      for (const chunk of client.writes.slice(-3)) {
        if (chunk.startsWith('event: delta\ndata: ')) delta = deltaFromChunk(chunk);
      }
    }
    assert.ok(delta, 'demo delta client receives a compact delta frame');
    assert.equal(delta.type, 'delta');
  } finally {
    hub.clients.delete(client);
  }
});

test('eventlog watcher finds a brand-new session log on the next poll', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-events-'));
  const seen = [];
  const tailer = new EventLogTailer({
    root,
    recentMs: 60 * 60_000,
    tailBytes: 64 * 1024,
    readBudgetPerPoll: 1 << 20,
  });
  // The collector wires the callback after construction, so mirror that here.
  tailer.onEvents = (sessionId, events) => {
    seen.push({ sessionId, count: events.length });
  };
  try {
    await tailer.init(Date.now());
    const sessionId = 'session-watch-test';
    const dir = path.join(root, '--D-app-AI-Ai~0020workspace--', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: sessionId }),
      JSON.stringify({ type: 'step/start', seq: 1, time: Date.now(), data: { turn: 1, step: 1 } }),
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)));

    await sleep(300); // let fs.watch deliver the event to the tailer queue
    await tailer.poll(Date.now());
    assert.ok(seen.some((entry) => entry.sessionId === sessionId), 'new session log is discovered within one poll');
    assert.ok(seen.some((entry) => entry.count >= 1), 'events of the new log are parsed');
    assert.equal(tailer.cursorSummary().watch, 'active', 'fs.watch is armed for the events root');
  } finally {
    tailer.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('projcache watcher picks up new and rewritten snapshot files without a full sweep', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-projcache-'));
  const writeRecord = (name, title) => {
    const record = {
      version: 7,
      record: {
        identity: { formatVersion: 7, createdAt: Date.now(), cwd: 'D:/tmp/astra-test' },
        rows: { title: { ver: 1, seq: 1, val: title } },
      },
    };
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(record));
  };
  const cache = new ProjCache({ dir, log: () => {}, scanMs: 600_000 });
  try {
    writeRecord('session-a', 'Alpha');
    await cache.init();
    assert.equal(cache.sessions.size, 1, 'initial scan loads the existing snapshot');

    writeRecord('session-b', 'Bravo');
    await sleep(300); // allow fs.watch to enqueue the new file
    const result = await cache.poll();
    assert.ok(cache.sessions.has('session-b'), 'new snapshot is loaded by the incremental poll');
    assert.equal(cache.sessions.size, 2);
    assert.equal(result.stats.parsed, 1, 'only the changed file is parsed, not the whole directory');

    writeRecord('session-a', 'Alpha-2');
    await sleep(300);
    await cache.poll();
    assert.ok(JSON.stringify(result).length >= 0);
    const state = cache.sessions.get('session-a');
    assert.equal(state.record.rows.title.val, 'Alpha-2', 'rewritten snapshot files are refreshed');
  } finally {
    cache.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a backpressure-skipped tick frame forces a delta client to resync with a full frame', () => {
  const client = fakeClient({ delta: true, buffered: 3 * 1024 * 1024 });
  hub.clients.add(client);
  try {
    // Pretend the client is in sync, then let a tick broadcast be skipped.
    client.needsFull = false;
    hub.broadcast(hub.sourceFor(false), { at: Date.now(), events: [{ id: 'evt-skip-1' }], sessions: [] });
    assert.equal(client.writes.length, 0, 'tick frame is skipped while over the buffer limit');
    assert.equal(client.needsFull, true, 'a skipped tick forces a full fleet resync (tick events cannot be replayed)');

    client.res.writableLength = 0;
    hub.tickFleet();
    assert.ok(client.writes.length >= 1);
    const fleet = fleetFromChunk(client.writes[0]);
    assert.equal(fleet.type, 'fleet', 'recovery frame is a full fleet frame (carries the event ring)');
  } finally {
    hub.clients.delete(client);
  }
});

test('delta frames carry the full source registry when its metadata changes', () => {
  const client = fakeClient({ delta: true });
  hub.clients.add(client);
  try {
    hub.tickFleet(); // first frame: full
    hub.tickFleet(); // establish a baseline tick
    // Force the registry signature to look stale so this tick must include it.
    hub.deltaState.get('live').sourcesSig = 'stale';
    let sources = null;
    for (let i = 0; i < 6 && !sources; i += 1) {
      hub.tickFleet();
      for (const chunk of client.writes.slice(-3)) {
        if (!chunk.startsWith('event: delta\ndata: ')) continue;
        const delta = deltaFromChunk(chunk);
        if (Array.isArray(delta.sources)) sources = delta.sources;
      }
      if (!sources) hub.deltaState.get('live').sourcesSig = 'stale';
    }
    assert.ok(sources, 'delta frame includes the source registry when it changed');
    assert.equal(sources.length, 5, 'all five sources are present');
    for (const source of sources) {
      for (const key of ['id', 'label', 'state', 'sessions', 'live', 'lastActivityAt', 'detail']) {
        assert.ok(key in source, `source.${key} is present`);
      }
    }
  } finally {
    hub.clients.delete(client);
  }
});

test('a structural change forces every delta client back to a full frame', () => {
  const a = fakeClient({ delta: true });
  const b = fakeClient({ delta: true });
  hub.clients.add(a);
  hub.clients.add(b);
  const original = hub.structureSignature.bind(hub);
  try {
    hub.tickFleet(); // full for both
    hub.tickFleet(); // delta baseline
    // Simulate a sector/path/registry shape change for exactly one tick.
    hub.structureSignature = (snapshot) => {
      const shape = original(snapshot);
      return { sectors: `${shape.sectors}|forced-change`, sources: shape.sources };
    };
    const beforeA = a.writes.length;
    const beforeB = b.writes.length;
    hub.tickFleet();
    const newA = a.writes.slice(beforeA);
    const newB = b.writes.slice(beforeB);
    assert.ok(newA.some((chunk) => chunk.startsWith('event: fleet\ndata: ')), 'client A gets a full frame');
    assert.ok(newB.some((chunk) => chunk.startsWith('event: fleet\ndata: ')), 'client B gets a full frame');
    assert.ok(!newA.some((chunk) => chunk.startsWith('event: delta\ndata: ')), 'no delta is sent on a structure change');
    const fleet = fleetFromChunk(newA.find((chunk) => chunk.startsWith('event: fleet\ndata: ')));
    assert.ok(Array.isArray(fleet.sectors) && fleet.sectors.every((sector) => typeof sector.path === 'string'));
  } finally {
    hub.structureSignature = original;
    hub.clients.delete(a);
    hub.clients.delete(b);
  }
});

test('a resumed cold session log is picked up by fs.watch on the next poll', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-cold-'));
  const sessionId = 'session-cold-test';
  const dir = path.join(root, '--D-app-AI-Ai~0020workspace--', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const frame = (seq) =>
    zstdCompressSync(
      Buffer.from(
        [
          JSON.stringify({ type: 'step/start', seq, time: Date.now(), data: { turn: 1, step: seq } }),
        ].join('\n'),
      ),
    );
  fs.writeFileSync(file, frame(1));
  // Make the log look old (> hotMs) so init treats it as cold and tracks it
  // without reading its tail.
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  fs.utimesSync(file, old, old);

  const seen = [];
  const tailer = new EventLogTailer({ root, recentMs: 60 * 60_000, tailBytes: 64 * 1024, readBudgetPerPoll: 1 << 20 });
  tailer.onEvents = (id, events) => seen.push({ sessionId: id, count: events.length });
  try {
    await tailer.init(Date.now());
    assert.equal(tailer.files.get(file).pos, fs.statSync(file).size, 'cold log is tracked at its current tail');

    // Resume the cold session: append a second zstd frame.
    fs.writeFileSync(file, Buffer.concat([fs.readFileSync(file), frame(2)]));
    await sleep(300);
    await tailer.poll(Date.now());
    assert.ok(seen.some((entry) => entry.sessionId === sessionId), 'resumed cold log is discovered');
    assert.ok(seen.some((entry) => entry.count >= 1), 'appended events are parsed');
  } finally {
    tailer.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
