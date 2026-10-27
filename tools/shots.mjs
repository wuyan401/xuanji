// 临时：v2.0 精选截图生成（交付前可用，非产品代码）
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
const ROOT = process.cwd();
const OUT = join(ROOT, 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });
const req = createRequire(join(ROOT, 'apps', 'web', 'package.json'));
const { chromium } = req('playwright-core');
const BASE = process.env.ASTRA_URL || 'http://127.0.0.1:8787';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const made = [];
async function shot(name, opts, prep) {
  const { viewport = { width: 1440, height: 900 }, dpr = 1, url = '/?boot=0' } = opts || {};
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(opts?.wait ?? 3600);
  if (prep) await prep(page);
  await page.screenshot({ path: join(OUT, name), fullPage: false });
  made.push(name);
  console.log('shot', name);
  await ctx.close();
}

// 01/02 观星主视图
await shot('01-home-wide.png', { viewport: { width: 1920, height: 1080 }, wait: 4200 });
await shot('02-home-desktop.png', { viewport: { width: 1440, height: 900 }, dpr: 1.75 });

// 03 分野聚焦（点总览首行）
await shot('03-sector-focus.png', { viewport: { width: 1440, height: 900 }, dpr: 1.75 }, async (page) => {
  const row = page.locator('[data-hud="sector-overview"] .ds-sector').first();
  if (await row.count()) await row.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1200);
});

// 04/05 运镜：逐星 / 浑仪
await shot('04-mode-track.png', { viewport: { width: 1440, height: 900 }, dpr: 1.75 }, async (page) => {
  await page.keyboard.press('2');
  await page.waitForTimeout(1800);
});
await shot('05-mode-orrery.png', { viewport: { width: 1440, height: 900 }, dpr: 1.75 }, async (page) => {
  await page.keyboard.press('5');
  await page.waitForTimeout(1800);
});

// 06 星牒档案（选中一颗在行的星）
await shot('06-dossier.png', { viewport: { width: 1440, height: 900 }, dpr: 1.75 }, async (page) => {
  await page.evaluate(() => {
    const live = window.__astra?.store?.getSessions?.()?.find?.((s) => s.state === 'live');
    if (live) window.__astra.selectSession(live.id);
  });
  await page.waitForTimeout(1200);
});

// 07 调参台
await shot('07-console.png', { viewport: { width: 1440, height: 900 }, dpr: 1.75 }, async (page) => {
  await page.keyboard.press('/');
  await page.waitForTimeout(900);
});

// 08 授时（不做 boot=0，等自检+钟鸣）
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1550);
  await page.screenshot({ path: join(OUT, '08-boot.png') });
  made.push('08-boot.png');
  console.log('shot 08-boot.png');
  await ctx.close();
}

// 09/10 移动端：主视图 / 星牒抽屉
await shot('09-mobile-home.png', { viewport: { width: 390, height: 844 }, dpr: 2, wait: 4200 });
await shot('10-mobile-sheet.png', { viewport: { width: 390, height: 844 }, dpr: 2 }, async (page) => {
  const tab = page.locator('.ds-tab');
  if (await tab.count()) await tab.first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(900);
});

// 11 静帧（motion=off）
await shot('11-still-motion-off.png', { viewport: { width: 1440, height: 900 }, dpr: 1.75, url: '/?boot=0&motion=off', wait: 4200 });

// 12/13/14 整机视图
await shot('12-system-desktop.png', { viewport: { width: 1440, height: 900 }, dpr: 1.75, url: '/?boot=0&view=system', wait: 4600 });
await shot('13-system-wide.png', { viewport: { width: 1920, height: 1080 }, url: '/?boot=0&view=system', wait: 4600 });
await shot('14-mobile-system.png', { viewport: { width: 390, height: 844 }, dpr: 2, url: '/?boot=0&view=system', wait: 4600 });

// 15 诸源筛选（点 DSH 签）
await shot('15-sources-filter.png', { viewport: { width: 1440, height: 900 }, dpr: 1.75 }, async (page) => {
  const chip = page.locator('[data-hud="source-chips"] .ds-source[data-source="dsh"]');
  if (await chip.count()) await chip.first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1000);
});

// 16/17 v2.1 视野主权：深度缩放（光标锚点）/ 手动锁定态
await shot('16-zoom-deep.png', { viewport: { width: 1440, height: 900 }, dpr: 1.75 }, async (page) => {
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.wheel(0, -1500);
  await page.waitForTimeout(1400);
});
await shot('17-camera-locked.png', { viewport: { width: 1440, height: 900 }, dpr: 1.75 }, async (page) => {
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.46);
  await page.mouse.wheel(0, -520);
  await page.waitForTimeout(1100);
});

await browser.close();
console.log('done:', made.length, 'files');
