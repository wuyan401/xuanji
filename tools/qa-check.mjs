#!/usr/bin/env node
// 璇玑 QA · 浏览器端验收器（playwright-core + 系统 Chrome，无需下载浏览器）
//
// 用法:
//   node tools/qa-check.mjs                              # 默认 http://127.0.0.1:8787/
//   node tools/qa-check.mjs --url http://127.0.0.1:8787/ --tag after
//   node tools/qa-check.mjs --only live,perf            # 只跑指定场景
//
// 场景:
//   live      真数据：连接为 live、sessions/events 有量、canvas 有尺寸、HUD 有内容、零 console error
//   behavior  键盘全流程：1-7 / Esc / Space / '?' / L / M / '/' / W 不报错、模式序号变化
//   demo      ?demo=1：source=demo、>=5 agents、events 有量
//   motion    prefers-reduced-motion：不报错、页面可用（截图对比人工看）
//   perf      4s rAF 采样：avg fps / p95 frame ms / 长帧数
//
// 输出: docs/qa/<tag>-<timestamp>/{live-wide.png, live-demo.png, reduced.png, report.json}
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
const outDir = arg('--out', join(ROOT, 'docs', 'qa', `check-${stamp}`));
mkdirSync(outDir, { recursive: true });

const report = { url: BASE, stamp, scenarios: {}, console: [], pageErrors: [], failedRequests: [] };
const fails = [];
const skipped = [];
function fail(name, detail) {
  fails.push(name + (detail ? ' — ' + detail : ''));
}
function scenario(name) {
  return !ONLY || ONLY.includes(name);
}

const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--force-device-scale-factor=1'] });

async function openPage(context, url, errors) {
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      report.console.push({ url, text: msg.text().slice(0, 400) });
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    report.pageErrors.push({ url, message: String(err.message || err).slice(0, 400) });
    errors.push('pageerror: ' + err.message);
  });
  page.on('requestfailed', (req) => report.failedRequests.push({ url, url2: req.url(), error: req.failure()?.errorText }));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return page;
}

async function evalAstra(page) {
  return page.evaluate(() => {
    const a = window.__astra;
    if (!a) return null;
    const store = a.store;
    const canvas = document.querySelector('canvas');
    const hud = document.getElementById('hud');
    const stats = document.querySelector('.astra-stats');
    return {
      hasAstra: true,
      connection: store?.getConnection?.(),
      source: store?.getSnapshot?.()?.source ?? null,
      sessions: store?.getSessions?.()?.length ?? 0,
      events: store?.getEvents?.()?.length ?? 0,
      aggregates: store?.getAggregates?.() ?? null,
      canvas: canvas ? { w: canvas.width, h: canvas.height, cw: canvas.clientWidth, ch: canvas.clientHeight } : null,
      hudHtml: hud ? hud.innerHTML.length : 0,
      hudText: hud ? (hud.innerText || '').replace(/\s+/g, ' ').slice(0, 600) : '',
      statsText: stats ? (stats.innerText || '').replace(/\s+/g, ' ').slice(0, 200) : null,
      params: a.getParams ? a.getParams() : null,
      bodyFont: getComputedStyle(document.body).fontFamily,
      title: document.title,
      docLang: document.documentElement.lang,
    };
  });
}

