import type { AgentContext } from "./agent-provider.ts";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentBinding, putAgentBinding } from "./agent-store.ts";
import { appendBundle, assertBundleReady } from "./handoff-bundles.ts";
import type { BundleRef } from "../shared/handoff-materials.ts";
import { digest, readState, writeState } from "./orchestration-state.ts";
import { sessionLimits, type SessionOperation } from "../shared/session-tools.ts";
import { withWorkspaceScope } from "./workspace-scope.ts";
import { readReviewSession, prepareSessionSupplement, cancelAgentIfSupported } from "./agent-review.ts";
import { resolveArtifactReference, resolvedArtifactImageAttachments, artifactSnapshotContent } from "./artifacts.ts";
import { liveAgentIdentity } from "./agent-identity.ts";

export async function authorizeSession(workspaceId: string, token: string | undefined, context: AgentContext, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("session_wait_finished");
  const binding = getAgentBinding(workspaceId);
  if (!binding) throw new Error("workspace_session_missing");
  const coordinatorId = binding.parentAgentId || binding.requestedByAgentId;
  if (token) {
    const identity = await liveAgentIdentity(token, context.paseo);
    if (!identity || !coordinatorId || identity.agentId !== coordinatorId) throw new Error("session_caller_not_coordinator");
    if (signal?.aborted) throw new Error("session_wait_finished");
  }
  const worker = (await context.paseo.agents.ref(binding.agentId).refresh())?.agent;
  if (signal?.aborted) throw new Error("session_wait_finished");
  if (!worker || worker.archivedAt || worker.cwd !== binding.cwd || worker.workspaceId !== binding.paseoWorkspaceId) throw new Error("session_worker_changed");
  return { binding, coordinatorId, worker };
}

// Only public messages and compact tool metadata cross the MCP boundary.
export function publicTimeline(items: unknown[], maxBytes = sessionLimits.historyBytes) {
  const output: Record<string, unknown>[] = [];
  let bytes = 2;
  let truncated = false;
  for (const entry of items) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const item = (raw.item || raw) as Record<string, unknown>;
    const type = item.type;
    let value: Record<string, unknown>;
    if (type === "user_message" || type === "assistant_message") {
      value = { type, text: typeof item.text === "string" ? item.text : "", messageId: item.messageId || item.clientMessageId, seq: raw.seqStart };
    } else if (type === "tool_call") {
      value = { type, name: item.name, status: item.status, seq: raw.seqStart };
    } else continue;
    const size = Buffer.byteLength(JSON.stringify(value)) + 1;
    if (bytes + size > maxBytes) {
      truncated = true;
      if (typeof value.text === "string") {
        let text = value.text;
        while (text.length && bytes + Buffer.byteLength(JSON.stringify(value)) + 1 > maxBytes) { text = text.slice(0, Math.floor(text.length / 2)); value.text = text; }
        if (bytes + Buffer.byteLength(JSON.stringify(value)) + 1 <= maxBytes) output.push(value);
      }
      break;
    }
    output.push(value); bytes += size;
  }
  return { items: output, truncated };
}

export async function handleSessionOperation(input: SessionOperation, context: AgentContext): Promise<unknown> {
  if (input.action === "message" || input.action === "stop") return withWorkspaceScope(input.workspaceId, () => perform(input, context));
  if (input.action === "wait") {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([perform(input, context, controller.signal), new Promise(resolve => {
      timer = setTimeout(() => { resolve({ ok: true, workspaceId: input.workspaceId, timedOut: true }); controller.abort(); }, input.timeoutMs);
    })]).finally(() => { clearTimeout(timer); controller.abort(); });
  }
  return perform(input, context);
}

