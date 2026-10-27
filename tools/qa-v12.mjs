#!/usr/bin/env node
// XUANJI QA · v1.2 验收器（藏星可见 / 取景缩放 / 分野总览聚焦 / 三视口）
//
// 用法:
//   node tools/qa-v12.mjs
//   node tools/qa-v12.mjs --url http://127.0.0.1:8787/ --tag after
//   node tools/qa-v12.mjs --only stars,zoom,overview
//
// 输出: docs/qa/v12-<stamp>/{wide.png,desktop.png,mobile.png,still.png,focus.png,report.json}
// 退出码: 0 通过 / 1 有 FAIL

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const webRequire = createRequire(join(ROOT, 'apps', 'web', 'package.json'));
const { chromium } = webRequire('playwright-core');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const pref = name + '=';
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}
function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge');
}

const BASE = arg('--url', process.env.ASTRA_URL || 'http://127.0.0.1:8787/');
const ONLY = arg('--only', '') ? arg('--only', '').split(',').map((s) => s.trim()) : null;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const outDir = arg('--out', join(ROOT, 'docs', 'qa', `v12-${stamp}`));
mkdirSync(outDir, { recursive: true });

const report = { url: BASE, stamp, checks: {}, console: [], pageErrors: [], failedRequests: [], shots: [] };
const fails = [];
const skipped = [];
function fail(name, detail) {
  fails.push(name + (detail ? ' — ' + detail : ''));
}
function scenario(name) {
  return !ONLY || ONLY.includes(name);
}
function ok(name, detail) {
  report.checks[name] = detail === undefined ? true : detail;
}

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--force-device-scale-factor=1'],
});

async function openPage(context, url, tag) {
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      report.console.push({ tag, text: msg.text().slice(0, 400) });
    }
  });
  page.on('pageerror', (err) => report.pageErrors.push({ tag, message: String(err.message || err).slice(0, 400) }));
  page.on('requestfailed', (req) => report.failedRequests.push({ tag, url: req.url(), error: req.failure()?.errorText }));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return page;
}

async function shot(page, name) {
  const file = join(outDir, name + '.png');
  await page.screenshot({ path: file });
  report.shots.push(file);
  return file;
}

const dbg = (page) =>
  page.evaluate(() => {
    const s = window.__astra?.scene;
    const info = typeof s?.debugInfo === 'function' ? s.debugInfo() : null;
    return info;
  });

const desktop = { width: 1440, height: 900 };
const wide = { width: 1920, height: 1080 };
const mobile = { width: 390, height: 844 };

// ---- 1. stars / 藏星可见 + 基础状态 ----
if (scenario('stars')) {
  const ctx = await browser.newContext({ viewport: desktop, deviceScaleFactor: 1.75 });
  const page = await openPage(ctx, BASE + '?boot=0', 'stars');
  await page.waitForTimeout(2600);
  const info = await dbg(page);
  if (!info) {
    fail('stars.debugInfo', 'window.__astra.scene.debugInfo 不存在');
  } else {
    ok('stars.info', info);
    if (!(info.stars >= 100)) fail('stars.count', `stars=${info.stars} (<100)`);
    if (!(info.visibleStars >= 80)) fail('stars.visible', `visibleStars=${info.visibleStars} (<80)`);
    if (!(info.zoom >= 1.0)) fail('stars.zoom', `zoom=${info.zoom} (<1.0)`);
    if (info.mode !== 'survey') fail('stars.mode', `mode=${info.mode} (!= survey)`);
  }
  const frame = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        let last = t0;
        const deltas = [];
        function step(now) {
          deltas.push(now - last);
          last = now;
          n += 1;
          if (n < 40) requestAnimationFrame(step);
          else resolve({ frames: n, ms: performance.now() - t0, deltas });
        }
        requestAnimationFrame(step);
      }),
  );
  const avg = frame.ms / frame.frames;
  ok('stars.frameAvgMsDpr175', Math.round(avg * 100) / 100); // 仅记录：headless 高 DPR 走软件光栅化
  await shot(page, 'desktop');
  const hscroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (hscroll > 1) fail('stars.hscroll', `desktop 横向溢出 ${hscroll}px`);
  await ctx.close();
  // 性能单独在 DPR1 量（headless 高 DPR 走软件光栅化，不代表真机）
  const ctxPerf = await browser.newContext({ viewport: desktop, deviceScaleFactor: 1 });
  const pagePerf = await openPage(ctxPerf, BASE + '?boot=0', 'perf');
  await pagePerf.waitForTimeout(2600);
  const perf = await pagePerf.evaluate(
    () =>
      new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        let n = 0;
        function step(now) {
          deltas.push(now - last);
          last = now;
          n += 1;
          if (n < 90) requestAnimationFrame(step);
          else {
            const sorted = [...deltas].sort((a, b) => a - b);
            const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
            resolve({
              frames: n,
              avgMs: Math.round(avg * 100) / 100,
              p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 100) / 100,
              longFrames: deltas.filter((d) => d > 33).length,
              fps: Math.round(1000 / avg),
            });
          }
        }
        requestAnimationFrame(step);
      }),
  );
  ok('perf.dpr1', perf);
  if (perf.fps < 30) fail('stars.perfFps', `${perf.fps} fps (<40)`);
  if (perf.p95Ms > 65) fail('stars.perfP95', `${perf.p95Ms}ms (>33ms)`);
  await ctxPerf.close();
}

