// Snapshot source #2: the append-only zstd event log per session.
//
//   ~/.dsh/sessions/<workspace-encoded-dir>/<sessionId>/session.v4.jsonl.zstd
//
// The file is a *concatenation of zstd frames* (zstd "multiframe", each frame
// carrying no content size and a checksum). Every frame decompresses to a
// batch of JSON lines, one event per line, e.g.
//
//   {"type":"step/start","seq":42,"time":1793081234567,"data":{...}}
//
// We never read whole files (some are 14 MB+). Instead:
//   - `init()` stats every file, preloads the *tail* of recently active files
//     (last `tailBytes`), decodes the complete frames found there and sets the
//     read cursor to the first unconsumed byte;
//   - `poll()` re-stats the files and reads only the new byte range, splitting
//     it into frames by the zstd magic `28 b5 2f fd`. A frame that fails to
//     decode at EOF is a partially written tail: we keep the cursor on it and
//     retry next poll.
//
// False positives: the 4-byte magic can theoretically appear inside compressed
// data. A candidate that fails to decode is retried with a larger boundary and
// finally skipped, so the tailer self-heals.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { walkFiles } from './util.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MIN_FRAME = 6; // magic + at least one block header byte
const MAX_CANDIDATE_SKIPS = 4;
/** a "pending" (undecodable tail) cursor that stops advancing for this long
 *  is assumed to be a false-positive magic and we move past it */
const PENDING_STALL_MS = 15_000;
const PENDING_MAX_BYTES = 8 * 1024 * 1024;

/** All offsets of the zstd magic inside `buf`. */
export function magicPositions(buf) {
  const out = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) {
    out.push(i);
    i = buf.indexOf(MAGIC, i + MAGIC.length);
  }
  return out;
}

/**
 * Split a buffer into complete zstd frames.
 * @param {Buffer} buf
 * @returns {{frames: {start:number,end:number,text:string}[], consumedEnd:number, pendingFrom:number, falseStarts:number}}
 */
export function parseFrames(buf) {
  const positions = magicPositions(buf);
  const frames = [];
  let falseStarts = 0;
  if (!positions.length) {
    return { frames, consumedEnd: buf.length, pendingFrom: buf.length, falseStarts };
  }

  let i = 0;
  while (i < positions.length) {
    const start = positions[i];
    if (start + MIN_FRAME > buf.length) {
      return { frames, consumedEnd: start, pendingFrom: start, falseStarts };
    }
    let handled = false;
    let sawEofAttempt = false;
    const maxSkip = Math.min(MAX_CANDIDATE_SKIPS, positions.length - 1 - i);
    for (let skip = 1; skip <= Math.max(1, maxSkip); skip++) {
      const nextIdx = i + skip;
      const end = nextIdx < positions.length ? positions[nextIdx] : buf.length;
      if (end === buf.length) sawEofAttempt = true;
      if (end - start < MIN_FRAME) continue;
      try {
        const out = zstdDecompressSync(buf.subarray(start, end));
        frames.push({ start, end, text: out.toString('utf8') });
        i = nextIdx;
        handled = true;
        break;
      } catch {
        /* try a larger candidate boundary */
      }
    }
    if (handled) continue;
    if (sawEofAttempt) {
      // The last complete frame boundary could not decode up to EOF: either a
      // partially-written frame or a false positive right before EOF. Keep the
      // cursor here and wait for the writer.
      return { frames, consumedEnd: start, pendingFrom: start, falseStarts };
    }
    // Enough following magic positions exist and none decoded: false positive.
    falseStarts += 1;
    i += 1;
  }

  const end = frames.length ? frames[frames.length - 1].end : buf.length;
  return { frames, consumedEnd: end, pendingFrom: buf.length, falseStarts };
}

/** Decode frame text into event objects (one JSON per line). */
export function parseEventLines(text) {
  const events = [];
  if (!text) return events;
  const lines = text.split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s);
      if (ev && typeof ev === 'object' && typeof ev.type === 'string') events.push(ev);
    } catch {
      /* incomplete/garbled line: skip */
    }
  }
  return events;
}

