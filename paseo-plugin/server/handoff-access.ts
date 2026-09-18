import { readState, readReviewState, writeState, digest } from "./orchestration-state.ts";
import { getAgentBinding } from "./agent-store.ts";
import { readReviewSession } from "./agent-review.ts";
import { readBundle, readBundleFile, readBundleEnvironment } from "./handoff-bundles.ts";
import { materialLimits, type MaterialRequest, type BundleRef } from "../shared/handoff-materials.ts";
import type { AgentContext } from "./agent-provider.ts";
import { liveAgentIdentity } from "./agent-identity.ts";

export function chunkText(bytes: Buffer, offset: number) {
  let start = Math.min(offset, bytes.length);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  let end = Math.min(start + materialLimits.readBytes, bytes.length);
  while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
  return { content: bytes.subarray(start, end).toString("utf8"), offset: start, nextOffset: end < bytes.length ? end : null, truncated: end < bytes.length };
}

export async function handleHandoffMaterials(input: MaterialRequest, context: AgentContext): Promise<Record<string, unknown>> {
  const binding = input.workspaceId ? getAgentBinding(input.workspaceId) : null;
  const session = input.workspaceId ? readReviewSession(input.workspaceId) : null;
  const identity = input.token ? await liveAgentIdentity(input.token, context.paseo) : null;
  const reviewAuth = session ? readReviewState<{ token: string; reviewerAgentId: string }>(`agent-review:auth:${session.id}`) : null;
  const reviewer = Boolean(input.token && reviewAuth?.token === input.token && session?.status === "reviewing" && reviewAuth.reviewerAgentId === session.reviewerAgentId);
  const ref: BundleRef | undefined = input.bundle || (reviewer ? session?.materials : binding?.pendingHandoffBundle || binding?.handoffBundle);
  if (!ref) throw new Error("handoff_bundle_unavailable");
  const manifest = readBundle(ref);
  let reader = "host-ui";
  if (input.token) {
    reader = reviewer ? reviewAuth!.reviewerAgentId : identity?.agentId || "";
    if (!reader || !reviewer && !identity) throw new Error("handoff_access_denied");
    const snapshot = (await context.paseo.agents.ref(reader).refresh())?.agent;
    if (!snapshot || snapshot.archivedAt || !reviewer && snapshot.cwd !== identity!.cwd) throw new Error("handoff_reader_changed");
    if (reviewer) {
      if (session?.materials?.id !== ref.id || session.materials.version !== ref.version) throw new Error("handoff_review_version_mismatch");
    } else if (reader === manifest.ownerAgentId) {
      if (snapshot.cwd !== manifest.ownerCwd) throw new Error("handoff_reader_changed");
      if (session?.status === "reviewing" && session.coordinator?.agentId === reader && (session.materials?.id !== ref.id || session.materials.version !== ref.version)) throw new Error("handoff_review_version_mismatch");
    } else if (!binding || reader !== binding.agentId || snapshot.cwd !== binding.cwd || snapshot.workspaceId !== binding.paseoWorkspaceId || binding.handoffBundle?.id !== ref.id || ref.version > (binding.pendingHandoffBundle || binding.handoffBundle).version) throw new Error("handoff_access_denied");
  } else if (!binding || binding.handoffBundle?.id !== ref.id || ref.version > (binding.pendingHandoffBundle || binding.handoffBundle).version) throw new Error("handoff_access_denied");
  const metadata = { bundle: ref, parent: manifest.parent, sourceCount: manifest.sources.length, requiredSources: manifest.sources.filter(s => s.required).slice(0, 30).map(s => s.id), blockers: manifest.blockers.slice(0, 30), warnings: manifest.warnings.slice(0, 20), conversation: manifest.conversation, fileCount: Object.keys(manifest.files).length };
  const key = `handoff-access:${ref.id}:${ref.version}:${digest(reader)}`;
  const record = (file: string) => {
    const prior = readState<Record<string, string>>(key) || {};
    writeState(key, { ...prior, [file]: new Date().toISOString() });
  };
  if (input.action === "asset") {
    const source = manifest.sources.find(s => s.id === input.sourceId);
    if (!source?.file || source.status !== "ready") throw new Error(source?.error || "handoff_asset_unavailable");
    const bytes = readBundleFile(ref, source.file, manifest);
    record(source.file);
    return source.mimeType?.startsWith("image/") ? { ok: true, bundle: ref, sourceId: source.id, image: { data: bytes.toString("base64"), mimeType: source.mimeType } }
      : { ok: true, bundle: ref, sourceId: source.id, ...chunkText(bytes, input.offset) };
  }
  if (input.action === "search") {
    if (!input.query) throw new Error("handoff_search_query_required");
    const hits: Array<{ file: string; offset: number; excerpt: string }> = [];
    const entries = Object.entries(manifest.files).filter(([, meta]) => meta.text);
    let nextOffset: number | null = null;
    for (let index = input.offset; index < entries.length; index++) {
      const [file] = entries[index], text = readBundleFile(ref, file, manifest).toString("utf8");
      const position = text.toLowerCase().indexOf(input.query.toLowerCase());
      if (position >= 0) {
        const hit = { file, offset: Buffer.byteLength(text.slice(0, Math.max(0, position - 100))), excerpt: text.slice(Math.max(0, position - 100), position + 200) };
        if (Buffer.byteLength(JSON.stringify([...hits, hit])) > materialLimits.readBytes) { nextOffset = index; break; }
        hits.push(hit);
      }
      if (hits.length >= materialLimits.searchHits) { nextOffset = index + 1 < entries.length ? index + 1 : null; break; }
    }
    return { ok: true, bundle: ref, hits, nextOffset };
  }
  if (input.file === "DIRECTORY.md") return { ok: true, ...metadata, ...chunkText(Buffer.from(["# Files", ...Object.keys(manifest.files).map(file => `- ${file}`)].join("\n")), input.offset) };
  if (input.file === "environment.json") {
    const bytes = readBundleEnvironment(ref);
    record(input.file); return { ok: true, ...metadata, ...chunkText(bytes, input.offset) };
  }
  const bytes = readBundleFile(ref, input.file, manifest);
  if (!manifest.files[input.file].text) throw new Error("use_handoff_asset_for_binary");
  record(input.file);
  return { ok: true, ...metadata, directory: "DIRECTORY.md", file: input.file, fetched: Object.keys(readState<Record<string, string>>(key) || {}).slice(0, 100), ...chunkText(bytes, input.offset) };
}
