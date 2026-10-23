import test from 'node:test';
import assert from 'node:assert/strict';
import { FilesTreeState, filesTreeState, reconcileFilesTrees } from '../client/files-tree-store.ts';
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

test('entering a matched folder shows all direct children, with deeper folders initially collapsed', async () => {
  const tree = fixture(), calls: any[] = [];
  tree.setFilter('app');
  const rpc = async (input: any) => { calls.push(input); return structuredClone(tree.pages.get(input.path)); };
  tree.enter('app', rpc);
  assert.equal(tree.filter, ''); assert.equal(tree.root, 'app');
  assert.deepEqual(tree.rows().filter(row => !row.more).map(row => [row.path, row.depth]), [
    ['app', 0], ['app/src', 1], ['app/assets', 1], ['app/package.json', 1],
  ]);
  assert.deepEqual([...tree.expanded], ['app']); assert.equal(tree.selected.size, 0);
  await tree.load('app', rpc);
  assert.equal(calls.length, 1, 'browse only the chosen directory, without scanning its children or ancestors');
  assert.equal(calls[0].workspaceId, 'main'); assert.equal(calls[0].instance, 'one');
  tree.toggle('app/src', rpc);
  assert.ok(tree.rows().some(row => row.path === 'app/src/config.ts'), 'children no longer need to match the previous query');
  await tree.load('app/src', rpc);
});

test('back restores the exact query, expanded paths, selection and scroll without rereading cached results', async () => {
  const tree = fixture(); tree.setFilter('ASSETS'); tree.scroll = 220; tree.selected.add('app/assets');
  const before = tree.rows(), expanded = [...tree.expanded], pages = [...tree.pages.values()];
  const rpc = async (input: any) => structuredClone(tree.pages.get(input.path));
  tree.enter('app/assets', rpc); await tree.load('app/assets', rpc);
  assert.equal(tree.backFilter, 'ASSETS'); assert.equal(tree.scroll, 0);
  let reads = 0;
  tree.back(async () => { reads++; throw Error('Cached navigation must not wait for RPC'); });
  assert.equal(reads, 0); assert.equal(tree.root, ''); assert.equal(tree.filter, 'ASSETS');
  assert.equal(tree.scroll, 220); assert.deepEqual([...tree.selected], ['app/assets']);
  assert.deepEqual([...tree.expanded], expanded); assert.deepEqual(tree.rows(), before);
  assert.deepEqual([...tree.pages.values()], pages); assert.equal(tree.canGoBack, false);
});

test('nested navigation and parent navigation retain distinct return points', async () => {
  const tree = fixture(), rpc = async (input: any) => structuredClone(tree.pages.get(input.path));
  tree.setFilter('app'); tree.enter('app', rpc); await tree.load('app', rpc);
  tree.setFilter('src'); tree.scroll = 44; tree.enter('app/src', rpc); await tree.load('app/src', rpc);
  assert.deepEqual(tree.rows().map(row => row.path), ['app/src', 'app/src/config.ts', 'app/src/index.ts', 'app/src']);
  assert.equal(tree.rows().at(-1)?.more, true, 'pagination uses the actual Workspace-relative directory');
  tree.enter('app', rpc); await tree.load('app', rpc);
  tree.back(rpc); assert.equal(tree.root, 'app/src'); assert.equal(tree.filter, '');
  tree.back(rpc); assert.equal(tree.root, 'app'); assert.equal(tree.filter, 'src'); assert.equal(tree.scroll, 44);
  tree.back(rpc); assert.equal(tree.root, ''); assert.equal(tree.filter, 'app');
});

test('returning while a folder is still loading keeps its late reply from changing the restored view', async () => {
  const tree = fixture(); tree.setFilter('empty');
  let finish!: (value: DirectoryPage) => void;
  tree.enter('empty', () => new Promise(resolve => { finish = resolve; }));
  const pending = tree.load('empty', async () => { throw Error('Must share the in-flight read'); });
  assert.equal(tree.root, 'empty'); assert.equal(tree.rows().length, 1);
  tree.back(async () => { throw Error('No cached result reread'); });
  finish({ workspaceId: 'main', instance: 'one', path: 'empty', version: 'v1', entries: [] }); await pending;
  assert.equal(tree.root, ''); assert.equal(tree.filter, 'empty');
  assert.deepEqual(tree.rows().filter(row => !row.more).map(row => row.path), ['', 'empty']);
});

