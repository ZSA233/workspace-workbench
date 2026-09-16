import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { currentProject } from "./projects.ts";
import { readState } from "./orchestration-state.ts";
import type { ReviewArtifactReference, ReviewArtifactKind } from "../shared/review-packet.ts";
import type { ArtifactListResponse, ArtifactRegisterResponse } from "../shared/artifacts.ts";

export const MAX_REGISTERED_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_BYTES = 512 * 1024;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export type RuntimeRepository = { id: string; worktreePath: string };
export type ArtifactRuntime = { repositories: RuntimeRepository[] };
export type StoredWorkbenchArtifact = {
  version: 1;
  id: string;
  title: string;
  purpose?: string;
  kind: ReviewArtifactKind;
  mimeType: string;
  size: number;
  createdAt: string;
};

export type ResolvedWorkbenchArtifact = {
  reference: ReviewArtifactReference;
  source: "workspace" | "conversation";
  repositoryId?: string;
  path?: string;
  assetId: string;
  title: string;
  purpose?: string;
  kind: ReviewArtifactKind;
  mimeType: string;
  bytes: Buffer;
  size: number;
  binary: boolean;
};

function artifactRoot(): string {
  const project = currentProject();
  if (project) return join(project.stateRoot, "artifacts");
  return resolve(process.env.WORKSPACE_WORKBENCH_ARTIFACT_ROOT || join(homedir(), ".local", "state", "workspace-workbench", "artifacts"));
}

function safeAssetId(value: string): string {
  if (!ASSET_ID_PATTERN.test(value)) throw new Error("artifact_id_invalid");
  return value;
}

function metadataPath(id: string): string { return join(artifactRoot(), `${safeAssetId(id)}.json`); }
function bytesPath(id: string): string { return join(artifactRoot(), `${safeAssetId(id)}.bin`); }

function writeAtomic(path: string, data: string | Uint8Array, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, data, { mode });
  renameSync(temporary, path);
}

function inferMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".html": "text/html",
    ".htm": "text/html",
    ".go": "text/plain",
    ".py": "text/plain",
    ".ts": "text/plain",
    ".tsx": "text/plain",
    ".js": "text/plain",
    ".jsx": "text/plain",
    ".mjs": "text/plain",
    ".cjs": "text/plain",
    ".rs": "text/plain",
    ".java": "text/plain",
    ".kt": "text/plain",
    ".swift": "text/plain",
    ".c": "text/plain",
    ".h": "text/plain",
    ".cpp": "text/plain",
    ".yaml": "text/plain",
    ".yml": "text/plain",
    ".toml": "text/plain",
    ".sql": "text/plain",
    ".sh": "text/plain",
    ".vue": "text/plain",
    ".css": "text/plain",
  } as Record<string, string>)[extension] || "application/octet-stream";
}

function isAllowedMimeType(mimeType: string): boolean {
  return [
    "image/png", "image/jpeg", "image/webp", "image/gif",
    "application/pdf", "text/plain", "text/markdown", "text/html", "application/json",
  ].includes(mimeType.toLowerCase());
}

function inferArtifactKind(mimeType: string): ReviewArtifactKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("text/")) return "document";
  return "file";
}

function readStoredMetadata(id: string): StoredWorkbenchArtifact {
  const parsed = JSON.parse(readFileSync(metadataPath(id), "utf8")) as StoredWorkbenchArtifact;
  if (parsed.version !== 1 || parsed.id !== id || !Number.isSafeInteger(parsed.size) || parsed.size <= 0 || parsed.size > MAX_REGISTERED_BYTES || typeof parsed.mimeType !== "string" || !isAllowedMimeType(parsed.mimeType)) throw new Error("artifact_metadata_invalid");
  return parsed;
}

export function readStoredArtifact(id: string): { metadata: StoredWorkbenchArtifact; bytes: Buffer } {
  const metadata = readStoredMetadata(id);
  const bytes = readFileSync(bytesPath(id));
  if (bytes.length !== metadata.size) throw new Error("artifact_integrity_failed");
  return { metadata, bytes };
}

