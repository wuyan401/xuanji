#!/usr/bin/env node
// XUANJI QA · v2.0 验收器（多来源可见 / 诸源筛选 / 整机视图 / 视图切换）
//
// 用法:
//   node tools/qa-v2.mjs
//   node tools/qa-v2.mjs --url http://127.0.0.1:8787/ --tag after
//   node tools/qa-v2.mjs --only sources,view,perf
//
// 输出: docs/qa/v2-<stamp>/{agents.png,system.png,system-direct.png,mobile-system.png,report.json}
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
const outDir = arg('--out', join(ROOT, 'docs', 'qa', `v2-${stamp}`));
mkdirSync(outDir, { recursive: true });

const report = { url: BASE, stamp, checks: {}, console: [], pageErrors: [], failedRequests: [], shots: [] };
const fails = [];
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
    if (msg.type() === 'error') report.console.push({ tag, text: msg.text().slice(0, 400) });
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
    return typeof s?.debugInfo === 'function' ? s.debugInfo() : null;
  });
const view = (page) => page.evaluate(() => window.__astra?.view ?? null);
const appState = (page) =>
  page.evaluate(() => ({
    view: window.__astra?.view ?? null,
    sourceFilter: window.__astra?.sourceFilter ?? null,
    sessions: window.__astra?.store?.getSessions?.()?.length ?? -1,
    sectors: window.__astra?.store?.getSectors?.()?.length ?? -1,
    sources: (window.__astra?.store?.getSnapshot?.()?.sources ?? []).map((s) => ({
      id: s.id,
      state: s.state,
      sessions: s.sessions,
    })),
    system: (() => {
      const sys = window.__astra?.getSystem?.() ?? null;
      if (!sys) return null;
      return { at: sys.at, available: sys.available, cpu: sys.cpu?.usage, cores: sys.cpu?.perCore?.length, procs: sys.procs?.length };
    })(),
  }));

const desktop = { width: 1440, height: 900 };
const mobile = { width: 390, height: 844 };

async function ensureOverviewOpen(page) {
  // v2.x HUD 会在事件到来时自动跟随选中会话（面板切到档案态），先点「← 分野总览」回到总览。
  const back = page.locator('.ds-back');
  if ((await back.count()) > 0 && (await back.first().isVisible().catch(() => false))) {
    await back.first().click().catch(() => {});
    await page.waitForTimeout(300);
  }
  const overview = page.locator('[data-hud="sector-overview"]');
  if ((await overview.count()) > 0 && (await overview.first().isVisible().catch(() => false))) return true;
  // v2 HUD：≥1280 首屏自动展开分野总览（.dossier.is-open）；否则点竖签 .ds-tab 展开。
  if ((await page.locator('.dossier.is-open').count()) > 0) return true;
  const tab = page.locator('.ds-tab');
  if ((await tab.count()) > 0) {
    const visible = await tab.first().isVisible().catch(() => false);
    if (visible) {
      await tab.first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(700);
    }
  }
  return true;
}
const perfProbe = (page, frames = 90) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        let i = 0;
        function step(now) {
          deltas.push(now - last);
          last = now;
          i += 1;
          if (i < n) requestAnimationFrame(step);
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
    frames,
  );

// ---- 1. sources：诸源签 + 来源筛选 + 多来源星 ----
if (scenario('sources')) {
  const ctx = await browser.newContext({ viewport: desktop, deviceScaleFactor: 1.75 });
  const page = await openPage(ctx, BASE + '?boot=0', 'sources');
  await page.waitForTimeout(2600);
  await ensureOverviewOpen(page);
  const state = await appState(page);
  ok('sources.state', state.sources);
  const detected = state.sources.filter((s) => s.state === 'detected');
  if (detected.length < 3) fail('sources.detected', `detected=${detected.length} (<3)`);
  const chips = page.locator('[data-hud="source-chips"] .ds-source[data-source]');
  const chipCount = await chips.count();
  ok('sources.chips', chipCount);
  if (chipCount < 4) fail('sources.chipCount', `${chipCount} (<4)`);
  const chipText = await page.locator('[data-hud="source-chips"]').innerText().catch(() => '');
  if (!/未发现|absent/i.test(chipText)) fail('sources.absent', 'absent 来源签未显示「未发现」');
  const info = await dbg(page);
  if (!info || !(info.stars >= 100)) fail('sources.stars', `stars=${info?.stars}`);
  // 点第一枚 detected 来源 → 筛选生效
  const target = detected[0]?.id;
  if (target) {
    await chips.first().click();
    await page.waitForTimeout(700);
    const after = await appState(page);
    ok('sources.filterAfterClick', after.sourceFilter);
    if (after.sourceFilter !== target) fail('sources.filter', `${after.sourceFilter} != ${target}`);
    await shot(page, 'agents-sources');
    // 再点一次取消
    await chips.first().click();
    await page.waitForTimeout(500);
    const cleared = await appState(page);
    if (cleared.sourceFilter !== null) fail('sources.filterClear', `${cleared.sourceFilter} != null`);
  }
  await ctx.close();
}

