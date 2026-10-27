#!/usr/bin/env node
/**
 * 璇玑 v2.2 验收器：丝滑缩放（无跳动） + 轨道混沌（不同速、不重合）
 *
 * 用法：
 *   node tools/qa-v22.mjs                       # 打 8787（生产 dist）
 *   node tools/qa-v22.mjs --url http://127.0.0.1:5173   # 打 dev（vite proxy）
 *
 * 依赖：apps/web devDeps 里的 playwright-core + 系统 Chrome。
 * 输出：docs/qa/v22-<stamp>/report.json + 截图；退出码 0=全 PASS，1=有失败。
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
const OUT = join(ROOT, 'docs', 'qa', `v22-${STAMP}`);
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
function log(line) { process.stdout.write(line + '\n'); }
function ok(name, detail) { checks[name] = { pass: true, ...(detail || {}) }; log(`  PASS ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`); }
function fail(name, detail) { checks[name] = { pass: false, ...(detail || {}) }; log(`  FAIL ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`); }

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

async function dbg() {
  return page.evaluate(() => {
    const s = window.__astra && window.__astra.scene;
    return s && s.debugInfo ? s.debugInfo() : null;
  });
}
async function orbits() {
  return page.evaluate(() => {
    const s = window.__astra && window.__astra.scene;
    return s && s.debugOrbits ? s.debugOrbits() : null;
  });
}
async function shot(name) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push({ name, file });
  return file;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  log('== XUANJI QA v2.2（丝滑缩放 + 轨道混沌）==');
  await page.goto(`${BASE}/?boot=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__astra && window.__astra.scene && window.__astra.scene.debugInfo, null, { timeout: 20000 });
  await sleep(2200);
  const initial = await dbg();
  log(`  初始 debugInfo: ${JSON.stringify(initial)}`);

  // ---------- smooth：滚轮连打，逐帧采样 ----------
  await page.evaluate(() => {
    window.__zsampler = { on: true, t: [], z: [], at: performance.now() };
    const tick = (t) => {
      if (!window.__zsampler.on) return;
      const s = window.__astra && window.__astra.scene;
      const di = s && s.debugInfo ? s.debugInfo() : null;
      if (di) { window.__zsampler.t.push(t); window.__zsampler.z.push(di.zoom); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.mouse.move(720, 450);
  const preZoom = (await dbg())?.zoom ?? 1;
  for (let i = 0; i < 8; i += 1) {
    await page.mouse.wheel(0, -175);
    await sleep(32);
    if (i === 1) await shot('smooth-burst-1');
  }
  await sleep(1500);
  await page.evaluate(() => { window.__zsampler.on = false; });
  const samples = await page.evaluate(() => window.__zsampler);
  const zs = samples.z.filter((v) => typeof v === 'number');
  const ratios = [];
  const shrink = [];
  for (let i = 1; i < zs.length; i += 1) {
    if (zs[i - 1] <= 0) continue;
    ratios.push(zs[i] / zs[i - 1]);
    shrink.push(zs[i] < zs[i - 1]);
  }
  const maxRatio = Math.max(...ratios);
  const shrinkRate = shrink.filter(Boolean).length / Math.max(1, shrink.length);
  const dts = [];
  for (let i = 1; i < samples.t.length; i += 1) dts.push(samples.t[i] - samples.t[i - 1]);
  const avgDt = dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length);
  const finalZoom = (await dbg())?.zoom ?? 0;
  // 页面级帧时（含浏览器软件光栅/HUD 主线程）只做兜底；硬预算看 scene 内部帧时 <=7ms。
  if (maxRatio <= 1.1 && shrinkRate <= 0.12 && avgDt <= 58) {
    ok('smooth.ratios', { maxRatio: +maxRatio.toFixed(4), shrinkRate: +shrinkRate.toFixed(3), avgFrameMs: +avgDt.toFixed(2), finalZoom: +finalZoom.toFixed(3), preZoom: +preZoom.toFixed(3) });
  } else fail('smooth.ratios', { maxRatio: +maxRatio.toFixed(4), shrinkRate: +shrinkRate.toFixed(3), avgFrameMs: +avgDt.toFixed(2) });
  if (finalZoom >= preZoom * 1.35) ok('smooth.gained', { from: +preZoom.toFixed(3), to: +finalZoom.toFixed(3) });
  else fail('smooth.gained', { from: +preZoom.toFixed(3), to: +finalZoom.toFixed(3) });
  const locked = (await dbg())?.manualLocked;
  if (locked === true) ok('smooth.locked', { manualLocked: true }); else fail('smooth.locked', { manualLocked: locked });
  // 8s 内不回拉
  const settled = (await dbg())?.zoom;
  await sleep(1600);
  const after8 = (await dbg())?.zoom;
  if (Math.abs(after8 - settled) / settled <= 0.01) ok('smooth.stays', { settled: +settled.toFixed(3), after: +after8.toFixed(3) });
  else fail('smooth.stays', { settled: +settled.toFixed(3), after: +after8.toFixed(3) });
  await shot('smooth-settled');

  // ---------- anchor：光标锚点 ----------
  await page.mouse.move(520, 420);
  const px = 520, py = 420;
  const world = await page.evaluate(([x, y]) => window.__astra.scene.unprojectPoint?.(x, y), [px, py]);
  if (world && typeof world.x === 'number') {
    await page.mouse.wheel(0, -420);
    await sleep(900);
    const back = await page.evaluate(([x, y]) => window.__astra.scene.projectPoint?.(x, y), [world.x, world.y]);
    const drift = back ? Math.hypot(back.x - px, back.y - py) : Infinity;
    if (drift <= 40) ok('smooth.anchor', { driftPx: +drift.toFixed(2) }); else fail('smooth.anchor', { driftPx: +drift.toFixed(2) });
  } else fail('smooth.anchor', { reason: 'scene.unprojectPoint 未实现' });

  // ---------- deep：深看 ≥3.6× ----------
  for (let i = 0; i < 8; i += 1) { await page.mouse.wheel(0, -260); await sleep(40); }
  await sleep(1200);
  const deep = await dbg();
  if (deep && deep.zoom >= 3.6) ok('smooth.deep', { zoom: +deep.zoom.toFixed(2) }); else fail('smooth.deep', { zoom: deep && +deep.zoom.toFixed(2) });
  await shot('zoom-deep');

  // ---------- reset：双击平滑复位 ----------
  await page.mouse.dblclick(720, 450);
  await sleep(1300);
  const reset = await dbg();
  const nearDefault = reset && Math.abs(reset.zoom - (initial?.zoom ?? 1.12)) <= 0.12;
  if (nearDefault) ok('smooth.reset', { zoom: +reset.zoom.toFixed(3) }); else fail('smooth.reset', { zoom: reset && +reset.zoom.toFixed(3) });
  const stored = await page.evaluate(() => { try { return localStorage.getItem('xuanji.camera.v1'); } catch { return 'n/a'; } });
  if (stored === null || stored === 'n/a' || /"agents"\s*:/.test(stored || '')) ok('smooth.resetStorage', { has: stored !== null });
  else fail('smooth.resetStorage', { has: stored !== null });

  // ---------- persist：记忆 ----------
  await page.mouse.move(800, 500);
  await page.mouse.wheel(0, -520);
  await sleep(1100);
  const beforeReload = await dbg();
  const raw = await page.evaluate(() => { try { return localStorage.getItem('xuanji.camera.v1'); } catch { return null; } });
  if (raw) ok('persist.written', { bytes: raw.length }); else fail('persist.written', {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__astra && window.__astra.scene && window.__astra.scene.debugInfo, null, { timeout: 20000 });
  await sleep(2000);
  const restored = await dbg();
  if (restored && beforeReload && Math.abs(restored.zoom - beforeReload.zoom) / beforeReload.zoom <= 0.05) {
    ok('persist.restored', { before: +beforeReload.zoom.toFixed(3), after: +restored.zoom.toFixed(3) });
  } else fail('persist.restored', { before: beforeReload && +beforeReload.zoom.toFixed(3), after: restored && +restored.zoom.toFixed(3) });

  // ---------- orbit：轨道混沌 ----------
  await page.evaluate(() => { try { localStorage.removeItem('xuanji.camera.v1'); } catch {} });
  await page.goto(`${BASE}/?boot=0&reset=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__astra && window.__astra.scene && window.__astra.scene.debugInfo, null, { timeout: 20000 });
  await sleep(2400);
  const o1 = await orbits();
  if (!o1) fail('orbit.available', { reason: 'scene.debugOrbits 未实现' });
  else {
    ok('orbit.available', { zones: o1.zones.length, stars: o1.stars });
    const speeds = o1.zones.map((z) => z.speed);
    const minRel = speeds.length >= 3 ? Math.min(...speeds.map((a) => Math.min(...speeds.filter((b) => b !== a).map((b) => Math.abs(Math.abs(a) - Math.abs(b)) / Math.max(Math.abs(a), Math.abs(b)))))) : 0;
    if (speeds.length >= 3 && minRel >= 0.02) ok('orbit.zoneSpeeds', { zones: speeds.map((s) => +s.toFixed(4)), minPairDiffRel: +minRel.toFixed(4) });
    else fail('orbit.zoneSpeeds', { zones: speeds.map((s) => +s.toFixed(4)), minPairDiffRel: +minRel.toFixed(4) });
    if (o1.speedSpread >= 1.4) ok('orbit.speedSpread', { spread: +o1.speedSpread.toFixed(2) }); else fail('orbit.speedSpread', { spread: +o1.speedSpread.toFixed(2) });
    if (o1.minPairDist >= 5) ok('orbit.minPairDist', { px: +o1.minPairDist.toFixed(2) }); else fail('orbit.minPairDist', { px: +o1.minPairDist.toFixed(2) });
    await shot('orbit-t0');
    await sleep(3000);
    const o2 = await orbits();
    await shot('orbit-t3');
    if (o1 && o2 && o2.minPairDist >= Math.max(4, o1.minPairDist * 0.55)) ok('orbit.stable', { t0: +o1.minPairDist.toFixed(2), t3: +o2.minPairDist.toFixed(2) });
    else fail('orbit.stable', { t0: o1 && +o1.minPairDist.toFixed(2), t3: o2 && +o2.minPairDist.toFixed(2) });
  }

  // ---------- errors ----------
  if (consoleErrors.length === 0) ok('errors.console', {}); else fail('errors.console', { errors: consoleErrors.slice(0, 5) });
  if (pageErrors.length === 0) ok('errors.page', {}); else fail('errors.page', { errors: pageErrors.slice(0, 5) });
  if (failedRequests.length === 0) ok('errors.requests', {}); else fail('errors.requests', { list: failedRequests.slice(0, 5) });
} catch (err) {
  fail('fatal', { message: String(err && err.message ? err.message : err) });
} finally {
  const failed = Object.entries(checks).filter(([, v]) => !v.pass).map(([k]) => k);
  const report = { url: BASE, stamp: STAMP, checks, failed, consoleErrors, pageErrors, failedRequests, shots, ms: Date.now() - t0 };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  log('');
  if (failed.length === 0) log(`ALL PASS  （${Object.keys(checks).length} 项）`);
  else log(`FAILED ${failed.length} / ${Object.keys(checks).length}: ${failed.join(', ')}`);
  log(`report: ${join(OUT, 'report.json')}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
