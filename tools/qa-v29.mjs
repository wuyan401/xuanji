#!/usr/bin/env node
/**
 * 璇玑 v2.9 验收器：面板收放（起居注 / 机枢 / 工籍 可收起，器牒修复可收起）。
 *
 * 用法：
 *   node tools/qa-v29.mjs                                 # 打 8787（生产 dist）
 *   node tools/qa-v29.mjs --url http://127.0.0.1:5173     # 打 dev（vite proxy + mock）
 *
 * 设计权威：docs/DESIGN-BIBLE.md §28（v2.9）。
 * 输出：docs/qa/v29-<stamp>/report.json + 截图；退出码 0=全 PASS，1=有失败。
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
const OUT = join(ROOT, 'docs', 'qa', `v29-${STAMP}`);
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

/** 面板定义：key / 视图 / 面板选择器 / 收放按钮候选选择器 / 收起后尺寸上限 */
const PANELS = {
  ledger: {
    view: '',
    panel: '.led',
    buttons: ['[data-hud="ledger-collapse"]', '[data-hud="ledger-grip"]'],
    aria: /起居注/,
    max: { w: 260, h: 70 },
  },
  system: {
    view: '?boot=0&view=system',
    panel: '[data-hud="system-panel"]',
    buttons: ['[data-hud="system-collapse"]'],
    aria: /机枢/,
    max: { w: 260, h: 70 },
  },
  worklist: {
    view: '?boot=0&view=processes',
    panel: '[data-hud="process-list"]',
    buttons: ['[data-hud="worklist-collapse"]'],
    aria: /工籍/,
    max: { w: 260, h: 70 },
  },
  procdetail: {
    view: '?boot=0&view=processes',
    panel: '[data-hud="process-detail"]',
    buttons: ['[data-hud="procdetail-collapse"]'],
    aria: /器牒/,
    max: { w: 40, h: 9999 },
  },
};

function rectOf(sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), display: cs.display, vis: cs.visibility, hidden: el.hasAttribute('hidden') || r.width === 0 };
  }, sel);
}

/** 找到可见的收起按钮并返回 {selector, rect} */
async function findButton(def) {
  for (const sel of def.buttons) {
    const r = await rectOf(sel);
    if (r && r.w >= 16 && r.display !== 'none') return { selector: sel, rect: r };
  }
  // 退路：aria-label 含关键词的按钮
  const fallback = await page.evaluate((reSource) => {
    const re = new RegExp(reSource);
    const btns = [...document.querySelectorAll('button')].filter((b) => re.test(b.getAttribute('aria-label') || '') && b.getBoundingClientRect().width >= 16);
    if (!btns.length) return null;
    const b = btns[0];
    b.setAttribute('data-qa-collapse', '1');
    const r = b.getBoundingClientRect();
    return {
      selector: '[data-qa-collapse="1"]',
      aria: b.getAttribute('aria-label'),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(b).display },
    };
  }, def.aria.source);
  return fallback;
}

async function clickSel(sel) {
  await page.click(sel, { timeout: 4000 });
  await sleep(420);
}

const tabVisible = async (sel) => {
  const r = await rectOf(sel);
  return !!(r && r.display !== 'none' && r.w > 0);
};

