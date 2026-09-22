import { useSyncExternalStore } from "react";

export type FileReviewSelection = {
  projectConfig?: string;
  workspaceId: string;
  repoPath: string;
  path: string;
  oldPath?: string | null;
  scope: "branch" | "working" | "commit";
  commitSha?: string;
  branch: string;
  baseSha?: string;
  head?: string;
  status: string;
  statusLabel: string;
};

type FileReviewOpenRequest = {
  hostWorkspaceId: string;
  panelId: string;
  agentId?: string;
  directory?: string;
  selection?: FileReviewSelection;
};

type FileReviewOpener = (request: FileReviewOpenRequest) => void;

const selectionsByHostWorkspace = new Map<string, FileReviewSelection[]>();
const activeKeysByHostWorkspace = new Map<string, string>();
const listeners = new Set<() => void>();
const emptySelections: FileReviewSelection[] = [];
const emptyActiveKey = "";
let opener: FileReviewOpener | null = null;

export function selectionKey(selection: Pick<FileReviewSelection, "projectConfig" | "workspaceId" | "repoPath" | "path" | "scope" | "commitSha">): string {
  return JSON.stringify([selection.projectConfig || "", selection.workspaceId, selection.repoPath, selection.path, selection.scope, selection.commitSha || ""]);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function configureFileReviewOpener(next: FileReviewOpener | null): () => void {
  opener = next;
  return () => {
    if (opener === next) opener = null;
  };
}

export function openFileReview(
  selection: FileReviewSelection,
  request: FileReviewOpenRequest,
): void {
  const current = selectionsByHostWorkspace.get(request.hostWorkspaceId) || [];
  const key = selectionKey(selection);
  const existingIndex = current.findIndex((item) => selectionKey(item) === key);
  const next = current.slice();
  if (existingIndex >= 0) next[existingIndex] = selection;
  else next.push(selection);
  selectionsByHostWorkspace.set(request.hostWorkspaceId, next);
  activeKeysByHostWorkspace.set(request.hostWorkspaceId, key);
  notify();
  opener?.({ ...request, selection });
}

export function closeFileReview(hostWorkspaceId: string, closingKey: string): void {
  const current = selectionsByHostWorkspace.get(hostWorkspaceId) || [];
  const closingIndex = current.findIndex((item) => selectionKey(item) === closingKey);
  const next = current.filter((item) => selectionKey(item) !== closingKey);
  if (next.length === current.length) return;
  if (next.length) selectionsByHostWorkspace.set(hostWorkspaceId, next);
  else selectionsByHostWorkspace.delete(hostWorkspaceId);
  const activeKey = activeKeysByHostWorkspace.get(hostWorkspaceId);
  if (!next.length) {
    activeKeysByHostWorkspace.delete(hostWorkspaceId);
  } else if (activeKey === closingKey || !next.some((item) => selectionKey(item) === activeKey)) {
    const fallback = next[closingIndex] || next[closingIndex - 1];
    if (fallback) activeKeysByHostWorkspace.set(hostWorkspaceId, selectionKey(fallback));
    else activeKeysByHostWorkspace.delete(hostWorkspaceId);
  }
  notify();
}

export function setActiveFileReview(hostWorkspaceId: string, key: string): void {
  const selections = selectionsByHostWorkspace.get(hostWorkspaceId) || [];
  if (!selections.some((selection) => selectionKey(selection) === key)) return;
  if (activeKeysByHostWorkspace.get(hostWorkspaceId) === key) return;
  activeKeysByHostWorkspace.set(hostWorkspaceId, key);
  notify();
}

export function getActiveFileReviewKey(hostWorkspaceId: string): string {
  return activeKeysByHostWorkspace.get(hostWorkspaceId) || emptyActiveKey;
}

export function clearFileReviews(hostWorkspaceId: string): void {
  if (!selectionsByHostWorkspace.has(hostWorkspaceId)) return;
  selectionsByHostWorkspace.delete(hostWorkspaceId);
  activeKeysByHostWorkspace.delete(hostWorkspaceId);
  notify();
}

export function getFileReviews(hostWorkspaceId: string): FileReviewSelection[] {
  return selectionsByHostWorkspace.get(hostWorkspaceId) || emptySelections;
}

export function subscribeFileReviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFileReviews(hostWorkspaceId: string): FileReviewSelection[] {
  return useSyncExternalStore(
    subscribeFileReviews,
    () => getFileReviews(hostWorkspaceId),
    () => emptySelections,
  );
}

export function useActiveFileReviewKey(hostWorkspaceId: string): string {
  return useSyncExternalStore(
    subscribeFileReviews,
    () => getActiveFileReviewKey(hostWorkspaceId),
    () => emptyActiveKey,
  );
}
