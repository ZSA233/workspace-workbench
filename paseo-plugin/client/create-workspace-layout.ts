export const CREATE_WORKSPACE_MIN_HEIGHT = 220;
export const CREATE_WORKSPACE_MAX_HEIGHT = 720;
export const CREATE_WORKSPACE_MIN_LIST_HEIGHT = 56;

export function clampCreateWorkspaceHeight(height: number, maxHeight: number): number {
  const upper = Math.max(CREATE_WORKSPACE_MIN_HEIGHT, maxHeight);
  return Math.min(upper, Math.max(CREATE_WORKSPACE_MIN_HEIGHT, Math.round(height)));
}

export function createWorkspaceNaturalHeight(input: {
  repositoryCount: number;
  selectedCount: number;
  basesExpanded: boolean;
  hasStatusMessage: boolean;
  maxHeight: number;
}): number {
  const repositoryRows = Math.max(1, Math.min(input.repositoryCount, 8));
  const listHeight = repositoryRows * 48 + (input.repositoryCount > 8 ? 12 : 0);
  const baseInputs = input.basesExpanded ? Math.max(0, input.selectedCount) * 42 + 28 : 0;
  const statusHeight = input.hasStatusMessage ? 28 : 0;
  // Two fields, the resize grip, base toggle and submit button need roughly
  // 146px before the repository viewport. Keeping this value explicit avoids
  // making a short two-repository catalog scroll just because the body was
  // clamped to its minimum height.
  return clampCreateWorkspaceHeight(146 + listHeight + baseInputs + statusHeight, input.maxHeight);
}
