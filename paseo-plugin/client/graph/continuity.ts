import type { CommitNode } from '../model.ts';

/** A graph response is an authoritative prefix, not an append-only page. */
export function uniqueCommits(nodes: CommitNode[]): CommitNode[] {
  const seen = new Set<string>();
  return nodes.filter(node => {
    if (seen.has(node.sha)) return false;
    seen.add(node.sha);
    return true;
  });
}

/** Preserve the first visible row, or its nearest surviving neighbour. */
export function anchoredOffset(before: readonly string[], after: readonly string[], offset: number, rowHeight: number): number {
  if (!before.length || !after.length) return 0;
  const index = Math.min(before.length - 1, Math.max(0, Math.floor(offset / rowHeight)));
  const remainder = Math.max(0, offset - index * rowHeight);
  for (let distance = 0; distance < before.length; distance++) {
    for (const candidate of distance ? [index + distance, index - distance] : [index]) {
      if (candidate < 0 || candidate >= before.length) continue;
      const next = after.indexOf(before[candidate]);
      if (next !== -1) return next * rowHeight + Math.min(remainder, rowHeight - 1);
    }
  }
  return 0;
}
