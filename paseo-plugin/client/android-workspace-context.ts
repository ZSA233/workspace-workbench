import { clearWorkbenchWorkspaceSnapshots, markWorkbenchWorkspaceSnapshotsReady, setWorkbenchWorkspaceSnapshot } from "./surface-context";

export type WorkspaceDirectoryReader = {
  list?: (options?: { page?: { limit: number; cursor?: string } }) => Promise<{
    entries: Array<{ id: string; directory?: string | null; workspaceDirectory?: string | null; name?: string | null }>;
    pageInfo?: { hasMore: boolean; nextCursor?: string | null };
  }>;
};

/** Android needs host directory context only while Workbench is mounted.
 * One paginated read per open lifetime, no daemon stream, listener or timer. */
export function createAndroidWorkspaceContext(api: WorkspaceDirectoryReader | undefined) {
  let observers = 0, generation = 0, closed = false;
  function observe() {
    if (closed) return () => {};
    observers++;
    if (observers === 1) {
      const epoch = ++generation;
      clearWorkbenchWorkspaceSnapshots();
      void Promise.resolve().then(async () => {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          if (closed || !observers || epoch !== generation) return;
          const result = await api?.list?.({ page: { limit: 100, ...(cursor ? { cursor } : {}) } });
          if (closed || !observers || epoch !== generation) return;
          for (const workspace of result?.entries || []) {
            const directory = workspace.directory || workspace.workspaceDirectory;
            if (directory) setWorkbenchWorkspaceSnapshot({ id: workspace.id, directory, name: workspace.name || workspace.id });
          }
          if (!result?.pageInfo?.hasMore) { markWorkbenchWorkspaceSnapshotsReady(Boolean(result)); return; }
          cursor = result.pageInfo.nextCursor || undefined;
          if (!cursor || seen.has(cursor)) throw new Error("workspace_directory_listing_incomplete");
          seen.add(cursor);
        } while (cursor);
      }).catch(() => { if (!closed && observers && epoch === generation) markWorkbenchWorkspaceSnapshotsReady(false); });
    }
    let released = false;
    return () => {
      if (released || closed) return;
      released = true;
      if (--observers === 0) { generation++; clearWorkbenchWorkspaceSnapshots(); }
    };
  }
  function close() { closed = true; observers = 0; generation++; clearWorkbenchWorkspaceSnapshots(); }
  return { observe, close };
}
