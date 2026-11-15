export type WorkspaceDirectoryEntry = {
  id: string;
  directory?: string | null;
  workspaceDirectory?: string | null;
  name?: string | null;
};

export function workspaceDirectorySnapshot(workspace: WorkspaceDirectoryEntry) {
  // The host's workspace directory is authoritative when both fields exist.
  const directory = workspace.workspaceDirectory || workspace.directory;
  return workspace.id && directory ? { id: workspace.id, directory, name: workspace.name || workspace.id } : null;
}
