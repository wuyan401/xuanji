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

import fsp from 'node:fs/promises';
import path from 'node:path';
import { ms, listDirSafe, mapLimit } from './util.mjs';

const PARSE_CONCURRENCY = 24;

export class ProjCache {
  /**
   * @param {{dir: string, log?: (msg: string, ...args: any[]) => void}} opts
   */
  constructor({ dir, log = console.log }) {
    this.dir = dir;
    /** @type {Map<string, {mtimeMs:number,size:number}>} fileName -> stat stamp */
    this.files = new Map();
    /** @type {Map<string, {record:any, mtimeMs:number, size:number, file:string, updatedAt:number}>} sessionId -> raw record */
    this.sessions = new Map();
    this.log = log;
    this.lastErrorAt = new Map();
    this.errorCount = 0;
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
    return { files: names.length, sessions: this.sessions.size, ms: elapsed };
  }

  /**
   * Incremental poll. Only changed files are re-read/parsed.
   * @returns {Promise<{changed: string[], removed: string[], added: string[], stats: {files:number, parsed:number, ms:number, bytes:number}}>}
   */
  async poll() {
    const t0 = performance.now();
    const names = (await listDirSafe(this.dir)).filter((n) => n.endsWith('.json'));
    const changed = [];
    const added = [];
    let parsedCount = 0;
    let bytes = 0;

    const seen = new Set(names);
    // Detect removals first so callers can mark sessions missing.
    const removed = [];
    for (const name of this.files.keys()) {
      if (!seen.has(name)) {
        removed.push(name.slice(0, -5));
        this.files.delete(name);
      }
    }

    await mapLimit(names, PARSE_CONCURRENCY, async (name) => {
      const file = path.join(this.dir, name);
      let st;
      try {
        st = await fsp.stat(file);
      } catch (err) {
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
        parsedCount++;
        bytes += st.size;
        if (isNew) added.push(sessionId);
        else changed.push(sessionId);
      } catch (err) {
        this.noteError(name, err);
      }
    });

    return {
      changed,
      added,
      removed,
      stats: { files: names.length, parsed: parsedCount, ms: performance.now() - t0, bytes },
    };
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
