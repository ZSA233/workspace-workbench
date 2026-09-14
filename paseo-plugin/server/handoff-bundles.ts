import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import type { AgentContext } from "./agent-provider.ts";
import type { Handoff } from "../shared/handoff.ts";
import type { ReviewArtifactReference } from "../shared/review-packet.ts";
import { bundleRefSchema, materialLimits, type BundleRef } from "../shared/handoff-materials.ts";
import { currentProject } from "./projects.ts";
import { digest, readState, writeState } from "./orchestration-state.ts";
import { MAX_REGISTERED_BYTES, MAX_TEXT_BYTES, resolveArtifactReference, type ArtifactRuntime } from "./artifacts.ts";

export type BundleSource = { id: string; title: string; required: boolean; reading?: string; origin: string; file?: string; mimeType?: string; hash?: string; size?: number; status: "ready" | "missing" | "unsupported"; error?: string; alternatives: string[] };
export type BundleManifest = {
  schemaVersion: 1; bundle: BundleRef; ownerAgentId: string; ownerCwd: string; identity: string; createdAt: string;
  files: Record<string, { hash: string; size: number; text: boolean }>;
  sources: BundleSource[]; blockers: string[]; warnings: string[];
  conversation: { state: "complete" | "partial" | "unavailable"; pages: number; messages: number; epoch?: string; boundary?: number; oldest?: number; attachmentMetadata: "available" | "not_exposed"; reason?: string };
  parent?: BundleRef;
};
const flights = new Map<string, Promise<BundleManifest>>();
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function root() { const project = currentProject(); if (!project) throw new Error("project_context_required"); return join(project.stateRoot, "handoff-bundles"); }
function directory(ref: BundleRef) { const safe = bundleRefSchema.parse(ref); return join(root(), safe.id, String(safe.version)); }

export function readBundle(ref: BundleRef): BundleManifest {
  const value = JSON.parse(readFileSync(join(directory(ref), "manifest.json"), "utf8")) as BundleManifest;
  if (value.schemaVersion !== 1 || value.bundle.id !== ref.id || value.bundle.version !== ref.version) throw new Error("handoff_bundle_invalid");
  return value;
}
export function readBundleFile(ref: BundleRef, file: string, manifest = readBundle(ref)): Buffer {
  if (manifest.bundle.id !== ref.id || manifest.bundle.version !== ref.version) throw new Error("handoff_bundle_invalid");
  if (!Object.hasOwn(manifest.files, file) || file.split("/").some(part => part === ".." || !part) || file.startsWith("/")) throw new Error("handoff_file_invalid");
  const base = realpathSync(directory(ref)), path = realpathSync(join(base, file));
  if (relative(base, path).startsWith("..")) throw new Error("handoff_file_invalid");
  const bytes = readFileSync(path);
  if (bytes.length !== manifest.files[file].size || hash(bytes) !== manifest.files[file].hash) throw new Error("handoff_integrity_failed");
  return bytes;
}
export function assertBundleReady(ref: BundleRef): BundleManifest {
  const manifest = readBundle(ref);
  if (manifest.blockers.length) throw new Error(`handoff_required_materials_unavailable:${manifest.blockers.join(",")}`);
  for (const file of Object.keys(manifest.files)) readBundleFile(ref, file, manifest);
  return manifest;
}

