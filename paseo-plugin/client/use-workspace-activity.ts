import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import type { ObserverMethod, ObserverResponse } from '../shared/observer';
import { WORKSPACE_ACTIVITY_VISIBLE_LIMIT, type WorkspaceActivityCursor, type WorkspaceActivityScan, type WorkspaceActivityUpdate, type WorkspaceActivityView } from '../shared/workspace-activity';
import type { WorkspaceActivityPublication } from './model';

const OPEN_INTERVAL = 1_000;
const IDLE_INTERVAL = 15_000;
const SCROLL_IDLE = 220;
const makeId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

type RPC = (input: { method: ObserverMethod; params: Record<string, unknown> }) => Promise<ObserverResponse>;
export function useWorkspaceActivity({ project, enabled, open, selectedWorkspaceId, snapshot, rpc, reloadRoster }: {
  project: string;
  enabled: boolean;
  open: boolean;
  selectedWorkspaceId: string;
  snapshot?: WorkspaceActivityCursor;
  rpc: RPC;
  reloadRoster: () => Promise<unknown>;
}) {
  const generation = snapshot?.generation || '';
  const input = useRef({ project, generation, enabled, selectedWorkspaceId, open, rpc, reloadRoster });
  input.current = { project, generation, enabled, selectedWorkspaceId, open, rpc, reloadRoster };
  const visible = useRef<string[]>([]);
  const selectorSequence = useRef(0);
  const latestScroll = useRef(-Infinity);
  const connection = useRef<{ id: string; wake(): void; task(value: WorkspaceActivityScan): void; call: RPC; command?: Promise<void> } | null>(null);
  const [publication, publish] = useState<WorkspaceActivityPublication | null>(null);
  const [scanState, setScanState] = useState<{ project: string; generation: string; scan: WorkspaceActivityScan | null }>();
  const [commandOwner, setCommandOwner] = useState<string>();

  const noteScroll = useCallback(() => { latestScroll.current = Date.now(); }, []);
  const noteVisible = useCallback((ids: string[]) => {
    const next = [...new Set(ids)].slice(0, WORKSPACE_ACTIVITY_VISIBLE_LIMIT);
    if (next.length === visible.current.length && next.every((id, index) => id === visible.current[index])) return;
    visible.current = next;
    connection.current?.wake();
  }, []);

  // Closing and reopening can happen between two throttled polls. Keep that
  // opening distinct even when the backend never receives the closed state.
  useEffect(() => { if (open) selectorSequence.current++; }, [open]);

  useEffect(() => {
    if (!enabled || !project || !generation) return;
    const viewId = 'selector-' + makeId();
    const call = input.current.rpc;
    let stopped = false, polling = false, requested = false, sequence = 0, commandRevision = 0;
    let startedAt = -Infinity, publishedAt = -Infinity, reloadedAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined, updateTimer: ReturnType<typeof setTimeout> | undefined;
    let cursor: WorkspaceActivityCursor = { generation, revision: -1 };
    let rows = new Map<string, WorkspaceActivityUpdate>();
    let pending = false;
    let task: WorkspaceActivityScan | null = null;
    const current = () => !stopped && input.current.enabled && input.current.project === project && input.current.generation === generation;

    function updateTask(next: WorkspaceActivityScan | null) {
      if (task?.scanId === next?.scanId && task?.state === next?.state && task?.completed === next?.completed && task?.errors === next?.errors) return;
      task = next;
      setScanState({ project, generation, scan: next });
    }
    function apply() {
      clearTimeout(updateTimer);
      updateTimer = undefined;
      if (!pending || !current()) return;
      const at = Date.now();
      const delay = Math.max(publishedAt + OPEN_INTERVAL, input.current.open ? latestScroll.current + SCROLL_IDLE : -Infinity) - at;
      if (delay > 0) { updateTimer = setTimeout(apply, delay); return; }
      pending = false;
      publishedAt = at;
      const state = { project, generation, rows: new Map(rows) };
      startTransition(() => publish(previous => current() ? state : previous));
    }
    function schedule(ms: number) {
      if (!current()) return;
      clearTimeout(timer);
      timer = setTimeout(() => void poll(), Math.max(ms, startedAt + OPEN_INTERVAL - Date.now()));
    }
    function wake() {
      requested = true;
      if (!polling) schedule(0);
    }
    async function poll() {
      if (!current() || polling) return;
      polling = true;
      requested = false;
      startedAt = Date.now();
      const version = commandRevision;
      const { open, selectedWorkspaceId } = input.current;
      let failed = false;
      try {
        const response = await call({ method: 'workspace.activity', params: { action: 'view', viewId, sequence: ++sequence,
          selectorOpen: open, selectorSequence: selectorSequence.current,
          selectedWorkspaceId, visibleWorkspaceIds: open ? visible.current : [], cursor } });
        if (!current()) return;
        const value = response.ok ? response.result as WorkspaceActivityView : undefined;
        if (!value || !Array.isArray(value.updates)) { failed = true; return; }
        if (value.generation !== generation) {
          if (Date.now() - reloadedAt >= 3_000) { reloadedAt = Date.now(); void input.current.reloadRoster().catch(() => {}); }
          return;
        }
        if (value.revision < cursor.revision) return;
        cursor = { generation, revision: value.revision };
        if (value.reset) rows = new Map();
        // Reset returns the current roster of summaries, so removed instances
        // cannot leak into the next view or accumulate across scope changes.
        for (const update of value.updates) rows.set(update.workspaceId, update);
        if (value.reset || value.updates.length) {
          pending = true;
          if (!updateTimer) apply();
        }
        if (version === commandRevision) updateTask(value.fullScan);
      } catch { failed = true; }
      finally {
        polling = false;
        schedule(failed ? 3_000 : requested ? 0 : input.current.open || task?.state === 'running' ? OPEN_INTERVAL : IDLE_INTERVAL);
      }
    }
    const owner = { id: viewId, call, wake, task(value: WorkspaceActivityScan) {
      if (!current()) return;
      commandRevision++;
      updateTask(value);
      wake();
    } };
    connection.current = owner;
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(updateTimer);
      if (connection.current === owner) connection.current = null;
      // An older in-flight request has a lower sequence and cannot renew this lease.
      void call({ method: 'workspace.activity', params: { action: 'view', viewId, sequence: ++sequence, cursor, visibleWorkspaceIds: [] } }).catch(() => {});
    };
  }, [project, generation, enabled]);

  useEffect(() => {
    if (!open) { visible.current = []; latestScroll.current = -Infinity; }
    connection.current?.wake();
  }, [open, selectedWorkspaceId]);

  const control = useCallback((force: boolean, cancelScanId?: string) => {
    const owner = connection.current;
    if (!owner || owner.command) return;
    if (force || cancelScanId) setCommandOwner(owner.id);
    owner.command = owner.call({ method: 'workspace.activity', params: cancelScanId
      ? { action: 'cancel', scanId: cancelScanId }
      : { action: 'start', scope: 'project', scanId: 'scan-' + makeId(), force } }).then(response => {
      if (connection.current !== owner) return;
      if (response.ok && (force || cancelScanId)) owner.task(response.result as WorkspaceActivityScan);
      else owner.wake();
    }).catch(() => {}).finally(() => {
      owner.command = undefined;
      setCommandOwner(previous => previous === owner.id ? undefined : previous);
    });
  }, []);
  return {
    publication, noteVisible, noteScroll, control,
    fullScan: scanState?.project === project && scanState.generation === generation ? scanState.scan : null,
    commandBusy: Boolean(commandOwner && connection.current?.id === commandOwner),
  };
}
