#!/usr/bin/env node
// Browser store boundary regression tests without Chrome/network or modifying source fixtures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/web/package.json'));
const ts = require('typescript');
const cache = new Map();
function loadTs(file) {
  file = resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const localRequire = (name) => name.startsWith('.') ? loadTs(resolve(dirname(file), `${name}.ts`)) : require(name);
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}
const { FleetStore } = loadTs(join(root, 'apps/web/src/state/store.ts'));
const { sameJson } = loadTs(join(root, 'apps/web/src/state/reconcile.ts'));
const { EMPTY_SNAPSHOT, EMPTY_SYSTEM } = loadTs(join(root, 'apps/web/src/state/types.ts'));
const checks = [];
function check(name, fn) { fn(); checks.push(name); console.log('PASS', name); }
async function checkAsync(name, fn) { await fn(); checks.push(name); console.log('PASS', name); }
const session = (id, output = 1) => ({ id, title: id, source: 'dsh', sourceLabel: 'DSH', tokens: { input: 2, output, cacheRead: 0, cacheWrite: 0 }, todos: [{ text: 'test', done: false }] });
const base = { ...EMPTY_SNAPSHOT, type: 'fleet', generatedAt: Date.now(), sessions: [session('a'), session('b')], sectors: [{ id:'s', name:'sector', path:'C:/work', source:'dsh', sessionIds:['a','b'], liveCount:0 }], sources: [{ id:'dsh',label:'DSH',state:'detected',sessions:2,live:0,lastActivityAt:0,detail:'local' }] };
const clone = (data) => structuredClone(data);
const store = new FleetStore();
const flushPromises = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
check('JSON equality is value-based and key-order independent', () => {
  assert(sameJson({ a: [1, null, { b: false }] }, { a: [1, null, { b: false }] }));
  assert(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 }));
  assert(!sameJson({ a: undefined }, { b: undefined }));
  assert(!sameJson([1], { 0: 1 }));
});
store.applyFleet(clone(base));
const original = store.getSnapshot();
check('identical full fleet preserves arrays, sessions, sectors, and sources', () => {
  store.applyFleet({ ...clone(base), generatedAt: Date.now() + 1 });
  const next = store.getSnapshot();
  assert.equal(next.sessions, original.sessions); assert.equal(next.sessions[0], original.sessions[0]);
  assert.equal(next.sectors, original.sectors); assert.equal(next.sources, original.sources);
});
check('single changed full session does not invalidate its siblings', () => {
  const next = clone(base); next.sessions[0].tokens.output = 8; store.applyFleet(next);
  assert.notEqual(store.getSession('a'), original.sessions[0]); assert.equal(store.getSession('b'), original.sessions[1]);
});
check('delta merges/creates/removes by id and preserves untouched references', () => {
  const keep = store.getSession('a');
  store.applyDelta({ type:'delta',at:Date.now(), sessions:[session('c',10)],removed:['b'], sources:[{...base.sources[0],sessions:2,live:1,lastActivityAt:123}],sectors:[{...base.sectors[0],sessionIds:['a','c'],liveCount:1}] });
  assert.equal(store.getSession('a'), keep); assert.equal(store.getSession('b'), null); assert.equal(store.getSession('c').tokens.output,10);
  assert.deepEqual(store.getSessions().map(s=>s.id), ['a','c']); assert.equal(store.getSnapshot().sources[0].live,1);
  assert.deepEqual(store.getSectors()[0].sessionIds,['a','c']);
});
check('unchanged delta is not a session array invalidation', () => {
  const sessions = store.getSessions(); store.applyDelta({type:'delta',at:Date.now(),sessions:[clone(store.getSession('a'))],removed:[]});
  assert.equal(store.getSessions(),sessions);
});
check('tick is compatible with deltas; repeated event ids deliver once', () => {
  const delivered=[]; const off = store.onEvents(events=>delivered.push(...events));
  const event = { id:'evt',at:Date.now(),kind:'tool/call',source:'dsh',sessionId:'a' };
  store.applyTick({type:'tick',at:event.at,events:[event],sessions:[session('a',12)]});
  store.applyTick({type:'tick',at:event.at,events:[clone(event)],sessions:[session('a',12)]});
  assert.equal(store.getSession('a').tokens.output,12); assert.equal(delivered.length,1); assert.equal(store.getEvents().length,1); off();
});
check('full snapshot resync authoritatively removes disappeared sessions', () => {
  store.applyFleet({ ...clone(base), sessions:[session('b',22)] });
  assert.equal(store.getSession('a'),null); assert.equal(store.getSession('c'),null); assert.equal(store.getSession('b').tokens.output,22);
});
check('duplicate/updated sample timestamps never duplicate system history', () => {
  const sys = { ...clone(EMPTY_SYSTEM), at:100, available:true };
  let calls=0; const off=store.onSystem(()=>calls++);
  store.applySystem(sys); store.applySystem(clone(sys));
  assert.equal(calls,1); assert.equal(store.getSystemHistory().length,1);
  store.applySystem({...clone(sys),cpu:{usage:.5,perCore:[.5]}});
  assert.equal(store.getSystemHistory().length,1); assert.equal(store.getSystemHistory()[0].cpu.usage,.5);
  store.applySystem({...clone(sys),at:90}); store.applySystem({...clone(sys),at:110});
  assert.deepEqual(store.getSystemHistory().map(s=>s.at),[90,100,110]); off();
});
await checkAsync('an in-flight REST fallback cannot overwrite a newer SSE reconnect snapshot', async () => {
  const originalES = globalThis.EventSource;
  const originalFetch = globalThis.fetch;
  const instances = [];
  let resolveFleet;
  globalThis.EventSource = class {
    constructor(url) { this.url = url; this.listeners = new Map(); instances.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    close() { this.closed = true; }
    dispatch(name, data) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  };
  globalThis.fetch = () => new Promise((resolve) => { resolveFleet = resolve; });
  const raced = new FleetStore('/api/stream');
  try {
    raced.connect();
    instances[0].onerror();
    assert.equal(typeof resolveFleet, 'function', 'fallback request has started');
    raced.openStream();
    const newer = { ...clone(base), generatedAt: 200, sessions: [session('newer')] };
    instances[1].dispatch('fleet', newer);
    instances[0].dispatch('delta', { type: 'delta', at: 300, sessions: [session('orphan')] });
    instances[0].onerror();
    assert.deepEqual(raced.getSessions().map((item) => item.id), ['newer']);
    assert.equal(instances[1].closed, undefined, 'a stale source cannot close its replacement');
    assert.equal(raced.getConnection(), 'live');
    resolveFleet({ ok: true, json: async () => ({ ...clone(base), generatedAt: 100, sessions: [session('stale')] }) });
    await flushPromises();
    assert.deepEqual(raced.getSessions().map((item) => item.id), ['newer']);
    assert.equal(raced.getSession('stale'), null);
  } finally {
    raced.dispose();
    globalThis.EventSource = originalES;
    globalThis.fetch = originalFetch;
  }
});
check('stream explicitly opts into delta while retaining legacy event handlers', () => {
  const originalES = globalThis.EventSource; let url; const handlers = new Set();
  globalThis.EventSource = class { constructor(value) { url=value; } addEventListener(name) { handlers.add(name); } close() {} };
  const demo = new FleetStore('/api/stream?other=1',{demo:true}); demo.connect();
  assert(url.includes('other=1&delta=1&demo=1')); for(const name of ['fleet','delta','tick','system'])assert(handlers.has(name));
  demo.dispose(); globalThis.EventSource=originalES;
});
store.dispose();
console.log(`\n${checks.length}/${checks.length} store regression checks passed`);