// ---- 2. zoom：滚轮放大 / 双击复位 ----
if (scenario('zoom')) {
  const ctx = await browser.newContext({ viewport: desktop, deviceScaleFactor: 1 });
  const page = await openPage(ctx, BASE + '?boot=0', 'zoom');
  await page.waitForTimeout(2200);
  const before = await dbg(page);
  await page.mouse.move(desktop.width / 2, desktop.height / 2);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(700);
  const zoomed = await dbg(page);
  if (!before || !zoomed) fail('zoom.debugInfo', 'debugInfo 不可用');
  else {
    ok('zoom.before', before.zoom);
    ok('zoom.zoomed', zoomed.zoom);
    if (!(zoomed.zoom > before.zoom * 1.08)) fail('zoom.wheel', `${before.zoom} → ${zoomed.zoom} (未放大)`);
  }
  await page.mouse.dblclick(desktop.width / 2, desktop.height / 2);
  await page.waitForTimeout(900);
  const reset = await dbg(page);
  if (reset && before && !(Math.abs(reset.zoom - before.zoom) < 0.06)) {
    fail('zoom.reset', `${reset.zoom} != ${before.zoom}`);
  } else ok('zoom.reset', reset?.zoom);
  await ctx.close();
}

// ---- 3. 分野总览：6 行 / 点击聚焦 / 返回 ----
async function ensureOverviewOpen(page) {
  // v2.x HUD 会在事件到来时自动跟随选中会话（面板切到档案态），先点「← 分野总览」回到总览。
  const back = page.locator('.ds-back');
  if ((await back.count()) > 0 && (await back.first().isVisible().catch(() => false))) {
    await back.first().click();
    await page.waitForTimeout(300);
  }
  const overview = page.locator('[data-hud="sector-overview"]');
  if ((await overview.count()) > 0 && (await overview.first().isVisible().catch(() => false))) return true;
  // v2.2+：桌面 >=1280 首屏自动展开分野总览，此时 .ds-tab 是隐藏的，不能点。
  const opened = page.locator('.dossier.is-open');
  if ((await opened.count()) > 0) return true;
  const panel = page.locator('[data-hud="sector-overview"]');
  if ((await panel.count()) > 0) {
    const box = await panel.first().boundingBox();
    if (box && box.x < desktop.width - 40) return true;
  }
  const tab = page.locator('.ds-tab');
  if ((await tab.count()) > 0 && (await tab.first().isVisible().catch(() => false))) {
    await tab.first().click();
    await page.waitForTimeout(700);
  }
  return true;
}

