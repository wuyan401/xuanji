#!/usr/bin/env node
/**
 * 璇玑 v2.3 验收器：稳定（无闪烁/错位） · 亮度稳定 · 径向层级 · 机器运转/交互动效 · 出生退场 · 复合核心 · 双主题
 *
 * 用法：
 *   node tools/qa-v23.mjs                       # 打 8787（生产 dist）
 *   node tools/qa-v23.mjs --url http://127.0.0.1:5173   # 打 dev（vite proxy）
 *
 * 依赖：apps/web devDeps 里的 playwright-core + 系统 Chrome。
 * 输出：docs/qa/v23-<stamp>/report.json + 截图；退出码 0=全 PASS，1=有失败。
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
const OUT = join(ROOT, 'docs', 'qa', `v23-${STAMP}`);
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
async function dbg() {
  return page.evaluate(() => {
    const s = window.__astra && window.__astra.scene;
    return s && s.debugInfo ? s.debugInfo() : null;
  });
}
async function call(fnName) {
  return page.evaluate((name) => {
    const s = window.__astra && window.__astra.scene;
    return s && typeof s[name] === 'function' ? s[name]() : null;
  }, fnName);
}
/** canvas 64×36 降采样：平均亮度 + 像素数组（主题切换差异检测用） */
async function frameSample() {
  return page.evaluate(() => {
    const cv = document.querySelector('#stage canvas');
    if (!cv) return null;
    const w = 64, h = 36;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(cv, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let sum = 0;
    const pixels = new Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p += 1) {
      sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      pixels[p] = [d[i], d[i + 1], d[i + 2]];
    }
    return { lum: sum / (w * h * 255), pixels, w, h };
  });
}
/** canvas 64×36 降采样平均亮度 0..1（缩放亮度稳定性验收） */
async function lum() {
  return page.evaluate(() => {
    const cv = document.querySelector('#stage canvas');
    if (!cv) return null;
    const w = 64, h = 36;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(cv, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (w * h * 255);
  });
}
async function shot(name) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push({ name, file });
  return file;
}
async function boot(url = `${BASE}/?boot=0`) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__astra && window.__astra.scene && window.__astra.scene.debugInfo,
    null,
    { timeout: 20000 },
  );
  await sleep(2200);
}

