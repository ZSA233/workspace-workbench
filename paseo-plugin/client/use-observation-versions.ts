import { useEffect, useRef, useState } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { useQueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';
import { observerQuery } from '../shared/observer';

type DocumentVisibility = { visibilityState?: string; addEventListener?(name: string, fn: () => void): void; removeEventListener?(name: string, fn: () => void): void };
/** One cheap version request; derived queries only refetch when their version changes. */
export function useObservationVersions(projectConfig: string | undefined, workspaceIds: string[], enabled = true) {
  const [issue, setIssue] = useState<string | null>(null);
  const rpc = useRpc(observerQuery), client = useQueryClient();
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const idsKey = JSON.stringify([...new Set(workspaceIds.filter(Boolean))].sort());
  useEffect(() => {
    if (!enabled || !projectConfig) return;
    let disposed = false, running = false, timer: ReturnType<typeof setTimeout> | undefined;
    let previous = '', previousReview = '', previousSession = '', failures = 0, validatedAt = 0;
    const document = (globalThis as unknown as { document?: DocumentVisibility }).document;
    const visible = () => Platform.OS === 'web' ? document?.visibilityState !== 'hidden' : !AppState.currentState || AppState.currentState === 'active';
    const schedule = () => { clearTimeout(timer); if (!disposed && visible()) timer = setTimeout(() => void poll(), Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5))); };
    const poll = async () => {
      if (disposed || running || !visible()) return;
      running = true;
      try {
        const response = await rpcRef.current({ projectConfig, method: 'observer.versions', params: { workspaceIds: JSON.parse(idsKey) } });
        if (disposed) return;
        if (!response.ok) { failures++; setIssue(response.error?.code || "observer_unavailable"); return; }
        failures = 0;
        const value = response.result as { instanceId: string; revision: number; reviewRevision?: string; sessionRevision?: string; tokens?: Record<string, string>; repositories?: Array<{ issue?: string }> };
        setIssue(value.repositories?.find(r => r.issue)?.issue || null);
        if (Date.now() - validatedAt > 10_000) {
          validatedAt = Date.now();
          client.setQueriesData({ predicate: q => q.queryKey[0] === 'workspace-workbench' && q.queryKey.includes(projectConfig) }, (old: any) => {
            const observation = old?.result?.observation;
            if (!old?.ok || observation?.state !== 'ready' || !observation.validationKey || value.tokens?.[observation.validationKey] !== observation.validationToken) return old;
            return { ...old, result: { ...old.result, observation: { ...observation, validatedAt: new Date().toISOString() } } };
          });
        }
        const version = `${value.instanceId}:${value.revision}`, reviewVersion = value.reviewRevision || value.instanceId;
        const changed = version !== previous, reviewChanged = reviewVersion !== previousReview;
        const sessionVersion = value.sessionRevision || value.instanceId, sessionChanged = sessionVersion !== previousSession;
        previousSession = sessionVersion;
        previous = version; previousReview = reviewVersion;
        if (changed || reviewChanged || sessionChanged) void client.invalidateQueries({ predicate: q => {
          const key = q.queryKey;
          if (key[0] !== 'workspace-workbench' || !key.includes(projectConfig)) return false;
          if (key.includes('execution-binding') || key.includes('agent-context')) return sessionChanged;
          const review = key.includes('agent-review') || key.includes('agent-review-history');
          return review ? reviewChanged : changed && key.some(part => ['workspace-list', 'workspace-detail', 'repository-graph', 'repository-changes', 'file-review', 'review'].includes(String(part)));
        }, refetchType: 'active' }).catch(() => {});
      } catch { failures++; if (!disposed) setIssue("observer_unavailable"); }
      finally { running = false; schedule(); }
    };
    const visibility = () => { clearTimeout(timer); if (visible()) { previous = ''; void poll(); } };
    document?.addEventListener?.('visibilitychange', visibility);
    const subscription = AppState.addEventListener('change', visibility);
    void poll();
    return () => { disposed = true; clearTimeout(timer); document?.removeEventListener?.('visibilitychange', visibility); subscription.remove(); };
  }, [projectConfig, idsKey, enabled, client]);
  return issue;
}
