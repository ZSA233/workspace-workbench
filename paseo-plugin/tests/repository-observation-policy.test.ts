import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { repositoryObservationActive } from '../client/repository-observation-policy.ts';
import { publishRefresh, hydrateRepositorySummaries } from '../client/observation-publication.ts';
import { repositoryQueryKeys } from '../client/repository-refresh-client.ts';

const context = { foreground: true, tab: 'workspace' as const, backendReady: true, listReady: true,
  workspaceUnavailable: false, workspaceId: 'workspace', repoPath: 'one' };

test('cold repository observations start before dirty status or HEAD is known', () => {
  const repository = { repoPath: 'one', observationPending: true, dirty: null, head: null };
  assert.equal(repositoryObservationActive({ ...context, repository }), true);
});

test('publishing a running summary keeps the current graph subscription active and permits independent completion', () => {
  const client = new QueryClient();
  const input = { workspaceId: 'workspace', repoPath: 'one', historyMode: 'branch', maxCommits: 50, scope: 'branch' };
  const keys = repositoryQueryKeys('project', input);
  const detailKey = ['workspace-workbench', 'project', 'workspace-detail', 'workspace'];
  const repository = { repoPath: 'one', branch: 'feature', head: 'head', dirty: false, status: 'clean', observationPending: false };
  client.setQueryData(detailKey, { ok: true, result: { workspace: { id: 'workspace' }, repositories: [repository] } });
  const graph = new QueryObserver<any>(client, { queryKey: keys.graph, enabled: false });
  const unsubscribe = graph.subscribe(() => {});
  try {
    assert.equal(repositoryObservationActive({ ...context, repository }), true);
    publishRefresh(client, 'project', input, { regions: { summary: { state: 'running', phase: 'status', result: {
      repository: { ...repository, observationPending: true, dirty: null, status: 'unknown' }, observation: { readStartedAt: 20 },
    } } } });
    const detail = hydrateRepositorySummaries(client, 'project', client.getQueryData<any>(detailKey).result);
    assert.equal(detail.repositories[0].observationPending, true);
    assert.equal(repositoryObservationActive({ ...context, repository: detail.repositories[0] }), true,
      'a partial result must not disable and release the task that produced it');
    publishRefresh(client, 'project', input, { regions: { graph: { state: 'ready', phase: 'complete', result: {
      nodes: [{ sha: 'head' }], observation: { state: 'ready', readStartedAt: 20 },
    } } } });
    assert.equal(graph.getCurrentResult().data.result.nodes[0].sha, 'head');
    assert.equal(client.getQueryData<any>(detailKey).result.repositories[0].observationPending, true,
      'graph completion does not pretend the summary has completed');
  } finally { unsubscribe(); graph.destroy(); client.clear(); }
});

test('selection and visibility still stop unrelated or inaccessible read subscriptions', () => {
  const active = { ...context, repository: { repoPath: 'one' } };
  for (const override of [
    { foreground: false }, { tab: 'review' as const }, { backendReady: false }, { listReady: false },
    { workspaceUnavailable: true }, { workspaceId: '' }, { repoPath: '' }, { repository: undefined },
    { repository: { repoPath: 'another' } },
  ]) assert.equal(repositoryObservationActive({ ...active, ...override }), false);
  assert.equal(repositoryObservationActive(active), true);
});
