#!/usr/bin/env node
/** Reproducible resource audit. No real session data is exported: fixtures/reports stay in ignored docs/qa.
 * node tools/perf-audit.mjs --label before --dist docs/qa/perf-baseline-dist --seconds 8
 * node tools/perf-audit.mjs --label after --dist apps/web/dist --seconds 8
 */
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (key, fallback) => { const i = process.argv.indexOf(`--${key}`); return i < 0 ? fallback : process.argv[i + 1]; };
const label = arg('label', 'before');
const dist = resolve(ROOT, arg('dist', 'docs/qa/perf-baseline-dist'));
const seconds = Number(arg('seconds', '8'));
const only = arg('only', 'agents,system,processes,hidden').split(',');
const deltaTransport = arg('delta', '0') === '1';
const width = Number(arg('width', '1440')), height = Number(arg('height', '900')), dpr = Number(arg('dpr', '1'));
const OUT = join(ROOT, 'docs', 'qa', `perf-${label}-${width}-${dpr}`);
mkdirSync(OUT, { recursive: true });
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const fixture = readJson(resolve(ROOT, arg('fixture', 'docs/qa/perf-fleet.json')));
const sysFixture = readJson(resolve(ROOT, arg('system-fixture', 'docs/qa/perf-system.json')));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };
let bytes = 0, frames = 0;
const clients = new Set();
const epoch = fixture.generatedAt;
const realStart = Date.now();
const auditNow = () => epoch + (Date.now() - realStart);
function fleet() { return { ...fixture, generatedAt: auditNow(), type: 'fleet' }; }
function system() { return { ...sysFixture, type: 'system', at: auditNow() }; }
function sse(res, event, value) { const data = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`; bytes += Buffer.byteLength(data); frames++; res.write(data); }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res); sse(res, 'fleet', fleet()); sse(res, 'system', system());
    const f = setInterval(() => {
      if (deltaTransport && url.searchParams.get('delta') === '1') {
        sse(res, 'delta', { type: 'delta', at: auditNow(), sessions: [], removed: [], aggregates: fixture.aggregates });
      } else sse(res, 'fleet', fleet());
    }, 1000);
    const s = setInterval(() => sse(res, 'system', system()), 2000);
    req.on('close', () => { clearInterval(f); clearInterval(s); clients.delete(res); }); return;
  }
  if (url.pathname.startsWith('/api/')) {
    let body = url.pathname.includes('history') ? { history: [system()] } : url.pathname.includes('system') ? system() : url.pathname.includes('health') ? { ok: true } : fleet();
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return;
  }
  const path = resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!(path === dist || path.startsWith(dist + sep)) || !existsSync(path) || !statSync(path).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(path));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const require = createRequire(join(ROOT, 'apps/web/package.json'));
const { chromium } = require('playwright-core');
const exe = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const report = { label, dist, at: new Date().toISOString(), viewport: { width, height, dpr }, fixture: { sessions: fixture.sessions.length, procs: sysFixture.procs.length }, deltaTransport, browser: null, runs: [], errors: [] };
let browser;
function probe({ epoch }) {
  // Same wall-clock age/freshness for before/after; determinism belongs to the harness, not production.
  const RealDate = Date;
  const realNow = performance.now.bind(performance);
  const dateStart = realNow();
  const clock = () => epoch + realNow() - dateStart;
  window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [clock()])); } static now() { return clock(); } };
  let rng = 0x51a57a;
  Math.random = () => { rng = Math.imul(rng ^ rng >>> 15, 1 | rng); rng ^= rng + Math.imul(rng ^ rng >>> 7, 61 | rng); return ((rng ^ rng >>> 14) >>> 0) / 4294967296; };
  // Keep native rAF and performance.now untouched: this harness measures real work,
  // not a synthetic clock or an artificial visible-frame-rate cap.
  const counts = {};
  const methods = ['arc','lineTo','stroke','fill','fillText','drawImage','createRadialGradient','createLinearGradient','save','restore','clearRect','fillRect','setTransform','setLineDash'];
  for (const key of methods) {
    const orig = CanvasRenderingContext2D.prototype[key];
    CanvasRenderingContext2D.prototype[key] = function (...args) { counts[key] = (counts[key] || 0) + 1; return orig.apply(this,args); };
  }
  const mutations = { nodes: 0, attributes: 0, text: 0 };
  const obs = new MutationObserver(items => { for (const item of items) { if (item.type==='childList') mutations.nodes += item.addedNodes.length + item.removedNodes.length; else if (item.type==='characterData') mutations.text++; else mutations.attributes++; } });
  document.addEventListener('DOMContentLoaded', () => obs.observe(document.documentElement, {subtree:true,childList:true,attributes:true,characterData:true}), {once:true});
  let cpuSamples = [], dtSamples = [], previous = 0, rendered = 0;
  window.__perfAudit = {
    counts, mutations,
    reset() { for (const key of Object.keys(counts)) counts[key]=0; mutations.nodes=mutations.attributes=mutations.text=0; cpuSamples=[];dtSamples=[];previous=0;rendered=0; },
    install() { const a=window.__astra; const orig=a.scene.frame; a.scene.frame=(t)=>{const start=performance.now(); orig(t); cpuSamples.push(performance.now()-start); if(previous)dtSamples.push(t-previous);previous=t;rendered++;}; },
    get() { const summary=(v)=>{const x=v.slice().sort((a,b)=>a-b);return {n:v.length,avg:v.length?v.reduce((a,b)=>a+b,0)/v.length:0,p95:x[Math.floor(x.length*.95)]||0,max:x[x.length-1]||0};};return {canvas:{...counts},mutations:{...mutations},scene:summary(cpuSamples),frame:summary(dtSamples),rendered,canvases:[...document.querySelectorAll('canvas')].map(c=>({width:c.width,height:c.height})),info:window.__astra.scene.debugInfo?.(),processes:window.__astra.scene.debugProcesses?.(),freshness:window.__astra.scene.debugStarFreshness?.(),fx:window.__astra.scene.debugFx?.()}; }
  };
}
const metrics = async cdp => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name,m.value]));
try {
  browser=await chromium.launch({ executablePath:exe, headless:true }); report.browser=await browser.version();
  for (const view of only) {
    const ctx=await browser.newContext({viewport:{width,height},deviceScaleFactor:dpr});
    await ctx.addInitScript(probe, { epoch });
    const page=await ctx.newPage(); page.on('pageerror',e=>report.errors.push({view,error:e.message}));
    page.on('console',m=>{if(m.type()==='error')report.errors.push({view,error:m.text()});});
    await page.goto(`${base}/?boot=0&view=${view==='hidden'?'agents':view}`,{waitUntil:'load'});
    await page.waitForFunction(()=>window.__astra?.store?.getSessions().length>100, undefined, { timeout: 15000 });
    await page.evaluate(()=>document.fonts.ready);
    await page.waitForTimeout(3500);
    await page.evaluate(()=>window.__perfAudit.install());
    const cdp=await ctx.newCDPSession(page); await cdp.send('Performance.enable');
    if (view==='hidden') await page.evaluate(()=>{ Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(500);
    await page.evaluate(()=>window.__perfAudit.reset());
    const m0=await metrics(cdp), b0=bytes, f0=frames, start=performance.now();
    await page.waitForTimeout(seconds*1000);
    const elapsed = (performance.now()-start)/1000;
    const m1=await metrics(cdp);
    const state=await page.evaluate(()=>window.__perfAudit.get());
    const delta={}; for(const k of ['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'])delta[k]=(m1[k]||0)-(m0[k]||0);
    report.runs.push({ view, seconds:elapsed, cpuPercentOneCore:delta.TaskDuration/elapsed*100, metrics:delta, heapMB:(m1.JSHeapUsedSize||0)/1048576, heapTotalMB:(m1.JSHeapTotalSize||0)/1048576, nodes:m1.Nodes, listeners:m1.JSEventListeners, transfer:{bytes:bytes-b0,frames:frames-f0}, ...state });
    if(view!=='hidden')await page.screenshot({path:join(OUT,`${view}.png`)});
    console.log(JSON.stringify({view,cpu:report.runs.at(-1).cpuPercentOneCore,scene:state.scene,mutations:state.mutations,heapMB:report.runs.at(-1).heapMB}));
    await ctx.close();
  }
} finally { if(browser)await browser.close(); for(const res of clients)res.end();server.closeAllConnections();await new Promise(r=>server.close(r));writeFileSync(join(OUT,'report.json'),JSON.stringify(report,null,2));console.log('report',join(OUT,'report.json')); }
if(report.errors.length) process.exitCode=1;
