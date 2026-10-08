import { comparisonKey, type Comparison } from '../shared/comparison.ts';
import { useSyncExternalStore } from "react";

export type FileReviewSelection = {
  kind?:'file'|'comparison';
  workspaceInstance?:string;
  targetRequest?:number;
  changeNoteId?:string;
  changeNoteRequest?:number;
  projectConfig?: string;
  workspaceId: string;
  repoPath: string;
  path: string;
  oldPath?: string | null;
  scope: "branch" | "working" | "commit" | "compare";
  comparison?: Comparison;
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

export type ComparisonViewState={display?:{fontSize:number;wrap:boolean};mode?:'unified'|'split';collapsed:Set<string>;expanded:Record<string,Array<{oldStart:number;newStart:number;count:number}>>;contexts:Record<string,unknown[]>;anchor?:{key:string;path:string;oldLine?:number|null;newLine?:number|null;offset:number};currentPath?:string;lastTarget?:string};
const comparisonViews=new Map<string,ComparisonViewState>();
export function getComparisonView(host:string,key:string){const id=JSON.stringify([host,key]);let state=comparisonViews.get(id);if(!state){state={collapsed:new Set(),expanded:{},contexts:{}};comparisonViews.set(id,state);}return state;}

type FileReviewOpener = (request: FileReviewOpenRequest) => void;

const selectionsByHostWorkspace = new Map<string, FileReviewSelection[]>();
export type FileReviewPosition = { offset: number; hunk: number };
const positionsByHostWorkspace = new Map<string, Map<string, { split: FileReviewPosition; unified: FileReviewPosition }>>();

/** View state has the same lifetime and identity as its file tab. */
export function getFileReviewPosition(hostWorkspaceId: string, key: string, mode: 'split' | 'unified'): FileReviewPosition {
  if (!(selectionsByHostWorkspace.get(hostWorkspaceId) || []).some(selection => selectionKey(selection) === key)) return { offset: 0, hunk: 0 };
  let positions = positionsByHostWorkspace.get(hostWorkspaceId);
  if (!positions) { positions = new Map(); positionsByHostWorkspace.set(hostWorkspaceId, positions); }
  let entry = positions.get(key);
  if (!entry) { entry = { split: { offset: 0, hunk: 0 }, unified: { offset: 0, hunk: 0 } }; positions.set(key, entry); }
  return entry[mode];
}
const activeKeysByHostWorkspace = new Map<string, string>();
const listeners = new Set<() => void>();
const emptySelections: FileReviewSelection[] = [];
const emptyActiveKey = "";
let opener: FileReviewOpener | null = null;

export function selectionKey(selection: Pick<FileReviewSelection, "projectConfig" | "workspaceId" | "repoPath" | "path" | "scope" | "commitSha" | "comparison" | "oldPath" | "kind" | "workspaceInstance">): string {
  if(selection.kind==='comparison')return JSON.stringify(['comparison',selection.projectConfig||'',selection.workspaceId,selection.workspaceInstance||'',selection.repoPath,comparisonKey(selection.comparison)]);
  return JSON.stringify([selection.projectConfig || "", selection.workspaceId, selection.repoPath, selection.path, selection.scope, selection.commitSha || "", selection.oldPath || "", comparisonKey(selection.comparison),...(selection.workspaceInstance?[selection.workspaceInstance]:[])]);
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
  if(selection.kind==='comparison')selection={...selection,targetRequest:Date.now()};
  if(selection.changeNoteId)selection={...selection,changeNoteRequest:Date.now()};
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
  comparisonViews.delete(JSON.stringify([hostWorkspaceId,closingKey]));
  const current = selectionsByHostWorkspace.get(hostWorkspaceId) || [];
  const closingIndex = current.findIndex((item) => selectionKey(item) === closingKey);
  const next = current.filter((item) => selectionKey(item) !== closingKey);
  if (next.length === current.length) return;
  const positions = positionsByHostWorkspace.get(hostWorkspaceId);
  positions?.delete(closingKey);
  if (!positions?.size) positionsByHostWorkspace.delete(hostWorkspaceId);
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
  for(const key of comparisonViews.keys())if(JSON.parse(key)[0]===hostWorkspaceId)comparisonViews.delete(key);
  positionsByHostWorkspace.delete(hostWorkspaceId);
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
