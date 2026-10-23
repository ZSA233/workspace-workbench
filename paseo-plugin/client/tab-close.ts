export type TabCloseMode = 'current' | 'others' | 'left' | 'right' | 'all';

/** Resolve one close operation against the visible order, without activating its anchor first. */
export function resolveTabClose<T>(values: T[], keyOf: (value: T) => string, anchorKey: string, activeKey: string, mode: TabCloseMode) {
  const keys = values.map(keyOf), anchor = keys.indexOf(anchorKey);
  if (anchor < 0) return { values, removed: [] as T[], activeKey };
  const removed: T[] = [], remaining: T[] = [], remainingKeys: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const close = mode === 'all' || mode === 'current' && index === anchor || mode === 'others' && index !== anchor || mode === 'left' && index < anchor || mode === 'right' && index > anchor;
    if (close) removed.push(values[index]);
    else { remaining.push(values[index]); remainingKeys.push(keys[index]); }
  }
  if (!removed.length) return { values, removed, activeKey };
  const survivors = new Set(remainingKeys);
  if (!survivors.has(activeKey)) {
    const previous = keys.indexOf(activeKey);
    activeKey = survivors.has(anchorKey) ? anchorKey : keys.find((key, index) => index > previous && survivors.has(key)) || remainingKeys.at(-1) || '';
  }
  return { values: remaining, removed, activeKey };
}