test('offline folder entry remains navigable back, and instance replacement clears its browsing history', async () => {
  const tree = fixture(); tree.setFilter('assets');
  const offline = async () => { throw Error('offline'); };
  tree.enter('app/assets', offline); await tree.load('app/assets', offline);
  assert.equal(tree.root, 'app/assets'); assert.equal(tree.error, 'offline');
  assert.ok(tree.rows().some(row => row.path === 'app/assets/logo.png'), 'cached contents stay visible');
  tree.back(offline); assert.equal(tree.filter, 'assets');
  tree.enter('app/assets', offline); await tree.load('app/assets', offline);
  await tree.load('app/assets', async () => ({ ...tree.pages.get('app/assets')!, instance: 'replacement' }));
  assert.equal(tree.root, ''); assert.equal(tree.filter, ''); assert.equal(tree.canGoBack, false); assert.equal(tree.pages.size, 0);
});

test('removed folders cannot be revisited and a late listing cannot restore their contents', async () => {
  const tree = fixture(), rpc = async (input: any) => structuredClone(tree.pages.get(input.path));
  tree.setFilter('app'); tree.selected.add('app/src'); tree.enter('app', rpc); await tree.load('app', rpc);
  tree.setFilter('src'); tree.enter('app/src', rpc); await tree.load('app/src', rpc);
  let finish!: (value: DirectoryPage) => void;
  const stale = structuredClone(tree.pages.get('app/src')!);
  const pending = tree.load('app/src', () => new Promise(resolve => { finish = resolve; }));
  tree.changed({ workspaceId: 'main', instance: 'one', paths: ['app'], removed: ['app'] }, rpc);
  assert.equal(tree.root, ''); assert.equal(tree.filter, '');
  finish(stale); await pending;
  assert.equal(tree.pages.has('app/src'), false);
  tree.back(rpc); assert.equal(tree.root, ''); assert.equal(tree.filter, 'app'); assert.equal(tree.selected.size, 0);
  assert.ok(!tree.rows().some(row => row.path === 'app')); assert.equal(tree.canGoBack, false);
});

test('browsing and query changes reuse directory snapshots instead of invalidating the entry index', async () => {
  const tree = fixture(), revision = tree.structureRevision, rpc = async (input: any) => structuredClone(tree.pages.get(input.path));
  tree.setFilter('app'); tree.enter('app', rpc); await tree.load('app', rpc); tree.back(rpc);
  assert.equal(tree.structureRevision, revision, 'only the view changes while the directory entries are unchanged');
});

test('Workspace browsing state and its search return point remain independent across switches and removal', async () => {
  const scope = 'files-browse-workspace-test';
  const a = filesTreeState(scope, 'a'), b = filesTreeState(scope, 'b');
  const rpc = async (input: any) => ({ workspaceId: input.workspaceId, instance: 'one', path: input.path, version: 'v1', entries: [] });
  try {
    a.setFilter('folder-a'); a.scroll = 123; a.enter('folder-a', rpc); await a.load('folder-a', rpc);
    b.setFilter('folder-b');
    assert.equal(filesTreeState(scope, 'a'), a); assert.equal(a.root, 'folder-a'); assert.equal(a.filter, '');
    a.back(rpc); assert.equal(a.filter, 'folder-a'); assert.equal(a.scroll, 123);
    assert.equal(b.root, ''); assert.equal(b.filter, 'folder-b'); assert.equal(b.canGoBack, false);
    reconcileFilesTrees(scope, [{ id: 'b' }]); assert.equal(a.root, ''); assert.equal(a.filter, ''); assert.equal(a.canGoBack, false);
    assert.equal(b.filter, 'folder-b');
  } finally { reconcileFilesTrees(scope, []); }
});

