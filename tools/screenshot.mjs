#!/usr/bin/env node
// 璇玑 QA 截图器：用系统 Chrome（playwright-core，无需下载浏览器）抓取页面并收集控制台错误。
//
// 用法：
//   node tools/screenshot.mjs                         # 默认 http://127.0.0.1:8787/ ，3 个视口
//   node tools/screenshot.mjs --url "http://127.0.0.1:8787/?demo=1&boot=0"
//   node tools/screenshot.mjs --set wide --wait 6000 --name demo
//   node tools/screenshot.mjs --tag before --set mobile
//
// 输出：docs/qa/<tag>-<timestamp>/{home-wide.png, home-desktop.png, home-mobile.png, report.json}

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// playwright-core 是 apps/web 的开发依赖；从 workspace 根运行时要按包路径解析。
const webRequire = createRequire(join(ROOT, 'apps', 'web', 'package.json'));
const { chromium } = webRequire('playwright-core');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const VIEWPORTS = {
  wide: { width: 1920, height: 1080, dpr: 1 },
  desktop: { width: 1440, height: 900, dpr: 1 },
  laptop: { width: 1280, height: 800, dpr: 1 },
  mobile: { width: 390, height: 844, dpr: 2, isMobile: true, hasTouch: true },
};

function parseArgs(argv) {
  const out = {
    url: 'http://127.0.0.1:8787/',
    sets: ['wide', 'desktop', 'mobile'],
    wait: 4500,
    name: 'home',
    tag: 'qa',
    outDir: null,
    fullPage: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') out.url = next();
    else if (a === '--set') out.sets = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--wait') out.wait = Number(next());
    else if (a === '--name') out.name = next();
    else if (a === '--tag') out.tag = next();
    else if (a === '--out') out.outDir = next();
    else if (a === '--full') out.fullPage = true;
  }
  return out;
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge：' + CHROME_CANDIDATES.join(' | '));
}

const args = parseArgs(process.argv.slice(2));
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\..+/, '')
  .replace('T', '-');
const outDir = args.outDir ?? join(ROOT, 'docs', 'qa', `${args.tag}-${stamp}`);
mkdirSync(outDir, { recursive: true });

const report = { url: args.url, stamp, viewport: null, shots: [], console: [], pageErrors: [], failedRequests: [] };

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--disable-lcd-text'],
});

try {
  for (const setName of args.sets) {
    const vp = VIEWPORTS[setName];
    if (!vp) throw new Error(`未知视口 ${setName}，可选：${Object.keys(VIEWPORTS).join(',')}`);
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dpr ?? 1,
      isMobile: Boolean(vp.isMobile),
      hasTouch: Boolean(vp.hasTouch),
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        report.console.push({ set: setName, type: msg.type(), text: msg.text() });
      }
    });
    page.on('pageerror', (err) => report.pageErrors.push({ set: setName, message: err.message }));
    page.on('requestfailed', (req) =>
      report.failedRequests.push({ set: setName, url: req.url(), error: req.failure()?.errorText }),
    );

    const t0 = Date.now();
    await page.goto(args.url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(args.wait);
    const file = join(outDir, `${args.name}-${setName}.png`);
    await page.screenshot({ path: file, fullPage: args.fullPage });
    const metrics = await page
      .evaluate(() => {
        const a = window.__astra;
        const canvas = document.querySelector('#stage canvas');
        return {
          title: document.title,
          canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
          sessions: a?.store?.getSessions?.().length ?? null,
          events: a?.store?.getEvents?.().length ?? null,
          connection: a?.store?.getConnection?.() ?? null,
          source: a?.store?.getSnapshot?.()?.source ?? null,
          aggregates: a?.store?.getAggregates?.() ?? null,
          params: a?.params ?? null,
          hudHtmlLength: document.getElementById('hud')?.innerHTML.length ?? 0,
        };
      })
      .catch((err) => ({ evalError: String(err) }));
    report.shots.push({ set: setName, file, waitMs: args.wait, ms: Date.now() - t0, metrics });
    console.log(`[shot] ${setName} -> ${file}`);
    await context.close();
  }
} finally {
  await browser.close();
}

writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
const errCount = report.pageErrors.length + report.console.filter((c) => c.type === 'error').length;
console.log(`[report] ${join(outDir, 'report.json')}`);
if (errCount) {
  console.log(`[warn] ${errCount} 个页面错误/控制台错误，详见 report.json`);
  for (const e of report.pageErrors.slice(0, 5)) console.log('  pageerror:', e.message);
  for (const c of report.console.filter((x) => x.type === 'error').slice(0, 5)) console.log('  console:', c.text);
}