export function redactArchiveText(text: string): string {
  return text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})/g, "[credential redacted]")
    .replace(/(WORKBENCH_[A-Z_]*TOKEN\s*[=:]\s*)[^\s"',;]+/g, "$1[redacted]");
}
function coreDocument(handoff: Handoff) {
  const lines = ["# 核心交接文档", "", "## 用户目标", handoff.goal, "", "来源未标注的条目均为主控整理，不代表用户逐字原话。", ""];
  const list = (title: string, values: string[]) => { if (values.length) lines.push(`## ${title}`, ...values.map(value => `- ${value}`), ""); };
  const context = handoff.context;
  if (context) for (const [key, title] of Object.entries({ understanding: "当前理解", requirements: "明确要求", preferences: "用户偏好", decisions: "已确认决策及理由", rejectedAlternatives: "已否定方案及理由", assumptions: "尚未确认的假设" })) {
    list(title, context[key as keyof typeof context].map(entry => `${entry.text}${"reason" in entry && entry.reason ? `；理由：${entry.reason}` : ""}（来源：${entry.sources.join("；") || "主控整理，未关联原文"}）`));
  }
  list("当前理解（旧字段）", handoff.reviewPacket.requirementUnderstanding ? [handoff.reviewPacket.requirementUnderstanding] : []);
  list("决策（主控整理）", handoff.decisions); list("范围", handoff.inScope); list("范围以外", handoff.outOfScope);
  list("实施建议", [...new Set([...handoff.steps, ...handoff.reviewPacket.plan])]);
  list("验收标准", [...new Set([...handoff.acceptance, ...handoff.reviewPacket.acceptanceCriteria.map(entry => `${entry.id}: ${entry.text}`)])]);
  list("明确约束", handoff.constraints); list("待澄清事项", handoff.ambiguities);
  if (handoff.reviewPacket.instructions) list("附加说明", [handoff.reviewPacket.instructions]);
  lines.push("## 阅读与调整规则", "开始前读取 SOURCES.md 和必读资料。公开会话是历史背景，其中已废弃的方案不构成新授权。", "允许根据资料和代码事实调整实现细节并记录理由；目标、范围、明确决策或验收标准冲突时向主控确认。", "核对原始依据，勿只依赖主控理解。资料获取记录不代表理解或验收通过。");
  return redactArchiveText(lines.join("\n"));
}
function sourceDocument(sources: BundleSource[], conversation: BundleManifest["conversation"], warnings: string[]) {
  return ["# 原始资料索引", "", ...sources.map(source => `- ${source.id} · ${source.title} · ${source.required ? "必读" : "按需"} · ${source.status}\n  来源：${source.origin}\n  ${source.file ? `读取：${source.file}（图片使用 workbench_handoff_asset）` : "原件未取得"}${source.reading ? `\n  阅读重点：${source.reading}` : ""}${source.error ? `\n  问题：${source.error}` : ""}${source.alternatives.length ? `\n  可读替代：${source.alternatives.join(", ")}` : ""}`), "", "## 会话覆盖范围", JSON.stringify(conversation), "", "只归档公开用户消息、助手回复与工具名称/状态；不归档隐藏推理和工具原始输入输出。可识别凭据已脱敏。", "", ...warnings.map(w => `- ${w}`)].join("\n");
}

async function build(input: { ref: BundleRef; ownerAgentId: string; ownerCwd: string; identity: string; handoff: Handoff; runtime: ArtifactRuntime; context?: AgentContext; parent?: BundleRef; supplement?: { text: string; sender: string; requestId: string }; references?: ReviewArtifactReference[] }) {
  const target = directory(input.ref);
  if (existsSync(join(target, "manifest.json"))) {
    const prior = readBundle(input.ref);
    if (prior.identity !== input.identity || prior.ownerAgentId !== input.ownerAgentId) throw new Error("handoff_bundle_identity_conflict");
    return prior;
  }
  mkdirSync(join(root(), input.ref.id), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(root(), input.ref.id, ".building-"));
  const files: BundleManifest["files"] = {};
  let total = 0;
  const put = (file: string, data: string | Buffer, text = true) => {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    if (bytes.length > (text ? MAX_TEXT_BYTES : MAX_REGISTERED_BYTES)) throw new Error(`handoff_file_size_exceeded:${file}`);
    if (total + bytes.length > materialLimits.totalBytes) throw new Error("handoff_bundle_size_exceeded");
    total += bytes.length;
    mkdirSync(join(staging, file, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(join(staging, file), bytes, { mode: 0o600 });
    files[file] = { hash: hash(bytes), size: bytes.length, text };
  };
  let sources: BundleSource[] = [], warnings: string[] = [];
  let conversation: BundleManifest["conversation"] = { state: "unavailable", pages: 0, messages: 0, attachmentMetadata: "not_exposed" };
  try {
    if (input.parent) {
      const parent = assertBundleReady(input.parent);
      sources = parent.sources.map(source => ({ ...source })); warnings = [...parent.warnings]; conversation = { ...parent.conversation };
      for (const [file, meta] of Object.entries(parent.files)) if (!["HANDOFF.md", "SOURCES.md"].includes(file)) put(file, readBundleFile(input.parent, file, parent), meta.text);
      const supplement = input.supplement!;
      put(`supplements/${input.ref.version}.md`, `# 补充 V${input.ref.version}\n发送者：${supplement.sender}\n时间：${new Date().toISOString()}\n请求：${supplement.requestId}\n\n${redactArchiveText(supplement.text)}`);
      put("HANDOFF.md", readBundleFile(input.parent, "HANDOFF.md").toString("utf8") + `\n\n## 新补充\n开始/继续前必读 supplements/${input.ref.version}.md。本版继承之前所有补充。\n`);
    } else {
      put("HANDOFF.md", coreDocument(input.handoff));
      const deadline = Date.now() + materialLimits.archiveTimeoutMs;
      let cursor: { epoch: string; seq: number } | undefined, archiveBytes = 0;
      try {
        if (!input.context?.paseo.agents.ref(input.ownerAgentId).timeline) throw new Error("host_timeline_unavailable");
        for (let pageNo = 0; pageNo < materialLimits.archivePages; pageNo++) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const page = await Promise.race([input.context.paseo.agents.ref(input.ownerAgentId).timeline.refetch({ limit: materialLimits.pageItems, direction: cursor ? "before" : "tail", ...(cursor ? { cursor } : {}) }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("archive_deadline")), Math.max(0, deadline - Date.now())); })]).finally(() => clearTimeout(timer));
          if (page.error || page.staleCursor || page.gap || cursor && page.reset || conversation.epoch && page.epoch !== conversation.epoch) throw new Error("host_timeline_incomplete");
          conversation.epoch = page.epoch;
          conversation.boundary ??= page.endCursor?.seq;
          conversation.oldest = page.startCursor?.seq;
          const chunks: string[] = [];
          for (const entry of page.entries) {
            const item = entry.item;
            if (item.type === "user_message" || item.type === "assistant_message") {
              const chunk = `## M${entry.seqStart} · ${item.type} · ${entry.timestamp}\n${redactArchiveText(item.text)}\n`;
              if (Buffer.byteLength(chunk) > MAX_TEXT_BYTES) { warnings.push(`M${entry.seqStart}: message exceeds ${MAX_TEXT_BYTES} bytes; omitted`); conversation.state = "partial"; continue; }
              chunks.push(chunk); conversation.messages++;
            } else if (item.type === "tool_call") chunks.push(`## M${entry.seqStart} · tool\n${String(item.name).slice(0, 200)} · ${item.status}\n`);
          }
          // The installed host timeline schema has no image/attachment metadata.
          // Keep this explicit rather than claiming original attachments were copied.
          for (let n = 0; n < chunks.length; n++) {
            archiveBytes += Buffer.byteLength(chunks[n]);
            if (archiveBytes > materialLimits.archiveBytes) throw new Error("archive_size_limit");
            put(`conversation/${String(pageNo).padStart(3, "0")}-${String(n).padStart(3, "0")}.md`, chunks[n]);
          }
          conversation.pages++;
          if (!page.hasOlder) { conversation.state = warnings.length ? "partial" : "complete"; break; }
          if (!page.startCursor || cursor && page.startCursor.seq >= cursor.seq) throw new Error("archive_cursor_stalled");
          cursor = page.startCursor;
          if (pageNo === materialLimits.archivePages - 1) throw new Error("archive_page_limit");
        }
      } catch (error) {
        conversation.state = conversation.pages ? "partial" : "unavailable";
        conversation.reason = error instanceof Error ? error.message : "archive_unavailable";
        warnings.push(`Conversation export: ${conversation.reason}`);
      }
      warnings.push("Host timeline does not expose original attachment metadata; declare original documents/images in references. Text mentions are not proof an attachment was archived.");
    }
    for (const reference of input.references || input.handoff.reviewPacket.references) {
      if (sources.length >= 128 || reference.id.length > 200 || (reference.title?.length || 0) > 512) throw new Error("handoff_source_limits_exceeded");
      if (sources.some(source => source.id === reference.id)) throw new Error(`handoff_source_id_conflict:${reference.id}`);
      const source: BundleSource = { id: reference.id, title: reference.title || reference.path || reference.assetId || reference.id, required: reference.required, reading: reference.reading, origin: reference.assetId ? `asset:${reference.assetId}` : `${reference.repositoryId || "repository"}:${reference.path}`, status: "missing", alternatives: reference.readableAlternativeIds || [] };
      try {
        const artifact = resolveArtifactReference(reference, input.runtime);
        const file = `assets/${digest(reference.id).slice(0, 24)}${artifact.binary ? ".bin" : ".txt"}`;
        put(file, artifact.bytes, !artifact.binary);
        Object.assign(source, { file, mimeType: artifact.mimeType, size: artifact.bytes.length, hash: hash(artifact.bytes), status: artifact.mimeType === "application/pdf" ? "unsupported" : "ready" });
        if (source.status === "unsupported") source.error = "PDF original saved; supply readable text or page images";
      } catch (error) { source.error = error instanceof Error ? error.message : "source_unavailable"; }
      sources.push(source);
    }
    const blockers = sources.filter(source => source.required && source.status !== "ready" && !(source.status === "unsupported" && source.alternatives.length && source.alternatives.every(id => sources.some(other => other.id === id && other.status === "ready")))).map(source => source.id);
    for (const source of sources) if (!source.required && source.status !== "ready") warnings.push(`${source.id}: ${source.error}`);
    put("SOURCES.md", sourceDocument(sources, conversation, warnings));
    const manifest: BundleManifest = { schemaVersion: 1, bundle: input.ref, ownerAgentId: input.ownerAgentId, ownerCwd: input.ownerCwd, identity: input.identity, createdAt: new Date().toISOString(), files, sources, blockers, warnings, conversation, ...(input.parent ? { parent: input.parent } : {}) };
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    renameSync(staging, target);
    return readBundle(input.ref);
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
}