test('a directory-name match expands in place to show nonmatching children and keeps the query and scroll', async () => {
  const tree = fixture(), requests: any[] = [];
  const rpc = async (input: any) => { requests.push(input); return structuredClone(tree.pages.get(input.path)); };
  tree.setFilter('ASSETS'); tree.scroll = 44;
  assert.equal(tree.rows().find(row => row.path === 'app/assets')?.expanded, false, 'cached expansion alone does not reveal filtered contents');
  tree.toggle('app/assets', rpc); await tree.load('app/assets', rpc);
  assert.equal(tree.root, ''); assert.equal(tree.filter, 'ASSETS'); assert.equal(tree.scroll, 44); assert.equal(tree.canGoBack, false);
  assert.deepEqual(tree.rows().filter(row => !row.more).map(row => row.path), ['', 'app', 'app/assets', 'app/assets/logo.png']);
  assert.deepEqual(requests.map(input => input.path), ['app/assets'], 'no recursive or sibling reads');
  tree.toggle('app/assets', rpc);
  assert.deepEqual(tree.rows().filter(row => !row.more).map(row => row.path), ['', 'app', 'app/assets']);
  assert.equal(tree.rows().find(row => row.path === 'app/assets')?.expanded, false);
});

test('a contextual parent can collapse and reopen without disappearing, while other matches stay filtered', async () => {
  const tree = fixture(), rpc = async (input: any) => structuredClone(tree.pages.get(input.path));
  tree.setFilter('config');
  assert.equal(tree.rows().find(row => row.path === 'app/src')?.expanded, true);
  tree.toggle('app/src', rpc);
  assert.deepEqual(tree.rows().filter(row => !row.more).map(row => row.path), ['', 'app', 'app/src', 'docs', 'docs/CONFIG.md']);
  tree.toggle('app/src', rpc); await tree.load('app/src', rpc);
  assert.deepEqual(tree.rows().filter(row => !row.more).map(row => row.path), ['', 'app', 'app/src', 'app/src/config.ts', 'app/src/index.ts', 'docs', 'docs/CONFIG.md']);
  assert.equal(tree.filter, 'config'); assert.equal(tree.root, '');
  assert.ok(!tree.rows().some(row => row.path === 'docs/notes.md' || row.path === 'app/assets'));
});

test('revealing a folder leaves cached nonmatching deep branches collapsed until explicitly opened', async () => {
  const tree = fixture(), rpc = async (input: any) => structuredClone(tree.pages.get(input.path));
  tree.setFilter('app'); tree.toggle('app', rpc); await tree.load('app', rpc);
  assert.deepEqual(tree.rows().filter(row => !row.more).map(row => row.path), ['', 'app', 'app/src', 'app/assets', 'app/package.json']);
  assert.equal(tree.rows().find(row => row.path === 'app/src')?.expanded, false);
  tree.toggle('app/src', rpc); await tree.load('app/src', rpc);
  assert.ok(tree.rows().some(row => row.path === 'app/src/config.ts'));
  tree.toggle('app', rpc); tree.toggle('app', rpc); await tree.load('app', rpc);
  assert.ok(!tree.rows().some(row => row.path === 'app/src/config.ts'), 'reopening its parent does not spill deeper unrelated contents');
});

test('explicit folder navigation restores in-place search browsing, and a new query resets its exceptions', async () => {
  const tree = fixture(), rpc = async (input: any) => structuredClone(tree.pages.get(input.path));
  tree.setFilter('ASSETS'); tree.toggle('app/assets', rpc); await tree.load('app/assets', rpc);
  const before = tree.rows(); tree.enter('app/assets', rpc); await tree.load('app/assets', rpc); tree.back(rpc);
  assert.equal(tree.filter, 'ASSETS'); assert.deepEqual(tree.rows(), before);
  tree.setFilter('config'); tree.setFilter('ASSETS');
  assert.ok(!tree.rows().some(row => row.path === 'app/assets/logo.png'));
});

test('collapsing and reopening the tree root keeps unrelated branches filtered out', async () => {
  const tree = fixture(), rpc = async (input: any) => structuredClone(tree.pages.get(input.path));
  tree.setFilter('config'); const before = tree.rows();
  tree.toggle('', rpc); assert.deepEqual(tree.rows().map(row => row.path), ['']);
  tree.toggle('', rpc); await tree.load('', rpc);
  assert.equal(tree.filter, 'config'); assert.deepEqual(tree.rows(), before);
});
