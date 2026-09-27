import test from 'node:test';
import assert from 'node:assert/strict';
import { changeListWindow, changeRowOffsets } from '../client/change-list-window.ts';
import type { TreeRow } from '../client/model.ts';

test('large flat lists retain scroll height while rendering a bounded visible slice', () => {
  const rows: TreeRow[] = Array.from({ length: 20000 }, (_, i) => ({ kind: 'file', depth: 0, file: { path: String(i), status: 'M', statusLabel: 'Modified', additions: 1, deletions: 1 } }));
  const offsets = changeRowOffsets(rows);
  for (const top of [0, 30000, 599000]) {
    const window = changeListWindow(offsets, top, 800, true);
    assert.ok(window.end - window.start <= 50);
    assert.equal(window.before + offsets[window.end] - offsets[window.start] + window.after, 600000);
  }
  assert.equal(changeListWindow(offsets, 0, 800, false).end, 20000);
});

test('directory heights and small lists preserve existing layout', () => {
  const offsets = changeRowOffsets([{ kind: 'directory', path: 'a', label: 'a', depth: 0, fileCount: 1, additions: 1, deletions: 0 }]);
  assert.deepEqual(offsets, [0, 29]);
  assert.deepEqual(changeListWindow(offsets, 0, 800, true), { start: 0, end: 1, before: 0, after: 0 });
});
