import { useEffect, useRef, useState } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { useQueryClient } from '@tanstack/react-query';
import { observerQuery } from '../shared/observer';

/** One cheap version request; derived queries only refetch when their version changes. */
export function useObservationVersions(projectConfig: string | undefined, workspaceIds: string[], enabled = true) {
  const [issue, setIssue] = useState<string | null>(null);
  const rpc = useRpc(observerQuery), client = useQueryClient();
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const idsKey = JSON.stringify([...new Set(workspaceIds.filter(Boolean))].sort());
  const previousRef = useRef({ key: '', version: '', review: '', session: '' });
  useEffect(() => {
    if (!enabled || !projectConfig) return;
    let disposed = false, running = false, timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0, validatedAt = 0, failureSince = 0;
    const identity = `${projectConfig}:${idsKey}`;
    if (previousRef.current.key !== identity) previousRef.current = { key: identity, version: '', review: '', session: '' };
    const schedule = () => { clearTimeout(timer); if (!disposed) timer = setTimeout(() => void poll(), Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5))); };
    const poll = async () => {
      if (disposed || running) return;
      running = true;
      try {
        const response = await rpcRef.current({ projectConfig, method: 'observer.versions', params: { workspaceIds: JSON.parse(idsKey) } });
        if (disposed) return;
        if (!response.ok) {
          failures++; failureSince ||= Date.now();
          if (Date.now() - failureSince >= 10_000) setIssue(response.error?.code || "observer_unavailable");
          return;
        }
        failures = 0; failureSince = 0;
        const value = response.result as { instanceId: string; revision: number; reviewRevision?: string; sessionRevision?: string; tokens?: Record<string, string>; repositories?: Array<{ issue?: string }> };
        // Repository issues are rendered on their own rows. A broken or
        // missing checkout must not turn the whole backend into a red banner.
        setIssue(null);
        if (Date.now() - validatedAt > 10_000) {
          validatedAt = Date.now();
          client.setQueriesData({ predicate: q => q.queryKey[0] === 'workspace-workbench' && q.queryKey.includes(projectConfig) }, (old: any) => {
            const observation = old?.result?.observation;
            if (!old?.ok || observation?.state !== 'ready' || !observation.validationKey || value.tokens?.[observation.validationKey] !== observation.validationToken) return old;
            return { ...old, result: { ...old.result, observation: { ...observation, validatedAt: new Date().toISOString() } } };
          });
        }
        const version = `${value.instanceId}:${value.revision}`, reviewVersion = value.reviewRevision || value.instanceId;
        const previous = previousRef.current;
        const changed = Boolean(previous.version && version !== previous.version);
        const reviewChanged = Boolean(previous.review && reviewVersion !== previous.review);
        const sessionVersion = value.sessionRevision || value.instanceId;
        const sessionChanged = Boolean(previous.session && sessionVersion !== previous.session);
        previousRef.current = { key: identity, version, review: reviewVersion, session: sessionVersion };
        if (changed || reviewChanged || sessionChanged) void client.invalidateQueries({ predicate: q => {
          const key = q.queryKey;
          if (key[0] !== 'workspace-workbench' || !key.includes(projectConfig)) return false;
          if (key.includes('execution-binding') || key.includes('agent-context')) return sessionChanged;
          const review = key.includes('agent-review') || key.includes('agent-review-history');
          return review ? reviewChanged : changed && key.some(part => ['workspace-list', 'workspace-detail', 'repository-graph', 'repository-changes', 'file-review', 'review'].includes(String(part)));
        }, refetchType: 'active' }).catch(() => {});
      } catch {
        failures++; failureSince ||= Date.now();
        if (!disposed && Date.now() - failureSince >= 10_000) setIssue("observer_unavailable");
      }
      finally { running = false; schedule(); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [projectConfig, idsKey, enabled, client]);
  return issue;
}
