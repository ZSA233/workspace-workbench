/** Read subscriptions follow selection and visibility, never their own partial results. */
export function repositoryObservationActive(input: {
  foreground: boolean;
  tab: 'workspace' | 'review';
  backendReady: boolean;
  listReady: boolean;
  workspaceUnavailable: boolean;
  workspaceId: string;
  repoPath: string;
  repository?: { repoPath: string };
}): boolean {
  return input.foreground && input.tab === 'workspace' && input.backendReady && input.listReady
    && !input.workspaceUnavailable && Boolean(input.workspaceId && input.repoPath)
    && input.repository?.repoPath === input.repoPath;
}
