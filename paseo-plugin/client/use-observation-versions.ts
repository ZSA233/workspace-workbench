import { useEffect, useRef, useState } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { observerQuery, type ObserverResponse } from '../shared/observer';
import { versionDelta, shouldRefreshVersionedQuery, type Versions } from './version-invalidation';

type Subscription = { ids: string[]; issue: (value: string | null) => void; reader: Reader };
type Reader = (ids: string[]) => Promise<ObserverResponse>;

/** A project has one foreground poll per renderer, regardless of its panel count. */
class ProjectVersions {
  private subscriptions = new Set<Subscription>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = false;
  private failures = 0;
  private failureSince = 0;
  private hostFailureSince = 0;
  private validatedAt = 0;
  private previous: Versions | null = null;
  client: QueryClient;

  constructor(readonly projectConfig: string, client: QueryClient) {
    this.client = client;
  }
  add(subscription: Subscription) {
    this.subscriptions.add(subscription);
    if (!this.timer && !this.running) void this.poll();
    return () => {
      this.subscriptions.delete(subscription);
      if (!this.subscriptions.size) { this.stopped = true; clearTimeout(this.timer); controllers.delete(this.projectConfig); }
    };
  }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, Math.min(30_000, 1_000 * 2 ** Math.min(this.failures, 5)));
  }
  private async poll() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const ids = [...new Set([...this.subscriptions].flatMap(item => item.ids))].sort();
      const response = await this.subscriptions.values().next().value!.reader(ids);
      if (this.stopped) return;
      if (!response.ok) throw new Error(response.error?.code || 'observer_unavailable');
      const value = response.result as Versions;
      this.failures = 0; this.failureSince = 0;
      const hostDisconnected = value.hostTransport && ["disconnected", "disposed", "closed"].includes(value.hostTransport.state);
      this.hostFailureSince = hostDisconnected ? this.hostFailureSince || Date.now() : 0;
      const hostIssue = this.hostFailureSince && Date.now() - this.hostFailureSince >= 10_000 ? "host_transport_unavailable" : null;
      for (const subscriber of this.subscriptions) subscriber.issue(hostIssue);
      if (Date.now() - this.validatedAt > 10_000) {
        this.validatedAt = Date.now();
        this.client.setQueriesData({ predicate: q => q.getObserversCount() > 0 && q.queryKey[0] === 'workspace-workbench' && q.queryKey.includes(this.projectConfig) }, (old: any) => {
          const observation = old?.result?.observation;
          if (!old?.ok || observation?.state !== 'ready' || !observation.validationKey || value.tokens?.[observation.validationKey] !== observation.validationToken) return old;
          return { ...old, result: { ...old.result, observation: { ...observation, validatedAt: new Date().toISOString() } } };
        });
      }
      const previous = this.previous;
      this.previous = value;
      const delta = versionDelta(previous, value);
      if (delta.reset || delta.roster || delta.fallback || delta.tokens.size || delta.workspaces.size || delta.repositories.size || delta.review || delta.session) {
        void this.client.invalidateQueries({ predicate: q => shouldRefreshVersionedQuery(this.projectConfig, delta, q.queryKey, q.state.data as ObserverResponse | undefined, q.getObserversCount() > 0), refetchType: 'active' }).catch(() => {});
      }
    } catch (error) {
      this.failures++; this.failureSince ||= Date.now();
      if (!this.stopped && Date.now() - this.failureSince >= 10_000)
        for (const subscriber of this.subscriptions) subscriber.issue(error instanceof Error ? error.message : 'observer_unavailable');
    } finally { this.running = false; this.schedule(); }
  }
}

const controllers = new Map<string, ProjectVersions>();

export function useObservationVersions(projectConfig: string | undefined, workspaceIds: string[], enabled = true) {
  const [issue, setIssue] = useState<string | null>(null);
  const rpc = useRpc(observerQuery), client = useQueryClient();
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const idsKey = JSON.stringify([...new Set(workspaceIds.filter(Boolean))].sort());
  useEffect(() => {
    if (!enabled || !projectConfig) {
      // A failed poll must not remain visible after the panel is backgrounded
      // or the subscription is removed. It is a stale diagnostic, not a
      // current observation failure.
      setIssue(null);
      return;
    }
    let controller = controllers.get(projectConfig);
    const reader: Reader = ids => rpcRef.current({ projectConfig, method: 'observer.versions', params: { workspaceIds: ids } });
    if (!controller) { controller = new ProjectVersions(projectConfig, client); controllers.set(projectConfig, controller); }
    else controller.client = client;
    const remove = controller.add({ ids: JSON.parse(idsKey), issue: setIssue, reader });
    return () => {
      remove();
      setIssue(null);
    };
  }, [projectConfig, idsKey, enabled, client]);
  return issue;
}
