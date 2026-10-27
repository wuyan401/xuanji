#!/usr/bin/env node
/**
 * 璇玑 v2.4 验收器：工作光流（连接/持续/断开） · 工具光束改从流上发射 · 主题光束配色 · 深空外圈旋转随势
 *
 * 用法：
 *   node tools/qa-v24.mjs                                 # 打 8787（生产 dist）
 *   node tools/qa-v24.mjs --url http://127.0.0.1:5173     # 打 dev（vite proxy）
 *
 * 依赖：apps/web devDeps 里的 playwright-core + 系统 Chrome。
 * 输出：docs/qa/v24-<stamp>/report.json + 截图；退出码 0=全 PASS，1=有失败。
 */
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromWeb = createRequire(join(ROOT, 'apps', 'web', 'package.json'));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const BASE = (arg('url', 'http://127.0.0.1:8787')).replace(/\/$/, '');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const OUT = join(ROOT, 'docs', 'qa', `v24-${STAMP}`);
mkdirSync(OUT, { recursive: true });

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
function findChrome() {
  const fs = requireFromWeb('node:fs');
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome/Edge，可用 CHROME_PATH 指定');
}

const checks = {};
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const shots = [];
const t0 = Date.now();
const log = (line) => process.stdout.write(line + '\n');
function ok(name, detail) {
  checks[name] = { pass: true, ...(detail || {}) };
  log(`  PASS ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`);
}
function fail(name, detail) {
  checks[name] = { pass: false, ...(detail || {}) };
  log(`  FAIL ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`);
}

