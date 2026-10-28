#!/usr/bin/env node
/**
 * 璇玑 v2.8 验收器：显存/GPU 接入 + 智能体星体「新鲜度」尺寸。
 *
 * 用法：
 *   node tools/qa-v28.mjs                                 # 打 8787（生产 dist + 真实 nvidia-smi）
 *   node tools/qa-v28.mjs --url http://127.0.0.1:5173     # 打 dev（vite proxy + mock）
 *
 * 设计权威：docs/DESIGN-BIBLE.md §27（v2.8）。
 * 依赖：apps/web devDeps 里的 playwright-core + 系统 Chrome。
 * 输出：docs/qa/v28-<stamp>/report.json + 截图；退出码 0=全 PASS，1=有失败。
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
const OUT = join(ROOT, 'docs', 'qa', `v28-${STAMP}`);
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
async function goto(query = '') {
  await page.goto(`${BASE}/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
}
async function shot(name) {
  const file = join(OUT, name);
  await page.screenshot({ path: file });
  shots.push(file);
  log(`  shot ${name}`);
}

const system = () =>
  page.evaluate(() => {
    const s = window.__astra?.getSystem?.();
    return s ? JSON.parse(JSON.stringify(s)) : null;
  });
const freshness = () =>
  page.evaluate(() => {
    const s = window.__astra?.scene;
    return s && typeof s.debugStarFreshness === 'function' ? s.debugStarFreshness() : null;
  });
const bodyText = () => page.evaluate(() => document.body.innerText || '');

try {
  // ── 1. GPU 数据接口（真实 nvidia-smi） ─────────────────────────────
  log('\n== gpu api ==');
  await goto('?boot=0');
  const sys1 = await system();
  const gpu = sys1?.gpu ?? null;
  if (!gpu) {
    // 没有 NVIDIA 工具时允许 null，但必须能在 HUD 上体现「不可用」
    ok('gpu.api', { gpu: null, note: '本机无 GPU 数据源，后续项按不可用路径校验' });
  } else {
    const fieldsOk =
      typeof gpu.name === 'string' &&
      gpu.name.length > 0 &&
      Number(gpu.memTotalBytes) > 0 &&
      Number(gpu.memUsedBytes) >= 0 &&
      Number(gpu.memPct) >= 0 &&
      Number(gpu.memPct) <= 1 &&
      Number(gpu.utilPct) >= 0 &&
      Number(gpu.utilPct) <= 1 &&
      Number(gpu.tempC) > 0;
    if (fieldsOk) ok('gpu.api', { name: gpu.name, memPct: gpu.memPct, utilPct: gpu.utilPct, tempC: gpu.tempC });
    else fail('gpu.api', { gpu });
  }
  const hist = await page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/system/history?limit=20`, { cache: 'no-store' });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    const arr = Array.isArray(j) ? j : Array.isArray(j.history) ? j.history : null;
    return { ok: !!arr, n: arr ? arr.length : 0, first: arr && arr[0] ? { hasCpu: !!arr[0].cpu, hasGpu: 'gpu' in arr[0] } : null };
  }, BASE);
  if (hist.ok && hist.n > 0) ok('gpu.history', { n: hist.n, first: hist.first });
  else fail('gpu.history', hist);

  // ── 2. 智能体星体新鲜度 ───────────────────────────────────────────
  log('\n== stars freshness ==');
  const fresh = await freshness();
  if (!fresh) fail('stars.freshness', { note: 'debugStarFreshness 未实现' });
  else {
    const pass = fresh.ratio >= 1.25 && fresh.maxStepRatio <= 0.03 && fresh.stars > 100;
    if (pass) ok('stars.freshness', fresh);
    else fail('stars.freshness', fresh);
  }
  await shot('agents-freshness.png');

  // ── 3. 整机《机枢》显存/GPU 两行 ──────────────────────────────────
  log('\n== hud system gpu ==');
  await goto('?boot=0&view=system');
  const hasPanel = await page.evaluate(() => !!document.querySelector('[data-hud="system-panel"]'));
  const gpuBox = await page.evaluate(() => {
    const el = document.querySelector('[data-hud="system-gpu"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: (el.innerText || '').replace(/\s+/g, ' ').trim(), w: Math.round(r.width), h: Math.round(r.height) };
  });
  if (hasPanel && gpuBox && gpuBox.w > 0 && gpuBox.h > 0 && /显存/.test(gpuBox.text) && /GPU/.test(gpuBox.text)) {
    ok('hud.systemGpu', gpuBox);
  } else fail('hud.systemGpu', { hasPanel, gpuBox });
  const topText = await bodyText();
  if (/显存/.test(topText)) ok('hud.systemTopbar', { hasXiancun: true });
  else fail('hud.systemTopbar');
  await shot('system-gpu.png');

  // ── 4. 百工顶栏 + 《器牒》总览显存 ────────────────────────────────
  log('\n== hud processes gpu ==');
  await goto('?boot=0&view=processes');
  const prow = await page.evaluate(() => {
    const el = document.querySelector('[data-hud="process-detail"]');
    if (!el) return null;
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const tb = document.querySelector('.tb') || document.body;
    return { detail: t.slice(0, 400), hasXiancun: /显存/.test(t), topbar: (tb.innerText || '').replace(/\s+/g, ' ').trim() };
  });
  if (prow && prow.hasXiancun && /显存/.test(prow.topbar)) ok('hud.procGpu', { hasDetail: true, hasTopbar: true, sample: prow.detail.slice(0, 120) });
  else fail('hud.procGpu', prow);
  await shot('processes-gpu.png');

  // ── 5. 性能 ──────────────────────────────────────────────────────
  log('\n== perf ==');
  const perf = await page.evaluate(async () => {
    const times = [];
    let last = performance.now();
    await new Promise((res) => {
      let n = 0;
      const step = (now) => {
        times.push(now - last);
        last = now;
        if (++n >= 90) return res();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const arr = times.slice(3).sort((a, b) => a - b);
    const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
    const p95 = arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))];
    return { frames: arr.length, avgMs: +avg.toFixed(2), p95Ms: +p95.toFixed(2) };
  });
  const sceneMs = await page.evaluate(() => window.__astra?.scene?.debugProcesses?.()?.sceneMs ?? null);
  if (perf.avgMs <= 42 && (sceneMs == null || sceneMs <= 9)) ok('perf.scene', { ...perf, sceneMs });
  else fail('perf.scene', { ...perf, sceneMs });
  await shot('processes-perf.png');

  // ── 6. 移动端 ────────────────────────────────────────────────────
  log('\n== mobile ==');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  const mob = await page.evaluate(() => ({
    view: window.__astra?.view,
    hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    hasList: !!document.querySelector('[data-hud="process-list"]'),
  }));
  const mshot = join(OUT, 'mobile-processes.png');
  await page.screenshot({ path: mshot });
  shots.push(mshot);
  if (mob.hscroll <= 1 && mob.hasList) ok('mobile.layout', mob);
  else fail('mobile.layout', mob);

  // ── 7. 错误 ──────────────────────────────────────────────────────
  log('\n== errors ==');
  const errPayload = { console: consoleErrors, page: pageErrors, failed: failedRequests };
  if (!consoleErrors.length && !pageErrors.length && !failedRequests.length) ok('errors.clean', { n: 0 });
  else fail('errors.clean', errPayload);
} catch (e) {
  fail('fatal', { message: String(e && e.stack ? e.stack : e) });
} finally {
  const passed = Object.values(checks).filter((c) => c.pass).length;
  const failed = Object.values(checks).filter((c) => !c.pass).length;
  const report = {
    url: BASE,
    stamp: STAMP,
    checks,
    shots,
    console: consoleErrors,
    pageErrors,
    failedRequests,
    summary: { passed, failed, total: passed + failed },
  };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  （${passed} 项）`);
  log(`report: ${join(OUT, 'report.json')}`);
  await browser.close();
  process.exit(failed === 0 ? 0 : 1);
}
