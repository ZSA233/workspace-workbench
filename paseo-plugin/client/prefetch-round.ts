/** Completion belongs to the current roster, not to the (smaller) content LRU. */
export function createPrefetchRound() {
  let identity = '', active = false;
  const visited = new Map<string, boolean>(); // true: success; false: skipped failure
  return {
    reconcile(owner: string, keys: string[], enabled: boolean) {
      if (identity !== owner) { identity = owner; visited.clear(); }
      if (enabled && !active) for (const [key, success] of visited) if (!success) visited.delete(key);
      active = enabled;
      const roster = new Set(keys);
      for (const key of visited.keys()) if (!roster.has(key)) visited.delete(key);
    },
    next(keys: string[]) { return keys.find(key => !visited.has(key)); },
    complete(key: string, success: boolean) { visited.set(key, success); },
    retry() { for (const [key, success] of visited) if (!success) visited.delete(key); },
  };
}
