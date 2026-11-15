import type { WorkspaceDirectoryEntry } from "./workspace-directory";

export type DesktopWorkspaceDirectoryApi = {
  subscribe?: (handler: (update: { kind: string; id?: string; workspace?: WorkspaceDirectoryEntry }) => void) => () => void;
  list?: (options?: { subscribe?: Record<string, never>; page?: { limit: number; cursor?: string } }) => Promise<{
    entries: WorkspaceDirectoryEntry[];
    pageInfo?: { hasMore: boolean; nextCursor?: string | null };
    subscription?: { release(): Promise<void> };
  }>;
};

type WorkspaceCallbacks = {
  upsert(workspace: WorkspaceDirectoryEntry): void;
  remove(id: string): void;
  ready(available: boolean): void;
};

/** Read every workspace and keep it current until this plugin generation ends. */
export function observeDesktopWorkspaceContext(api: DesktopWorkspaceDirectoryApi | undefined, callbacks: WorkspaceCallbacks): () => void {
  let disposed = false;
  let listing = true;
  let releaseStream: (() => void) | undefined;
  // Subscription events are newer than any in-flight listing page.
  const updatedWhileListing = new Set<string>();
  const unsubscribe = api?.subscribe?.((update) => {
    if (disposed) return;
    if (update.kind === "upsert" && update.workspace?.id) {
      if (listing) updatedWhileListing.add(update.workspace.id);
      callbacks.upsert(update.workspace);
    } else if (update.kind === "remove" && update.id) {
      if (listing) updatedWhileListing.add(update.id);
      callbacks.remove(update.id);
    }
  });
  void Promise.resolve().then(async () => {
    if (disposed) return;
    if (!api?.list) { listing = false; if (!disposed) callbacks.ready(false); return; }
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await api.list(cursor
        ? { page: { limit: 100, cursor } }
        : { subscribe: {}, page: { limit: 100 } });
      if (result.subscription) {
        const release = () => { void Promise.resolve().then(() => result.subscription!.release()).catch(() => {}); };
        if (disposed) release();
        else if (releaseStream) release();
        else releaseStream = release;
      }
      if (disposed) return;
      for (const entry of result.entries) {
        if (!updatedWhileListing.has(entry.id)) callbacks.upsert(entry);
      }
      if (!result.pageInfo?.hasMore) { listing = false; updatedWhileListing.clear(); callbacks.ready(true); return; }
      cursor = result.pageInfo.nextCursor || undefined;
      if (!cursor || seen.has(cursor)) throw new Error("workspace_directory_listing_incomplete");
      seen.add(cursor);
    } while (cursor);
  }).catch(() => { listing = false; updatedWhileListing.clear(); if (!disposed) callbacks.ready(false); });
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    releaseStream?.();
  };
}
