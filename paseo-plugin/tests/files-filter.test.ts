import test from 'node:test';
import assert from 'node:assert/strict';
import { FilesTreeState } from '../client/files-tree-store.ts';
import type { DirectoryPage, FileEntry } from '../shared/files.ts';

function fixture() {
  const tree = new FilesTreeState('file-filter-test', 'main');
  tree.instance = 'one';
  const page = (path: string, entries: [string, FileEntry['kind']][], cursor?: string) => {
    tree.pages.set(path, { workspaceId: 'main', instance: 'one', path, version: 'v1', cursor,
      entries: entries.map(([name, kind]) => ({ name, kind, path: [path, name].filter(Boolean).join('/'),
        size: 1, modifiedAt: 1, version: 'v1', protected: false, repository: false })) } satisfies DirectoryPage);
  };
  page('', [['app', 'directory'], ['empty', 'directory'], ['docs', 'directory'], ['README.md', 'file']], 'root-next');
  page('app', [['src', 'directory'], ['assets', 'directory'], ['package.json', 'file']]);
  page('app/src', [['config.ts', 'file'], ['index.ts', 'file']], 'src-next');
  page('app/assets', [['logo.png', 'file']], 'assets-next');
  page('docs', [['CONFIG.md', 'file'], ['notes.md', 'file']]);
  tree.expanded = new Set(['', 'app', 'app/src', 'app/assets', 'docs']);
  return tree;
}

test('file filtering retains matching files and their ancestors, hiding unrelated branches', () => {
  const tree = fixture();
  const rows = tree.rows('config');
  assert.deepEqual(rows.filter(row => !row.more).map(row => [row.path, row.depth]), [
    ['', 0], ['app', 1], ['app/src', 2], ['app/src/config.ts', 3], ['docs', 1], ['docs/CONFIG.md', 2],
  ]);
  assert.deepEqual(rows.filter(row => row.more).map(row => row.path), ['app/src', '']);
});

test('a directory matches its own name without admitting unrelated descendants or siblings', () => {
  const tree = fixture();
  assert.deepEqual(tree.rows('ASSETS').filter(row => !row.more).map(row => row.path), ['', 'app', 'app/assets']);
  assert.deepEqual(tree.rows('readme').filter(row => !row.more).map(row => row.path), ['', 'README.md']);
});

test('no match leaves the Workspace root and its pagination, without unrelated directory rows', () => {
  const rows = fixture().rows('not-a-match');
  assert.deepEqual(rows.map(row => row.key), ['root', '/:more']);
});

test('changing and clearing the filter preserves expansion, selection, scroll and directory snapshots', () => {
  const tree = fixture(); tree.selected.add('app/src/config.ts'); tree.scroll = 220;
  const before = tree.rows(), expanded = [...tree.expanded], pages = [...tree.pages.values()];
  tree.rows('config'); tree.rows('assets'); tree.rows('not-a-match');
  assert.deepEqual(tree.rows(''), before);
  assert.deepEqual([...tree.expanded], expanded); assert.deepEqual([...tree.selected], ['app/src/config.ts']);
  assert.equal(tree.scroll, 220); assert.deepEqual([...tree.pages.values()], pages);
});
