import { publishRefresh } from './observation-publication.ts';
import { useRpc } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { clientDiagnostic } from "../shared/client-diagnostics";
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { observationQueryOptions } from './observation-content.ts';
import { observationMeta } from './observation-coordinator.ts';
import { createRepositoryRefreshClient, repositoryQueryKeys, type RefreshInput, type RefreshResult, type RefreshRpc } from './repository-refresh-client.ts';

/** Query payloads stay in QueryClient; the shared coordinator owns job polling. */
export function useRepositoryRefresh(project: string, input: RefreshInput, enabled: boolean, rpc: RefreshRpc, prefetch = false) {
  const client = useQueryClient();
  const diagnostic = useRpc(clientDiagnostic);
  const sent = useRef(new Set<string>());
  const reader = useRef(createRepositoryRefreshClient()).current;
  const identity = JSON.stringify([project, input]);
  const keys = useMemo(() => repositoryQueryKeys(project, input), [identity]);
  const force = useRef(false);
  const manualFlight = useRef(false);
  const queuedManual = useRef(false);
  const [manual, setManual] = useState(false);
  const [slow, setSlow] = useState(false);
  const clickedAt = useRef(0);
  const query = useQuery({ queryKey: keys.refresh,
    queryFn: () => reader.readRefresh(identity, input, rpc, force.current, prefetch),
    enabled, ...observationQueryOptions,
  });
  const result = (query.data?.result || null) as RefreshResult | null;
  const pending = !!observationMeta(query.data).readTask;
  useEffect(() => {
    if (!enabled) return;
    return () => { reader.releaseRefresh(identity, rpc); };
  }, [enabled, identity, reader]);
  useEffect(() => {
    setManual(false); setSlow(false); force.current = false; manualFlight.current = false; queuedManual.current = false;
  }, [identity, enabled]);
  useEffect(() => {
    if (result) {
      publishRefresh(client, project, input, result);
      if (!prefetch) for (const [area, region] of Object.entries(result.regions || {})) {
        const id = `${result.refreshId}:${area}:${region.state}`;
        if (region.state !== 'ready' || sent.current.has(id)) continue;
        sent.current.add(id); if (sent.current.size > 64) sent.current.delete(sent.current.values().next().value!);
        void diagnostic({ phase: 'repository-refresh-region', platform: Platform.OS, details: { refreshId: result.refreshId || '', area, elapsedMs: String(clickedAt.current ? Date.now() - clickedAt.current : 0), sourceObservedAt: region.result?.observation?.observedAt || '', outcome: region.state } }).catch(() => {});
      }
    }
    if (query.data && !pending) {
      if (queuedManual.current) { queuedManual.current = false; force.current = true; reader.retry(identity); void query.refetch({ cancelRefetch: false }); }
      else { force.current = false; manualFlight.current = false; setManual(false); }
    }
  }, [query.data, client, identity]);
  useEffect(() => {
    if (!enabled || !pending && !manual) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(timer);
  }, [enabled, identity, pending, manual]);
  const refresh = useCallback(() => {
    if (manualFlight.current) return;
    manualFlight.current = true;
    if (pending || query.isFetching) { clickedAt.current = Date.now(); queuedManual.current = true; setManual(true); return; }
    clickedAt.current = Date.now(); sent.current.clear(); void diagnostic({ phase: 'repository-refresh-click', platform: Platform.OS, details: { at: String(clickedAt.current) } }).catch(() => {}); force.current = true; reader.retry(identity); setManual(true);
    void query.refetch({ cancelRefetch: false });
  }, [identity, pending, query.isFetching, query.refetch, reader]);
  return { query, result, pending, slow, manual, refresh, clickedAt: clickedAt.current,
    failed: !!query.data && !query.data.ok || Object.values(result?.regions || {}).some(region => region.state === 'failed') };
}
