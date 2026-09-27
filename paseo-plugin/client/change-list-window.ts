import type { TreeRow } from './model.ts';
/** Existing web row heights, with ten rows of overscan and no style changes. */
export function changeRowOffsets(rows: readonly TreeRow[]): number[] {
  const offsets = [0];
  for (const row of rows) offsets.push(offsets[offsets.length - 1] + (row.kind === 'directory' ? 29 : 30));
  return offsets;
}
export function changeListWindow(offsets: readonly number[], scrollTop: number, height: number, enabled: boolean) {
  const count = offsets.length - 1;
  if (!enabled || count <= 200) return { start: 0, end: count, before: 0, after: 0 };
  const find = (y: number) => {
    let low = 0, high = count;
    while (low < high) { const mid = (low + high) >>> 1; if (offsets[mid] < y) low = mid + 1; else high = mid; }
    return low;
  };
  const start = Math.max(0, find(Math.max(0, scrollTop - 300)) - 1);
  const end = Math.min(count, find(scrollTop + Math.max(300, height) + 300) + 1);
  return { start, end, before: offsets[start], after: offsets[count] - offsets[end] };
}
