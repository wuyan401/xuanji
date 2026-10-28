// Machine telemetry: spawns src/system-sample.ps1 once and turns its one-JSON-line-
// per-2s stdout into a compact history ring that /api/system and SSE `system`
// frames are served from.
//
// Resilience: any spawn/parse failure only marks the monitor unavailable (or skips
// that line) — the fleet API keeps working. The sampler process is restarted with
// capped backoff if it ever exits. Non-Windows machines simply report available:false.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** v2.5 百工视图要「全进程」：采样器输出上限（按 CPU/内存取前 N） */
const PROCS_TOP = 220;
const RESTART_MAX_MS = 10_000;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, num(value)));
}

/** Normalise one sampler line into the public SystemSample shape. */
export function normalizeSample(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const procs = Array.isArray(raw.procs)
    ? raw.procs
        .map((proc) => ({
          pid: Math.round(num(proc?.pid)),
          name: String(proc?.name ?? '?').slice(0, 64),
          cpuPct: Math.round(num(proc?.cpuPct) * 10) / 10,
          memBytes: Math.round(num(proc?.memBytes)),
          threads: Math.round(num(proc?.threads)),
          startedAt: Math.round(num(proc?.startedAt)),
        }))
        .slice(0, PROCS_TOP)
    : [];
  const disks = Array.isArray(raw.disks)
    ? raw.disks.map((disk) => ({
        name: String(disk?.name ?? '?'),
        totalBytes: Math.round(num(disk?.totalBytes)),
        freeBytes: Math.round(num(disk?.freeBytes)),
        usedPct: Math.round(clamp01(disk?.usedPct) * 10_000) / 10_000,
      }))
    : [];
  const sample = {
    at: Math.round(num(raw.at, now)),
    available: true,
    cpu: {
      usage: Math.round(clamp01(raw.cpu?.usage) * 10_000) / 10_000,
      perCore: Array.isArray(raw.cpu?.perCore)
        ? raw.cpu.perCore.map((value) => Math.round(clamp01(value) * 10_000) / 10_000)
        : [],
    },
    mem: {
      usedPct: Math.round(clamp01(raw.mem?.usedPct) * 10_000) / 10_000,
      usedBytes: Math.round(num(raw.mem?.usedBytes)),
      totalBytes: Math.round(num(raw.mem?.totalBytes)),
    },
    disks,
    net: {
      rxBps: Math.round(num(raw.net?.rxBps)),
      txBps: Math.round(num(raw.net?.txBps)),
      totalRxBytes: Math.round(num(raw.net?.totalRxBytes)),
      totalTxBytes: Math.round(num(raw.net?.totalTxBytes)),
    },
    procs,
    uptimeSec: Math.round(num(raw.uptimeSec)),
    battery: raw.battery
      ? {
          percent: Math.round(num(raw.battery.percent)),
          charging: Boolean(raw.battery.charging),
        }
      : null,
  };
  return sample;
}

/** Shape returned when telemetry is unavailable, so clients can render a state. */
export function createEmptySystem() {
  return {
    at: Date.now(),
    available: false,
    cpu: { usage: 0, perCore: [] },
    mem: { usedPct: 0, usedBytes: 0, totalBytes: 0 },
    disks: [],
    net: { rxBps: 0, txBps: 0, totalRxBytes: 0, totalTxBytes: 0 },
    procs: [],
    uptimeSec: 0,
    battery: null,
  };
}

export class SystemMonitor extends EventEmitter {
  constructor(config = {}, { log = () => {} } = {}) {
    super();
    this.config = config;
    this.log = log;
    this.scriptPath =
      config.systemScript ?? path.join(HERE, 'system-sample.ps1');
    this.intervalMs = Math.max(500, config.systemSampleMs ?? 2000);
    this.historyLimit = Math.max(10, config.systemHistory ?? 120);
    this.enabled = config.system !== false;
    this.available = false;
    this.child = null;
    this.running = false;
    this.stopped = false;
    this.stdoutBuffer = '';
    this.history = [];
    this.latest = null;
    this.startedAt = Date.now();
    this.lastSampleAt = 0;
    this.restarts = 0;
    this.restartTimer = null;
    this.errors = 0;
    this.command = null;
    this._spawnIndex = 0;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.spawnWorker();
    return this;
  }

