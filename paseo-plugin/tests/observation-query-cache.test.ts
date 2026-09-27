import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { observationQueries } from '../client/observation-query-cache.ts';
import { observationQueryOptions } from '../shared/observation-policy.ts';

test('real QueryObserver selection changes preserve cache and never auto-refetch', async () => {
  const client = new QueryClient(); let calls = 0;
  const options = (repo: string) => ({ queryKey: ['workspace-workbench', 'p', 'repository-changes', 'w', repo],
    queryFn: async () => { calls++; return { ok: true, result: { observation: { state: 'ready', validationKey: '/repo#working', validationToken: '1' } } }; }, ...observationQueryOptions });
  try {
    await client.fetchQuery(options('a')); await client.fetchQuery(options('b'));
    const observer = new QueryObserver(client, options('a'));
    const unsubscribe = observer.subscribe(() => {});
    for (let n = 0; n < 10; n++) observer.setOptions(options(n % 2 ? 'a' : 'b'));
    await Promise.resolve(); assert.equal(calls, 2);
    const views = observationQueries(client, 'p');
    assert.equal(views.filter(q => q.active).length, 1);
    const active = views.find(q => q.active)!;
    const oldUpdated = active.updatedAt;
    active.validate('2026-09-27T12:00:00Z');
    assert.equal(observationQueries(client, 'p').find(q => q.active)!.updatedAt, oldUpdated);
    assert.equal(calls, 2);
    observer.setOptions({ ...options('a'), enabled: false });
    assert.equal(observationQueries(client, 'p').filter(q => q.active).length, 0);
    observer.setOptions(options('a'));
    assert.equal(observationQueries(client, 'p').filter(q => q.active).length, 1);
    assert.equal(calls, 2);
    assert.equal(observationQueries(client, 'other').length, 0);
    unsubscribe(); observer.destroy();
  } finally { client.clear(); }
});

test('authoritative roster removes deleted workspace caches without touching other projects', () => {
  const client = new QueryClient();
  try {
    client.setQueryData(['workspace-workbench', 'p', 'workspace-list'], { ok: true, result: { workspaces: [{ id: 'retained' }], observation: { state: 'ready' } } });
    for (const project of ['p', 'other']) client.setQueryData(['workspace-workbench', project, 'repository-changes', 'deleted'], { ok: true, result: { workspaceId: 'deleted' } });
    observationQueries(client, 'p');
    assert.equal(client.getQueryData(['workspace-workbench', 'p', 'repository-changes', 'deleted']), undefined);
    assert.ok(client.getQueryData(['workspace-workbench', 'other', 'repository-changes', 'deleted']));
  } finally { client.clear(); }
});
