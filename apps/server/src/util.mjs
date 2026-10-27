// Small dependency-free helpers shared by the collector modules.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const nowMs = () => Date.now();

/** millisecond pretty formatter for logs */
export function ms(v) {
  return `${Math.round(v * 10) / 10}ms`;
}

export async function statSafe(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

export async function readJsonSafe(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listDirSafe(dir) {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

export async function listFilesByExtSafe(dir, ext) {
  const entries = await listDirSafe(dir);
  return entries.filter((n) => n.endsWith(ext));
}

/** Recursively list files under `root`, one level nesting is enough for DSH
 *  (`sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`), but walk anyway. */
export async function walkFiles(root, maxDepth = 3) {
  const out = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(full, depth + 1);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(root, 0);
  return out;
}

/** Strip DSH system-reminder / injected noise from prompts so titles and
 *  ledger text stay human. Also collapses whitespace. */
export function cleanText(input, maxLen = Infinity) {
  if (typeof input !== 'string') return '';
  let s = input;
  // remove <system-reminder> ... </system-reminder> blocks
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ');
  // truncated payloads may cut the closing tag: drop from the lone opening tag
  // to the end so raw reminder markup never reaches the UI (callers fall back)
  s = s.replace(/<system-reminder[\s\S]*$/gi, ' ');
  // remove any dangling reminder headings / teammate boilerplate lines
  s = s.replace(/^>\s*/gm, '');
  s = s.replace(/\s+/g, ' ').trim();
  // truncated payloads end with an ellipsis marker, keep one
  if (s.length > maxLen) {
    s = `${s.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
  }
  return s;
}

/** Keep only the first line / first N chars of a tool argument blob. */
export function summarizeArgs(args, maxLen = 120) {
  if (args == null) return null;
  if (typeof args !== 'string') {
    try {
      args = JSON.stringify(args);
    } catch {
      args = String(args);
    }
  }
  const text = String(args).replace(/\r/g, '');
  const firstLine = text.split('\n').find((l) => l.trim().length) || '';
  const compact = firstLine.replace(/\s+/g, ' ').trim();
  return cleanText(compact, maxLen) || null;
}

/** Try to pull a short human hint out of a tool-call argument JSON. */
export function toolArgHint(name, args) {
  if (!args) return null;
  if (typeof args !== 'string') {
    try {
      args = JSON.stringify(args);
    } catch {
      return null;
    }
  }
  // Prefer the most descriptive scalar field when the payload is plain JSON.
  if (args.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(args);
      const preferred = [
        'file_path', 'path', 'filePath', 'command', 'description', 'pattern',
        'query', 'queries', 'url', 'name', 'subject', 'prompt', 'content',
      ];
      for (const key of preferred) {
        const v = obj?.[key];
        if (typeof v === 'string' && v.trim()) return summarizeArgs(v, 120);
        if (Array.isArray(v) && v.length && typeof v[0] === 'string') {
          return summarizeArgs(v.join(' · '), 120);
        }
      }
    } catch {
      /* fall through to raw summary */
    }
  }
  return summarizeArgs(args, 120);
}

/** Extract the visible answer text from an assistant message content array. */
export function assistantText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return cleanText(content);
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return cleanText(parts.join(' '));
}

/** Extract text from a tool result message. */
export function toolResultText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return cleanText(content);
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === 'string') parts.push(block);
    else if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return cleanText(parts.join(' '));
}

/** User message text. */
export function userMessageText(data) {
  if (!data) return '';
  const content = data.content;
  if (typeof content === 'string') return cleanText(content);
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === 'string') parts.push(block);
    else if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return cleanText(parts.join(' '));
}

/** Stable short id helper for synthetic events / entities. */
let seqCounter = 0;
export function nextId(prefix) {
  seqCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${seqCounter.toString(36)}`;
}

/** Map over items with bounded concurrency. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const sleep = (n) => new Promise((r) => setTimeout(r, n));

/** JSON response helper, used by the tiny HTTP server. */
export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...(res.__corsHeaders || {}),
  });
  res.end(payload);
}

export function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...(res.__corsHeaders || {}),
  });
  res.end(buf);
}

export function tail(arr, n) {
  return arr.length <= n ? arr.slice() : arr.slice(arr.length - n);
}

export { fs, fsp };
