// Workspace ("Sector") indexing.
//
//   ~/.dsh/storages/workspace.json
//   { tables: { workspaces: { <id>: { path, title, sessionIds[], createdAt, updatedAt } } },
//     global: { archivedSessionIds: string[], pinnedSessionIds: string[] } }
//
// Most sessions in the projcache are no longer listed in workspace.json (only
// ~35 of 123 at the time of writing), so sessions are assigned by cwd with a
// stable fallback sector per path.

import path from 'node:path';
import { readJsonSafe } from './util.mjs';

export function slugifyPath(p) {
  return String(p || '')
    .toLowerCase()
    .replace(/[:\\/]+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Normalise a Windows/posix path so cwd comparison is stable. */
export function normPath(p) {
  if (!p || typeof p !== 'string') return '';
  return path.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
}

export class WorkspaceIndex {
  constructor() {
    /** @type {Map<string,{id:string,name:string,path:string,sessionIds:Set<string>,listed:boolean}>} */
    this.byId = new Map();
    /** @type {Map<string,string>} normalised path -> workspace id */
    this.byPath = new Map();
    /** @type {Map<string,string>} sessionId -> workspace id */
    this.bySession = new Map();
    this.archived = new Set();
    this.pinned = new Set();
    this.loadedAt = 0;
    this.error = null;
  }

  static async load(file) {
    const index = new WorkspaceIndex();
    const raw = await readJsonSafe(file);
    if (!raw) {
      index.error = 'workspace.json unreadable';
      return index;
    }
    const workspaces = raw?.tables?.workspaces ?? {};
    for (const [id, ws] of Object.entries(workspaces)) {
      if (!ws || typeof ws !== 'object') continue;
      const wsPath = typeof ws.path === 'string' ? ws.path : '';
      const name = (typeof ws.title === 'string' && ws.title.trim()) ||
        (wsPath ? path.basename(wsPath) : id);
      const entry = {
        id,
        name,
        path: wsPath,
        sessionIds: new Set(Array.isArray(ws.sessionIds) ? ws.sessionIds : []),
        listed: true,
      };
      index.byId.set(id, entry);
      if (wsPath) index.byPath.set(normPath(wsPath), id);
      for (const sid of entry.sessionIds) index.bySession.set(sid, id);
    }
    const g = raw?.global ?? {};
    for (const sid of g.archivedSessionIds ?? []) index.archived.add(sid);
    for (const sid of g.pinnedSessionIds ?? []) index.pinned.add(sid);
    index.loadedAt = Date.now();
    return index;
  }

  /** Sector descriptor for a session, creating a cwd fallback if needed. */
  assign(sessionId, cwd) {
    const known = this.byId.get(this.bySession.get(sessionId));
    if (known) return known;
    const key = normPath(cwd);
    let id = key ? this.byPath.get(key) : null;
    if (!id) {
      if (!key) {
        id = 'ws-unknown';
        if (!this.byId.has(id)) {
          this.byId.set(id, { id, name: '未知星域', path: '', sessionIds: new Set(), listed: false });
        }
      } else {
        id = `ws-${slugifyPath(cwd) || 'root'}`;
        if (!this.byId.has(id)) {
          const name = path.basename(cwd) || cwd;
          this.byId.set(id, { id, name, path: cwd, sessionIds: new Set(), listed: false });
          this.byPath.set(key, id);
        }
      }
    }
    const ws = this.byId.get(id);
    ws.sessionIds.add(sessionId);
    this.bySession.set(sessionId, id);
    return ws;
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  list() {
    return [...this.byId.values()];
  }
}