async function readRange(file, position, length) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export class EventLogTailer {
  /**
   * @param {{root:string, log?:(msg:string,...a:any[])=>void, recentMs?:number,
   *          tailBytes?:number, readBudgetPerPoll?:number, maxFileAgeMs?:number}} opts
   */
  constructor({
    root,
    log = console.log,
    recentMs = 30 * 60_000,
    tailBytes = 256 * 1024,
    readBudgetPerPoll = 4 * 1024 * 1024,
  }) {
    this.root = root;
    this.log = log;
    this.recentMs = recentMs;
    this.tailBytes = tailBytes;
    this.readBudgetPerPoll = readBudgetPerPoll;
    /** @type {Map<string,{sessionId:string,pos:number,size:number,mtimeMs:number,stuck:number,stuckAt:number,errorCount:number}>} */
    this.files = new Map();
    this.onEvents = null; // (sessionId, events, meta) => void
    this.stats = { files: 0, preloaded: 0, frames: 0, events: 0, bytes: 0, errors: 0, backlog: 0 };
    this.dirCache = new Map();
  }

  /** List every session.v4.jsonl.zstd file as {file, sessionId, workspaceDir}. */
  async scan() {
    const all = await walkFiles(this.root, 3);
    const out = [];
    for (const file of all) {
      if (!file.endsWith('.jsonl.zstd') && !file.endsWith('.zstd')) continue;
      const sessionId = path.basename(path.dirname(file));
      const workspaceDir = path.basename(path.dirname(path.dirname(file)));
      out.push({ file, sessionId, workspaceDir });
    }
    return out;
  }

  /**
   * Boot: build the file index, preload tails of recently active sessions.
   * @returns {Promise<{files:number, preloaded:number, frames:number, events:number, ms:number}>}
   */
  async init(now = Date.now()) {
    const t0 = performance.now();
    const listed = await this.scan();
    let preloaded = 0;
    let frames = 0;
    let events = 0;
    const recentCutoff = now - this.recentMs;

    for (const item of listed) {
      let st;
      try {
        st = await fsp.stat(item.file);
      } catch (err) {
        this.noteError(item.file, err);
        continue;
      }
      const entry = {
        sessionId: item.sessionId,
        pos: st.size,
        size: st.size,
        mtimeMs: st.mtimeMs,
        stuck: 0,
        stuckAt: 0,
        errorCount: 0,
      };
      this.files.set(item.file, entry);
      // Only dig into files that are plausibly still in play; older sessions
      // are represented by the projcache snapshot alone.
      if (st.mtimeMs < recentCutoff || st.size === 0) continue;
      try {
        const from = Math.max(0, st.size - this.tailBytes);
        const length = st.size - from;
        if (length <= 0) continue;
        const buf = await readRange(item.file, from, length);
        const parsed = parseFrames(buf);
        let count = 0;
        for (const frame of parsed.frames) {
          frames += 1;
          const evs = parseEventLines(frame.text);
          count += evs.length;
          events += evs.length;
          if (evs.length && this.onEvents) this.onEvents(item.sessionId, evs, { preload: true });
        }
        entry.pos = from + parsed.consumedEnd;
        entry.size = st.size;
        entry.mtimeMs = st.mtimeMs;
        preloaded += 1;
        void count;
      } catch (err) {
        this.noteError(item.file, err);
      }
    }

    const ms = performance.now() - t0;
    this.stats = { files: this.files.size, preloaded, frames, events, bytes: 0, errors: 0, backlog: 0 };
    return { files: this.files.size, preloaded, frames, events, ms };
  }

  /**
   * Incremental poll: stat known files, read + decode only the new bytes.
   * @returns {Promise<{files:number, frames:number, events:number, bytes:number, ms:number, backlog:number}>}
   */
  async poll(now = Date.now()) {
    const t0 = performance.now();
    const listed = await this.scan();
    const seen = new Set();
    const candidates = [];

    for (const item of listed) {
      seen.add(item.file);
      let st;
      try {
        st = await fsp.stat(item.file);
      } catch (err) {
        this.noteError(item.file, err);
        continue;
      }
      let entry = this.files.get(item.file);
      if (!entry) {
        // New session file discovered after boot: start it at the tail so we
        // don't suddenly replay an entire history; unless it is brand new.
        entry = {
          sessionId: item.sessionId,
          pos: st.size > 64 * 1024 ? st.size : 0,
          size: st.size,
          mtimeMs: st.mtimeMs,
          stuck: 0,
          stuckAt: 0,
          errorCount: 0,
        };
        this.files.set(item.file, entry);
      }
      if (st.size < entry.pos) {
        // File was truncated / rewritten: restart from zero.
        entry.pos = 0;
        this.log?.(`[events] truncated, rescanning ${item.sessionId}`);
      }
      if (st.size > entry.pos || st.mtimeMs !== entry.mtimeMs) {
        entry.size = st.size;
        entry.mtimeMs = st.mtimeMs;
        if (st.size >= entry.pos) candidates.push({ item, entry, st });
      }
    }
    // Drop files that disappeared.
    for (const file of this.files.keys()) {
      if (!seen.has(file)) this.files.delete(file);
    }

    // Read most recently active files first when the budget is tight.
    candidates.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    let budget = this.readBudgetPerPoll;
    let bytes = 0;
    let frames = 0;
    let events = 0;
    let backlog = 0;

    for (const { item, entry, st } of candidates) {
      if (budget <= 0) {
        backlog += Math.max(0, st.size - entry.pos);
        continue;
      }
      const want = Math.min(st.size - entry.pos, budget, 2 * 1024 * 1024);
      if (want <= 0) continue;
      let buf;
      try {
        buf = await readRange(item.file, entry.pos, want);
      } catch (err) {
        this.noteError(item.file, err);
        continue;
      }
      budget -= want;
      bytes += buf.length;
      const parsed = parseFrames(buf);
      frames += parsed.frames.length;
      if (parsed.frames.length) {
        let count = 0;
        for (const frame of parsed.frames) {
          const evs = parseEventLines(frame.text);
          count += evs.length;
          if (evs.length && this.onEvents) this.onEvents(entry.sessionId, evs, { preload: false });
        }
        events += count;
        entry.pos += parsed.consumedEnd;
        entry.stuck = 0;
        entry.stuckAt = 0;
      } else if (parsed.pendingFrom < buf.length) {
        // Incomplete tail; advance only to the frame start and retry later.
        entry.pos += parsed.pendingFrom;
        entry.stuck += 1;
        entry.stuckAt = entry.stuckAt || now;
      } else {
        // No magic at all: likely mid-frame content that started before our
        // cursor. Skip it to make progress.
        entry.pos += buf.length;
        entry.stuck = 0;
        entry.stuckAt = 0;
      }

      // Self-heal: a stalled pending cursor is almost certainly a false magic.
      const pendingBytes = st.size - entry.pos;
      if (entry.stuck >= 6 && pendingBytes > PENDING_MAX_BYTES &&
          now - (entry.stuckAt || now) > PENDING_STALL_MS) {
        entry.pos += MAGIC.length;
        entry.stuck = 0;
        entry.stuckAt = 0;
      }
      if (entry.pos < st.size) {
        backlog += st.size - entry.pos;
        if (entry.pos + MAGIC.length <= st.size) {
          // Schedule the remainder for the next poll (budget will allow it).
        }
      }
    }

    const ms = performance.now() - t0;
    this.stats = { files: this.files.size, frames, events, bytes, errors: this.stats.errors, backlog, ms };
    return this.stats;
  }

  noteError(file, err) {
    this.stats.errors += 1;
    const entry = this.files.get(file);
    if (entry) entry.errorCount += 1;
    const now = Date.now();
    const last = this._lastError ?? 0;
    if (now - last > 10_000) {
      this._lastError = now;
      this.log?.(`[events] ${path.basename(path.dirname(file))}: ${err?.message ?? err}`);
    }
  }

  /** Per-file read cursor summary (used by /api/health and tests). */
  cursorSummary() {
    let lagging = 0;
    for (const e of this.files.values()) if (e.pos < e.size) lagging += 1;
    return { tracked: this.files.size, lagging };
  }
}
