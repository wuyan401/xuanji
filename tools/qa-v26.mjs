#!/usr/bin/env node
/**
 * 璇玑 v2.6 验收器：百工重做——瀑布（内向数据流）· 径向层级 · 连续轨迹。
 *
 * 用法：
 *   node tools/qa-v26.mjs                                 # 打 8787（生产 dist）
 *   node tools/qa-v26.mjs --url http://127.0.0.1:5173     # 打 dev（vite proxy + mock）
 *
 * 设计权威：docs/DESIGN-BIBLE.md §25（v2.6）。
 * 依赖：apps/web devDeps 里的 playwright-core + 系统 Chrome。
 * 输出：docs/qa/v26-<stamp>/report.json + 截图；退出码 0=全 PASS，1=有失败。
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
const OUT = join(ROOT, 'docs', 'qa', `v26-${STAMP}`);
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
  await page.waitForTimeout(2800);
}
async function dbg() {
  return page.evaluate(() => {
    const s = window.__astra && window.__astra.scene;
    return s && typeof s.debugProcesses === 'function' ? s.debugProcesses() : null;
  });
}
async function dbgInfo() {
  return page.evaluate(() => {
    const s = window.__astra && window.__astra.scene;
    return s && typeof s.debugInfo === 'function' ? s.debugInfo() : null;
  });
}
async function procStats() {
  return page.evaluate(() => {
    const procs = window.__astra?.getSystem?.()?.procs ?? [];
    const now = Date.now();
    const withAge = procs.map((p) => ({
      pid: p.pid,
      cpu: Number(p.cpuPct) || 0,
      mem: Number(p.memBytes) || 0,
      age: p.startedAt ? Math.max(0, now - p.startedAt) : null,
    }));
    const usable = withAge.filter((p) => p.age != null);
    usable.sort((a, b) => a.age - b.age);
    return {
      count: procs.length,
      usable: usable.length,
      newestAvg: usable.length ? usable.slice(0, Math.max(1, Math.round(usable.length * 0.1))).reduce((s, p) => s + p.age, 0) / Math.max(1, Math.round(usable.length * 0.1)) : null,
      hasThreads: procs.some((p) => typeof p.threads === 'number'),
      totalThreads: procs.reduce((s, p) => s + (Number(p.threads) || 0), 0),
    };
  });
}

async function shot(name) {
  const file = join(OUT, name);
  await page.screenshot({ path: file });
  shots.push(file);
  log(`  shot ${name}`);
}

/* ------------------------------------------------------------------ */
log(`== XUANJI QA v2.6 · 百工瀑布 · ${BASE}`);
try {
  // ---- 1. 进入百工视图 ------------------------------------------------
  await goto('?boot=0');
  for (let i = 0; i < 2; i += 1) {
    await page.keyboard.press('Digit0');
    await page.waitForTimeout(850);
  }
  const info = await dbgInfo();
  const view = await page.evaluate(() => window.__astra?.view);
  const d0 = await dbg();
  if (view === 'processes' && info?.view === 'processes' && d0) ok('processes.view', { view, scene: info?.view });
  else fail('processes.view', { view, scene: info?.view, hasDebug: Boolean(d0) });

  // ---- 2. 瀑布：在途包数量 / 恒速 / 入口雨幕 --------------------------
  if (!d0) {
    fail('stream.available', { reason: 'debugProcesses() 缺失' });
  } else {
    const need = ['packets', 'packetSpeed', 'packetSpeedVar', 'entryFlow', 'chipAngularSpeed', 'hierarchySpearman', 'maxAlphaStep'];
    const missing = need.filter((k) => typeof d0[k] !== 'number');
    if (!missing.length) ok('stream.available', { ok: need.length });
    else fail('stream.available', { missing });

    const expectChips = await page.evaluate(() => window.__astra?.getSystem?.()?.procs?.length ?? 0);
    if ((d0.chips ?? 0) > 0 && d0.chips === Math.min(220, expectChips)) ok('processes.chips', { chips: d0.chips, procs: expectChips });
    else fail('processes.chips', { chips: d0.chips, procs: expectChips });

    const a = await dbg();
    await sleep(900);
    const b = await dbg();
    if (a && b && typeof a.packets === 'number' && typeof b.packets === 'number') {
      const minPackets = Math.min(a.packets, b.packets);
      if (minPackets >= 300) ok('stream.packets', { a: a.packets, b: b.packets });
      else fail('stream.packets', { a: a.packets, b: b.packets, need: 300 });
    }
    if (a && b) {
      const sp = (Math.abs(a.packetSpeed - b.packetSpeed) / Math.max(1, b.packetSpeed)) || 0;
      if (sp <= 0.01 && a.packetSpeed > 0 && a.packetSpeedVar <= 0.05) ok('stream.speed', { speed: b.packetSpeed, deltaRel: sp, var: b.packetSpeedVar });
      else fail('stream.speed', { speedA: a.packetSpeed, speedB: b.packetSpeed, deltaRel: sp, var: a.packetSpeedVar });
    }
    if (a && typeof a.entryFlow === 'number' && a.entryFlow > 0) ok('stream.entry', { entryFlow: a.entryFlow });
    else fail('stream.entry', { entryFlow: a?.entryFlow ?? null });
    if (a && typeof a.maxAlphaStep === 'number' && a.maxAlphaStep <= 0.04) ok('stream.alpha', { maxAlphaStep: a.maxAlphaStep });
    else fail('stream.alpha', { maxAlphaStep: a?.maxAlphaStep ?? null });
  }
  await shot('processes-stream.png');

  // ---- 3. 径向层级：占用/新旧 → 越靠内 --------------------------------
  {
    const d = await dbg();
    const ps = await procStats();
    const spearman = d?.hierarchySpearman;
    if (typeof spearman === 'number' && spearman <= -0.35) ok('hierarchy.spearman', { spearman, procs: ps.count });
    else fail('hierarchy.spearman', { spearman: spearman ?? null, procs: ps.count });
    if (ps.usable >= 20) ok('hierarchy.startedAt', { usable: ps.usable, newestAvgAgeMs: Math.round(ps.newestAvg ?? 0), totalThreads: ps.totalThreads });
    else fail('hierarchy.startedAt', { usable: ps.usable, reason: 'procs 缺少 startedAt（后端采样器需升级）' });
  }
  await shot('processes-hierarchy.png');

  // ---- 4. 轨迹：芯片角速度恒定（两次采样同值）----------------------
  {
    const a = await dbg();
    await sleep(700);
    const b = await dbg();
    const v0 = a?.chipAngularSpeed;
    const v1 = b?.chipAngularSpeed;
    // v2.7 §26 起角速度随 weight 分档（0.008+0.30*w^1.5），不再是全盘同一恒速；
    // 这里只防「逐帧随机跳变」：同一芯片两帧角速度相对差 ≤5%。
    if (typeof v0 === 'number' && typeof v1 === 'number' && v0 > 0 && Math.abs(v0 - v1) / v1 <= 0.05) ok('orbit.constant', { v0, v1 });
    else fail('orbit.constant', { v0: v0 ?? null, v1: v1 ?? null });
  }

  // ---- 5. HUD：工籍 / 器牒 / 点选 / Esc ------------------------------
  const hud = await page.evaluate(() => {
    const list = document.querySelector('[data-hud="process-list"]');
    const detail = document.querySelector('[data-hud="process-detail"], [data-hud="proc-detail"]');
    const rows = list ? Array.from(list.querySelectorAll('[data-pid]')) : [];
    return {
      list: Boolean(list),
      detail: Boolean(detail),
      rows: rows.length,
      firstPid: rows.length ? Number(rows[0].getAttribute('data-pid')) : null,
    };
  });
  if (hud.list && hud.detail && hud.rows >= 5) ok('processes.hud', hud);
  else fail('processes.hud', hud);

  if (hud.rows >= 5) {
    await page.locator('[data-hud="process-list"] [data-pid]').first().click();
    await page.waitForTimeout(420);
    const sel = await page.evaluate(() => window.__astra?.getProcessSelection?.() ?? null);
    const dsel = (await dbg())?.selectedPid ?? null;
    if (sel != null && sel === hud.firstPid && dsel === hud.firstPid) ok('processes.select', { sel, scene: dsel });
    else fail('processes.select', { sel, scene: dsel, firstPid: hud.firstPid });
    await shot('processes-selected.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(360);
    const cleared = await page.evaluate(() => window.__astra?.getProcessSelection?.() ?? null);
    if (cleared === null) ok('processes.clear', { cleared });
    else fail('processes.clear', { cleared });
  } else {
    fail('processes.select', { reason: 'no rows' });
  }

  // ---- 6. 主题：深空冷色占比 -----------------------------------------
  await page.keyboard.press('KeyT');
  await page.waitForTimeout(1000);
  const theme = await page.evaluate(() => ({
    theme: window.__astra?.theme,
    dataTheme: document.documentElement.dataset.theme,
  }));
  const cold = await page.evaluate(() => {
    const c = document.querySelector('#stage canvas');
    if (!c) return null;
    const off = document.createElement('canvas');
    off.width = 64;
    off.height = 36;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0, 64, 36);
    const data = ctx.getImageData(0, 0, 64, 36).data;
    let n = 0;
    let usable = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum < 0.06 || d < 0.02) continue;
      usable += 1;
      let h;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      if (h >= 150 && h <= 240) n += 1;
    }
    return { ratio: usable ? n / usable : 0, usable };
  });
  if (theme.theme === 'scifi' && theme.dataTheme === 'scifi' && cold && cold.ratio >= 0.5) ok('theme.cold', { ...theme, ratio: cold.ratio });
  else fail('theme.cold', { ...theme, ratio: cold?.ratio ?? null });
  await shot('processes-theme.png');
  await page.keyboard.press('KeyT');
  await page.waitForTimeout(700);

  // ---- 7. 性能 --------------------------------------------------------
  const perf = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        const tick = (now) => {
          deltas.push(now - last);
          last = now;
          if (deltas.length < 60) requestAnimationFrame(tick);
          else {
            const sorted = deltas.slice(1).sort((a, b) => a - b);
            const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
            resolve({ avg, p95: sorted[Math.floor(sorted.length * 0.95)] || 0, frames: sorted.length });
          }
        };
        requestAnimationFrame(tick);
      }),
  );
  const dPerf = await dbg();
  if (perf.frames >= 40 && (dPerf?.sceneMs ?? 99) <= 8) ok('processes.perf', { ...perf, sceneMs: dPerf.sceneMs });
  else fail('processes.perf', { ...perf, sceneMs: dPerf?.sceneMs ?? null });

  // ---- 8. URL 直达 + 移动端 -------------------------------------------
  await goto('?boot=0&view=processes');
  const direct = await page.evaluate(() => ({ view: window.__astra?.view }));
  const dDirect = await dbg();
  if (direct.view === 'processes' && (dDirect?.chips ?? 0) > 0) ok('processes.direct', { ...direct, chips: dDirect.chips });
  else fail('processes.direct', { ...direct, chips: dDirect?.chips ?? null });

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  const mErrors = [];
  mobile.on('pageerror', (e) => mErrors.push(String(e)));
  await mobile.goto(`${BASE}/?boot=0&view=processes`, { waitUntil: 'domcontentloaded' });
  await mobile.waitForTimeout(2800);
  const m = await mobile.evaluate(() => {
    const d = window.__astra?.scene?.debugProcesses?.();
    return {
      view: window.__astra?.view,
      chips: d?.chips ?? null,
      hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      hasList: Boolean(document.querySelector('[data-hud="process-list"]')),
    };
  });
  const mshot = join(OUT, 'processes-mobile.png');
  await mobile.screenshot({ path: mshot });
  shots.push(mshot);
  if (m.view === 'processes' && (m.chips ?? 0) > 0 && !m.hscroll && mErrors.length === 0) ok('processes.mobile', m);
  else fail('processes.mobile', { ...m, errors: mErrors.slice(0, 2) });
  await mobile.close();

  // ---- 9. 错误 --------------------------------------------------------
  if (!consoleErrors.length && !pageErrors.length && !failedRequests.length) ok('errors.clean', { n: 0 });
  else fail('errors.clean', { consoleErrors: consoleErrors.slice(0, 3), pageErrors: pageErrors.slice(0, 3), failedRequests: failedRequests.slice(0, 3) });
} catch (err) {
  fail('runner', { message: String(err && err.stack ? err.stack : err) });
} finally {
  await context.close();
  await browser.close();
}

const passed = Object.values(checks).filter((c) => c.pass).length;
const total = Object.keys(checks).length;
const report = {
  tool: 'qa-v26',
  url: BASE,
  stamp: STAMP,
  finishedAt: new Date().toISOString(),
  checks,
  consoleErrors,
  pageErrors,
  failedRequests,
  shots,
};
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

log('');
if (passed === total && total > 0) log(`ALL PASS  （${total} 项）`);
else log(`FAILED  ${total - passed}/${total}`);
log(`report: ${join(OUT, 'report.json')}`);
process.exit(passed === total && total > 0 ? 0 : 1);