  candidates() {
    return configShellCandidates(this.config);
  }

  spawnWorker() {
    if (this.stopped || !this.enabled) return;
    if (process.platform !== 'win32') {
      this.available = false;
      return;
    }
    if (!fs.existsSync(this.scriptPath)) {
      this.available = false;
      this.log(`[system] sampler script missing: ${this.scriptPath}`);
      return;
    }
    const candidates = this.candidates();
    const shell = candidates[this._spawnIndex % candidates.length];
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.scriptPath,
      '-IntervalMs',
      String(this.intervalMs),
    ];
    let child;
    try {
      child = spawn(shell, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.log(`[system] spawn failed (${shell}): ${err?.message ?? err}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.command = shell;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.log(`[system] stderr: ${text.slice(0, 400)}`);
    });
    child.on('error', (err) => {
      this.errors += 1;
      this.available = false;
      this.log(`[system] child error (${shell}): ${err?.message ?? err}`);
      if (err?.code === 'ENOENT') this._spawnIndex += 1;
      this.scheduleRestart();
    });
    child.on('close', (code) => {
      this.child = null;
      if (this.stopped) return;
      if (code !== 0) this.log(`[system] sampler exited (code ${code}), restarting`);
      this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (this.stopped) return;
    if (this.restartTimer) return;
    this.restarts += 1;
    const delay = Math.min(RESTART_MAX_MS, 500 * 2 ** Math.min(4, this.restarts - 1));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnWorker();
    }, delay);
    this.restartTimer.unref?.();
  }

  onStdout(chunk) {
    this.stdoutBuffer += chunk;
    let index;
    while ((index = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) this.ingestLine(line);
    }
    if (this.stdoutBuffer.length > 1_000_000) this.stdoutBuffer = '';
  }

  /** Parse one sampler JSON line; returns the stored sample (or null). */
  ingestLine(line) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      return null;
    }
    if (!raw || typeof raw !== 'object' || raw.error) {
      this.errors += 1;
      return null;
    }
    const sample = normalizeSample(raw, Date.now());
    if (!sample) return null;
    this.available = true;
    this.latest = sample;
    this.lastSampleAt = sample.at || Date.now();
    this.history.push(sample);
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    this.emit('sample', sample);
    return sample;
  }

  /** Latest full sample (procs already trimmed to top 12). */
  getSystem() {
    if (!this.latest) {
      const empty = createEmptySystem();
      empty.at = this.lastSampleAt || Date.now();
      return empty;
    }
    return this.latest;
  }

  getHistory(limit = this.historyLimit) {
    const count = Math.min(Math.max(1, limit), this.historyLimit);
    return this.history.slice(-count);
  }

  getHealth() {
    return {
      available: this.available,
      running: this.running && !this.stopped,
      command: this.command,
      shell: this.command,
      script: this.scriptPath,
      intervalMs: this.intervalMs,
      samples: this.history.length,
      historyLimit: this.historyLimit,
      lastSampleAt: this.lastSampleAt,
      restarts: this.restarts,
      errors: this.errors,
    };
  }

  stop() {
    this.stopped = true;
    this.running = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.child = null;
    }
  }
}

function configShellCandidates(config) {
  if (Array.isArray(config.shellCandidates) && config.shellCandidates.length) return config.shellCandidates;
  if (process.platform !== 'win32') return ['pwsh', 'powershell'];
  // Prefer absolute paths: a server launched from a stripped-PATH environment
  // (services, CI, background jobs) cannot resolve `pwsh` by name, which used to
  // leave machine telemetry permanently unavailable.
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const absolute = [
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ].filter((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  return [...absolute, 'pwsh', 'powershell.exe', 'powershell'];
}

export function createSystemMonitor(config, opts) {
  return new SystemMonitor(config, opts);
}
