// Structural sharing at the JSON boundary. A full SSE frame is not a full UI invalidation.
// Avoid serializing the object twice: equal JSON subtrees retain their previous references.
import type { AgentSession } from './types';

export function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !sameJson(left[key], right[key])) return false;
  }
  return true;
}

export function retainJson<T>(previous: T, incoming: T): T {
  return sameJson(previous, incoming) ? previous : incoming;
}

/** Reuse unchanged sessions as well as the array when ordering and content are identical. */
export function retainSessions(
  previous: AgentSession[],
  incoming: AgentSession[],
  byId: ReadonlyMap<string, AgentSession>,
): AgentSession[] {
  let unchanged = previous.length === incoming.length;
  const result = incoming.map((item, index) => {
    const old = byId.get(item.id);
    const next = old && sameJson(old, item) ? old : item;
    if (next !== previous[index]) unchanged = false;
    return next;
  });
  return unchanged ? previous : result;
}
