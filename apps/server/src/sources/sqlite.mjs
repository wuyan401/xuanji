// Lazily load `node:sqlite`.
//
// SQLite support in Node is still flagged experimental, so importing it prints
// a one-time ExperimentalWarning on stderr. That noise would pollute the server
// log (and any supervisor), so we set NODE_NO_WARNINGS *before* the dynamic
// import: the warning check happens when the module is first loaded, and the
// flag read then is respected. Doing it here keeps every static import path
// warning-free; the load is cached so callers just `await loadSqlite()`.
let cached = null;

export function loadSqlite() {
  if (!cached) {
    if (!process.env.NODE_NO_WARNINGS) process.env.NODE_NO_WARNINGS = '1';
    cached = import('node:sqlite');
  }
  return cached;
}