const { chromium } = requireFromWeb('playwright-core');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || findChrome(), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  if (/ERR_ABORTED|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|favicon/i.test(text)) return;
  consoleErrors.push(text);
});
page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
page.on('requestfailed', (r) => {
  const url = r.url();
  const err = r.failure()?.errorText || '';
  if (/ERR_ABORTED|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|favicon/i.test(err + url)) return;
  failedRequests.push({ url, error: err });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dbgStreams() {
  return page.evaluate(() => {
    const s = window.__astra && window.__astra.scene;
    return s && typeof s.debugStreams === 'function' ? s.debugStreams() : null;
  });
}
/** 等某个 streams 条件成立，最多 timeoutMs，返回最后一次快照 */
async function waitStreams(pred, timeoutMs = 1600, step = 120) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    last = await dbgStreams();
    if (last && pred(last)) return last;
    await sleep(step);
  }
  return last;
}
function hueOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
/** 取当前快照并把若干会话临时置为 live / idle，用于确定性触发 connect/disconnect */
async function setSyntheticLive(count) {
  return page.evaluate((n) => {
    const store = window.__astra && window.__astra.store;
    const scene = window.__astra && window.__astra.scene;
    if (!store || !scene) return null;
    const snap = store.getSnapshot();
    if (!snap || !Array.isArray(snap.sessions)) return null;
    const now = Date.now();
    const candidates = snap.sessions
      .filter((s) => s.state !== 'live')
      .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
      .slice(0, n);
    if (candidates.length === 0) return { ids: [], before: {} };
    const before = {};
    const sessions = snap.sessions.map((s) => {
      if (candidates.some((c) => c.id === s.id)) {
        before[s.id] = s.state;
        return { ...s, state: 'live', lastActivityAt: now, openStep: s.openStep || { turn: 1, step: 1, startedAt: now, firstTokenAt: now } };
      }
      return s;
    });
    scene.setFleet({ ...snap, generatedAt: now, sessions });
    return { ids: candidates.map((c) => c.id), before };
  }, count);
}
async function setSyntheticState(state) {
  return page.evaluate((nextState) => {
    const store = window.__astra && window.__astra.store;
    const scene = window.__astra && window.__astra.scene;
    if (!store || !scene) return null;
    const snap = store.getSnapshot();
    if (!snap || !Array.isArray(snap.sessions)) return null;
    const now = Date.now();
    const sessions = snap.sessions.map((s) => (s.state === 'live' ? { ...s, state: nextState, lastActivityAt: now } : s));
    scene.setFleet({ ...snap, generatedAt: now, sessions });
    return sessions.filter((s) => s.state === nextState).length;
  }, state);
}
async function pushLiveEvents(sessionIds) {
  return page.evaluate((ids) => {
    const store = window.__astra && window.__astra.store;
    const scene = window.__astra && window.__astra.scene;
    if (!store || !scene || !ids || ids.length === 0) return 0;
    const snap = store.getSnapshot();
    const byId = new Map((snap?.sessions || []).map((s) => [s.id, s]));
    const now = Date.now();
    const events = ids.map((id, i) => {
      const s = byId.get(id);
      return {
        id: `qa-v24-live-${now}-${i}`,
        at: now + i,
        kind: 'session/live',
        sessionId: id,
        sessionTitle: s?.title || id,
        tool: null,
        toolCategory: null,
        detail: null,
        isError: false,
        turn: null,
        step: null,
        durationMs: null,
      };
    });
    scene.pushEvents(events);
    return events.length;
  }, sessionIds);
}
async function pushToolEvent(cat) {
  return page.evaluate((toolCategory) => {
    const store = window.__astra && window.__astra.store;
    const scene = window.__astra && window.__astra.scene;
    if (!store || !scene) return null;
    const snap = store.getSnapshot();
    if (!snap || !Array.isArray(snap.sessions)) return null;
    const live = snap.sessions.filter((s) => s.state === 'live');
    const star = live[0] || snap.sessions[0];
    if (!star) return null;
    const now = Date.now();
    const ev = {
      id: `qa-v24-${now}`,
      at: now,
      kind: 'tool/call',
      sessionId: star.id,
      sessionTitle: star.title || star.id,
      tool: 'QA 探针',
      toolCategory,
      detail: 'qa-v24 synthetic tool call',
      isError: false,
      turn: 1,
      step: 1,
      durationMs: null,
    };
    scene.pushEvents([ev]);
    return ev.id;
  }, cat);
}
async function pushEventBurst(cat, n) {
  return page.evaluate(
    ({ toolCategory, count }) => {
      const store = window.__astra && window.__astra.store;
      const scene = window.__astra && window.__astra.scene;
      if (!store || !scene) return null;
      const snap = store.getSnapshot();
      if (!snap || !Array.isArray(snap.sessions)) return null;
      const live = snap.sessions.filter((s) => s.state === 'live');
      const star = live[0] || snap.sessions[0];
      if (!star) return null;
      const now = Date.now();
      const events = [];
      for (let i = 0; i < count; i += 1) {
        events.push({
          id: `qa-v24-burst-${now}-${i}`,
          at: now + i,
          kind: 'tool/call',
          sessionId: star.id,
          sessionTitle: star.title || star.id,
          tool: 'QA 探针',
          toolCategory,
          detail: 'qa-v24 burst',
          isError: false,
          turn: 1,
          step: 1 + i,
          durationMs: null,
        });
      }
      scene.pushEvents(events);
      return events.length;
    },
    { toolCategory: cat, count: n },
  );
}
async function snap(name) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
}

log(`== XUANJI QA v2.4  (${BASE}) ==`);
await page.goto(`${BASE}/?boot=0`, { waitUntil: 'domcontentloaded' });
await sleep(2600);

