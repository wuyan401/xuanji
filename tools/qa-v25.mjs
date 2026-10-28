#!/usr/bin/env node
/**
 * 璇玑 v2.5 验收器：第三视图「百工 · 器群」——全进程机械化盘面。
 *
 * 用法：
 *   node tools/qa-v25.mjs                                 # 打 8787（生产 dist）
 *   node tools/qa-v25.mjs --url http://127.0.0.1:5173     # 打 dev（vite proxy）
 *
 * 依赖：apps/web devDeps 里的 playwright-core + 系统 Chrome。
 * 输出：docs/qa/v25-<stamp>/report.json + 截图；退出码 0=全 PASS，1=有失败。
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
const OUT = join(ROOT, 'docs', 'qa', `v25-${STAMP}`);
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
  await page.waitForTimeout(2600);
}
async function dbgProcesses() {
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
async function progCount() {
  return page.evaluate(() => {
    const sys = window.__astra?.getSystem?.();
    return Array.isArray(sys?.procs) ? sys.procs.length : 0;
  });
}

async function shot(name) {
  const file = join(OUT, name);
  await page.screenshot({ path: file });
  shots.push(file);
  log(`  shot ${name}`);
}

/* ------------------------------------------------------------------ */
log(`== XUANJI QA v2.5 · 百工（全进程）· ${BASE}`);
try {
  // ---- 1. 进入百工视图：0 键循环 -------------------------------------
  await goto('?boot=0');
  const view0 = await page.evaluate(() => window.__astra?.view);
  await page.keyboard.press('Digit0');
  await page.waitForTimeout(750);
  const view1 = await page.evaluate(() => window.__astra?.view);
  await page.keyboard.press('Digit0');
  await page.waitForTimeout(900);
  const view2 = await page.evaluate(() => window.__astra?.view);
  const info = await dbgInfo();
  const dbg = await dbgProcesses();
  const procs = await progCount();
  if (view0 === 'agents' && view1 === 'system' && view2 === 'processes' && info?.view === 'processes') {
    ok('processes.view', { view0, view1, view2, scene: info?.view });
  } else {
    fail('processes.view', { view0, view1, view2, scene: info?.view });
  }

  // ---- 2. 盘面统计：芯片 / 轨道 / 流线 / 恒速 / 节拍 ------------------
  if (!dbg) {
    fail('processes.debug', { reason: 'scene.debugProcesses() 缺失' });
  } else {
    const chips = dbg.chips;
    const expect = Math.min(220, procs);
    if (chips >= 20 && chips === expect) ok('processes.chips', { chips, procs, expect });
    else fail('processes.chips', { chips, procs, expect });

    if (dbg.rails === 3) ok('processes.rails', { rails: dbg.rails });
    else fail('processes.rails', { rails: dbg.rails });

    if (dbg.flowLines > 0) ok('processes.flow', { flowLines: dbg.flowLines, sceneMs: dbg.sceneMs });
    else fail('processes.flow', { flowLines: dbg.flowLines });

    // 恒定角速：两次采样（600ms）之间不变
    const a = await dbgProcesses();
    await sleep(600);
    const b = await dbgProcesses();
    const scrollStable = a && b && Math.abs((a.scrollRate ?? -1) - (b.scrollRate ?? -2)) < 1e-6 && Math.abs((b.scrollRate ?? 0) - 0.05) < 1e-6;
    if (scrollStable) ok('processes.scrollRate', { rate: b.scrollRate });
    else fail('processes.scrollRate', { a: a?.scrollRate, b: b?.scrollRate });

    // 严格 1Hz 节拍：tickPhase 应贴合 (Date.now()%1000)/1000
    await page.evaluate(() => performance.now());
    const tick = await page.evaluate(() => {
      const s = window.__astra?.scene;
      const d = s?.debugProcesses?.();
      return { phase: d?.tickPhase, ms: Date.now() % 1000 };
    });
    const expected = tick.ms / 1000;
    const diff = tick.phase == null ? 1 : Math.abs(tick.phase - expected);
    if (diff < 0.12) ok('processes.tick', { phase: tick.phase, expected, diff });
    else fail('processes.tick', { phase: tick.phase, expected, diff });
  }
  await shot('processes-desktop.png');

  // ---- 3. HUD：工籍列表 / 器牒 / 点选同步 / Esc 清选 ------------------
  const hud = await page.evaluate(() => {
    const list = document.querySelector('[data-hud="process-list"]');
    const detail = document.querySelector('[data-hud="process-detail"], [data-hud="proc-detail"]');
    const rows = list ? Array.from(list.querySelectorAll('[data-pid]')) : [];
    return {
      list: Boolean(list),
      detail: Boolean(detail),
      rows: rows.length,
      firstPid: rows.length ? Number(rows[0].getAttribute('data-pid')) : null,
      texts: rows.length ? rows.slice(0, 3).map((r) => (r.textContent || '').trim().slice(0, 40)) : [],
    };
  });
  if (hud.list && hud.detail && hud.rows >= 5) ok('processes.hud', hud);
  else fail('processes.hud', hud);

  if (hud.rows >= 5) {
    await page.locator('[data-hud="process-list"] [data-pid]').first().click();
    await page.waitForTimeout(400);
    const sel = await page.evaluate(() => window.__astra?.getProcessSelection?.() ?? null);
    const dsel = (await dbgProcesses())?.selectedPid ?? null;
    if (sel != null && sel === hud.firstPid && dsel === hud.firstPid) ok('processes.select', { sel, scene: dsel });
    else fail('processes.select', { sel, scene: dsel, firstPid: hud.firstPid });
    await shot('processes-selected.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    const cleared = await page.evaluate(() => window.__astra?.getProcessSelection?.() ?? null);
    if (cleared === null) ok('processes.clear', { cleared });
    else fail('processes.clear', { cleared });
  } else {
    fail('processes.select', { reason: 'no rows' });
  }

  // ---- 4. 主题：深空下盘面仍成立、冷色占比 ----------------------------
  await page.keyboard.press('KeyT');
  await page.waitForTimeout(900);
  const theme = await page.evaluate(() => ({
    theme: window.__astra?.theme,
    dataTheme: document.documentElement.dataset.theme,
  }));
  const dbgScifi = await dbgProcesses();
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
  if (theme.theme === 'scifi' && theme.dataTheme === 'scifi' && dbgScifi && dbgScifi.chips > 0) {
    ok('processes.theme', { ...theme, chips: dbgScifi.chips, cold });
  } else {
    fail('processes.theme', { ...theme, chips: dbgScifi?.chips ?? null, cold });
  }
  await shot('processes-theme.png');
  await page.keyboard.press('KeyT');
  await page.waitForTimeout(700);

  // ---- 5. 性能：百工视图帧时 ----------------------------------------
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
  const d = await dbgProcesses();
  if (perf.frames >= 40 && (d?.sceneMs ?? 99) <= 8) ok('processes.perf', { ...perf, sceneMs: d.sceneMs });
  else fail('processes.perf', { ...perf, sceneMs: d?.sceneMs ?? null });

  // ---- 6. URL 直达 + 移动端 -----------------------------------------
  await goto('?boot=0&view=processes');
  const direct = await page.evaluate(() => ({
    view: window.__astra?.view,
    theme: window.__astra?.theme,
  }));
  const dbgDirect = await dbgProcesses();
  if (direct.view === 'processes' && dbgDirect?.chips > 0) ok('processes.direct', { ...direct, chips: dbgDirect.chips });
  else fail('processes.direct', { ...direct, chips: dbgDirect?.chips ?? null });

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  const mErrors = [];
  mobile.on('pageerror', (e) => mErrors.push(String(e)));
  await mobile.goto(`${BASE}/?boot=0&view=processes`, { waitUntil: 'domcontentloaded' });
  await mobile.waitForTimeout(2600);
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

  // ---- 7. 错误 ------------------------------------------------------
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
  tool: 'qa-v25',
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