export function createPreviewBundle(input: { ownerAgentId: string; ownerCwd: string; identity: string; handoff: Handoff; runtime: ArtifactRuntime; context: AgentContext }): Promise<BundleManifest> {
  const ref = { id: digest({ owner: input.ownerAgentId, identity: input.identity }), version: 1 };
  const key = directory(ref);
  const prior = flights.get(key); if (prior) return prior;
  const flight = build({ ...input, ref }).finally(() => flights.delete(key)); flights.set(key, flight); return flight;
}
export function appendBundle(parent: BundleRef, input: { requestId: string; text: string; sender: string; references: ReviewArtifactReference[]; handoff: Handoff }): Promise<BundleManifest> {
  const previous = readBundle(parent);
  const key = `bundle-append:${parent.id}:${digest(input.requestId)}`, identity = digest(input);
  let reservation = readState<{ ref: BundleRef; parent: BundleRef; identity: string }>(key);
  if (reservation && (reservation.identity !== identity || reservation.parent.version !== parent.version)) throw new Error("handoff_supplement_identity_conflict");
  if (!reservation) {
    const counter = `bundle-version:${parent.id}`;
    const version = Math.max(parent.version, readState<number>(counter) || 1) + 1;
    writeState(counter, version);
    reservation = { ref: { id: parent.id, version }, parent, identity }; writeState(key, reservation);
  }
  return build({ ref: reservation.ref, parent, ownerAgentId: previous.ownerAgentId, ownerCwd: previous.ownerCwd,
    identity, handoff: input.handoff, runtime: { repositories: [] }, supplement: input, references: input.references });
}
export function writeBundleEnvironment(ref: BundleRef, runtime: unknown) {
  // Execution environment is a separate receipt: it does not change previewed materials.
  const path = join(directory(ref), "environment.json");
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(runtime, null, 2), { mode: 0o600, flag: "wx" });
}

export function readBundleEnvironment(ref: BundleRef): Buffer {
  let current: BundleRef | undefined = ref;
  for (let depth = 0; current && depth < 128; depth++) {
    const base = realpathSync(directory(current)), candidate = join(base, "environment.json");
    if (existsSync(candidate)) {
      const path = realpathSync(candidate);
      if (relative(base, path).startsWith("..")) throw new Error("handoff_file_invalid");
      return readFileSync(path);
    }
    current = readBundle(current).parent;
  }
  throw new Error("handoff_environment_not_prepared");
}