// ---- 2. view：0 键切换 + 整机盘面 + HUD 钩子 ----
if (scenario('view')) {
  const ctx = await browser.newContext({ viewport: desktop, deviceScaleFactor: 1 });
  const page = await openPage(ctx, BASE + '?boot=0', 'view');
  await page.waitForTimeout(2400);
  const tabs = page.locator('[data-hud="view-tabs"] [data-view]');
  ok('view.tabs', await tabs.count());
  if ((await tabs.count()) < 2) fail('view.tabsMissing', '视图铭牌 tab 不足 2 枚');
  await page.keyboard.press('0');
  await page.waitForTimeout(1200);
  const st = await appState(page);
  ok('view.afterKey0', st.view);
  if (st.view !== 'system') fail('view.key0', `view=${st.view} (!= system)`);
  const info = await dbg(page);
  ok('view.sceneInfo', info ? { view: info.view, mode: info.mode, zoom: info.zoom } : null);
  if (info && info.view !== 'system') fail('view.sceneView', `scene.view=${info.view}`);
  if (!st.system) fail('view.systemData', 'store.getSystem() 为空（SSE system 未到？）');
  else {
    if (!st.system.available) fail('view.systemAvailable', 'available=false');
    if (!(st.system.procs >= 3)) fail('view.systemProcs', `procs=${st.system.procs}`);
  }
  const panel = page.locator('[data-hud="system-panel"]');
  if ((await panel.count()) === 0) fail('view.systemPanel', 'data-hud="system-panel" 缺失');
  const procRowsCount = async () => {
    const rows = await page.locator('[data-hud="proc-table"] .pr-row').count();
    if (rows > 0) return rows;
    return page.locator('[data-hud="proc-table"] tbody tr').count();
  };
  const procRows = await procRowsCount();
  ok('view.procRows', procRows);
  if (procRows < 3) fail('view.procTable', `进程表 ${procRows} 行 (<3)`);
  const activeTab = page.locator('[data-hud="view-tabs"] [data-view="system"]');
  if ((await activeTab.count()) > 0) {
    const pressed = await activeTab.first().getAttribute('aria-pressed');
    ok('view.tabPressed', pressed);
    if (pressed !== 'true') fail('view.tabState', `aria-pressed=${pressed}`);
  }
  await shot(page, 'system');
  // 整机视图下 1–7 不改变 camera mode
  const modeBefore = (await dbg(page))?.mode;
  await page.keyboard.press('2');
  await page.waitForTimeout(400);
  const modeAfter = (await dbg(page))?.mode;
  if (modeAfter !== modeBefore) fail('view.digitsBlocked', `mode ${modeBefore} → ${modeAfter}`);
  // 回观星（v2.5 起 0 键按 agents→system→processes→agents 循环，需按两次）
  await page.keyboard.press('0');
  await page.waitForTimeout(1000);
  await page.keyboard.press('0');
  await page.waitForTimeout(1200);
  const back = await appState(page);
  if (back.view !== 'agents') fail('view.back', `view=${back.view}`);
  await ctx.close();
}

// ---- 3. system-direct：?view=system 直达 + 移动端 ----
if (scenario('direct')) {
  const ctx = await browser.newContext({ viewport: desktop, deviceScaleFactor: 1 });
  const page = await openPage(ctx, BASE + '?boot=0&view=system', 'direct');
  await page.waitForTimeout(3000);
  const st = await appState(page);
  ok('direct.view', st.view);
  if (st.view !== 'system') fail('direct.url', `view=${st.view} (!= system)`);
  await shot(page, 'system-direct');
  await ctx.close();

  const mctx = await browser.newContext({ viewport: mobile, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mpage = await openPage(mctx, BASE + '?boot=0&view=system', 'mobile-system');
  await mpage.waitForTimeout(3000);
  const mh = await mpage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (mh > 1) fail('direct.mobileHscroll', `${mh}px`);
  await shot(mpage, 'mobile-system');
  await mctx.close();
}

// ---- 4. perf：观星 / 整机 两视图 DPR1 帧率 ----
if (scenario('perf')) {
  for (const [name, url, wait] of [
    ['agents', BASE + '?boot=0', 2600],
    ['system', BASE + '?boot=0&view=system', 3000],
  ]) {
    const ctx = await browser.newContext({ viewport: desktop, deviceScaleFactor: 1 });
    const page = await openPage(ctx, url, 'perf-' + name);
    await page.waitForTimeout(wait);
    const perf = await perfProbe(page);
    ok('perf.' + name, perf);
    if (perf.fps < 40) fail('perf.' + name + 'Fps', `${perf.fps} (<40)`);
    if (perf.p95Ms > 60) fail('perf.' + name + 'P95', `${perf.p95Ms}ms (>33)`);
    await ctx.close();
  }
}

report.fails = fails;
report.consoleCount = report.console.length;
report.pageErrorCount = report.pageErrors.length;
report.failedRequestCount = report.failedRequests.length;
if (report.console.length) fail('console.errors', report.console.length + ' 条');
if (report.pageErrors.length) fail('page.errors', report.pageErrors.length + ' 条');
if (report.failedRequests.length) fail('requests.failed', report.failedRequests.length + ' 条');
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));

await browser.close();
console.log('\n== XUANJI QA v2.0 ==');
if (fails.length === 0) {
  console.log('ALL PASS  （' + Object.keys(report.checks).length + ' 项）');
  console.log('report: ' + join(outDir, 'report.json'));
  process.exit(0);
}
console.log('FAIL ' + fails.length + ' 项:');
for (const f of fails) console.log('  - ' + f);
console.log('report: ' + join(outDir, 'report.json'));
process.exit(1);