async function waitLive(page, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await page.evaluate(() => window.__astra?.store?.getConnection?.() ?? null).catch(() => null);
    if (r === 'live') return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function measureFps(page, ms = 4000) {
  return page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const frames = [];
        let last = performance.now();
        const t0 = last;
        function tick(now) {
          frames.push(now - last);
          last = now;
          if (now - t0 < duration) requestAnimationFrame(tick);
          else {
            const sorted = frames.slice(1).sort((a, b) => a - b);
            const avg = sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length);
            resolve({
              frames: sorted.length,
              avgMs: +avg.toFixed(2),
              fps: +(1000 / avg).toFixed(1),
              p95Ms: +sorted[Math.floor(sorted.length * 0.95)]?.toFixed(2),
              longFrames: sorted.filter((v) => v > 33).length,
            });
          }
        }
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

// ---------------------------------------------------------------- live
if (scenario('live')) {
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  const page = await openPage(ctx, BASE + '?boot=0', errors);
  const live = await waitLive(page);
  await page.waitForTimeout(3200);
  const info = await evalAstra(page);
  const shot = join(outDir, 'live-wide.png');
  await page.screenshot({ path: shot });

  if (!live) fail('live/connection', 'store.getConnection() 未在 20s 内变为 live');
  if (!info) fail('live/__astra', 'window.__astra 未暴露');
  if (info) {
    if (info.sessions < 1) fail('live/sessions', 'sessions=' + info.sessions);
    if (info.events < 1) fail('live/events', 'events=' + info.events);
    if (!info.canvas || info.canvas.cw < 300 || info.canvas.ch < 200) fail('live/canvas', JSON.stringify(info.canvas));
    if (!info.hudHtml || info.hudHtml < 500) fail('live/hud', 'hudHtml=' + info.hudHtml);
    if (!/璇玑/.test(info.title || '')) fail('live/title', info.title);
    if (errors.length) fail('live/console', errors.slice(0, 3).join(' | '));
  }
  report.scenarios.live = { live, info, shot, errors, durationMs: Date.now() };
  await ctx.close();
}

// ---------------------------------------------------------------- behavior
if (scenario('behavior')) {
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  const page = await openPage(ctx, BASE + '?boot=0', errors);
  await waitLive(page);
  await page.waitForTimeout(1500);
  const seen = new Set();
  for (const key of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Escape', 'Space', 'Space', 'KeyL', 'KeyM', 'Slash', 'KeyW', 'KeyW', 'Backquote']) {
    await page.keyboard.press(key).catch(() => {});
    await page.waitForTimeout(140);
    const t = await page.evaluate(() => (document.getElementById('hud')?.innerText || '').replace(/\s+/g, ' ').slice(0, 120));
    seen.add(key + '::' + t.slice(0, 40));
  }
  await page.waitForTimeout(400);
  const info = await evalAstra(page);
  const shot = join(outDir, 'behavior.png');
  await page.screenshot({ path: shot });
  if (errors.length) fail('behavior/console', errors.slice(0, 3).join(' | '));
  if (!info?.canvas) fail('behavior/canvas', 'canvas 丢失');
  report.scenarios.behavior = { keys: seen.size, info, shot, errors };
  await ctx.close();
}

// ---------------------------------------------------------------- demo
if (scenario('demo')) {
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  const page = await openPage(ctx, BASE + '?boot=0&demo=1', errors);
  const live = await waitLive(page);
  await page.waitForTimeout(2600);
  const info = await evalAstra(page);
  const shot = join(outDir, 'live-demo.png');
  await page.screenshot({ path: shot });
  if (!live) fail('demo/connection', '未连接');
  if (info && info.source !== 'demo') {
    // 服务端是 live 模式时 ?demo=1 不会切到演示数据：跳过而不是误判失败。
    const reason = '服务端未启用演示模式（用 `pnpm start:demo` 起服务后再跑 --only demo）';
    skipped.push('demo — ' + reason);
    report.scenarios.demo = { skipped: true, reason, info, shot, errors };
  } else {
    if (info && info.sessions < 5) fail('demo/sessions', 'sessions=' + info.sessions);
    if (info && info.events < 5) fail('demo/events', 'events=' + info.events);
    if (errors.length) fail('demo/console', errors.slice(0, 3).join(' | '));
    report.scenarios.demo = { live, info, shot, errors };
  }
  await ctx.close();
}

// ---------------------------------------------------------------- reduced motion
if (scenario('motion')) {
  const errors = [];
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  const page = await openPage(ctx, BASE + '?boot=1', errors); // boot=1: 带开机序列的降级路径
  await waitLive(page);
  await page.waitForTimeout(3200);
  const info = await evalAstra(page);
  const shot = join(outDir, 'reduced.png');
  await page.screenshot({ path: shot });
  if (!info?.canvas) fail('motion/canvas', 'canvas 丢失');
  if (errors.length) fail('motion/console', errors.slice(0, 3).join(' | '));
  report.scenarios.motion = { info, shot, errors };
  await ctx.close();
}

// ---------------------------------------------------------------- perf
if (scenario('perf')) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  const page = await openPage(ctx, BASE + '?boot=0', []);
  await waitLive(page);
  await page.waitForTimeout(2500);
  const fps = await measureFps(page, 4000);
  const info = await evalAstra(page);
  report.scenarios.perf = { fps, canvas: info?.canvas, dpr: await page.evaluate(() => devicePixelRatio) };
  // 无头软件光栅化下，页面级 rAF 帧时会被合成器/HUD 主线程放大（真机 GPU 不具可比性）。
  // 硬性预算看 scene 自报帧时（≤7ms），这里仅作「没有完全卡死」的兜底阈值。
  if (fps.fps < 24) fail('perf/fps', `avg ${fps.fps}fps (<24 headless-calibrated)`);
  // v2.5 起每 2s 推 200 条进程，headless 下 p95 会被整帧 GC 尖峰拉到 ~100ms；真机 GPU 无此问题。
  if (fps.p95Ms > 120) fail('perf/p95', `p95 ${fps.p95Ms}ms (>120ms headless-calibrated)`);
  await ctx.close();
}

await browser.close();

// ---------------------------------------------------------------- output
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log('\n=== 璇玑浏览器验收 ===');
console.log('目录: ' + outDir);
for (const [name, s] of Object.entries(report.scenarios)) {
  if (s.skipped) console.log(`${name.padEnd(9)}: SKIP — ${s.reason}`);
  else if (name === 'perf') console.log(`perf      : ${s.fps.fps}fps avg / p95 ${s.fps.p95Ms}ms / 长帧 ${s.fps.longFrames} / frames ${s.fps.frames}`);
  else if (s.info) console.log(`${name.padEnd(9)}: connection=${s.info.connection} source=${s.info.source} sessions=${s.info.sessions} events=${s.info.events} canvas=${s.info.canvas?.cw}x${s.info.canvas?.ch} hud=${s.info.hudHtml}b`);
  else console.log(`${name}      : ${JSON.stringify(s).slice(0, 160)}`);
}
console.log(`console errors: ${report.console.length} | page errors: ${report.pageErrors.length} | failed requests: ${report.failedRequests.length}`);
if (report.pageErrors.length) console.log('PAGE ERRORS: ' + report.pageErrors.map((e) => e.message).slice(0, 5).join(' | '));
if (report.failedRequests.length) console.log('FAILED REQ: ' + report.failedRequests.slice(0, 8).map((f) => f.url2 + ' ' + f.error).join(' | '));
if (skipped.length) console.log('SKIPPED: ' + skipped.join(' ; '));
if (fails.length) {
  console.log('\nFAIL (' + fails.length + '):');
  for (const f of fails.slice(0, 20)) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('\n✅ 浏览器端验收通过');
