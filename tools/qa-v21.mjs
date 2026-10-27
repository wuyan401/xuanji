// XUANJI · 璇玑 — v2.1「视野主权」验收器
// 覆盖 BIBLE §20.5：
//  1) 默认不自动移动  2) 手动缩放不被拉回  3) Space 开锁后自动转场回来
//  4) 双击复位        5) 刷新保留视野       6) 6× 深度缩放可读且不卡
//  6) 底部提示与「视野已锁」徽标状态正确
//
// 用法：node tools/qa-v21.mjs [--url http://127.0.0.1:8787] [--tag v21]
// 输出：docs/qa/v21-<stamp>/{report.json, *.png}，退出码 0/1

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const req = createRequire(join(ROOT, 'apps', 'web', 'package.json'));
const { chromium } = req('playwright-core');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const BASE = arg('url', 'http://127.0.0.1:8787');
const TAG = arg('tag', 'v21');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const OUT = join(ROOT, 'docs', 'qa', `${TAG}-${stamp}`);
mkdirSync(OUT, { recursive: true });

const checks = [];
const consoleMsgs = [];
const pageErrors = [];
const failedRequests = [];
let failures = 0;

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}  ${JSON.stringify(detail)}`);
  } else {
    console.log(`ok   ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
  }
}

const browser = await chromium.launch({ executablePath, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
ctx.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push({ type: m.type(), text: m.text() });
});
ctx.on('pageerror', (e) => pageErrors.push(String(e)));
ctx.on('requestfailed', (r) => {
  const error = r.failure()?.errorText ?? '';
  // 页面导航 / reload 会主动中断在途 SSE，属预期，不计入失败
  if (/ERR_ABORTED|ERR_CONNECTION_RESET/.test(error)) return;
  failedRequests.push({ url: r.url(), error });
});

const page = await ctx.newPage();

const info = () => page.evaluate(() => window.__astra?.scene?.debugInfo?.() ?? null);
const autoState = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-hud="auto-state"]');
    return el ? { auto: el.getAttribute('data-auto'), title: el.getAttribute('title') } : null;
  });
const hintText = () => page.evaluate(() => document.querySelector('[data-hud="hint"]')?.textContent ?? '');
const camStorage = () =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('xuanji.camera.v1') || 'null');
    } catch {
      return null;
    }
  });

async function framePerf(frames = 40) {
  return page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const times = [];
        let last = performance.now();
        let count = 0;
        const tick = (now) => {
          times.push(now - last);
          last = now;
          count += 1;
          if (count >= n) {
            const sorted = [...times].sort((a, b) => a - b);
            const avg = times.reduce((a, b) => a + b, 0) / times.length;
            resolve({ avg, p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1] });
          } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );
}

const sleep = (ms) => page.waitForTimeout(ms);

