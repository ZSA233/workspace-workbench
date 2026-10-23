/** Pocket client extensions v1. No React, DOM, native, or Workbench dependencies. */
export interface PocketPluginClient { readonly paseo: object }
export interface PocketContext {
  readonly hostId: string;
  readonly workspaceId: string;
  readonly agentId?: string;
}
export interface PocketPanelContribution {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly location: "right-sidebar";
  readonly content: { readonly workspacePanelId: string; readonly agentPanelId?: string };
  readonly enabled?: boolean;
}
export interface PocketPanelRegistration {
  update(patch: Partial<Pick<PocketPanelContribution, "title" | "icon" | "enabled">>): void;
  dispose(): void;
}
export interface PocketExtensionClient {
  readonly protocolVersion: 1;
  supports(capability: string): boolean;
  readonly context: {
    getSnapshot(): PocketContext | null;
    subscribe(listener: () => void): () => void;
  };
  readonly ui: { registerPanel(panel: PocketPanelContribution): PocketPanelRegistration };
  dispose(): void;
}

/** Call during Paseo plugin setup and dispose with the plugin's existing cleanup. */
export function connectPocket(client: PocketPluginClient): PocketExtensionClient | null {
  const api = (globalThis as { Pocket?: {
    readonly protocolVersion?: number;
    connect?: (client: PocketPluginClient) => PocketExtensionClient | null;
  } }).Pocket;
  if (api?.protocolVersion !== 1 || typeof api.connect !== "function") return null;
  try { return api.connect(client); }
  catch { return null; } // Optional client enhancement must not break ordinary plugin setup.
}
