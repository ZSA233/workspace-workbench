// One automatic attempt per observed page. Failures require explicit retry.
export function createHistoryLoadGate() {
  const attempted = new Set<string>();
  let currentIdentity = '';
  let lastOffset = 0;
  let pendingCount: string | null = null;

  return {
    reset(identity: string, offset = 0) {
      currentIdentity = identity;
      attempted.clear();
      pendingCount = null;
      lastOffset = offset;
    },
    resume(identity: string, count: number, busy: boolean, hasOlder: boolean): boolean {
      if (busy) return false;
      const pending = pendingCount;
      pendingCount = null;
      if (identity !== currentIdentity || pending !== String(count) || !hasOlder || count >= 200 || attempted.has(pending)) return false;
      attempted.add(pending);
      return true;
    },
    allow(identity: string, count: number, offset: number, viewport: number, content: number, busy: boolean, hasOlder: boolean): boolean {
      if (identity !== currentIdentity) {
        currentIdentity = identity;
        attempted.clear();
        pendingCount = null;
        lastOffset = offset;
        return false;
      }
      const movingDown = offset > lastOffset;
      lastOffset = offset;
      const key = String(count);
      if (!hasOlder || count >= 200 || content <= viewport || content - viewport - offset > 80) { pendingCount = null; return false; }
      if (!movingDown || attempted.has(key)) return false;
      if (busy) { pendingCount = key; return false; }
      pendingCount = null;
      attempted.add(key);
      return true;
    }
  };
}
