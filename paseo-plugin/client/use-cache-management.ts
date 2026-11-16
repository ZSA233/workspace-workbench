import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ObserverMethod, ObserverResponse } from '../shared/observer';
import type { CacheCleanupPreview, CacheListResult, CacheTask } from '../shared/cache-management';
import { cacheTaskActive } from '../shared/cache-management';
import { uncertainControlFailure } from '../shared/task-state';

type Rpc = (input: { method: ObserverMethod; params: Record<string, unknown> }) => Promise<ObserverResponse>;
type Operation = { project: string; requestId: string; at: number };
export function useCacheManagement({ project, workspaceId, enabled, foreground, visible, watching, rpc }: {
  project: string; workspaceId: string; enabled: boolean; foreground: boolean; visible: boolean; watching: boolean; rpc: Rpc;
}) {
  const scope = useRef(project); scope.current = project;
  const call = useRef(rpc); call.current = rpc;
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<CacheCleanupPreview | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);
  const view = useRef<{ project: string; id: string } | null>(null);
  const selected = useRef(workspaceId); selected.current = workspaceId;
  const tick = useRef<(() => void) | null>(null);
  const request = useCallback(async <T,>(method: ObserverMethod, params: Record<string, unknown>): Promise<T> => {
    const response = await call.current({ method, params });
    if (!response.ok) throw Object.assign(new Error(response.error?.message || 'Cache request failed'), { code: response.error?.code });
    return response.result as T;
  }, []);
  const query = useQuery({ queryKey: ['workspace-workbench', project, 'cache-inventory'],
    queryFn: () => request<CacheListResult>('cache.list', {}), enabled: enabled && foreground,
    retry: false, refetchOnWindowFocus: false, staleTime: 1000,
    refetchInterval: current => foreground && enabled && (cacheTaskActive(current.state.data?.task) || watching) ? 1000 : foreground && visible ? 5000 : false,
    refetchIntervalInBackground: false,
  });
  const receipt = useQuery({ queryKey: ['workspace-workbench', project, 'cache-cleanup-receipt', operation?.requestId],
    queryFn: () => request<CacheTask | { state: 'idle' }>('cache.task', { requestId: operation?.requestId }),
    enabled: enabled && foreground && operation?.project === project, retry: false, refetchOnWindowFocus: false,
    refetchInterval: current => !foreground ? false : current.state.data?.state === 'idle' ? operation && Date.now() - operation.at < 30_000 ? 1000 : false : cacheTaskActive(current.state.data as CacheTask | undefined) ? 1000 : false,
  });
  const refetch = query.refetch;
  const scan = useCallback(async (force = false) => {
    const captured = project;
    const current = view.current?.project === project ? view.current : null;
    try { setError(''); await request('cache.scan', { action: 'start', force, workspaceId: selected.current, ...(current ? { viewId: current.id } : {}) }); if (scope.current === captured) await refetch({ cancelRefetch: false }); }
    catch (error) { if (scope.current === captured) setError(String((error as Error).message)); }
  }, [project, request, refetch]);
  useEffect(() => { setError(''); setPreview(null); setOperation(null); setBusy(false); }, [project]);
  useEffect(() => {
    if (!enabled || !foreground || !workspaceId) return;
    // Selection/foreground transitions are real use; polling never records use.
    void call.current({ method: 'cache.scan', params: { action: 'activity', workspaceId } }).catch(() => {});
  }, [enabled, foreground, project, workspaceId]);
  useEffect(() => {
    if (!enabled || !foreground || !visible) return;
    const captured = project, rpc = call.current;
    const id = `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let stopped = false, inFlight = false;
    view.current = { project, id };
    const update = () => {
      if (stopped || inFlight) return;
      inFlight = true;
      void rpc({ method: 'cache.scan', params: { action: 'start', automatic: true, force: false, viewId: id, workspaceId: selected.current } })
        .then(response => {
          if (stopped || scope.current !== captured) return;
          if (!response.ok) setError(response.error?.message || 'Cache request failed');
          void refetch({ cancelRefetch: false });
        }).catch(error => { if (!stopped && scope.current === captured) setError(String(error)); })
        .finally(() => { inFlight = false; });
    };
    tick.current = update; update();
    const timer = setInterval(update, 15_000);
    return () => {
      stopped = true; clearInterval(timer);
      if (tick.current === update) tick.current = null;
      if (view.current?.id === id) view.current = null;
      void rpc({ method: 'cache.scan', params: { action: 'pause', viewId: id } }).catch(() => {});
    };
  }, [enabled, foreground, visible, project, refetch]);
  useEffect(() => {
    if (visible && foreground && query.data?.stale && !cacheTaskActive(query.data.task)) tick.current?.();
  }, [visible, foreground, query.data?.stale, query.data?.nextScanAt, query.data?.task?.state, query.data?.task?.taskId, workspaceId]);
  useEffect(() => {
    if (receipt.data && receipt.data.state !== 'idle' && !cacheTaskActive(receipt.data as CacheTask)) void refetch({ cancelRefetch: false });
  }, [receipt.data, refetch]);
  const inspectCleanup = useCallback(async (resourceId: string) => {
    const captured = project; setBusy(true); setError('');
    try { const result = await request<CacheCleanupPreview>('cache.cleanup', { action: 'preview', resourceId }); if (scope.current === captured) setPreview(result); }
    catch (error) { if (scope.current === captured) setError((error as Error).message); }
    finally { if (scope.current === captured) setBusy(false); }
  }, [project, request]);
  const confirmCleanup = useCallback(async () => {
    if (!preview || busy) return;
    const captured = project, requestId = `cache-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    setBusy(true); setError('');
    try {
      await request('cache.cleanup', { action: 'start', previewId: preview.previewId, requestId });
      if (scope.current === captured) { setPreview(null); setOperation({ project, requestId, at: Date.now() }); await refetch({ cancelRefetch: false }); }
    } catch (error) {
      if (scope.current === captured) {
        setError((error as Error).message);
        if (uncertainControlFailure((error as { code?: string }).code)) { setPreview(null); setOperation({ project, requestId, at: Date.now() }); }
      }
    } finally { if (scope.current === captured) setBusy(false); }
  }, [preview, busy, project, request, refetch]);
  const cancelScan = useCallback(async () => {
    const task = query.data?.task;
    if (!task || task.kind !== 'scan') return;
    const captured = project;
    try { await request('cache.scan', { action: 'cancel', taskId: task.taskId }); if (scope.current === captured) await refetch({ cancelRefetch: false }); }
    catch (error) { if (scope.current === captured) setError((error as Error).message); }
  }, [project, query.data?.task, request, refetch]);
  return { data: query.data, loading: query.isPending, error: error || (query.error as Error | null)?.message || '',
    preview, closePreview: () => setPreview(null), busy, inspectCleanup, confirmCleanup, scan, cancelScan,
    task: receipt.data?.state !== 'idle' && receipt.data ? receipt.data as CacheTask : query.data?.task,
    uncertain: receipt.data?.state === 'idle', checkReceipt: () => receipt.refetch() };
}