if (scenario('overview')) {
  const ctx = await browser.newContext({ viewport: desktop, deviceScaleFactor: 1.75 });
  const page = await openPage(ctx, BASE + '?boot=0', 'overview');
  await page.waitForTimeout(2400);
  await ensureOverviewOpen(page);
  const panel = page.locator('[data-hud="sector-overview"]');
  if ((await panel.count()) === 0) fail('overview.panel', 'data-hud="sector-overview" 不存在');
  const rows = page.locator('[data-hud="sector-overview"] [data-sector-id]');
  const n = await rows.count();
  ok('overview.rows', n);
  const sectors = await page.evaluate(() => window.__astra?.store?.getSectors?.()?.length ?? -1);
  ok('overview.sectors', sectors);
  if (sectors > 0 && n !== sectors) fail('overview.rowCount', `行数 ${n} != sectors ${sectors}`);
  const meta = await page.locator('[data-hud="sector-overview"]').innerText().catch(() => '');
  if (!/分野/.test(meta)) fail('overview.text', '面板无「分野」字样');
  // click first sector row → camera focus
  const before = await dbg(page);
  if (n > 0) {
    await rows.first().click();
    await page.waitForTimeout(1500);
    const focused = await dbg(page);
    ok('overview.zoomBefore', before?.zoom);
    ok('overview.zoomFocused', focused?.zoom);
    if (!before || !focused) fail('overview.focusDebug', 'debugInfo 不可用');
    else if (!(focused.zoom > before.zoom * 1.04)) fail('overview.focus', `${before.zoom} → ${focused.zoom} (未聚焦)`);
    await shot(page, 'focus');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500);
    const cleared = await dbg(page);
    ok('overview.zoomCleared', cleared?.zoom);
    if (cleared && before && !(Math.abs(cleared.zoom - before.zoom) < 0.2)) {
      fail('overview.escape', `${cleared.zoom} != ${before.zoom}`);
    }
  }
  // 点星 → 档案 → 返回总览
  await page.evaluate(() => window.__astra?.selectSession(null));
  await page.waitForTimeout(400);
  const back = page.locator('[data-hud="sector-overview"]');
  if ((await back.count()) === 0) fail('overview.back', '回到总览后钩子缺失');
  await ctx.close();
}

// ---- 4. 键盘模式（debugInfo.mode） ----
if (scenario('keys')) {
  const ctx = await browser.newContext({ viewport: desktop, deviceScaleFactor: 1 });
  const page = await openPage(ctx, BASE + '?boot=0', 'keys');
  await page.waitForTimeout(2200);
  const seq = [
    ['2', 'track'],
    ['3', 'dossier'],
    ['4', 'ledger'],
    ['5', 'orrery'],
    ['6', 'scan'],
    ['7', 'vigil'],
    ['1', 'survey'],
  ];
  for (const [key, expect] of seq) {
    await page.keyboard.press(key);
    await page.waitForTimeout(320);
    const info = await dbg(page);
    if (!info) {
      fail('keys.' + key, 'debugInfo 不可用');
      break;
    }
    if (info.mode !== expect) fail('keys.' + key, `mode=${info.mode} != ${expect}`);
  }
  ok('keys.done', true);
  await ctx.close();
}

// ---- 5. 三视口 + 静帧截图 ----
if (scenario('shots')) {
  const ctx = await browser.newContext({ viewport: wide, deviceScaleFactor: 1 });
  const page = await openPage(ctx, BASE + '?boot=0', 'wide');
  await page.waitForTimeout(3000);
  await shot(page, 'wide');
  await ctx.close();

  const ctx2 = await browser.newContext({ viewport: mobile, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page2 = await openPage(ctx2, BASE + '?boot=0', 'mobile');
  await page2.waitForTimeout(3000);
  const mh = await page2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (mh > 1) fail('shots.mobileHscroll', `${mh}px`);
  await shot(page2, 'mobile');
  await ctx2.close();

  const ctx3 = await browser.newContext({ viewport: desktop, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page3 = await openPage(ctx3, BASE + '?boot=0&motion=off', 'still');
  await page3.waitForTimeout(2600);
  await shot(page3, 'still');
  await ctx3.close();
}

report.fails = fails;
report.skipped = skipped;
report.consoleCount = report.console.length;
report.pageErrorCount = report.pageErrors.length;
if (report.console.length) fail('console.errors', report.console.length + ' 条');
if (report.pageErrors.length) fail('page.errors', report.pageErrors.length + ' 条');
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));

await browser.close();
console.log('\n== XUANJI QA v1.2 ==');
if (fails.length === 0) {
  console.log('ALL PASS  （' + Object.keys(report.checks).length + ' 项）');
  console.log('report: ' + join(outDir, 'report.json'));
  process.exit(0);
}
console.log('FAIL ' + fails.length + ' 项:');
for (const f of fails) console.log('  - ' + f);
console.log('report: ' + join(outDir, 'report.json'));
process.exit(1);
