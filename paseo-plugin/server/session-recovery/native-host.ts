/** Bundled into the Paseo host by the explicit, version-checked installer.
 * Never runs inside the plugin worker and never starts a second Codex writer. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoAgent } from "@getpaseo/client";
import { z } from "zod";
import { recoveryIdentity } from "./identity.ts";
import { nativeAttemptSchema, nativeReceiptSchema, type NativeReceipt, type NativeOutcome } from "./native-contract.ts";

const generation = randomUUID();
const locks = new Map<string, Promise<unknown>>();
const observers = new WeakSet<object>();
type StreamEvent = { type: string; turnId?: string; error?: string; reason?: string };
type Session = {
  agentManager: {
    getAgent(id: string): unknown; hasInFlightRun(id: string): boolean;
    fetchTimeline(id: string, options: { direction: "tail"; limit: number }): { rows: Array<{ turnId?: string }> };
    streamAgent(id: string, prompt: []): AsyncGenerator<StreamEvent>;
    subscribe(callback: (event: { type: string; agentId?: string; event?: StreamEvent }) => void): () => void;
  };
  buildAgentPayload(agent: unknown): Promise<PaseoAgent>;
  agentStorage: unknown; sessionLogger: unknown;
};
type Load = (id: string, context: { agentManager: Session["agentManager"]; agentStorage: unknown; logger: unknown }) => Promise<unknown>;
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("capabilities") }),
  z.object({ action: z.literal("read"), agentId: z.string().min(1), attemptId: z.string().min(1).max(200) }),
  nativeAttemptSchema.extend({ action: z.literal("start") }),
]);

export async function invokeWorkbenchNativeRecovery(session: Session, raw: unknown, load: Load,
  home = process.env.PASEO_HOME || join(homedir(), ".paseo")) {
  const input = requestSchema.parse(raw);
  const serverId = readFileSync(join(home, "server-id"), "utf8").trim();
  if (!serverId) throw new Error("native_recovery_server_identity_unavailable");
  const directory = join(home, "workspace-workbench", "native-recovery", createHash("sha256").update(serverId).digest("hex").slice(0, 24));
  const latestFile = (id: string) => join(directory, `agent-${createHash("sha256").update(id).digest("hex")}.json`);
  if (!observers.has(session.agentManager)) {
    observers.add(session.agentManager);
    session.agentManager.subscribe(event => {
      if (event.type !== "agent_stream" || !event.agentId || !event.event?.turnId || !["turn_started", "turn_failed", "turn_completed", "turn_canceled"].includes(event.event.type)) return;
      // Host-owned turn evidence survives plugin/daemon reload without inserting
      // a model-visible message. Unlike error timeline rows, it always has an ID.
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = latestFile(event.agentId), temporary = `${file}.${generation}.tmp`;
        writeFileSync(temporary, JSON.stringify({ serverId, agentId: event.agentId, turnId: event.event.turnId, type: event.event.type }), { mode: 0o600 }); renameSync(temporary, file);
      } catch { /* No admission can rely on missing turn evidence. */ }
    });
  }
  if (input.action === "capabilities") return { version: 1, emptyInput: true, receipts: true };
  const file = join(directory, createHash("sha256").update(JSON.stringify([input.agentId, input.attemptId])).digest("hex") + ".json");
  const read = (): (NativeReceipt & { generation: string; serverId: string; requestHash: string }) | null => {
    try {
      const receipt = nativeReceiptSchema.extend({ generation: z.string(), serverId: z.string(), requestHash: z.string() }).parse(JSON.parse(readFileSync(file, "utf8")));
      if (receipt.serverId !== serverId || receipt.agentId !== input.agentId || receipt.attemptId !== input.attemptId) throw new Error("native_recovery_receipt_identity_changed");
      return receipt;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const publicReceipt = (receipt: ReturnType<typeof read>) => {
    if (receipt && receipt.generation !== generation && ["dispatching", "accepted"].includes(receipt.status))
      return nativeReceiptSchema.parse({ ...receipt, status: "uncertain", error: "native_recovery_host_restarted" });
    return receipt ? nativeReceiptSchema.parse(receipt) : null;
  };
  if (input.action === "read") return { receipt: publicReceipt(read()) };
  const key = `${serverId}:${input.agentId}`, previous = locks.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const old = read();
    if (old) {
      if (old.requestHash !== requestHash) throw new Error("native_recovery_attempt_conflict");
      return { receipt: publicReceipt(old) };
    }
    await load(input.agentId, { agentManager: session.agentManager, agentStorage: session.agentStorage, logger: session.sessionLogger });
    const managed = session.agentManager.getAgent(input.agentId);
    if (!managed) throw new Error("native_recovery_session_unavailable");
    const agent = await session.buildAgentPayload(managed);
    const planning = agent.features?.find(feature => feature.id === "plan_mode");
    if (!agent.currentModeId || planning?.type !== "toggle" || typeof planning.value !== "boolean") throw new Error("native_recovery_session_changed");
    if (agent.provider !== "codex" || agent.archivedAt || agent.status !== "error" || !agent.lastError || agent.activeTurn || agent.pendingPermissions?.length || session.agentManager.hasInFlightRun(input.agentId))
      throw new Error("native_recovery_session_changed_or_busy");
    if (recoveryIdentity(agent) !== input.identity || agent.lastUserMessageAt !== input.lastUserMessageAt)
      throw new Error("native_recovery_session_changed");
    let lastTurn: string | undefined;
    try {
      const latest = JSON.parse(readFileSync(latestFile(input.agentId), "utf8"));
      if (latest.serverId === serverId && latest.agentId === input.agentId && latest.type === "turn_failed") lastTurn = latest.turnId;
    } catch { /* Older hosts can retain the original failure in their timeline. */ }
    if (!lastTurn) lastTurn = session.agentManager.fetchTimeline(input.agentId, { direction: "tail", limit: 50 }).rows.filter(row => row.turnId).at(-1)?.turnId;
    if (lastTurn !== input.failedTurnId) throw new Error("native_recovery_session_changed");
    let receipt = { agentId: input.agentId, attemptId: input.attemptId, status: "dispatching" as NativeReceipt["status"], turnId: null as string | null,
      outcome: null as NativeOutcome | null, error: null as string | null, serverId, generation, requestHash };
    const save = () => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${generation}.tmp`;
      writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 }); renameSync(temporary, file);
    };
    // Journal before starting. Even an uncertain/crashed start is never replayed.
    save();
    let iterator: AsyncGenerator<StreamEvent>;
    try { iterator = session.agentManager.streamAgent(input.agentId, []); }
    catch (error) { receipt = { ...receipt, status: "rejected", error: String(error) }; save(); return { receipt: publicReceipt(receipt) }; }
    const started = (async () => {
      try {
        const first = await iterator.next();
        if (first.done || first.value.type !== "turn_started" || !first.value.turnId) throw new Error("native_recovery_turn_identity_unconfirmed");
        receipt = { ...receipt, status: "accepted", turnId: first.value.turnId }; save();
        void (async () => {
          try {
            for await (const event of iterator) {
              let outcome: NativeOutcome | null = null;
              if (event.type === "turn_completed") outcome = { kind: "completed" };
              if (event.type === "turn_failed") outcome = { kind: "failed", error: { message: event.error || "Unknown Codex failure" } };
              if (event.type === "turn_canceled") outcome = { kind: "canceled" };
              if (outcome) { receipt = { ...receipt, status: "finished", outcome }; save(); }
            }
          } catch { receipt = { ...receipt, status: "uncertain", error: "native_recovery_terminal_unconfirmed" }; save(); }
        })().catch(() => {});
        return { receipt: publicReceipt(receipt) };
      } catch { receipt = { ...receipt, status: "uncertain", error: "native_recovery_start_unconfirmed" }; save(); return { receipt: publicReceipt(receipt) }; }
    })();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([started, new Promise<{ receipt: NativeReceipt | null }>(resolve => { timeout = setTimeout(() => resolve({ receipt: nativeReceiptSchema.parse({ ...receipt, status: "uncertain", error: "native_recovery_start_timeout" }) }), 15000); })]);
    } finally { clearTimeout(timeout); }
  });
  locks.set(key, operation);
  try { return await operation; } finally { if (locks.get(key) === operation) locks.delete(key); }
}
