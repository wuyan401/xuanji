// Snapshot source #1: the per-session projection cache written by DSH.
//
//   ~/.dsh/storages/session_projcache/sessions/<sessionId>.json
//
// Each file is a JSON document:
//   { version: 7, record: { identity: {...}, rows: { <key>: { ver, seq, val } } } }
// The file is rewritten by DSH after every step / message, so it is a cheap
// "last known full state" per session. We poll the directory, re-parse only
// files whose (mtimeMs, size) changed, and hand raw rows to `fleet.mjs` for
// normalisation.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ms, listDirSafe, mapLimit } from './util.mjs';

const PARSE_CONCURRENCY = 24;

export class ProjCache {
  /**
   * @param {{dir: string, log?: (msg: string, ...args: any[]) => void,
   *          scanMs?: number}} opts `scanMs` is the safety-net full sweep
   *   interval used while fs.watch is active (0 disables watching).
   */
  constructor({ dir, log = console.log, scanMs = 10_000 }) {
    this.dir = dir;
    /** @type {Map<string, {mtimeMs:number,size:number}>} fileName -> stat stamp */
    this.files = new Map();
    /** @type {Map<string, {record:any, mtimeMs:number, size:number, file:string, updatedAt:number}>} sessionId -> raw record */
    this.sessions = new Map();
    this.log = log;
    this.lastErrorAt = new Map();
    this.errorCount = 0;
    // Statting ~180 projcache files every 500ms was measurable idle CPU. DSH
    // rewrites a file whenever its session changes, so fs.watch tells us exactly
    // which few files to stat; a periodic sweep is the safety net.
    this.scanMs = Math.max(1000, scanMs);
    this.watcher = null;
    this.watchQueue = new Set();
    this.watchDirty = false;
    this.watchState = process.platform === 'win32' || process.platform === 'darwin' ? 'pending' : 'fallback';
    this.lastSweepAt = 0;
  }

  /** Full initial scan; returns timing + counts for the boot log. */
  async init() {
    const t0 = performance.now();
    const names = (await listDirSafe(this.dir)).filter((n) => n.endsWith('.json'));
    const stats = await mapLimit(names, PARSE_CONCURRENCY, async (name) => {
      const file = path.join(this.dir, name);
      try {
        const st = await fsp.stat(file);
        const raw = await fsp.readFile(file, 'utf8');
        const parsed = JSON.parse(raw);
        const sessionId = name.slice(0, -5);
        return { name, sessionId, mtimeMs: st.mtimeMs, size: st.size, parsed };
      } catch (err) {
        this.noteError(name, err);
        return null;
      }
    });
    for (const item of stats) {
      if (!item) continue;
      const record = item.parsed?.record;
      if (!record || typeof record !== 'object') continue;
      this.files.set(item.name, { mtimeMs: item.mtimeMs, size: item.size });
      this.sessions.set(item.sessionId, {
        record,
        mtimeMs: item.mtimeMs,
        size: item.size,
        file: path.join(this.dir, item.name),
        updatedAt: Date.now(),
      });
    }
    const elapsed = performance.now() - t0;
    this.lastSweepAt = Date.now();
    this.startWatch();
    return { files: names.length, sessions: this.sessions.size, ms: elapsed };
  }

