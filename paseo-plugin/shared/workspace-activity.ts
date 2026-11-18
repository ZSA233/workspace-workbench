export const WORKSPACE_ACTIVITY_PROTOCOL = 2;
export const WORKSPACE_ACTIVITY_VISIBLE_LIMIT = 12;
export const WORKSPACE_ACTIVITY_LEASE_MS = 45_000;

export type WorkspaceActivitySummary = {
  latestCommitAt: string | null;
  latestCommitObservedAt: string | null;
  latestCommitState: "ready" | "pending" | "partial" | "unknown";
};

export type WorkspaceActivityCursor = {
  generation: string;
  revision: number;
};

export type WorkspaceActivityUpdate = WorkspaceActivitySummary & {
  workspaceId: string;
  instanceKey: string;
  activityScope: string;
  revision: number;
};

export type WorkspaceActivityScan = {
  scanId: string;
  state: "running" | "complete" | "cancelled" | "unknown";
  total: number;
  completed: number;
  errors: number;
};

export type WorkspaceActivityView = WorkspaceActivityCursor & {
  reset: boolean;
  updates: WorkspaceActivityUpdate[];
  fullScan: WorkspaceActivityScan | null;
};