// ---------- 1. streams：可用 + 持续发流 ----------
let s0 = await dbgStreams();
if (!s0) {
  fail('streams.available', { reason: 'window.__astra.scene.debugStreams() 不存在' });
} else {
  ok('streams.available');
  // 真实数据里 live 数可能为 0~2，直接用真实 live 判定；若为 0 用合成 live
  if (!(s0.active >= 1)) {
    await setSyntheticLive(3);
    s0 = await waitStreams((s) => s.active >= 1 || s.connecting >= 1, 1600);
  }
  if (s0 && s0.active >= 1) ok('streams.active', { active: s0.active, connecting: s0.connecting, packets: s0.packets });
  else fail('streams.active', s0 || null);

  // 2s 采样：粒子总数与出现频次（「不是很久才有一道」）
  let samples = 0;
  let withPackets = 0;
  let packetSum = 0;
  let activeSum = 0;
  for (let i = 0; i < 10; i += 1) {
    const s = await dbgStreams();
    if (s) {
      samples += 1;
      packetSum += s.packets || 0;
      activeSum += s.active || 0;
      if ((s.packets || 0) > 0) withPackets += 1;
    }
    await sleep(200);
  }
  const avgActive = samples ? activeSum / samples : 0;
  const perStream = avgActive > 0 ? packetSum / samples / avgActive : 0;
  if (packetSum > 0 && withPackets >= Math.ceil(samples * 0.5) && perStream >= 2) {
    ok('streams.packets', { samples, withPackets, packetSum, perStream: Number(perStream.toFixed(2)) });
  } else {
    fail('streams.packets', { samples, withPackets, packetSum, perStream: Number(perStream.toFixed(2)) });
  }
  await snap('streams-agents');

  // ---------- 3. connect / disconnect ----------
  const liveReq = await setSyntheticLive(3);
  const liveIds = liveReq?.ids || [];
  await pushLiveEvents(liveIds);
  const conn = await waitStreams((s) => s.connecting >= 1, 1200, 40);
  if (conn && conn.connecting >= 1) ok('streams.connect', { connecting: conn.connecting, active: conn.active, seeded: liveIds.length });
  else fail('streams.connect', { ...(conn || {}), seeded: liveIds.length });

  await sleep(420); // 让 connect 进入 stream
  const activeBefore = (await dbgStreams())?.active || 0;
  await setSyntheticState('idle');
  const disc = await waitStreams((s) => s.disconnecting >= 1, 1200);
  if (disc && disc.disconnecting >= 1) ok('streams.disconnect', { disconnecting: disc.disconnecting, activeBefore });
  else fail('streams.disconnect', disc || null);
  // 800ms 后 connect/disconnect 归零（流本身可继续存在，但过渡动画应结束）
  await sleep(900);
  const settled = await dbgStreams();
  if (settled && (settled.connecting || 0) <= 1 && (settled.disconnecting || 0) <= 1) {
    ok('streams.settle', { connecting: settled.connecting, disconnecting: settled.disconnecting });
  } else {
    fail('streams.settle', settled || null);
  }

  // ---------- 4. 工具光束从流上发射 ----------
  await setSyntheticLive(2);
  await sleep(300);
  await pushToolEvent('read');
  const beams = await waitStreams((s) => (s.toolBeams || 0) > 0, 900, 80);
  if (beams && beams.toolBeams > 0 && beams.toolBeamsFromStream > 0) {
    ok('streams.toolBeam', { toolBeams: beams.toolBeams, fromStream: beams.toolBeamsFromStream });
  } else {
    fail('streams.toolBeam', beams || null);
  }
}

// ---------- 5. 主题光束配色 ----------
const xuanjiBeam = (await dbgStreams())?.beamColor || null;
const xuanjiHue = hueOf(xuanjiBeam);
if (xuanjiHue != null && xuanjiHue >= 15 && xuanjiHue <= 65) ok('theme.beamColorXuanji', { beamColor: xuanjiBeam, hue: Number(xuanjiHue.toFixed(1)) });
else fail('theme.beamColorXuanji', { beamColor: xuanjiBeam, hue: xuanjiHue });

await page.evaluate(() => window.__astra && window.__astra.setTheme && window.__astra.setTheme('scifi'));
await sleep(700);
await snap('streams-scifi');
const scifiBeam = (await dbgStreams())?.beamColor || null;
const scifiHue = hueOf(scifiBeam);
if (scifiHue != null && scifiHue >= 150 && scifiHue <= 230) ok('theme.beamColorScifi', { beamColor: scifiBeam, hue: Number(scifiHue.toFixed(1)) });
else fail('theme.beamColorScifi', { beamColor: scifiBeam, hue: scifiHue });