  /**
   * Watch the projcache directory. One file per session lives directly in the
   * directory, so a non-recursive watch is enough: every rewritten file lands in
   * `watchQueue` and is stat'ed on the next poll; new/removed files show up as
   * rename events (stat or ENOENT clears them).
   */
  startWatch() {
    if (this.watcher || this.watchState === 'off') return;
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, (eventType, filename) => {
        if (!filename) {
          this.watchDirty = true;
          return;
        }
        const name = String(filename);
        // A nested path means the directory layout itself changed -> re-walk.
        if (name.includes('/') || name.includes('\\')) this.watchDirty = true;
        // Queue every plain file name: atomic writers may surface a temp name
        // first, and the fast path simply ignores names that are not `*.json`.
        else this.watchQueue.add(name);
      });
      this.watcher.on?.('error', (err) => this.failWatch(err));
      this.watchState = 'active';
    } catch (err) {
      this.failWatch(err);
    }
  }

  failWatch(err) {
    this.watchState = 'fallback';
    try {
      this.watcher?.close();
    } catch {
      /* already gone */
    }
    this.watcher = null;
    this.log?.(`[projcache] fs.watch unavailable (${err?.message ?? err}) — falling back to full directory polls`);
  }

  stop() {
    if (!this.watcher) return;
    try {
      this.watcher.close();
    } catch {
      /* already gone */
    }
    this.watcher = null;
    this.watchState = 'off';
  }

  /**
   * Incremental poll. Only changed files are re-read/parsed.
   * @returns {Promise<{changed: string[], removed: string[], added: string[], stats: {files:number, parsed:number, ms:number, bytes:number}}>}
   */
  async poll(now = Date.now()) {
    const t0 = performance.now();
    const ctx = { changed: [], added: [], removed: [], parsed: 0, bytes: 0 };
    // With fs.watch active a full sweep is only a safety net (10s); without it
    // we must stat the whole directory every poll like before.
    const sweepEvery = this.watchState === 'active' ? this.scanMs : 0;
    const full = this.lastSweepAt === 0 || this.watchDirty || sweepEvery === 0 || now - this.lastSweepAt >= sweepEvery;

    if (full) {
      this.watchDirty = false;
      const names = (await listDirSafe(this.dir)).filter((n) => n.endsWith('.json'));
      const seen = new Set(names);
      // Detect removals first so callers can mark sessions missing.
      for (const name of this.files.keys()) {
        if (!seen.has(name)) {
          ctx.removed.push(name.slice(0, -5));
          this.files.delete(name);
          this.sessions.delete(name.slice(0, -5));
        }
      }
      await mapLimit(names, PARSE_CONCURRENCY, async (name) => { await this.refreshFile(name, ctx); });
      this.lastSweepAt = now;
    } else if (this.watchQueue.size) {
      const queued = [...this.watchQueue];
      this.watchQueue.clear();
      for (const name of queued) await this.refreshFile(name, ctx);
    }

    return {
      changed: ctx.changed,
      added: ctx.added,
      removed: ctx.removed,
      stats: { files: this.files.size, parsed: ctx.parsed, ms: performance.now() - t0, bytes: ctx.bytes },
    };
  }

  /** stat + parse one session file, recording it into the given poll result. */
  async refreshFile(name, ctx) {
    if (!name.endsWith('.json')) return; // temp file names from atomic writes
    const file = path.join(this.dir, name);
    let st;
    try {
      st = await fsp.stat(file);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        if (this.files.delete(name)) {
          const sessionId = name.slice(0, -5);
          this.sessions.delete(sessionId);
          ctx.removed.push(sessionId);
        }
        return;
      }
      this.noteError(name, err);
      return;
    }
    const prev = this.files.get(name);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return;
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      const record = parsed?.record;
      if (!record || typeof record !== 'object') return;
      const sessionId = name.slice(0, -5);
      const isNew = !this.sessions.has(sessionId);
      this.files.set(name, { mtimeMs: st.mtimeMs, size: st.size });
      this.sessions.set(sessionId, {
        record,
        mtimeMs: st.mtimeMs,
        size: st.size,
        file,
        updatedAt: Date.now(),
      });
      ctx.parsed += 1;
      ctx.bytes += st.size;
      if (isNew) ctx.added.push(sessionId);
      else ctx.changed.push(sessionId);
    } catch (err) {
      this.noteError(name, err);
    }
  }

  /** Raw record for one session, or null. */
  getRecord(sessionId) {
    return this.sessions.get(sessionId)?.record ?? null;
  }

  /** File mtime (epoch ms) for one session, used to derive liveness. */
  getMtime(sessionId) {
    return this.sessions.get(sessionId)?.mtimeMs ?? 0;
  }

  ids() {
    return [...this.sessions.keys()];
  }

  noteError(name, err) {
    this.errorCount += 1;
    const now = Date.now();
    const last = this.lastErrorAt.get(name) ?? 0;
    // Avoid log spam for a file that is being rewritten (transient partial JSON).
    if (now - last > 10_000) {
      this.lastErrorAt.set(name, now);
      this.log?.(`[projcache] parse failed ${name}: ${err?.message ?? err}`);
    }
  }

  summary() {
    return { files: this.files.size, sessions: this.sessions.size, errors: this.errorCount };
  }
}

export { ms };