try {
  log('== XUANJI QA v2.3（稳定 · 层级 · 机器运转 · 核心 · 双主题）==');
  await boot();
  const initial = await dbg();
  log(`  初始 debugInfo: ${JSON.stringify(initial)}`);
  await shot('entry');

  // ---------- stability：无瞬移 / alpha 稳定 ----------
  await sleep(2600);
  const motion = await call('debugMotion');
  if (!motion) {
    fail('stability.available', { reason: 'scene.debugMotion 未实现' });
  } else {
    ok('stability.available', { frames: motion.frames });
    if (motion.teleports === 0) ok('stability.teleports', { teleports: 0 });
    else fail('stability.teleports', { teleports: motion.teleports });
    if (motion.maxAlphaStep <= 0.08) ok('stability.alpha', { maxAlphaStep: +motion.maxAlphaStep.toFixed(4) });
    else fail('stability.alpha', { maxAlphaStep: +motion.maxAlphaStep.toFixed(4) });
  }

  // ---------- brightness：滚轮连打期间「帧间跳变」稳定（允许构图造成缓变） ----------
  await page.mouse.move(720, 450);
  const lums = [];
  lums.push(await lum());
  for (let i = 0; i < 8; i += 1) {
    await page.mouse.wheel(0, -170);
    await sleep(90);
    lums.push(await lum());
  }
  await sleep(900);
  lums.push(await lum());
  const validLums = lums.filter((v) => typeof v === 'number');
  if (validLums.length >= 4) {
    let maxJump = 0;
    for (let i = 1; i < validLums.length; i += 1) {
      const prev = Math.max(validLums[i - 1], 1e-6);
      maxJump = Math.max(maxJump, Math.abs(validLums[i] - validLums[i - 1]) / prev);
    }
    // 阈值 12%：本项守护的是「缩放手势本身不得引起亮度阶跃」；但真实数据下事件脉冲
    // （分野弧反馈/协作光包/器数环点亮）会按 §22.4 的设计主动添光，安静态实测 ≤7.8%，
    // 事件洪峰时相邻采样可到 ~10%，故留 12% 容差；硬性稳定度另由 stability.alpha 把关。
    if (maxJump <= 0.12) ok('brightness.stable', { maxJump: +maxJump.toFixed(4), samples: validLums.length });
    else fail('brightness.stable', { maxJump: +maxJump.toFixed(4), samples: validLums.map((v) => +v.toFixed(4)) });
    await shot('brightness-settled');
  } else fail('brightness.stable', { reason: 'canvas 亮度采样失败' });

  // ---------- hierarchy：体量/活跃 → 靠内 ----------
  await boot(`${BASE}/?boot=0&reset=1`);
  await sleep(1800);
  const hier = await call('debugHierarchy');
  if (!hier) {
    fail('hierarchy.available', { reason: 'scene.debugHierarchy 未实现' });
  } else {
    ok('hierarchy.available', { stars: hier.stars });
    if (hier.spearman <= -0.5) ok('hierarchy.spearman', { spearman: +hier.spearman.toFixed(3) });
    else fail('hierarchy.spearman', { spearman: +hier.spearman.toFixed(3) });
    const gap = hier.innerAvgWeight - hier.outerAvgWeight;
    if (gap >= 0.15) ok('hierarchy.gap', { gap: +gap.toFixed(3), inner: +hier.innerAvgWeight.toFixed(3), outer: +hier.outerAvgWeight.toFixed(3) });
    else fail('hierarchy.gap', { gap: +gap.toFixed(3), inner: +hier.innerAvgWeight.toFixed(3), outer: +hier.outerAvgWeight.toFixed(3) });
  }
  await shot('hierarchy');

  // ---------- fx：数据流 / 分野反应 / 协作光包 / 出生 ----------
  const fx0 = await call('debugFx');
  if (!fx0) {
    fail('fx.available', { reason: 'scene.debugFx 未实现' });
  } else {
    ok('fx.available', { ...fx0 });
    if (fx0.streams >= 8) ok('fx.streams', { streams: fx0.streams });
    else fail('fx.streams', { streams: fx0.streams });
    if (fx0.sectorFx >= 3) ok('fx.sectorFx', { sectorFx: fx0.sectorFx });
    else fail('fx.sectorFx', { sectorFx: fx0.sectorFx });
    if (fx0.coreNodes >= 4) ok('fx.coreNodes', { coreNodes: fx0.coreNodes });
    else fail('fx.coreNodes', { coreNodes: fx0.coreNodes });

    // 合成一次「遣使」事件 → 协作弧 + 光包
    const sent = await page.evaluate(() => {
      const a = window.__astra;
      const sessions = a.store.getSessions();
      const s = sessions.find((x) => x.state === 'live') || sessions[0];
      if (!s) return false;
      const now = Date.now();
      a.scene.pushEvents([
        {
          id: `qa-send-${now}`,
          at: now,
          kind: 'tool/call',
          sessionId: s.id,
          sessionTitle: s.title,
          tool: 'send_message',
          toolCategory: 'agent',
          detail: 'QA 合成：遣使协作',
          isError: false,
          turn: 1,
          step: 1,
          durationMs: 240,
          source: s.source,
        },
      ]);
      return true;
    });
    await sleep(420);
    const fx1 = await call('debugFx');
    if (sent && fx1 && fx1.links > 0 && fx1.packets > 0) ok('fx.collab', { links: fx1.links, packets: fx1.packets });
    else fail('fx.collab', { sent, links: fx1 && fx1.links, packets: fx1 && fx1.packets });
    await shot('fx-collab');

    // 合成一个新会话（setFleet）→ 出生动画
    const spawned = await page.evaluate(() => {
      const a = window.__astra;
      const snap = a.store.getSnapshot();
      const base = snap.sessions[0];
      if (!base) return false;
      const id = `qa-new-${Date.now()}`;
      const fake = {
        ...base,
        id,
        title: 'QA 新生会话（合成）',
        state: 'live',
        parentId: null,
        depth: 0,
        turns: 0,
        steps: 0,
        lastActivityAt: Date.now(),
      };
      const sessions = [...snap.sessions, fake];
      a.scene.setFleet({
        ...snap,
        sessions,
        aggregates: { ...snap.aggregates, liveCount: snap.aggregates.liveCount + 1 },
      });
      return true;
    });
    await sleep(500);
    const fx2 = await call('debugFx');
    if (spawned && fx2 && fx2.spawns > (fx1 ? fx1.spawns : 0)) ok('fx.spawn', { before: fx1 && fx1.spawns, after: fx2 && fx2.spawns });
    else fail('fx.spawn', { before: fx1 && fx1.spawns, after: fx2 && fx2.spawns });
  }

  // ---------- theme：双主题切换 / 持久化 / 底色变化 ----------
  const theme0 = await page.evaluate(() => ({
    theme: window.__astra.theme,
    dom: document.documentElement.dataset.theme,
    ink: getComputedStyle(document.documentElement).getPropertyValue('--ink-void').trim(),
  }));
  const frameA = await frameSample();
  await page.keyboard.press('KeyT');
  await sleep(1100);
  const theme1 = await page.evaluate(() => ({
    theme: window.__astra.theme,
    dom: document.documentElement.dataset.theme,
    ink: getComputedStyle(document.documentElement).getPropertyValue('--ink-void').trim(),
    stored: (() => {
      try {
        return localStorage.getItem('xuanji.theme.v1');
      } catch {
        return null;
      }
    })(),
  }));
  const frameB = await frameSample();
  if (theme0.theme && theme1.theme && theme0.theme !== theme1.theme) ok('theme.toggle', { from: theme0.theme, to: theme1.theme });
  else fail('theme.toggle', { from: theme0.theme, to: theme1.theme });
  if (theme1.dom === theme1.theme) ok('theme.dom', { dom: theme1.dom }); else fail('theme.dom', { dom: theme1.dom });
  if (theme0.ink !== theme1.ink) ok('theme.tokens', { before: theme0.ink, after: theme1.ink });
  else fail('theme.tokens', { before: theme0.ink, after: theme1.ink });
  // 主题切换后 canvas 必须有可见变化：统计 64×36 降采样里明显变化的像素数
  if (frameA && frameB && frameA.pixels && frameB.pixels) {
    let changed = 0;
    for (let i = 0; i < frameA.pixels.length; i += 1) {
      const a = frameA.pixels[i];
      const b = frameB.pixels[i];
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 6) changed += 1;
    }
    const lumDelta = Math.abs(frameB.lum - frameA.lum) / Math.max(frameA.lum, 1e-6);
    if (changed >= 40 || lumDelta >= 0.02) ok('theme.pixels', { changedPixels: changed, lumDelta: +lumDelta.toFixed(4) });
    else fail('theme.pixels', { changedPixels: changed, lumDelta: +lumDelta.toFixed(4) });
  } else fail('theme.pixels', { reason: 'canvas 采样失败' });
  if (theme1.stored === theme1.theme) ok('theme.stored', { stored: theme1.stored }); else fail('theme.stored', { stored: theme1.stored });
  await shot('theme-scifi');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__astra && window.__astra.scene, null, { timeout: 20000 });
  await sleep(1800);
  const theme2 = await page.evaluate(() => ({
    theme: window.__astra.theme,
    dom: document.documentElement.dataset.theme,
  }));
  if (theme2.theme === theme1.theme && theme2.dom === theme1.theme) ok('theme.persist', { theme: theme2.theme });
  else fail('theme.persist', { theme: theme2.theme, expected: theme1.theme });

  // 切回璇玑
  await page.evaluate(() => {
    window.__astra.setThemeById ? window.__astra.setThemeById('xuanji') : window.__astra.setTheme('xuanji');
  });
  await sleep(800);
  const theme3 = await page.evaluate(() => ({ theme: window.__astra.theme, dom: document.documentElement.dataset.theme }));
  if (theme3.theme === 'xuanji' && theme3.dom === 'xuanji') ok('theme.back', { theme: theme3.theme });
  else fail('theme.back', { theme: theme3.theme, dom: theme3.dom });
  await page.evaluate(() => {
    try {
      localStorage.removeItem('xuanji.theme.v1');
    } catch {}
  });
  await shot('theme-xuanji');

  // ---------- errors ----------
  if (consoleErrors.length === 0) ok('errors.console', {});
  else fail('errors.console', { errors: consoleErrors.slice(0, 5) });
  if (pageErrors.length === 0) ok('errors.page', {});
  else fail('errors.page', { errors: pageErrors.slice(0, 5) });
  if (failedRequests.length === 0) ok('errors.requests', {});
  else fail('errors.requests', { list: failedRequests.slice(0, 5) });
} catch (err) {
  fail('fatal', { message: String(err && err.message ? err.message : err) });
} finally {
  const failed = Object.entries(checks)
    .filter(([, v]) => !v.pass)
    .map(([k]) => k);
  const report = { url: BASE, stamp: STAMP, checks, failed, consoleErrors, pageErrors, failedRequests, shots, ms: Date.now() - t0 };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  log('');
  if (failed.length === 0) log(`ALL PASS  （${Object.keys(checks).length} 项）`);
  else log(`FAILED ${failed.length} / ${Object.keys(checks).length}: ${failed.join(', ')}`);
  log(`report: ${join(OUT, 'report.json')}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