// 暖色像素占比（深空下不应再出现成片暖金）
const warm = await page.evaluate(() => {
  const cv = document.querySelector('#stage canvas');
  if (!cv) return null;
  const w = 96;
  const h = 54;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(cv, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let warm = 0;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum > 24) lit += 1;
    if (r > 120 && r > g * 1.12 && r > b * 1.35) warm += 1;
  }
  return { warm, lit, ratio: lit ? warm / lit : 0 };
});
if (warm && warm.ratio < 0.03) ok('theme.warmRatioScifi', { ratio: Number(warm.ratio.toFixed(4)), warm: warm.warm, lit: warm.lit });
else fail('theme.warmRatioScifi', warm || null);

// ---------- 6. 深空外圈旋转随势 ----------
const baseS = await waitStreams((s) => typeof s.ringSpeed === 'number' && s.ringSpeed > 0, 1600);
const baseRing = baseS?.ringSpeedBase ?? null;
await sleep(900);
const quietRing = (await dbgStreams())?.ringSpeed ?? null;
await setSyntheticLive(3);
await pushEventBurst('read', 12);
await pushEventBurst('exec', 8);
const fast = await waitStreams((s) => baseRing != null && s.ringSpeed >= baseRing * 1.1, 1600, 100);
if (fast && baseRing != null && fast.ringSpeed >= baseRing * 1.1) {
  ok('ringSpeed.scifiBoost', { base: Number(baseRing.toFixed(3)), quiet: quietRing, fast: Number(fast.ringSpeed.toFixed(3)), ratio: Number((fast.ringSpeed / baseRing).toFixed(3)) });
} else {
  fail('ringSpeed.scifiBoost', { base: baseRing, quiet: quietRing, fast: fast && fast.ringSpeed });
}
await sleep(4200);
const back = (await dbgStreams())?.ringSpeed ?? null;
if (back != null && baseRing != null && back <= baseRing * 1.3) ok('ringSpeed.scifiSettle', { base: Number(baseRing.toFixed(3)), back: Number(back.toFixed(3)) });
else fail('ringSpeed.scifiSettle', { base: baseRing, back });

// ---------- 7. 性能 / 错误 ----------
const perf = await dbgStreams();
if (perf && typeof perf.sceneMs === 'number' && perf.sceneMs <= 8) ok('perf.sceneMs', { sceneMs: Number(perf.sceneMs.toFixed(2)) });
else fail('perf.sceneMs', perf && { sceneMs: perf.sceneMs });

if (consoleErrors.length === 0) ok('errors.console');
else fail('errors.console', { list: consoleErrors.slice(0, 5) });
if (pageErrors.length === 0) ok('errors.page');
else fail('errors.page', { list: pageErrors.slice(0, 5) });
if (failedRequests.length === 0) ok('errors.requests');
else fail('errors.requests', { list: failedRequests.slice(0, 5) });

// 回到璇玑主题，方便交付截图默认态
await page.evaluate(() => window.__astra && window.__astra.setTheme && window.__astra.setTheme('xuanji'));
await sleep(500);

const passed = Object.values(checks).filter((c) => c.pass).length;
const total = Object.keys(checks).length;
const report = {
  url: BASE,
  stamp: STAMP,
  checks,
  console: consoleErrors,
  pageErrors,
  failedRequests,
  shots,
  passed,
  total,
  elapsedMs: Date.now() - t0,
};
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
log(`\n== ${passed === total ? 'ALL PASS' : 'FAILED'} (${passed}/${total}) ==`);
log(`report: ${join(OUT, 'report.json')}`);

await browser.close();
process.exit(passed === total ? 0 : 1);