try {
  // ── 1. 智能体：起居注 ─────────────────────────────────────────────
  log('\n== ledger ==');
  await goto('?boot=0');
  const ledgerBtn = await findButton(PANELS.ledger);
  if (ledgerBtn && ledgerBtn.rect.w >= 16) ok('panels.visible.ledger', { selector: ledgerBtn.selector, rect: ledgerBtn.rect });
  else fail('panels.visible.ledger', { ledgerBtn });
  const before = await rectOf(PANELS.ledger.panel);
  await shot('01-ledger-open.png');
  if (ledgerBtn) {
    await clickSel(ledgerBtn.selector);
    const collapsed = await rectOf(PANELS.ledger.panel);
    const aria = await page.evaluate((s) => document.querySelector(s)?.getAttribute('aria-expanded') ?? null, ledgerBtn.selector);
    const collapsedOk = collapsed && (collapsed.w <= PANELS.ledger.max.w || collapsed.h <= PANELS.ledger.max.h);
    if (collapsedOk) ok('panels.collapse.ledger', { before, collapsed, aria });
    else fail('panels.collapse.ledger', { before, collapsed, aria });
    await shot('02-ledger-collapsed.png');
    await clickSel(ledgerBtn.selector);
    const restored = await rectOf(PANELS.ledger.panel);
    const restoredOk = restored && Math.abs(restored.w - before.w) <= 6 && Math.abs(restored.h - before.h) <= 6;
    if (restoredOk) ok('panels.expand.ledger', { restored });
    else fail('panels.expand.ledger', { before, restored });
  }

  // ── 2. 整机：机枢 ────────────────────────────────────────────────
  log('\n== system ==');
  await goto(PANELS.system.view);
  const sysBtn = await findButton(PANELS.system);
  if (sysBtn && sysBtn.rect.w >= 16) ok('panels.visible.system', { selector: sysBtn.selector, rect: sysBtn.rect });
  else fail('panels.visible.system', { sysBtn });
  if (sysBtn) {
    const b = await rectOf(PANELS.system.panel);
    await clickSel(sysBtn.selector);
    const c = await rectOf(PANELS.system.panel);
    if (c && (c.w <= PANELS.system.max.w || c.h <= PANELS.system.max.h)) ok('panels.collapse.system', { before: b, collapsed: c });
    else fail('panels.collapse.system', { before: b, collapsed: c });
    await shot('03-system-collapsed.png');
    await clickSel(sysBtn.selector);
    const r = await rectOf(PANELS.system.panel);
    if (r && (!b || (Math.abs(r.w - b.w) <= 6 && Math.abs(r.h - b.h) <= 6))) ok('panels.expand.system', { restored: r });
    else fail('panels.expand.system', { before: b, restored: r });
  }

  // ── 3. 百工：工籍 + 器牒 ─────────────────────────────────────────
  log('\n== processes ==');
  await goto(PANELS.worklist.view);
  const workBtn = await findButton(PANELS.worklist);
  if (workBtn && workBtn.rect.w >= 16) ok('panels.visible.worklist', { selector: workBtn.selector, rect: workBtn.rect });
  else fail('panels.visible.worklist', { workBtn });
  if (workBtn) {
    const b = await rectOf(PANELS.worklist.panel);
    await clickSel(workBtn.selector);
    const c = await rectOf(PANELS.worklist.panel);
    if (c && (c.w <= PANELS.worklist.max.w || c.h <= PANELS.worklist.max.h)) ok('panels.collapse.worklist', { before: b, collapsed: c });
    else fail('panels.collapse.worklist', { before: b, collapsed: c });
    await shot('04-worklist-collapsed.png');
    await clickSel(workBtn.selector);
    const r = await rectOf(PANELS.worklist.panel);
    if (r && (!b || (Math.abs(r.w - b.w) <= 6 && Math.abs(r.h - b.h) <= 6))) ok('panels.expand.worklist', { restored: r });
    else fail('panels.expand.worklist', { before: b, restored: r });
  }

  // 器牒：× 必须真正收起，且出现可展开的竖签
  const procBtn = await findButton(PANELS.procdetail);
  if (procBtn && procBtn.rect.w >= 16) ok('panels.visible.procdetail', { selector: procBtn.selector, rect: procBtn.rect });
  else fail('panels.visible.procdetail', { procBtn });
  const pdBefore = await rectOf(PANELS.procdetail.panel);
  if (procBtn) await clickSel(procBtn.selector);
  const pdCollapsed = await rectOf(PANELS.procdetail.panel);
  const tabR = await page.evaluate(() => {
    const t = document.querySelector('.pd-tab') || document.querySelector('[data-hud="procdetail-tab"]');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    const cs = getComputedStyle(t);
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), display: cs.display };
  });
  const pdOk = (!pdCollapsed || pdCollapsed.hidden || pdCollapsed.w <= PANELS.procdetail.max.w) && tabR && tabR.display !== 'none' && tabR.w > 0;
  if (pdOk) ok('panels.collapse.procdetail', { before: pdBefore, collapsed: pdCollapsed, tab: tabR });
  else fail('panels.collapse.procdetail', { before: pdBefore, collapsed: pdCollapsed, tab: tabR });
  await shot('05-procdetail-collapsed.png');
  if (tabR && tabR.display !== 'none') {
    await page.click('.pd-tab', { timeout: 4000 });
    await sleep(420);
    const back = await rectOf(PANELS.procdetail.panel);
    if (back && back.w >= 200) ok('panels.expand.procdetail', { restored: back });
    else fail('panels.expand.procdetail', { restored: back });
  }

  // ── 4. 持久化：收起起居注 → 刷新 → 仍收起；再展开 → 刷新仍展开 ──
  log('\n== persist ==');
  await goto('?boot=0');
  const lb2 = await findButton(PANELS.ledger);
  if (lb2) {
    await clickSel(lb2.selector);
    const stored = await page.evaluate(() => localStorage.getItem('xuanji.panels.v1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2600);
    const afterReload = await rectOf(PANELS.ledger.panel);
    const lb3 = await findButton(PANELS.ledger);
    const aria = lb3 ? await page.evaluate((s) => document.querySelector(s)?.getAttribute('aria-expanded') ?? null, lb3.selector) : null;
    const stillCollapsed = afterReload && afterReload.h <= PANELS.ledger.max.h;
    if (stored && stillCollapsed) ok('panels.persist', { stored, afterReload, aria });
    else fail('panels.persist', { stored, afterReload, aria });
    if (lb3) {
      await clickSel(lb3.selector);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2400);
      const back = await rectOf(PANELS.ledger.panel);
      if (back && back.h > PANELS.ledger.max.h) ok('panels.persist.expanded', { back });
      else fail('panels.persist.expanded', { back });
    }
  } else fail('panels.persist', { note: '收起按钮未找到' });

  // ── 5. 键盘 [ / ] ───────────────────────────────────────────────
  log('\n== keys ==');
  await page.evaluate(() => localStorage.removeItem('xuanji.panels.v1'));
  await goto('?boot=0&reset=1');
  const ledBefore = await rectOf('.led');
  await page.keyboard.press('BracketLeft');
  await sleep(420);
  const ledAfter = await rectOf('.led');
  await page.keyboard.press('BracketLeft');
  await sleep(420);
  const ledBack = await rectOf('.led');
  const key1 = ledBefore && ledAfter && ledAfter.h <= PANELS.ledger.max.h && ledBack && Math.abs(ledBack.h - ledBefore.h) <= 6;
  if (key1) ok('panels.keys.bracketLeft', { before: ledBefore, collapsed: ledAfter, restored: ledBack });
  else fail('panels.keys.bracketLeft', { before: ledBefore, collapsed: ledAfter, restored: ledBack });

  await goto('?boot=0&view=processes&reset=1');
  const pdBefore2 = await rectOf('[data-hud="process-detail"]');
  await page.keyboard.press('BracketRight');
  await sleep(420);
  const pdAfter = await rectOf('[data-hud="process-detail"]');
  const tab2 = await tabVisible('.pd-tab');
  await page.keyboard.press('BracketRight');
  await sleep(420);
  const pdBack = await rectOf('[data-hud="process-detail"]');
  const key2 = pdBefore2 && pdAfter && (pdAfter.hidden || pdAfter.w <= 40) && tab2 && pdBack && pdBack.w >= 200;
  if (key2) ok('panels.keys.bracketRight', { before: pdBefore2, collapsed: pdAfter, tab: tab2, restored: pdBack });
  else fail('panels.keys.bracketRight', { before: pdBefore2, collapsed: pdAfter, tab: tab2, restored: pdBack });

  // ── 6. 移动端不回归 ─────────────────────────────────────────────
  log('\n== mobile ==');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2800);
  const mobile = await page.evaluate(() => ({
    hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    hasLedger: !!document.querySelector('.led'),
    hasList: !!document.querySelector('[data-hud="process-list"]'),
    view: window.__astra?.view ?? null,
  }));
  const mshot = join(OUT, '06-mobile.png');
  await page.screenshot({ path: mshot });
  shots.push(mshot);
  if (mobile.hscroll <= 1 && mobile.hasLedger && mobile.hasList) ok('panels.mobile', mobile);
  else fail('panels.mobile', mobile);
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── 7. 错误 ─────────────────────────────────────────────────────
  log('\n== errors ==');
  if (!consoleErrors.length && !pageErrors.length && !failedRequests.length) ok('errors.clean', { n: 0 });
  else fail('errors.clean', { console: consoleErrors, page: pageErrors, failed: failedRequests });
} catch (e) {
  fail('fatal', { message: String(e && e.stack ? e.stack : e) });
} finally {
  const passed = Object.values(checks).filter((c) => c.pass).length;
  const failed = Object.values(checks).filter((c) => !c.pass).length;
  writeFileSync(
    join(OUT, 'report.json'),
    JSON.stringify({ url: BASE, stamp: STAMP, checks, shots, console: consoleErrors, pageErrors, failedRequests, summary: { passed, failed, total: passed + failed } }, null, 2),
  );
  log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  （${passed} 项）`);
  log(`report: ${join(OUT, 'report.json')}`);
  await browser.close();
  process.exit(failed === 0 ? 0 : 1);
}
