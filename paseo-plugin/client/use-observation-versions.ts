import { observationQueries } from './observation-query-cache.ts';
import { OBSERVATION_POLICY } from '../shared/observation-policy.ts';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { observerQuery, type ObserverResponse } from '../shared/observer';
import { ObservationCoordinator, type QueryView } from './observation-coordinator.ts';


const controllers = new WeakMap<QueryClient, Map<string, Controller>>();
type Subscriber = { ids: string[]; reader: (ids: string[]) => Promise<ObserverResponse>; issue(value: string | null): void };
class Controller {
  readonly coordinator: ObservationCoordinator;
  private subscribers = new Set<Subscriber>();
  private unsubscribe: () => void;
  private disposal?: ReturnType<typeof setTimeout>;
  constructor(readonly project: string, client: QueryClient, private remove: () => void) {
    this.coordinator = new ObservationCoordinator(project, {
      queries: () => observationQueries(client, project),
      read: ids => this.subscribers.values().next().value!.reader(ids),
      issue: value => { for (const subscriber of this.subscribers) subscriber.issue(value); },
    });
    this.unsubscribe = client.getQueryCache().subscribe(() => this.coordinator.changed());
  }
  add(subscriber: Subscriber) {
    clearTimeout(this.disposal); this.disposal = undefined;
    this.subscribers.add(subscriber);
    const unsubscribe = this.coordinator.subscribe(subscriber.ids, Platform.OS === 'web');
    return () => {
      unsubscribe(); this.subscribers.delete(subscriber);
      // Effects may replace a subscription in the same commit. Preserve its
      // generation and retry counters until that replacement has subscribed.
      queueMicrotask(() => {
        if (!this.subscribers.size && !this.disposal) { this.disposal = setTimeout(() => { this.disposal = undefined; if (this.subscribers.size) return; this.unsubscribe(); this.coordinator.close(); this.remove(); }, OBSERVATION_POLICY.retentionMs); }
      });
    };
  }
}

export function refreshObservations(client: QueryClient, project: string, matches?: (q: QueryView) => boolean) {
  return controllers.get(client)?.get(project)?.coordinator.refresh(matches) || Promise.resolve();
}
export function observationRefreshDiagnostics(client: QueryClient, project: string) {
  const counters = controllers.get(client)?.get(project)?.coordinator.counters;
  return counters ? { ...counters, reasons: { ...counters.reasons }, state: controllers.get(client)?.get(project)?.coordinator.debug() } : null;
}
export function useObservationVersions(projectConfig: string | undefined, workspaceIds: string[], enabled = true) {
  const [issue, setIssue] = useState<string | null>(null);
  const rpc = useRpc(observerQuery), client = useQueryClient();
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const idsKey = JSON.stringify([...new Set(workspaceIds.filter(Boolean))].sort());
  useEffect(() => {
    if (!enabled || !projectConfig) { setIssue(null); return; }
    let projects = controllers.get(client);
    if (!projects) { projects = new Map(); controllers.set(client, projects); }
    let controller = projects.get(projectConfig);
    if (!controller) {
      controller = new Controller(projectConfig, client, () => { if (projects!.get(projectConfig) === controller) projects!.delete(projectConfig); });
      projects.set(projectConfig, controller);
    }
    const remove = controller.add({ ids: JSON.parse(idsKey), issue: setIssue,
      reader: ids => rpcRef.current({ projectConfig, method: 'observer.versions', params: { workspaceIds: ids } }) });
    return () => { remove(); setIssue(null); };
  }, [projectConfig, idsKey, enabled, client]);
  return issue;
}