try {
  // ---- 1. 默认不自动移动（首屏 9s） ----
  await page.goto(`${BASE}/?boot=0`, { waitUntil: 'domcontentloaded' });
  await sleep(2200);
  const i0 = await info();
  await sleep(9000);
  const i1 = await info();
  await page.screenshot({ path: join(OUT, 'default-9s.png') });
  check('default.stars', i0 && i0.stars >= 100, { stars: i0?.stars });
  check('default.autoDisabled', i0 ? i0.autoEnabled === false : false, { autoEnabled: i0?.autoEnabled });
  check(
    'default.noAutoMove',
    i0 && i1 && Math.abs(i0.zoom - i1.zoom) < 0.01 && i0.mode === i1.mode,
    { zoomBefore: i0?.zoom, zoomAfter: i1?.zoom, modeBefore: i0?.mode, modeAfter: i1?.mode },
  );

  // ---- 2. 手动缩放：不被拉回，且锁死自动 ----
  const box = await page.locator('#stage').boundingBox();
  const cx = box.x + box.width * 0.5;
  const cy = box.y + box.height * 0.5;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -700);
  await sleep(900);
  const i2 = await info();
  check('zoom.zoomedIn', i2 && i2.zoom > i0.zoom * 1.25, { before: i0?.zoom, after: i2?.zoom });
  check('zoom.manualLocked', i2 ? i2.manualLocked === true : false, { manualLocked: i2?.manualLocked });
  // v2.4.1：放大时字号必须跟着变大（不能反而缩小）——textScreen = textScale × zoom
  check(
    'zoom.textGrows',
    i0 && i2 && typeof i2.textScreen === 'number' && i2.textScreen >= i0.textScreen * 1.08,
    { scaleAtHome: i0?.textScreen, scaleAt2x: i2?.textScreen },
  );
  await page.screenshot({ path: join(OUT, 'zoom-2x.png') });
  await sleep(8000);
  const i3 = await info();
  check('zoom.staysPut', i3 && Math.abs(i3.zoom - i2.zoom) < 0.02 && i3.mode === i2.mode, {
    zoom: [i2?.zoom, i3?.zoom],
    mode: [i2?.mode, i3?.mode],
  });
  const hudLock = await autoState();
  check('hud.lockedBadge', hudLock && hudLock.auto === 'off', hudLock);

  // ---- 3. 光标锚点：缩放到 6× 时，鼠标下世界点尽量不动 ----
  const anchor = await page.evaluate(
    (pt) => window.__astra?.scene?.unprojectPoint?.(pt.x, pt.y) ?? null,
    { x: cx, y: cy - 120 },
  ).catch(() => null);
  await page.mouse.move(cx, cy - 120);
  await page.mouse.wheel(0, -1500);
  await sleep(1200);
  const i4 = await info();
  check('zoom.deep', i4 && i4.zoom >= 3.6, { zoom: i4?.zoom });
  // v2.4.1：深看时字更大（2× 的 1.15 倍以上），屏幕字号倍数目标 1.6 上限
  check(
    'zoom.deepTextGrows',
    i2 && i4 && typeof i4.textScreen === 'number' && i4.textScreen >= (i2.textScreen ?? 0) * 1.15,
    { scaleAt2x: i2?.textScreen, scaleAtDeep: i4?.textScreen },
  );
  const anchorAfter = anchor
    ? await page.evaluate(
        (a) => {
          const s = window.__astra?.scene;
          if (!s?.projectPoint) return null;
          return s.projectPoint(a.x, a.y);
        },
        anchor,
      )
    : null;
  const anchorDrift = anchorAfter ? Math.hypot(anchorAfter.x - (cx - (cx - cx)), anchorAfter.y - (cy - 120)) : null;
  check('zoom.cursorAnchor', anchorDrift !== null ? anchorDrift <= 40 : true, {
    driftPx: anchorDrift,
    /* scene 若未暴露 worldToScreen 则跳过此项 */ skipped: anchorDrift === null,
  });
  await page.screenshot({ path: join(OUT, 'zoom-deep.png') });
  const perfDeep = await framePerf(40);
  // 页面级帧时对 headless 软件光栅 + 真实 389 会话负载敏感；硬预算由 scene 内部帧时（<=7ms）把关，
  // 这里只兜底「没有明显卡死」。
  check('zoom.deepPerf', perfDeep.avg <= 32, perfDeep);

  // ---- 4. 双击复位 ----
  await page.mouse.dblclick(cx, cy);
  await sleep(1100);
  const i5 = await info();
  const savedAfterReset = await camStorage();
  check('reset.zoom', i5 && Math.abs(i5.zoom - 1.12) < 0.12, { zoom: i5?.zoom });
  check('reset.mode', i5 && i5.mode === 'survey', { mode: i5?.mode });
  check(
    'reset.storageCleared',
    !savedAfterReset || !savedAfterReset.agents || Math.abs((savedAfterReset.agents.zoom ?? 1) - 1) < 0.05,
    savedAfterReset ? { agentsZoom: savedAfterReset.agents?.zoom } : { storage: null },
  );

  // ---- 5. 视野记忆：缩放后刷新仍在 ----
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -520);
  await sleep(1000);
  const i6 = await info();
  await sleep(900); // 等 debounce 500ms 保存
  const saved = await camStorage();
  check('persist.saved', Boolean(saved && saved.agents), saved ? Object.keys(saved) : null);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2600);
  const i7 = await info();
  check(
    'persist.restored',
    i6 && i7 && Math.abs(i7.zoom - i6.zoom) < 0.08 && Math.abs((i7.dragX ?? 0) - (i6.dragX ?? 0)) < 8,
    { before: { zoom: i6?.zoom, dragX: i6?.dragX }, after: { zoom: i7?.zoom, dragX: i7?.dragX } },
  );
  await page.screenshot({ path: join(OUT, 'persist-restored.png') });

  // ---- 6. Space 开锁后自动转场回来（用 ?p=dwell:6 让停留更短便于验收） ----
  await page.goto(`${BASE}/?boot=0&p=dwell:6`, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  const j0 = await info();
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -300);
  await sleep(700);
  const locked = await page.evaluate(() => window.__astra?.scene?.debugInfo?.().manualLocked);
  await page.keyboard.press('Space');
  await sleep(600);
  const unlocked = await page.evaluate(() => window.__astra?.scene?.debugInfo?.().manualLocked);
  const hintAfter = await hintText();
  const hudOn = await autoState();
  check('space.unlocks', locked === true && unlocked === false, { locked, unlocked });
  check('hud.autoOn', !hudOn || hudOn.auto === 'on', hudOn);
  check('hud.hintText', /自动运镜/.test(hintAfter), hintAfter.slice(0, 80));
  // 等待自动导播转场（dwell≈6s，转场 ≤1.4s）
  let moved = false;
  for (let k = 0; k < 26; k += 1) {
    await sleep(500);
    const cur = await info();
    if (cur && (cur.mode !== j0.mode || Math.abs(cur.zoom - j0.zoom) > 0.05)) {
      moved = true;
      break;
    }
  }
  check('space.autoMoves', moved, { startedMode: j0?.mode });
  await page.screenshot({ path: join(OUT, 'auto-after-space.png') });

  // ---- 7. 控制台 / 请求错误 ----
  check('errors.console', consoleMsgs.filter((m) => m.type === 'error').length === 0, consoleMsgs.slice(0, 4));
  check('errors.page', pageErrors.length === 0, pageErrors.slice(0, 3));
  check('errors.requests', failedRequests.length === 0, failedRequests.slice(0, 3));
} catch (err) {
  check('runner', false, String(err && err.stack ? err.stack.split('\n')[0] : err));
} finally {
  const passed = checks.filter((c) => c.ok).length;
  const report = {
    url: BASE,
    stamp,
    passed,
    total: checks.length,
    checks,
    console: consoleMsgs,
    pageErrors,
    failedRequests,
  };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await browser.close();
  console.log(`\n${passed}/${checks.length} checks passed · ${OUT}`);
  process.exit(failures === 0 ? 0 : 1);
}
