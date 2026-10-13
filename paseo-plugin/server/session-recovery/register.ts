import type { PaseoAgent, PaseoAgentListResult } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { recoveryPolicySchema, recoverySettings, recoverySettingsRpc, sessionRecoveryRpc } from "../../shared/session-recovery.ts";
import { readState } from "../orchestration-state.ts";
import { withProject } from "../projects.ts";
import type { HostConnection } from "../host-connection.ts";
import { SessionRecoveryController, type RecoveryReviewBridge } from "./controller.ts";
import { installRecoveryCoordinator } from "./current.ts";
import { RecoveryDiskStore, recoveryStorageLocation } from "./store.ts";
import { nativeRecoveryMethod, nativeReceiptSchema } from "./native-contract.ts";

export function registerSessionRecovery(server: PluginServerContext, host: HostConnection, review: RecoveryReviewBridge): () => Promise<void> {
  const settings = server.registerSettings(recoverySettings);
  let controller: SessionRecoveryController | null = null, disposed = false, booting = false;
  let removeCoordinator = () => {};
  let lastError = "recovery_starting";
  let nextBootAt = 0, warnedError = "";
  let scanAt = 0;
  const workspaceNames = new Map<string, string>();
  async function nativeRpc(input: unknown): Promise<unknown> {
    return host.run(async (_api, client) => {
      if (!client.invokePluginRpc) throw new Error("native_recovery_host_unavailable");
      return client.invokePluginRpc("workspace-workbench-paseo", nativeRecoveryMethod, input);
    });
  }
  const receiptFrom = (result: unknown) => {
    const value = (result as { receipt?: unknown })?.receipt;
    return value == null ? null : nativeReceiptSchema.parse(value);
  };
  async function remember(agent: PaseoAgent): Promise<void> {
    if (!controller || agent.provider !== "codex") return;
    controller.register(agent, agent.workspaceId ? workspaceNames.get(agent.workspaceId) : undefined);
    let connected = false;
    try { connected = withProject({ directory: agent.cwd }, () => {
      const saved = readState<{ token: string }>(`session:${agent.id}`);
      const identity = saved ? readState<{ agentId: string; cwd: string; revoked?: boolean }>(`context:${saved.token}`) : null;
      return Boolean(identity?.agentId === agent.id && identity.cwd === agent.cwd && !identity.revoked);
    }); } catch { /* Recovery does not require a Workbench project. */ }
    controller.markWorkbenchConnection(agent.id, connected);
  }
  async function scan(): Promise<void> {
    if (disposed || !controller) return;
    const startedAt = Date.now(), seen = new Set<string>();
    const api = await host.api();
    let cursor: string | undefined;
    do {
      const result = await api.workspaces.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) } });
      if (disposed) return;
      for (const workspace of result.entries) workspaceNames.set(workspace.id, workspace.name || workspace.workspaceDirectory);
      cursor = result.pageInfo.hasMore ? result.pageInfo.nextCursor || undefined : undefined;
      if (result.pageInfo.hasMore && !cursor) throw new Error("recovery_workspace_listing_incomplete");
    } while (cursor);
    cursor = undefined;
    do {
      const result: PaseoAgentListResult = await api.agents.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) } });
      if (disposed) return;
      for (const entry of result.entries) { seen.add(entry.agent.id); await remember(entry.agent); }
      cursor = result.pageInfo.hasMore ? result.pageInfo.nextCursor || undefined : undefined;
      if (result.pageInfo.hasMore && !cursor) throw new Error("recovery_agent_listing_incomplete");
    } while (cursor);
    await controller.reconcileListing(seen, startedAt);
    scanAt = Date.now(); lastError = "";
  }
  async function boot(): Promise<void> {
    if (disposed || booting || controller || Date.now() < nextBootAt) return;
    booting = true;
    let store: RecoveryDiskStore | undefined;
    try {
      const capability = await nativeRpc({ action: "capabilities" }) as { version?: number; emptyInput?: boolean; receipts?: boolean };
      if (capability.version !== 1 || !capability.emptyInput || !capability.receipts) throw new Error("native_recovery_host_unavailable");
      const location = recoveryStorageLocation(); store = new RecoveryDiskStore(location.directory, location.serverId);
      const candidate = new SessionRecoveryController({ store, review, api: () => host.api(),
        retry: async attempt => receiptFrom(await nativeRpc({ action: "start", ...attempt })),
        receipt: async (agentId, attemptId) => receiptFrom(await nativeRpc({ action: "read", agentId, attemptId })),
      });
      if (disposed) { await candidate.close(); return; }
      controller = candidate; removeCoordinator = installRecoveryCoordinator(candidate);
      const policy = await settings.read();
      if (disposed) return;
      await candidate.setPolicy(policy.status === "ready" ? policy.values : null);
      await scan(); lastError = "";
    } catch (error) {
      lastError = controller ? (error instanceof Error ? error.message : "recovery_initialization_failed") : "native_recovery_host_unavailable";
      if (!controller) store?.close();
      nextBootAt = Date.now() + 5000;
      if (warnedError !== lastError) { console.warn("workbench_recovery_unavailable", lastError); warnedError = lastError; }
    } finally { booting = false; }
  }
  const unsubscribeSettings = settings.subscribe(async state => {
    if (!disposed && controller) await controller.setPolicy(state.status === "ready" ? state.values : null);
  });
  const cleanups = [
    server.on("agent.created", async (event, context) => { if (!disposed && controller && event.agent.provider === "codex") { const agent = (await context.paseo.agents.ref(event.agent.id).refresh())?.agent; if (agent) await remember(agent); } }),
    server.on("agent.turn_started", async (event, context) => {
      if (disposed || !controller || event.agent.provider !== "codex") return;
      const agent = (await context.paseo.agents.ref(event.agent.id).refresh())?.agent;
      if (agent) await remember(agent);
      await controller.turnStarted(event.agent.id, event.turnId);
    }),
    server.on("agent.turn_ended", async event => {
      if (!disposed && controller && event.agent.provider === "codex") await controller.turnEnded(event.agent.id, event.turnId, event.outcome);
    }),
    server.on("agent.permission_requested", async event => { await controller?.cancel(event.agent.id, "permission_requested"); }),
    server.on("agent.archived", async event => {
      await controller?.archive(event.agent.id);
    }),
  ];
  server.handle(sessionRecoveryRpc, async input => {
    if (!controller && input.action !== "list" && input.action !== "get") throw new Error("recovery_unavailable");
    if (controller && !disposed) {
      if (input.action === "setEnabled") {
        if (!controller.records.has(input.agentId)) throw new Error("recovery_session_unknown");
        const current = await settings.read();
        if (current.status !== "ready") throw new Error("recovery_settings_unavailable");
        const values = recoveryPolicySchema.parse(current.values);
        if (input.enabled === null) delete values.enabledByAgent[input.agentId]; else values.enabledByAgent[input.agentId] = input.enabled;
        const result = await host.run(async (_api, client) => {
          if (!client.invokePluginRpc) throw new Error("recovery_settings_write_unavailable");
          return recoverySettingsRpc.write.output.parse(await client.invokePluginRpc("workspace-workbench-paseo", recoverySettingsRpc.write.name, { revision: current.revision, values }));
        });
        if (result.status !== "saved") throw new Error(result.error);
        await controller.setPolicy(recoveryPolicySchema.parse(result.values));
      }
      if (input.action === "cancel") await controller.cancel(input.agentId);
      if (input.action === "retryNow") await controller.retryNow(input.agentId);
    }
    return { ok: Boolean(controller && !disposed), available: controller?.isAvailable() || false,
      policy: controller?.getPolicy() || recoveryPolicySchema.parse({}),
      sessions: controller?.list(input.action === "list" ? undefined : input.agentId) || [],
      ...(lastError ? { error: lastError } : {}) };
  });
  let ticking = false;
  const timer = setInterval(() => {
    if (disposed || ticking) return;
    ticking = true;
    void (async () => {
      await boot();
      if (controller && !disposed) {
        if (Date.now() - scanAt >= 60000) await scan().catch(() => {});
        await controller.tick();
      }
    })().catch(error => { console.warn("workbench_recovery_tick_failed", error instanceof Error ? error.message : "unknown"); }).finally(() => { ticking = false; });
  }, 1000);
  timer.unref();
  const starting = boot();
  return async () => {
    disposed = true; clearInterval(timer); removeCoordinator(); unsubscribeSettings(); cleanups.forEach(remove => remove());
    await starting; await controller?.close();
  };
}
