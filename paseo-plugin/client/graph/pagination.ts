// One automatic attempt per observed page. Failures require explicit retry.
export function createHistoryLoadGate() {
  const attempted = new Set<string>();
  let currentIdentity = "";
  let lastOffset = 0;

  return {
    allow(identity: string, count: number, offset: number, viewport: number, content: number, busy: boolean, hasOlder: boolean): boolean {
      if (identity !== currentIdentity) {
        currentIdentity = identity;
        attempted.clear();
        lastOffset = offset;
        return false;
      }
      const movingDown = offset > lastOffset;
      lastOffset = offset;
      const key = String(count);
      if (!movingDown || busy || !hasOlder || count >= 200 || content <= viewport || content - viewport - offset > 80 || attempted.has(key)) return false;
      attempted.add(key);
      return true;
    }
  };
}
