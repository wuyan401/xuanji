// Runtime configuration for the ASTRA data server.
// Everything is env- or CLI-overridable so the server can run with zero deps
// on any machine that has a DSH installation.

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
/** repo root: apps/server/src -> apps/server -> apps -> <repo> */
export const REPO_ROOT = path.resolve(SRC_DIR, '..', '..', '..');

function flag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Resolve the DSH data root (`~/.dsh`). Honours DSH_HOME / DSH_ROOT for tests. */
export function resolveDshRoot() {
  const explicit = process.env.DSH_ROOT || process.env.DSH_HOME;
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), '.dsh');
}

export function loadConfig() {
  const dshRoot = resolveDshRoot();
  const demo = flag('--demo') || process.env.DEMO === '1' || process.env.DEMO === 'true';
  const replayFile = argValue('--replay', process.env.REPLAY_FILE || null);

  return {
    host: process.env.HOST || '127.0.0.1',
    port: num(process.env.PORT, 8787),

    // --- data sources ---
    dshRoot,
    projcacheDir: path.join(dshRoot, 'storages', 'session_projcache', 'sessions'),
    workspaceFile: path.join(dshRoot, 'storages', 'workspace.json'),
    eventsRoot: path.join(dshRoot, 'sessions'),

    // --- v2: other local agent tools (all read-only, each may be absent) ---
    /** Hermes agent state DB (SQLite, seconds-based REAL timestamps) */
    hermesDb: process.env.HERMES_DB || '~/.hermes/state.db',
    /** opencode SQLite DB (ms timestamps, JSON TEXT columns) */
    opencodeDb:
      process.env.OPENCODE_DB ||
      path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    /** Claude Code project logs (one *.jsonl session per file) */
    claudeDir: process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects'),
    /** Codex CLI root (rollouts live in <root>/sessions/**) */
    codexDir: process.env.CODEX_DIR || path.join(os.homedir(), '.codex'),
    /** how often non-DSH sources re-check their data (ms) */
    sourcePollMs: num(process.env.SOURCE_POLL_MS, 1000),
    /** Claude sessions without activity for this long are skipped for seed events */
    claudeRecentMs: num(process.env.CLAUDE_RECENT_MS, 7 * 24 * 3_600_000),

    // --- v2: machine telemetry ---
    /** false disables the PowerShell sampler entirely (available:false) */
    system: process.env.SYSTEM_TELEMETRY !== '0',
    systemScript:
      process.env.SYSTEM_SCRIPT ||
      path.join(SRC_DIR, 'system-sample.ps1'),
    /** sampler cadence; the contract promises one sample every 2s */
    systemSampleMs: num(process.env.SYSTEM_SAMPLE_MS, 2000),
    /** in-memory sample ring for /api/system/history */
    systemHistory: num(process.env.SYSTEM_HISTORY, 120),

    demo: demo || Boolean(replayFile),
    replayFile: replayFile || null,

    // --- collector tuning ---
    pollMs: num(process.env.POLL_MS, 500),
    /** a session counts as `live` if it had activity within this window */
    liveMs: num(process.env.LIVE_MS, 60_000),
    /** ... `idle` when younger than this, otherwise `ended` */
    idleMs: num(process.env.IDLE_MS, 30 * 60_000),
    /** how many events the in-memory ring keeps */
    eventRing: num(process.env.EVENT_RING, 2000),
    /** how many events a /api/fleet snapshot carries (contract: <=300) */
    fleetEventLimit: num(process.env.FLEET_EVENT_LIMIT, 300),
    /** zstd tailer: bytes re-read on init for recently-active sessions */
    tailBytes: num(process.env.EVENT_TAIL_BYTES, 256 * 1024),
    /** zstd tailer: max bytes consumed per file per poll */
    readBudgetPerPoll: num(process.env.EVENT_READ_BUDGET, 4 * 1024 * 1024),
    /** sessions with no event file are still shown; no need to scan deeply */
    workspaceRefreshMs: num(process.env.WORKSPACE_REFRESH_MS, 15_000),

    // --- http ---
    cors: flag('--cors') || process.env.CORS === '1',
    webDist: process.env.WEB_DIST || path.join(REPO_ROOT, 'apps', 'web', 'dist'),
    /** SSE snapshot cadence (ms); contract says <=1 fps */
    fleetFrameMs: num(process.env.FLEET_FRAME_MS, 1000),
    /** SSE heartbeat comment cadence (ms) */
    heartbeatMs: num(process.env.HEARTBEAT_MS, 15_000),
    /**
     * Slow-client protection: skip SSE frames while a client socket has more
     * than this many bytes queued (a backgrounded tab stops draining). Without
     * this the 1/s full-fleet frame (~0.6MB) grows the heap until OOM.
     */
    sseMaxBuffer: num(process.env.SSE_MAX_BUFFER, 2 * 1024 * 1024),
    /** print one collector timing line per poll unless disabled */
    logPoll: process.env.LOG_POLL !== '0',
    verbose: process.env.VERBOSE === '1',
  };
}
