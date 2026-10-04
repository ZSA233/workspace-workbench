import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { previousDisplay, type DisplayAddress } from '../client/query-continuity.ts';
import { anchoredOffset, uniqueCommits } from '../client/graph/continuity.ts';
import type { CommitNode } from '../client/model.ts';

const node = (sha: string, parents: string[] = [], isBase = false) => ({ sha, shortSha: sha.slice(0, 8), parents, subject: sha, author: 'Test', authoredAt: '', isBase }) as CommitNode;

test('history expansion reads the displayed cache address without seeding the pending or failed target', () => {
  const client = new QueryClient();
  try {
    const family = JSON.stringify(['project', 'workspace', 'repo', 'head', 'base']);
    const branch = ['graph', 'branch', 50], full = ['graph', 'full', 50], more = ['graph', 'full', 100];
    const initial = [node('head', ['base']), node('base', [], true)];
    client.setQueryData(branch, initial);
    let displayed: DisplayAddress = { family, key: branch };
    const read = (key: readonly unknown[]) => client.getQueryData<CommitNode[]>(key);
    assert.deepEqual(previousDisplay(displayed, family, read), initial);
    assert.equal(client.getQueryData(full), undefined);
    // A failed target leaves the display address intact, not a fake successful target.
    assert.deepEqual(previousDisplay(displayed, family, read), initial);
    const expanded = [node('head', ['base']), node('base', ['parent'], true), node('parent')];
    client.setQueryData(full, expanded);
    displayed = { family, key: full };
    assert.equal(previousDisplay(displayed, family, read)?.[1].parents[0], 'parent');
    assert.equal(client.getQueryData(more), undefined);
    // A late smaller response stays in its own query entry.
    client.setQueryData(branch, [node('old-head')]);
    assert.deepEqual(previousDisplay(displayed, family, read), expanded);
    for (const other of ['other-project', 'other-repository', 'new-head', 'new-base']) {
      assert.equal(previousDisplay(displayed, other, read), undefined);
    }
    client.removeQueries({ queryKey: full, exact: true });
    assert.equal(previousDisplay(displayed, family, read), undefined);
  } finally { client.clear(); }
});

test('an authoritative prefix has unique SHAs and preserves merge topology without retaining unreachable old nodes', () => {
  const nodes = [node('merge', ['left', 'right']), node('left', ['base']), node('right', ['base']), node('base', ['older'], true), node('older')];
  const result = uniqueCommits([...nodes, nodes[3]]);
  assert.deepEqual(result, nodes);
  assert.deepEqual(result[0].parents, ['left', 'right']);
  assert.deepEqual(uniqueCommits([node('replacement')]).map(n => n.sha), ['replacement']);
});

test('scroll anchors survive expansion, inserted commits, base replacement and removed anchors', () => {
  assert.equal(anchoredOffset(['a','b','base'], ['a','b','base','older'], 37, 30), 37);
  assert.equal(anchoredOffset(['a','b','base'], ['new','a','b','base'], 37, 30), 67);
  assert.equal(anchoredOffset(['a','b','base'], ['a','base','older'], 37, 30), 37);
  assert.equal(anchoredOffset(['a','b','base'], ['a'], 67, 30), 7);
  assert.equal(anchoredOffset(['a','b'], ['unrelated'], 37, 30), 0);
  assert.equal(anchoredOffset([], ['a'], 37, 30), 0);
});

import { createHistoryLoadGate } from '../client/graph/pagination.ts';
test('a prepared history gate handles the first user scroll after changing modes', () => {
  const gate = createHistoryLoadGate();
  gate.reset('full-history', 0);
  assert.equal(gate.allow('full-history', 50, 1250, 300, 1550, false, true), true);
  assert.equal(gate.allow('full-history', 50, 1251, 300, 1550, false, true), false);
  assert.equal(gate.allow('full-history', 100, 2750, 300, 3050, true, true), false);
  assert.equal(gate.allow('full-history', 100, 2750, 300, 3050, false, true), false);
  assert.equal(gate.allow('full-history', 100, 2751, 300, 3050, false, true), true);
  gate.reset('another-head', 0);
  assert.equal(gate.allow('another-head', 50, 1250, 300, 1550, false, true), true);
});

test('scrolling to the end while the graph task settles defers one load without requiring another gesture', () => {
  const gate = createHistoryLoadGate();
  gate.reset('full', 0);
  assert.equal(gate.allow('full', 50, 1250, 300, 1550, true, true), false);
  assert.equal(gate.resume('full', 50, true, true), false);
  assert.equal(gate.resume('full', 50, false, true), true);
  assert.equal(gate.resume('full', 50, false, true), false);
  assert.equal(gate.allow('full', 50, 1251, 300, 1550, true, true), false);
  assert.equal(gate.resume('full', 100, false, true), false);
  // Moving away cancels the deferred scroll intent.
  gate.allow('full', 100, 2750, 300, 3050, true, true);
  gate.allow('full', 100, 1000, 300, 3050, true, true);
  assert.equal(gate.resume('full', 100, false, true), false);
});

test('material pagination keeps one complete page and never reuses another file or bundle version', async () => {
  const client = new QueryClient();
  try {
    const family = JSON.stringify(['project', 'workspace', 'bundle', 1, 'HANDOFF.md']);
    const first = ['materials', family, 0], second = ['materials', family, 1000];
    const before = { content: 'first page', nextOffset: 1000, sourceCount: 2 };
    client.setQueryData(first, before);
    let address: DisplayAddress = { family, key: first };
    const read = (key: readonly unknown[]) => client.getQueryData<typeof before>(key);
    await assert.rejects(client.fetchQuery({ queryKey: second, retry: false, queryFn: async () => { throw Error('test transport failure'); } }));
    assert.deepEqual(previousDisplay(address, family, read), before);
    assert.equal(client.getQueryData(second), undefined);
    client.setQueryData(second, { content: 'second page', nextOffset: 2000, sourceCount: 3 });
    address = { family, key: second };
    assert.deepEqual(previousDisplay(address, family, read), { content: 'second page', nextOffset: 2000, sourceCount: 3 });
    assert.equal(previousDisplay(address, JSON.stringify(['project', 'workspace', 'bundle', 2, 'HANDOFF.md']), read), undefined);
    assert.equal(previousDisplay(address, JSON.stringify(['project', 'workspace', 'bundle', 1, 'SOURCES.md']), read), undefined);
  } finally { client.clear(); }
});
