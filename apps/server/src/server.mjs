// Zero-dependency HTTP + SSE server for ASTRA.
//
//   GET /api/health
//   GET /api/fleet[?demo=1]
//   GET /api/sessions
//   GET /api/sessions/:id
//   GET /api/events?limit=100
//   GET /api/stream[?demo=1]     SSE: fleet (initial + 1/s), tick (incremental), 15s ping
//   GET /*                       static apps/web/dist (or a friendly hint page)
//
// The HTTP listener is bound BEFORE the collector boots, so health probes and
// the placeholder UI work immediately; fleet responses are empty until the
// first snapshot is ready.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { MultiSource } from './multi.mjs';
import { DemoSource } from './demo.mjs';
import { ReplaySource } from './replay.mjs';
import { SystemMonitor, createEmptySystem } from './system.mjs';
import { nowMs } from './util.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const API_ROUTES = [
  'GET /api/health',
  'GET /api/fleet',
  'GET /api/sessions',
  'GET /api/sessions/:id',
  'GET /api/events?limit=100',
  'GET /api/system',
  'GET /api/system/history?limit=120',
  'GET /api/stream (SSE: fleet/tick/system)',
];

const HINT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ASTRA 观测台 · 前端尚未构建</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(1200px 800px at 70% -10%, #1b2550 0%, #070b18 55%, #04060d 100%);
    color: #dbe4ff; font: 15px/1.75 ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { width: min(720px, 92vw); padding: 42px 38px; border: 1px solid rgba(120,160,255,.22);
    border-radius: 18px; background: rgba(10,16,34,.62); box-shadow: 0 24px 80px rgba(0,0,0,.45);
    backdrop-filter: blur(10px); }
  h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: .12em; color: #eaf1ff; }
  h1 span { color: #7fb0ff; }
  p { margin: 10px 0; color: #9fb0d8; }
  code, pre { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  pre { padding: 14px 16px; border-radius: 10px; background: rgba(4,10,24,.85);
    border: 1px solid rgba(120,160,255,.16); color: #b9cdff; overflow-x: auto; }
  a { color: #8ec2ff; text-decoration: none; border-bottom: 1px dashed rgba(142,194,255,.4); }
  a:hover { color: #cfe4ff; }
  ul { padding-left: 18px; }
  .hint { margin-top: 22px; font-size: 13px; color: #6f81aa; }
</style>
</head>
<body>
<main>
  <h1>ASTRA <span>观测台</span></h1>
  <p>数据服务已经在线，但前端构建产物 <code>apps/web/dist</code> 还不存在哦～</p>
  <p>先构建前端，再刷新本页：</p>
  <pre>pnpm --filter @astra/web build
# 或者开发模式：
pnpm dev</pre>
  <p>也可以直接用 JSON 接口看数据：</p>
  <ul>
    <li><a href="/api/health">/api/health</a> — 采集器健康与时钟</li>
    <li><a href="/api/fleet">/api/fleet</a> — 全量舰队快照</li>
    <li><a href="/api/sessions">/api/sessions</a> — 会话列表</li>
    <li><a href="/api/events?limit=50">/api/events?limit=50</a> — 最近事件</li>
    <li><a href="/api/fleet?demo=1">/api/fleet?demo=1</a> — 内置演示数据</li>
    <li><a href="/api/stream">/api/stream</a> — SSE 实时流</li>
  </ul>
  <p class="hint">提示：演示模式可以用 <code>node apps/server/src/server.mjs --demo</code> 启动。</p>
</main>
</body>
</html>`;

function emptyAggregates(now) {
  return {
    liveCount: 0, idleCount: 0, endedCount: 0,
    tokenRate: 0, toolRate: 0, errorCount: 0, maxContextPressure: 0, stamp: now,
  };
}

function emptyFleet(source) {
  const now = nowMs();
  return {
    generatedAt: now,
    source,
    sessions: [],
    sectors: [],
    sources: [],
    aggregates: emptyAggregates(now),
    events: [],
  };
}

class FleetHub {
  constructor(config, { log = console.log } = {}) {
    this.config = config;
    this.log = log;
    // --replay 优先于 --demo:config.demo 在只给 replayFile 时也为 true,
    // 所以必须先判 replay,否则回放会被当成 demo 模式。
    this.mode = config.replayFile ? 'replay' : config.demo ? 'demo' : 'live';
    this.primary = null;
    this.demoSource = null;
    this.demoPromise = null;
    this.primaryReady = false;
    this.clients = new Set();
    this.startedAt = nowMs();
    this.serveDemo = this.mode === 'demo';
    this.webDist = path.resolve(config.webDist);
    this.webDistExists = fs.existsSync(path.join(this.webDist, 'index.html'));
    this.closed = false;
    // Machine telemetry: live mode gets it from MultiSource; demo/replay get a
    // hub-owned monitor so /api/system still reports the real machine.
    this.systemMonitor = null;

    this.pingTimer = setInterval(() => this.heartbeat(), this.config.heartbeatMs);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  // -- source lifecycle ------------------------------------------------------

  async initPrimary() {
    if (this.mode === 'demo') {
      const demo = new DemoSource(this.config, { log: this.log });
      await demo.init();
      demo.start();
      this.primary = demo;
      this.demoSource = demo;
      this.serveDemo = true;
      this.attach(demo);
    } else if (this.mode === 'replay') {
      try {
        const replay = new ReplaySource(this.config, { log: this.log });
        await replay.init();
        replay.start();
        this.primary = replay;
        this.attach(replay);
      } catch (err) {
        this.log(`[astra] replay failed (${err?.message ?? err}); falling back to live mode`);
        this.mode = 'live';
      }
    }
    if (!this.primary) {
      // v2: the live fleet is merged DSH + external agents, plus machine telemetry.
      const multi = new MultiSource(this.config, { log: this.log });
      this.primary = multi;
      this.attach(multi);
      await multi.start();
    } else {
      // demo / replay: no external-agent collection,但整机遥测照常开。
      this.ensureSystemMonitor();
    }
    this.primaryReady = true;
    this.log(
      `[astra] source ready · mode ${this.mode} · ${this.primary.getSessions().length} sessions ` +
      `(${this.mode === 'live' ? 'live DSH data' : this.mode})`,
    );
    return this.primary;
  }

  async ensureDemo() {
    if (this.demoSource) return this.demoSource;
    if (!this.demoPromise) {
      this.demoPromise = (async () => {
        const demo = new DemoSource(this.config, { log: this.log });
        await demo.init();
        demo.start();
        this.demoSource = demo;
        this.attach(demo);
        this.log('[astra] demo simulator started (?demo=1)');
        return demo;
      })().catch((err) => {
        this.demoPromise = null;
        throw err;
      });
    }
    return this.demoPromise;
  }

  attach(source) {
    source.on('tick', (tick) => this.broadcast(source, tick));
    source.on('system', (sample) => this.broadcastSystem(sample));
  }

  sourceFor(wantDemo) {
    return wantDemo ? this.demoSource : this.primary;
  }

  // -- machine telemetry -----------------------------------------------------

  /** Hub-owned telemetry for demo/replay (live mode uses MultiSource's monitor). */
  ensureSystemMonitor() {
    if (this.systemMonitor || this.config.system === false) return this.systemMonitor;
    const monitor = new SystemMonitor(this.config, { log: this.log });
    monitor.on('sample', (sample) => this.broadcastSystem(sample));
    monitor.start();
    this.systemMonitor = monitor;
    return monitor;
  }

  systemSnapshot() {
    try {
      if (this.primary && typeof this.primary.getSystem === 'function') return this.primary.getSystem();
    } catch {
      /* fall through to the hub monitor */
    }
    if (this.systemMonitor) return this.systemMonitor.getSystem();
    return createEmptySystem();
  }

  systemHistory(limit) {
    try {
      if (this.primary && typeof this.primary.getSystemHistory === 'function') {
        return this.primary.getSystemHistory(limit);
      }
    } catch {
      /* fall through to the hub monitor */
    }
    if (this.systemMonitor) return this.systemMonitor.getHistory(limit);
    return [];
  }

  /** SSE `event: system` — compact frame, process list trimmed to the top 12. */
  broadcastSystem(sample) {
    if (!sample || !this.clients.size) return;
    const frame = `event: system\ndata: ${JSON.stringify({
      type: 'system',
      ...sample,
      procs: Array.isArray(sample.procs) ? sample.procs.slice(0, 12) : [],
    })}\n\n`;
    for (const client of this.clients) {
      if (!client.closed) this.writeClient(client, frame);
    }
  }

  // -- response helpers ------------------------------------------------------

  corsHeaders(req) {
    if (!this.config.cors) return {};
    const origin = req.headers.origin;
    if (origin && LOCAL_ORIGIN.test(origin)) {
      return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      };
    }
    return {};
  }

  sendJson(req, res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      ...this.corsHeaders(req),
    });
    if (req.method === 'HEAD') res.end();
    else res.end(payload);
  }

  sendText(req, res, status, body, contentType = 'text/plain; charset=utf-8') {
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...this.corsHeaders(req),
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  }

  // -- routing ---------------------------------------------------------------

  async handle(req, res) {
    const started = nowMs();
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const method = req.method || 'GET';

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          ...this.corsHeaders(req),
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        await this.handleApi(req, res, method, url);
        return;
      }
      if (url.pathname === '/api') {
        this.sendJson(req, res, 200, { name: 'ASTRA observatory', mode: this.mode, routes: API_ROUTES });
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') {
        this.sendText(req, res, 405, 'Method Not Allowed');
        return;
      }
      await this.serveStatic(req, res, url.pathname);
    } catch (err) {
      this.log(`[astra] request failed ${req.method} ${req.url}: ${err?.stack ?? err}`);
      if (!res.headersSent) this.sendJson(req, res, 500, { error: 'internal error', message: String(err?.message ?? err) });
      else res.end();
    } finally {
      if (this.config.verbose) {
        this.log(`[astra] ${req.method} ${req.url} ${res.statusCode} ${nowMs() - started}ms`);
      }
    }
  }

  async handleApi(req, res, method, url) {
    if (method !== 'GET' && method !== 'HEAD') {
      this.sendJson(req, res, 405, { error: 'method not allowed' });
      return;
    }
    const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const wantDemo = url.searchParams.get('demo') === '1';

    if (segments[1] === 'health') {
      this.sendJson(req, res, 200, this.health());
      return;
    }
    if (segments[1] === 'system') {
      if (segments[2] === 'history') {
        const rawLimit = Number(url.searchParams.get('limit'));
        // The ring buffer keeps at most `config.systemHistory` (default 120)
        // samples, so the documented upper bound for `limit` is 120 as well.
        const maxHistory = this.config.systemHistory ?? 120;
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), maxHistory) : maxHistory;
        this.sendJson(req, res, 200, { generatedAt: nowMs(), history: this.systemHistory(limit) });
        return;
      }
      this.sendJson(req, res, 200, this.systemSnapshot());
      return;
    }
    if (segments[1] === 'stream') {
      if (method !== 'GET') {
        this.sendJson(req, res, 405, { error: 'SSE requires GET' });
        return;
      }
      await this.handleStream(req, res, wantDemo);
      return;
    }
    if (segments[1] === 'fleet') {
      if (wantDemo) await this.ensureDemo().catch((err) => this.log(`[astra] demo unavailable: ${err?.message ?? err}`));
      this.sendJson(req, res, 200, this.fleetFor(wantDemo));
      return;
    }
    if (segments[1] === 'sessions') {
      const id = segments[2] ? decodeURIComponent(segments[2]) : null;
      if (wantDemo) await this.ensureDemo().catch((err) => this.log(`[astra] demo unavailable: ${err?.message ?? err}`));
      const source = this.sourceFor(wantDemo);
      if (!source) {
        this.sendJson(req, res, 503, { error: 'source not ready yet', retry: true });
        return;
      }
      if (!id) {
        this.sendJson(req, res, 200, { generatedAt: nowMs(), source: source.source ?? this.mode, sessions: source.getSessions() });
        return;
      }
      const session = source.getSession(id);
      if (!session) {
        this.sendJson(req, res, 404, { error: 'session not found', id });
        return;
      }
      this.sendJson(req, res, 200, session);
      return;
    }
    if (segments[1] === 'events') {
      if (wantDemo) await this.ensureDemo().catch((err) => this.log(`[astra] demo unavailable: ${err?.message ?? err}`));
      const source = this.sourceFor(wantDemo);
      const rawLimit = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 2000) : 100;
      this.sendJson(req, res, 200, {
        generatedAt: nowMs(),
        source: source?.source ?? this.mode,
        events: source ? source.getEvents(limit) : [],
      });
      return;
    }
    this.sendJson(req, res, 404, { error: 'unknown endpoint', path: url.pathname, routes: API_ROUTES });
  }

  health() {
    const now = nowMs();
    const source = this.primary;
    const base = source?.getHealth ? source.getHealth() : {
      ok: true,
      source: this.mode,
      generatedAt: now,
      booted: false,
      sessions: { total: 0, projected: 0, ...emptyAggregates(now) },
      events: { ring: 0, ringMax: 0 },
      counters: {},
    };
    return {
      ...base,
      generatedAt: now,
      system: this.systemSnapshot(),
      hub: {
        mode: this.mode,
        clients: this.clients.size,
        uptimeMs: now - this.startedAt,
        port: this.port ?? this.config.port,
        webDist: this.webDist,
        webBuilt: this.webDistExists,
        demoAvailable: Boolean(this.demoSource),
        systemTelemetry: Boolean(this.systemMonitor) || typeof this.primary?.getSystem === 'function',
      },
    };
  }

  // -- fleet snapshot --------------------------------------------------------

  fleetFor(wantDemo) {
    const source = this.sourceFor(wantDemo);
    if (!source) return emptyFleet(wantDemo ? 'demo' : this.mode === 'replay' ? 'replay' : 'live');
    try {
      return source.getFleet();
    } catch (err) {
      this.log(`[astra] fleet build failed: ${err?.stack ?? err}`);
      return emptyFleet(source.source ?? this.mode);
    }
  }

  // -- SSE -------------------------------------------------------------------

  async handleStream(req, res, wantDemo) {
    if (wantDemo) {
      try {
        await this.ensureDemo();
      } catch (err) {
        this.log(`[astra] demo unavailable for stream: ${err?.message ?? err}`);
      }
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...this.corsHeaders(req),
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');

    const client = {
      res,
      wantDemo,
      closed: false,
      fleetTimer: null,
      lastFleetAt: 0,
      lastTickAt: 0,
    };
    this.clients.add(client);

    this.sendFleet(client);

    client.fleetTimer = setInterval(() => this.sendFleet(client), this.config.fleetFrameMs);
    if (client.fleetTimer.unref) client.fleetTimer.unref();

    const close = () => {
      if (client.closed) return;
      client.closed = true;
      if (client.fleetTimer) clearInterval(client.fleetTimer);
      this.clients.delete(client);
    };
    req.on('close', close);
    req.on('aborted', close);
    res.on('close', close);
    res.on('error', close);
  }

  writeClient(client, chunk) {
    if (client.closed || client.res.writableEnded) return false;
    try {
      client.res.write(chunk);
      return true;
    } catch {
      return false;
    }
  }

  sendFleet(client) {
    if (client.closed) return;
    const fleet = this.fleetFor(client.wantDemo);
    client.lastFleetAt = nowMs();
    this.writeClient(client, `event: fleet\ndata: ${JSON.stringify({ type: 'fleet', ...fleet })}\n\n`);
  }

  broadcast(source, tick) {
    const now = nowMs();
    const frame = `event: tick\ndata: ${JSON.stringify({
      type: 'tick',
      at: tick.at ?? now,
      events: tick.events ?? [],
      sessions: tick.sessions ?? [],
      aggregates: tick.aggregates ?? null,
    })}\n\n`;
    for (const client of this.clients) {
      if (client.closed) continue;
      if (this.sourceFor(client.wantDemo) !== source) continue;
      client.lastTickAt = now;
      this.writeClient(client, frame);
    }
  }

  heartbeat() {
    for (const client of this.clients) {
      if (client.closed) continue;
      this.writeClient(client, ': ping\n\n');
    }
  }

  // -- static files ----------------------------------------------------------

  async serveStatic(req, res, pathname) {
    const root = this.webDist;
    if (!this.webDistExists) {
      this.sendText(req, res, 200, HINT_HTML, 'text/html; charset=utf-8');
      return;
    }
    let rel = pathname === '/' ? '/index.html' : pathname;
    try {
      rel = decodeURIComponent(rel);
    } catch {
      this.sendText(req, res, 400, 'Bad Request');
      return;
    }
    const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
    let filePath = path.resolve(root, `.${rel}`);
    if (filePath !== path.join(root, 'index.html') && filePath !== root && !filePath.startsWith(rootPrefix)) {
      this.sendText(req, res, 403, 'Forbidden');
      return;
    }

    let stat = await fsp.stat(filePath).catch(() => null);
    if (stat?.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fsp.stat(filePath).catch(() => null);
    }
    if (!stat || !stat.isFile()) {
      const hasExtension = path.extname(rel) !== '';
      if (hasExtension) {
        this.sendText(req, res, 404, 'Not Found');
        return;
      }
      // SPA fallback
      filePath = path.join(root, 'index.html');
      stat = await fsp.stat(filePath).catch(() => null);
      if (!stat) {
        this.sendText(req, res, 200, HINT_HTML, 'text/html; charset=utf-8');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const immutable = new Set(['.js', '.mjs', '.css', '.woff', '.woff2', '.ttf', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.webm', '.mp4']);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': immutable.has(ext) ? 'public, max-age=3600' : 'no-cache',
      ...this.corsHeaders(req),
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      this.log(`[astra] static read failed ${filePath}: ${err.message}`);
      res.destroy();
    });
    stream.pipe(res);
  }

  // -- lifecycle -------------------------------------------------------------

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const client of this.clients) {
      client.closed = true;
      if (client.fleetTimer) clearInterval(client.fleetTimer);
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    if (this.systemMonitor) {
      this.systemMonitor.removeAllListeners('sample');
      this.systemMonitor.stop();
      this.systemMonitor = null;
    }
    const stops = [this.primary, this.demoSource].filter(Boolean).map((source) => source.stop?.());
    await Promise.allSettled(stops);
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(() => resolve());
        if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections();
        setTimeout(resolve, 1500).unref?.();
      });
    }
  }
}

/** Create + bind the HTTP server, then boot the data source in the background. */
export async function startServer(config = loadConfig(), { log = console.log } = {}) {
  const hub = new FleetHub(config, { log });
  const server = http.createServer((req, res) => {
    hub.handle(req, res);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  hub.server = server;

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listen', onListen);
      reject(err);
    };
    const onListen = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(config.port, config.host);
  });

  const address = server.address();
  hub.port = address && typeof address === 'object' ? address.port : config.port;
  hub.url = `http://${config.host}:${hub.port}`;
  log(
    `[astra] listening on ${hub.url} · mode ${hub.mode} · ` +
    `web ${hub.webDistExists ? 'dist' : 'not built (serving hint page)'} · cors ${config.cors ? 'on' : 'off'}`,
  );

  hub.initPrimary().catch((err) => {
    log(`[astra] source init failed: ${err?.stack ?? err}`);
  });
  return hub;
}

export { FleetHub, HINT_HTML, emptyFleet };

async function main() {
  const config = loadConfig();
  let hub;
  try {
    hub = await startServer(config);
  } catch (err) {
    console.error(`[astra] failed to start: ${err?.stack ?? err}`);
    process.exitCode = 1;
    return;
  }
  const shutdown = async (signal) => {
    console.log(`\n[astra] ${signal} received · shutting down`);
    try {
      await hub.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error(`[astra] uncaught exception: ${err?.stack ?? err}`);
  });
  process.on('unhandledRejection', (err) => {
    console.error(`[astra] unhandled rejection: ${err?.stack ?? err}`);
  });
}

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
