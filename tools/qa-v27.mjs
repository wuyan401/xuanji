#!/usr/bin/env node
/**
 * 璇玑 v2.7 验收器：百工重做 2——奔流（五轨·模块芯片·六层数据引擎）。
 *
 * 用法：
 *   node tools/qa-v27.mjs                                 # 打 8787（生产 dist）
 *   node tools/qa-v27.mjs --url http://127.0.0.1:5173     # 打 dev（vite proxy + mock）
 *
 * 设计权威：docs/DESIGN-BIBLE.md §26（v2.7）。
 * 依赖：apps/web devDeps 里的 playwright-core + 系统 Chrome。
 * 输出：docs/qa/v27-<stamp>/report.json + 截图；退出码 0=全 PASS，1=有失败。
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
const OUT = join(ROOT, 'docs', 'qa', `v27-${STAMP}`);
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
async function procs() {
  return page.evaluate(() => {
    const list = window.__astra?.getSystem?.()?.procs ?? [];
    return list.map((p) => ({ pid: p.pid, cpu: Number(p.cpuPct) || 0, mem: Number(p.memBytes) || 0, threads: Number(p.threads) || 0 }));
  });
}
async function shot(name) {
  const file = join(OUT, name);
  await page.screenshot({ path: file });
  shots.push(file);
  log(`  shot ${name}`);
}
function spearman(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    idx.forEach(([, i], k) => (r[i] = k + 1));
    return r;
  };
  const rx = rank(x.slice(0, n));
  const ry = rank(y.slice(0, n));
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = avg(rx), my = avg(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

log(`== 璇玑 QA v2.7 @ ${BASE}`);
try {
  await goto('?boot=0&view=processes');
  // 芯片的 cpu/mem 是 damp 跟随的，且系统帧要等首帧到达：给足 3.2s 再采样
  await page.waitForTimeout(3200);

  const d0 = await dbg();
  if (!d0) { fail('debug.available', { msg: 'scene.debugProcesses() 缺失' }); throw new Error('no debugProcesses'); }

  // 1) 五轨
  const bandsOk = d0.bands === 5 && Array.isArray(d0.laneCenters) && d0.laneCenters.length === 5;
  bandsOk ? ok('lanes.five', { bands: d0.bands, laneCenters: d0.laneCenters.map((v) => Math.round(v)) }) : fail('lanes.five', { bands: d0.bands, laneCenters: d0.laneCenters });
  const counts = [0, 0, 0, 0, 0];
  for (const b of d0.chipBands ?? []) if (b >= 0 && b < 5) counts[b]++;
  if (bandsOk && d0.chipBands && counts.filter((c) => c > 0).length >= 2 && counts[0] + counts[1] + counts[2] + counts[3] + counts[4] === d0.chips) ok('lanes.populated', { counts });
  else fail('lanes.populated', { counts, chips: d0.chips });

  // 2) 芯片宽差异
  const [wMin, wMax] = d0.chipWidthRange ?? [0, 0];
  wMin <= 12 && wMax >= 30 ? ok('chip.sizeSpread', { wMin, wMax }) : fail('chip.sizeSpread', { wMin, wMax });

  // 3) 速度随占用（cpuPct → chipSpeeds；按 pid 对齐，不假设数组同序）
  const p0 = await procs();
  const cpuOf = (p) => Number(p.cpuPct ?? p.cpu ?? 0);
  const chipPids = d0.chipPids ?? [];
  const speedByPid = new Map();
  (d0.chipSpeeds ?? []).forEach((v, i) => speedByPid.set(chipPids[i], v));
  const speedPairs = p0.filter((p) => speedByPid.has(p.pid)).map((p) => ({ cpu: cpuOf(p), speed: Number(speedByPid.get(p.pid)) || 0 }));
  if (speedPairs.length >= 5) {
    // 真实机器上多数进程 cpu=0（大量并列），原始 Spearman 会被并列噪声主导；
    // 改为「按 CPU 降序分位对比」：前 10% 与后 10% 的平均角速度必须显著拉开，且整体最小/最大 ≥12×。
    const byCpu = speedPairs.slice().sort((a, b) => b.cpu - a.cpu);
    const k = Math.max(3, Math.round(byCpu.length * 0.1));
    const avgOf = (a) => a.reduce((s, v) => s + v.speed, 0) / a.length;
    const fast = avgOf(byCpu.slice(0, k));
    const slow = avgOf(byCpu.slice(-k));
    const ratio = fast / Math.max(1e-9, slow);
    const sorted = speedPairs.map((p) => p.speed).slice().sort((a, b) => a - b);
    const spread = sorted[sorted.length - 1] / Math.max(1e-9, sorted[0]);
    ratio >= 3 && spread >= 12
      ? ok('chip.speedByLoad', { topAvg: Number(fast.toFixed(4)), bottomAvg: Number(slow.toFixed(4)), ratio: Number(ratio.toFixed(1)), spread: Number(spread.toFixed(1)), n: speedPairs.length })
      : fail('chip.speedByLoad', { topAvg: Number(fast.toFixed(4)), bottomAvg: Number(slow.toFixed(4)), ratio: Number(ratio.toFixed(1)), spread: Number(spread.toFixed(1)), n: speedPairs.length });
  } else fail('chip.speedByLoad', { n: speedPairs.length });

  // 4) 光束速率随占用（按 pid 对齐）
  const beamByPid = new Map();
  (d0.beamRates ?? []).forEach((v, i) => beamByPid.set(chipPids[i], v));
  const beamPairs = p0.filter((p) => beamByPid.has(p.pid)).map((p) => ({ cpu: p.cpu, rate: Number(beamByPid.get(p.pid)) || 0 })).sort((a, b) => b.cpu - a.cpu);
  if (beamPairs.length >= 10) {
    const top = beamPairs.slice(0, 10);
    const bottom = beamPairs.slice(-10);
    const avg = (a) => a.reduce((s, v) => s + v.rate, 0) / a.length;
    const r = avg(top) / Math.max(1e-6, avg(bottom));
    r >= 2.5 ? ok('beam.rateByLoad', { ratio: Number(r.toFixed(2)), top: Number(avg(top).toFixed(2)), bottom: Number(avg(bottom).toFixed(2)) }) : fail('beam.rateByLoad', { ratio: Number(r.toFixed(2)) });
  } else fail('beam.rateByLoad', { n: beamPairs.length });

  // 5) 芯片确实在动（1.2s 屏幕位移）
  const posA = (d0.chipScreenPositions ?? []).map((p) => ({ x: p.x, y: p.y }));
  await page.waitForTimeout(1200);
  const d1 = await dbg();
  const posB = (d1.chipScreenPositions ?? []).map((p) => ({ x: p.x, y: p.y }));
  const n5 = Math.min(posA.length, posB.length);
  let moved = 0;
  for (let i = 0; i < n5; i++) if (Math.hypot(posA[i].x - posB[i].x, posA[i].y - posB[i].y) > 2) moved++;
  const motionRatio = n5 ? moved / n5 : 0;
  motionRatio >= 0.8 ? ok('chip.motion', { ratio: Number(motionRatio.toFixed(3)), n: n5 }) : fail('chip.motion', { ratio: Number(motionRatio.toFixed(3)), n: n5 });
  await shot('processes-motion-a.png');
  await page.waitForTimeout(300);
  await shot('processes-motion-b.png');

  // 6) 核心：六层、正反都有、各自可见运转
  const layers = d1.coreLayers ?? [];
  const distinct = layers.length >= 6 && layers.some((l) => l.direction > 0) && layers.some((l) => l.direction < 0);
  const layerSpeeds = layers.map((l) => Math.abs(l.speed));
  const speedSpread = layerSpeeds.length ? Math.max(...layerSpeeds) / Math.max(1e-9, Math.min(...layerSpeeds)) : 0;
  distinct && speedSpread >= 3 ? ok('core.layers', { n: layers.length, speedSpread: Number(speedSpread.toFixed(2)) }) : fail('core.layers', { n: layers.length, speedSpread: Number(speedSpread.toFixed(2)) });

  const a0 = d1.coreAngles ?? [];
  await page.waitForTimeout(1200);
  const d2 = await dbg();
  const a1 = d2.coreAngles ?? [];
  let spinning = 0;
  const n6 = Math.min(a0.length, a1.length);
  for (let i = 0; i < n6; i++) {
    let delta = Math.abs(a1[i] - a0[i]) % (Math.PI * 2);
    if (delta > Math.PI) delta = Math.PI * 2 - delta;
    if (delta >= 0.05) spinning++;
  }
  spinning >= 2 ? ok('core.motion', { spinning, n: n6 }) : fail('core.motion', { spinning, n: n6 });

  // 7) 涡流粒子
  const vp = Number(d2.vortexParticles) || 0;
  vp >= 40 ? ok('core.vortex', { vortexParticles: vp }) : fail('core.vortex', { vortexParticles: vp });

  // 8) HUD 钩子与选中
  const hud = await page.evaluate(() => ({
    tabs: document.querySelectorAll('[data-hud="view-tabs"] [data-view]').length,
    procTab: !!document.querySelector('[data-hud="view-tabs"] [data-view="processes"]'),
    rows: document.querySelectorAll('[data-hud="process-list"] [data-pid]').length,
    detail: !!document.querySelector('[data-hud="process-detail"]'),
  }));
  hud.procTab && hud.rows >= 5 ? ok('hud.hooks', hud) : fail('hud.hooks', hud);

  await page.evaluate(() => window.__astra?.selectProcess?.(window.__astra?.getSystem?.()?.procs?.[0]?.pid ?? null));
  await page.waitForTimeout(500);
  const selected = await dbg();
  selected && selected.selectedPid != null ? ok('chip.select', { selectedPid: selected.selectedPid }) : fail('chip.select', { selectedPid: selected?.selectedPid });
  await shot('processes-selected.png');
  await page.evaluate(() => window.__astra?.selectProcess?.(null));

  // 9) 性能
  const perf = await page.evaluate(async () => {
    const scene = window.__astra.scene;
    const t = [];
    for (let i = 0; i < 40; i++) {
      const a = performance.now();
      scene.frame(a + i * 16);
      t.push(performance.now() - a);
    }
    t.sort((x, y) => x - y);
    return { avg: t.reduce((s, v) => s + v, 0) / t.length, p95: t[Math.floor(t.length * 0.95)] };
  });
  perf.avg <= 10 && (d2.sceneMs ?? 99) <= 8.5 ? ok('perf.scene', { avgMs: Number(perf.avg.toFixed(2)), sceneMs: d2.sceneMs }) : fail('perf.scene', { avgMs: Number(perf.avg.toFixed(2)), sceneMs: d2.sceneMs });

  // 10) 深空主题
  await page.keyboard.press('KeyT');
  await page.waitForTimeout(900);
  const theme = await page.evaluate(() => ({
    theme: window.__astra?.getTheme?.(),
    dataTheme: document.documentElement.dataset.theme,
    chips: window.__astra.scene.debugProcesses().chips,
  }));
  theme.dataTheme === 'scifi' && theme.chips > 0 ? ok('theme.scifi', theme) : fail('theme.scifi', theme);
  await shot('processes-scifi.png');
  await page.keyboard.press('KeyT');
  await page.waitForTimeout(600);

  // 11) 移动端
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1200);
  const mobile = await page.evaluate(() => ({
    hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    chips: window.__astra.scene.debugProcesses().chips,
    hasList: !!document.querySelector('[data-hud="process-list"]'),
  }));
  !mobile.hscroll && mobile.hasList ? ok('mobile.layout', mobile) : fail('mobile.layout', mobile);
  await shot('processes-mobile.png');
  await page.setViewportSize({ width: 1440, height: 900 });

  // 12) 控制台
  consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0
    ? ok('errors.clean', { console: 0, page: 0, failed: 0 })
    : fail('errors.clean', { console: consoleErrors.slice(0, 3), page: pageErrors.slice(0, 3), failed: failedRequests.slice(0, 3) });

  await shot('processes-default.png');
} catch (e) {
  fail('exception', { message: String(e && e.message ? e.message : e) });
} finally {
  await browser.close();
}

const failed = Object.entries(checks).filter(([, v]) => !v.pass);
const report = { url: BASE, stamp: STAMP, checks, consoleErrors, pageErrors, failedRequests, shots };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
log(`\n${failed.length === 0 ? `ALL PASS  （${Object.keys(checks).length} 项）` : `FAILED ${failed.length}/${Object.keys(checks).length}`}`);
log(`report: ${join(OUT, 'report.json')}`);
process.exit(failed.length === 0 ? 0 : 1);