async function perform(input: SessionOperation, context: AgentContext, signal?: AbortSignal): Promise<unknown> {
  const { binding, coordinatorId, worker } = await authorizeSession(input.workspaceId, input.token, context, signal);
  const handle = context.paseo.agents.ref(binding.agentId);
  const status = async () => {
    const current = (await authorizeSession(input.workspaceId, input.token, context, signal)).worker;
    const review = readReviewSession(input.workspaceId);
    return { ok: true, workspaceId: input.workspaceId, workerAgentId: current.id, coordinatorAgentId: coordinatorId || null,
      status: current.status, activeTurn: current.activeTurn || null, pendingPermissionCount: current.pendingPermissions?.length || 0,
      review: review ? { sessionId: review.id, status: review.status, round: review.round } : null };
  };
  if (input.action === "status") return status();
  if (input.action === "history") {
    const page = await handle.timeline.refetch({ limit: input.limit, direction: input.cursor ? "before" : "tail", ...(input.cursor ? { cursor: input.cursor } : {}) });
    if (page.error || page.staleCursor) throw new Error(page.error || "history_cursor_stale");
    const result = publicTimeline([...page.entries].reverse());
    const last = result.items.at(-1);
    return { ok: true, ...result, nextCursor: result.truncated && typeof last?.seq === "number" ? { epoch: page.epoch, seq: last.seq } : page.startCursor, hasMore: result.truncated || page.hasOlder };
  }
  if (input.action === "wait") {
    const initial = await status();
    const deadline = Date.now() + input.timeoutMs;
    if (!initial.activeTurn) return { ...initial, timedOut: false };
    while (Date.now() < deadline) {
      await delay(Math.max(0, Math.min(sessionLimits.pollMs, deadline - Date.now())), undefined, { signal });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([status(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); })]).finally(() => clearTimeout(timer));
      if (!next) return { ...initial, timedOut: true };
      if (digest(next) !== digest(initial) || !next.activeTurn) return { ...next, timedOut: false };
    }
    return { ...initial, timedOut: true };
  }
  if (input.action === "stop") {
    if (worker.activeTurn) await cancelAgentIfSupported(context, binding.agentId);
    const result = await status();
    return { ...result, stopConfirmed: !result.activeTurn };
  }
  if (!input.requestId || !input.text) throw new Error("message_request_id_and_text_required");
  const key = `session-message:${binding.agentId}:${digest(input.requestId)}`;
  const supplementKey = `session-supplements:${input.workspaceId}:${binding.agentId}`;
  const acknowledgeSupplement = (messageId: string) => {
    const items = readState<Array<Record<string, unknown>>>(supplementKey) || [];
    writeState(supplementKey, items.map(item => item.messageId === messageId ? { ...item, delivery: "accepted" } : item));
    const receipt = readState<{ bundle?: BundleRef }>(key);
    if (receipt?.bundle) {
      const current = getAgentBinding(input.workspaceId);
      if (!current || current.agentId !== binding.agentId) throw new Error("session_worker_changed");
      if (current.pendingHandoffBundle?.id === receipt.bundle.id && current.pendingHandoffBundle.version === receipt.bundle.version) putAgentBinding({ ...current, handoffBundle: receipt.bundle, pendingHandoffBundle: undefined });
    }
  };
  const identity = digest({ text: input.text, attachments: input.attachments, behavior: input.behavior });
  const prior = readState<{ identity: string; delivery: string; messageId: string }>(key);
  if (prior) {
    if (prior.identity !== identity) throw new Error("message_request_conflict");
    if (prior.delivery === "uncertain") {
      const page = await handle.timeline.refetch({ limit: sessionLimits.maxHistoryItems });
      if (!page.error && page.entries.some(entry => entry.item.type === "user_message" && (entry.item.messageId === prior.messageId || entry.item.clientMessageId === prior.messageId))) {
        prior.delivery = "accepted";
        writeState(key, prior);
      }
    }
    if (prior.delivery === "accepted") acknowledgeSupplement(prior.messageId);
    return { ok: prior.delivery === "accepted", messageId: prior.messageId, delivery: prior.delivery, readConfirmed: false };
  }
  const assets = input.attachments.map(reference => {
    if (!reference.assetId) throw new Error("registered_attachment_required");
    return resolveArtifactReference(reference, { repositories: [] });
  });
  if (binding.pendingHandoffBundle) throw new Error("handoff_supplement_delivery_pending");
  const material = binding.handoffBundle && binding.handoff ? await appendBundle(binding.handoffBundle, { requestId: input.requestId, text: input.text, sender: coordinatorId || "host-user", references: input.attachments, handoff: binding.handoff }) : null;
  if (material) assertBundleReady(material.bundle);
  await prepareSessionSupplement(input.workspaceId);
  const messageId = digest({ agentId: binding.agentId, requestId: input.requestId });
  const record = { identity, messageId, delivery: "uncertain", text: input.text, attachments: input.attachments, ...(material ? { bundle: material.bundle } : {}), createdAt: new Date().toISOString() };
  writeState(key, record);
  if (material) putAgentBinding({ ...binding, pendingHandoffBundle: material.bundle });
  writeState(supplementKey, [...(readState<unknown[]>(supplementKey) || []), record]);
  try {
    const text = material ? `Task supplement available: bundle=${JSON.stringify(material.bundle)}. Read HANDOFF.md and supplements/${material.bundle.version}.md using workbench_handoff_read, plus required sources. Include materialsVersion=${material.bundle.version} in the next execution report. Existing scope and host mode remain in effect.` : [input.text, ...assets.map(asset => artifactSnapshotContent(asset).content || "")].join("\n\n");
    await handle.send(text, { messageId, activeTurnBehavior: input.behavior, images: material ? [] : resolvedArtifactImageAttachments(assets) } as Parameters<typeof handle.send>[1]);
    writeState(key, { ...record, delivery: "accepted" });
    acknowledgeSupplement(messageId);
    return { ok: true, messageId, delivery: "accepted", readConfirmed: false };
  } catch {
    return { ok: false, messageId, delivery: "uncertain", readConfirmed: false };
  }
}
