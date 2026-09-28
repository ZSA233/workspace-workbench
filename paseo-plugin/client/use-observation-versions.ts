import { observationQueries } from './observation-query-cache.ts';
import { OBSERVATION_POLICY } from '../shared/observation-policy.ts';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { observerQuery, type ObserverResponse } from '../shared/observer';
import { createObservationCoordinator, type QueryView } from './observation-coordinator.ts';


const controllers = new WeakMap<QueryClient, Map<string, Controller>>();
type Subscriber = { ids: string[]; reader: (ids: string[]) => Promise<ObserverResponse>; issue(value: string | null): void };
function createController(project: string, client: QueryClient, remove: () => void) {
  const subscribers = new Set<Subscriber>();
  let disposal: ReturnType<typeof setTimeout> | undefined;
  const coordinator = createObservationCoordinator(project, {
    queries: () => observationQueries(client, project),
    read: ids => subscribers.values().next().value!.reader(ids),
    issue: value => { for (const subscriber of subscribers) subscriber.issue(value); },
  });
  const unsubscribeCache = client.getQueryCache().subscribe(() => coordinator.changed());
  function add(subscriber: Subscriber) {
    clearTimeout(disposal); disposal = undefined;
    subscribers.add(subscriber);
    const unsubscribe = coordinator.subscribe(subscriber.ids, Platform.OS === 'web');
    return () => {
      unsubscribe(); subscribers.delete(subscriber);
      queueMicrotask(() => {
        if (!subscribers.size && !disposal) disposal = setTimeout(() => {
          disposal = undefined;
          if (subscribers.size) return;
          unsubscribeCache(); coordinator.close(); remove();
        }, OBSERVATION_POLICY.retentionMs);
      });
    };
  }
  return {coordinator, add};
}
type Controller = ReturnType<typeof createController>;

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
      controller = createController(projectConfig, client, () => { if (projects!.get(projectConfig) === controller) projects!.delete(projectConfig); });
      projects.set(projectConfig, controller);
    }
    const remove = controller.add({ ids: JSON.parse(idsKey), issue: setIssue,
      reader: ids => rpcRef.current({ projectConfig, method: 'observer.versions', params: { workspaceIds: ids } }) });
    return () => { remove(); setIssue(null); };
  }, [projectConfig, idsKey, enabled, client]);
  return issue;
}
