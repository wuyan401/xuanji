// One-shot dev launcher: boots the data server and the Vite dev server together.
// Usage: node tools/dev.mjs
import { spawn } from 'node:child_process';

const procs = [];
function run(label, cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32', ...opts });
  p.on('exit', (code) => {
    console.log(`[dev] ${label} exited (${code})`);
    shutdown();
  });
  procs.push(p);
  return p;
}

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const p of procs) {
    try { p.kill(); } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('[dev] starting data server on :8787');
run('server', process.execPath, ['--watch', 'apps/server/src/server.mjs']);
console.log('[dev] starting web on :5173');
run('web', 'pnpm', ['-C', 'apps/web', 'dev']);
