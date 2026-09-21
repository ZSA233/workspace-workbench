export type WorkbenchPanelScope = {
  hostWorkspaceId: string;
  projectConfig: string;
  workspaceId: string;
  repositoryId?: string;
};

/** Stable identity for query keys, preferences and diagnostics. */
export function workbenchScopeKey(scope: WorkbenchPanelScope): string {
  return [scope.hostWorkspaceId || "global", scope.projectConfig, scope.workspaceId, scope.repositoryId || ""].join("::");
}

export function projectPreferenceScopeKey(projectConfig: string, hostWorkspaceId: string): string {
  return `project:${projectConfig}:paseo-workspace:${hostWorkspaceId || "global"}`;
}