export function listArtifacts(): ArtifactListResponse {
  try {
    const artifacts = readdirSync(artifactRoot(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .flatMap((entry) => {
        try {
          const id = entry.name.slice(0, -5);
          const metadata = readStoredMetadata(id);
          if (id.startsWith("review-")) return [];
          return [{ id: metadata.id, title: metadata.title, ...(metadata.purpose ? { purpose: metadata.purpose } : {}), kind: metadata.kind, mimeType: metadata.mimeType, size: metadata.size, createdAt: metadata.createdAt }];
        } catch { return []; }
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { ok: true, artifacts };
  } catch (error) {
    return { ok: false, artifacts: [], error: { code: error instanceof Error ? error.message : "artifact_list_failed", message: error instanceof Error ? error.message : "Artifact list unavailable" } };
  }
}

export function storeArtifactBytes(input: { id: string; title: string; purpose?: string; kind: ReviewArtifactKind; mimeType: string; bytes: Uint8Array }): StoredWorkbenchArtifact {
  const id = safeAssetId(input.id);
  const mimeType = input.mimeType.toLowerCase();
  if (!isAllowedMimeType(mimeType)) throw new Error("artifact_type_not_allowed");
  if (!input.bytes.length || input.bytes.length > MAX_REGISTERED_BYTES) throw new Error("artifact_size_exceeded");
  if (existsSync(metadataPath(id)) || existsSync(bytesPath(id))) {
    throw new Error("artifact_id_conflict");
  }
  const metadata: StoredWorkbenchArtifact = {
    version: 1,
    id,
    title: input.title,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    kind: input.kind,
    mimeType,
    size: input.bytes.length,
    createdAt: new Date().toISOString(),
  };
  writeAtomic(bytesPath(id), input.bytes, 0o600);
  writeAtomic(metadataPath(id), `${JSON.stringify(metadata, null, 2)}\n`, 0o600);
  return metadata;
}

function safeRelativePath(root: string, value: string): string | null {
  if (!value || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\0")) return null;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) return null;
  const target = resolve(root, normalized);
  const relativePath = relative(resolve(root), target);
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith(".git/") || relativePath === ".git") return null;
  return relativePath.replaceAll("\\", "/");
}

function hasSymlink(root: string, value: string): boolean {
  let current = resolve(root);
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function resolveRepository(reference: ReviewArtifactReference, runtime: ArtifactRuntime): { repositoryId: string; worktreePath: string; path: string } {
  if (!reference.path) throw new Error("artifact_path_missing");
  const candidates = reference.repositoryId
    ? runtime.repositories.filter((repo) => repo.id === reference.repositoryId)
    : runtime.repositories;
  if (!candidates.length) throw new Error("artifact_repository_invalid");
  const matches = candidates.flatMap((repo) => {
    const path = safeRelativePath(repo.worktreePath, reference.path!);
    return path && !hasSymlink(repo.worktreePath, path) ? [{ repositoryId: repo.id, worktreePath: repo.worktreePath, path }] : [];
  });
  const existing = matches.filter((item) => {
    try { return lstatSync(resolve(item.worktreePath, item.path)).isFile(); }
    catch { return false; }
  });
  if (existing.length !== 1) throw new Error(existing.length > 1 ? "artifact_path_ambiguous" : "artifact_not_found");
  return existing[0];
}

function resolvedTitle(reference: ReviewArtifactReference, fallback: string): string {
  return reference.title || fallback;
}

export function resolveArtifactReference(reference: ReviewArtifactReference, runtime: ArtifactRuntime): ResolvedWorkbenchArtifact {
  if (reference.assetId) {
    const stored = readStoredArtifact(reference.assetId);
    return {
      reference,
      source: "conversation",
      assetId: stored.metadata.id,
      title: resolvedTitle(reference, stored.metadata.title),
      ...(reference.purpose || stored.metadata.purpose ? { purpose: reference.purpose || stored.metadata.purpose } : {}),
      kind: reference.kind || stored.metadata.kind,
      mimeType: reference.mimeType || stored.metadata.mimeType,
      bytes: stored.bytes,
      size: stored.metadata.size,
      binary: stored.metadata.mimeType.startsWith("image/") || stored.metadata.mimeType === "application/pdf",
    };
  }
  const repository = resolveRepository(reference, runtime);
  const absolute = resolve(repository.worktreePath, repository.path);
  const stat = lstatSync(absolute);
  if (stat.size <= 0 || stat.size > MAX_REGISTERED_BYTES) throw new Error("artifact_size_exceeded");
  const bytes = readFileSync(absolute);
  const mimeType = (reference.mimeType || inferMimeType(repository.path)).toLowerCase();
  if (!isAllowedMimeType(mimeType)) throw new Error("artifact_type_not_allowed");
  return {
    reference,
    source: "workspace",
    repositoryId: repository.repositoryId,
    path: repository.path,
    assetId: "",
    title: resolvedTitle(reference, repository.path),
    ...(reference.purpose ? { purpose: reference.purpose } : {}),
    kind: reference.kind,
    mimeType,
    bytes,
    size: bytes.length,
    binary: mimeType.startsWith("image/") || mimeType === "application/pdf",
  };
}

export function materializeReviewArtifact(artifact: ResolvedWorkbenchArtifact): ResolvedWorkbenchArtifact {
  if (artifact.assetId) return artifact;
  const assetId = `review-${randomUUID()}`;
  const metadata = storeArtifactBytes({ id: assetId, title: artifact.title, purpose: artifact.purpose, kind: artifact.kind, mimeType: artifact.mimeType, bytes: artifact.bytes });
  return { ...artifact, assetId: metadata.id, size: metadata.size };
}

export function artifactImageAttachments(artifacts: Array<{ assetId?: string; mimeType: string; status: string; required?: boolean }>): Array<{ data: string; mimeType: string }> {
  const seen = new Set<string>();
  return artifacts.flatMap((artifact) => {
    if (artifact.status !== "ready" || !artifact.assetId || !artifact.mimeType.startsWith("image/") || seen.has(artifact.assetId)) return [];
    seen.add(artifact.assetId);
    const stored = readStoredArtifact(artifact.assetId);
    return [{ data: stored.bytes.toString("base64"), mimeType: stored.metadata.mimeType }];
  });
}

export function resolvedArtifactImageAttachments(artifacts: ResolvedWorkbenchArtifact[]): Array<{ data: string; mimeType: string }> {
  const seen = new Set<string>();
  return artifacts.flatMap((artifact) => {
    if (!artifact.mimeType.startsWith("image/")) return [];
    const key = artifact.assetId || `${artifact.path || artifact.reference.id}:${artifact.mimeType}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ data: artifact.bytes.toString("base64"), mimeType: artifact.mimeType }];
  });
}

export function artifactSnapshotContent(artifact: ResolvedWorkbenchArtifact): { content?: string; binary: boolean; truncated: boolean } {
  if (artifact.binary) return { binary: true, truncated: false };
  if (artifact.bytes.length > MAX_TEXT_BYTES) return { binary: false, truncated: true };
  return { content: artifact.bytes.toString("utf8"), binary: false, truncated: false };
}

export async function authorizeArtifactCaller(input: { token: string }, context: { paseo: PaseoApi }): Promise<{ cwd?: string }> {
  const identity = readState<{ agentId?: string; cwd?: string; revoked?: boolean }>(`context:${input.token}`);
  if (!identity || identity.revoked || !identity.agentId) throw new Error("artifact_caller_context_invalid");
  const snapshot = await context.paseo.agents.ref(identity.agentId).refresh();
  if (!snapshot?.agent || snapshot.agent.archivedAt || (identity.cwd && snapshot.agent.cwd !== identity.cwd)) throw new Error("artifact_caller_context_changed");
  return { cwd: identity.cwd };
}

export function artifactReferenceFromStored(input: { id: string; title: string; purpose?: string; kind: ReviewArtifactKind; metadata: StoredWorkbenchArtifact }): NonNullable<ArtifactRegisterResponse["reference"]> {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    required: true,
    assetId: input.metadata.id,
    mimeType: input.metadata.mimeType,
  };
}

function sourcePathForAgent(root: string, value: string): string {
  const candidate = value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) ? value : resolve(root, value);
  const path = candidate === value ? relative(resolve(root), candidate) : value;
  const safe = safeRelativePath(root, path);
  if (!safe || hasSymlink(root, safe)) throw new Error("artifact_path_invalid");
  const absolute = resolve(root, safe);
  let stat;
  try { stat = lstatSync(absolute); } catch { throw new Error("artifact_not_found"); }
  if (!stat.isFile()) throw new Error("artifact_not_file");
  if (stat.size <= 0 || stat.size > MAX_REGISTERED_BYTES) throw new Error("artifact_size_exceeded");
  return absolute;
}

export async function registerArtifact(input: { token: string; artifact: { id?: string; title: string; purpose?: string; kind?: ReviewArtifactKind; mimeType?: string; data?: string; path?: string } }, context: { paseo: PaseoApi }): Promise<ArtifactRegisterResponse> {
  try {
    const caller = await authorizeArtifactCaller(input, context);
    let bytes: Buffer;
    let mimeType = input.artifact.mimeType?.toLowerCase() || "";
    if (input.artifact.path) {
      if (!caller.cwd) throw new Error("artifact_caller_path_unavailable");
      const sourcePath = sourcePathForAgent(caller.cwd, input.artifact.path);
      bytes = readFileSync(sourcePath);
      if (!mimeType) mimeType = inferMimeType(sourcePath);
    } else {
      const raw = input.artifact.data!.replace(/^data:[^;]+;base64,/, "");
      if (!raw || raw.length > Math.ceil(MAX_REGISTERED_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) throw new Error("artifact_data_invalid");
      bytes = Buffer.from(raw, "base64");
    }
    if (!mimeType) throw new Error("artifact_mime_type_required");
    const id = input.artifact.id || `conversation-${randomUUID()}`;
    const kind = input.artifact.kind || inferArtifactKind(mimeType);
    const metadata = storeArtifactBytes({ id, title: input.artifact.title, purpose: input.artifact.purpose, kind, mimeType, bytes });
    return { ok: true, reference: artifactReferenceFromStored({ id: metadata.id, title: input.artifact.title, purpose: input.artifact.purpose, kind, metadata }) };
  } catch (error) {
    return { ok: false, error: { code: error instanceof Error ? error.message : "artifact_register_failed", message: error instanceof Error ? error.message : "Artifact registration failed" } };
  }
}
