import { DIFF_READ_PROTOCOL, type DiffReadStatus } from '../shared/diff-read.ts';
import type { ObserverResponse } from '../shared/observer.ts';
type Entry = { requestId: string; taskId?: string; generation?: string; deadline: number; polls: number; pending: boolean; released: boolean; restarts: number; failed?: ObserverResponse };
export type DiffRpc = (method: 'repository.diff' | 'repository.diff.read', params: Record<string, unknown>) => Promise<ObserverResponse>;
const newId = () => `diff:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
/** Owns identities only. The observation coordinator owns all polling timers. */
export function createDiffReadClient(partialResults = false) {
  const entries = new Map<string, Entry>();
  async function read(key: string, params: Record<string, unknown>, rpc: DiffRpc, capable: boolean): Promise<ObserverResponse> {
    if (!capable) return rpc('repository.diff', params);
    let entry = entries.get(key);
    if (entry?.failed && !entry.released) return entry.failed;
    if (!entry || !entry.pending || entry.released) {
      entry = { requestId: newId(), deadline: Date.now() + 30_000, polls: 0, pending: true, released: false, restarts: 0 };
      entries.set(key, entry);
      if (entries.size > 128) for (const [id, e] of entries) if (!e.pending || e.released) { entries.delete(id); break; }
    }
    if (Date.now() >= entry.deadline) return fail(entry, { code: partialResults ? 'observer_refresh_timeout' : 'diff_read_timeout', message: partialResults ? 'Repository refresh deadline exceeded' : 'File read deadline exceeded' });
    let response: ObserverResponse;
    try { response = await rpc('repository.diff.read', entry.taskId ? { action: 'status', taskId: entry.taskId, requestId: entry.requestId } : { ...params, action: 'start', requestId: entry.requestId }); }
    catch { response = { ok: false, error: { code: 'observer_unavailable', message: 'File read connection unavailable' } }; }
    if (!response.ok) {
      const error = response.error || { code: 'observer_unavailable', message: 'File read unavailable' };
      const generation = (error.details as { generation?: string } | undefined)?.generation;
      if (error.code === 'diff_task_missing' && generation && generation !== entry.generation && entry.restarts < 1) {
        entry.restarts++; entry.taskId = undefined; entry.generation = generation; entry.requestId = newId();
      } else if (!['observer_timeout', 'observer_unavailable', 'observer_busy', 'observer_connection_refused', 'observer_socket_error'].includes(error.code)) return fail(entry, error);
      return pending(entry, 'connecting');
    }
    const status = response.result as DiffReadStatus;
    if (status.protocol !== DIFF_READ_PROTOCOL) return fail(entry, { code: 'diff_protocol_mismatch', message: 'File reader update required' });
    entry.taskId = status.taskId; entry.generation = status.generation; entry.deadline = Math.min(entry.deadline, status.deadline);
    if (entry.released) { void rpc('repository.diff.read', { action: 'release', requestId: entry.requestId, taskId: entry.taskId }).catch(() => {}); }
    if (status.state === 'ready') { entry.pending = false; const result = status.result as Record<string, unknown>; return { ok: true, result: { ...result, observation: { ...(result.observation as object), requestId: entry.requestId, taskId: status.taskId, generation: status.generation } } }; }
    if (status.state === 'failed' || status.state === 'cancelled') return fail(entry, status.error || { code: 'observer_cancelled', message: 'File read cancelled' }, partialResults ? status.result : undefined);
    return pending(entry, status.state, partialResults ? status.result : undefined);
  }
  function pending(entry: Entry, state: string, partial?: unknown): ObserverResponse {
    const nextPollMs = entry.polls++ === 0 ? 250 : entry.polls === 2 ? 500 : 1000;
    return { ok: true, result: { ...(partial && typeof partial === 'object' ? partial : {}), observation: { state: 'ready', refreshing: true, readTask: { requestId: entry.requestId, taskId: entry.taskId, generation: entry.generation, state, deadline: entry.deadline, nextPollMs } } } };
  }
  function fail(entry: Entry, error: NonNullable<ObserverResponse['error']>, partial?: unknown): ObserverResponse {
    entry.pending = false;
    entry.failed = { ok: false, ...(partial && typeof partial === 'object' ? {result:partial} : {}), error: { ...error, details: { ...(error.details as object || {}), readTask: true, terminal: true, requestId: entry.requestId } } };
    return entry.failed;
  }
  function release(key: string, rpc: DiffRpc) {
    const entry = entries.get(key);
    if (!entry) return;
    entry.released = true;
    if (entry.pending) void rpc('repository.diff.read', { action: 'release', taskId: entry.taskId, requestId: entry.requestId }).catch(() => {});
  }
  function retry(key: string) { const entry = entries.get(key); if (entry) { entry.failed = undefined; entry.released = true; } }
  return { read, release, retry };
}
