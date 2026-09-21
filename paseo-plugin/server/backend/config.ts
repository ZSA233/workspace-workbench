import { createHash } from "node:crypto";
import { dirname, join, basename, resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { scanGitRoots } from "./discovery-scan.ts";
import {
  canonical,
  hash,
  inside,
  readJson,
  slug,
  WorkbenchError,
  type Json,
} from "./storage.ts";
import {
  resolveObservationTiming,
  type ObservationTiming,
} from "../../shared/observation-timing.ts";

export type Repository = {
  id: string;
  path: string;
  name: string;
  enabled: boolean;
  role: string | null;
  defaultBase: string | null;
};
export type Config = ReturnType<typeof loadConfig>;
function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}
export function loadConfig(file: string) {
  const configPath = canonical(file),
    base = dirname(configPath);
  let raw: Json;
  try {
    raw = readJson(configPath);
  } catch (error) {
    throw new WorkbenchError(
      existsSync(configPath) ? "config_invalid" : "config_missing",
      String(error),
    );
  }
  if (
    !raw ||
    Array.isArray(raw) ||
    typeof raw !== "object" ||
    (raw.schemaVersion ?? 1) !== 1
  )
    throw new WorkbenchError("config_invalid", "unsupported project schema");
  const path = (value: unknown, fallback: string, root = base): string => {
    if (value === undefined || value === null) return canonical(fallback);
    if (typeof value !== "string" || !value.trim())
      throw new WorkbenchError(
        "config_invalid",
        "paths must be non-empty strings",
      );
    return canonical(
      value.startsWith("~/") || value.startsWith("/")
        ? value
        : join(root, value),
    );
  };
  const sourceRoot = path(raw.sourceRoot, base);
  const workspaceRoot = path(
    raw.workspaceRoot,
    join(sourceRoot, ".workspace-workbench/workspaces"),
  );
  const stateRoot = path(
    raw.stateRoot,
    join(sourceRoot, ".workspace-workbench"),
  );
  const recordsRoot = path(raw.recordsRoot, join(workspaceRoot, "records"));
  const treesRoot = path(raw.treesRoot, join(workspaceRoot, "trees"));
  if (
    inside(recordsRoot, treesRoot, true) ||
    inside(treesRoot, recordsRoot, true)
  )
    throw new WorkbenchError(
      "config_invalid",
      "records and trees must be separate",
    );
  const socketPath =
    raw.socketPath === "auto"
      ? join(
          homedir(),
          ".config/workspace-workbench",
          hash(configPath).slice(0, 12) + ".sock",
        )
      : path(raw.socketPath, join(stateRoot, "observer.sock"));
  if (!Array.isArray(raw.repositories ?? []))
    throw new WorkbenchError("config_invalid", "repositories must be an array");
  const seen = new Set<string>();
  const repositories: Repository[] = (raw.repositories || []).map(
    (item: Json) => {
      if (
        !item ||
        typeof item.id !== "string" ||
        !item.id.trim() ||
        seen.has(item.id) ||
        typeof item.path !== "string" ||
        !item.path.trim()
      )
        throw new WorkbenchError(
          "config_invalid",
          "repository IDs must be unique with non-empty paths",
        );
      seen.add(item.id);
      if (!inside(path(item.path, sourceRoot, sourceRoot), sourceRoot, true))
        throw new WorkbenchError(
          "path_outside_root",
          "repository is outside source root",
        );
      return {
        id: item.id,
        path: item.path,
        name: item.displayName || item.id,
        enabled: item.enabled !== false,
        role: item.role || null,
        defaultBase: item.defaultBase || null,
      };
    },
  );
  const discovery = object(raw.discovery),
    limits = object(raw.limits),
    cache = object(raw.cache);
  if (!["manual", "auto", "hybrid"].includes(discovery.mode || "hybrid"))
    throw new WorkbenchError("config_invalid", "invalid discovery mode");
  const number = (key: string, fallback: number, min: number, max: number) => {
    const n = Number(limits[key] ?? fallback);
    if (!Number.isFinite(n))
      throw new WorkbenchError("config_invalid", `invalid limit ${key}`);
    return Math.max(min, Math.min(max, n));
  };
  let timing: ObservationTiming;
  try {
    timing = resolveObservationTiming(limits);
  } catch (error) {
    throw new WorkbenchError(
      "config_invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    configPath,
    sourceRoot,
    workspaceRoot,
    stateRoot,
    recordsRoot,
    treesRoot,
    socketPath,
    repositories,
    projectId:
      raw.project?.id || slug(basename(configPath).replace(/\.json$/, "")),
    displayName:
      raw.project?.displayName ||
      raw.project?.id ||
      slug(basename(configPath).replace(/\.json$/, "")),
    mainWorkspaceName: raw.mainWorkspace?.displayName || "Main workspace",
    managementEnabled: raw.management?.enabled !== false,
    agentEnabled: raw.agent?.provider === "paseo",
    toolchain: raw.toolchain ? object(raw.toolchain) : null,
    cacheEnabled: cache.enabled !== false,
    cacheRoot: path(cache.root, join(stateRoot, "cache")),
    timing,
    gitTimeout: timing.gitTimeoutMs,
    observationTimeout: timing.observationTimeoutMs,
    operationTimeout:
      number("workspaceOperationTimeoutSeconds", 120, 5, 600) * 1000,
    maxDiffBytes: number("maxDiffBytes", 262144, 16384, 4194304),
    cacheEntries: number("cacheMaxEntries", 500, 20, 10000),
    cacheBytes: number("cacheMaxBytes", 33554432, 1048576, 536870912),
    cacheTtl: timing.cacheTtlMs,
    foregroundGitTimeout: timing.foregroundGitTimeoutMs,
    discovery: {
      mode: discovery.mode || "hybrid",
      roots: (discovery.roots || [sourceRoot]).map((value: string) =>
        path(value, sourceRoot, sourceRoot),
      ),
      maxDepth: Math.min(12, Math.max(0, Number(discovery.maxDepth ?? 3))),
      exclude: Array.isArray(discovery.exclude) ? discovery.exclude : [],
      followSymlinks: discovery.followSymlinks === true,
    },
  };
}
export function repositoryPath(config: Config, repo: Repository): string {
  const candidate = canonical(
    repo.path.startsWith("~/")
      ? repo.path
      : resolve(config.sourceRoot, repo.path),
  );
  if (!inside(candidate, config.sourceRoot, true))
    throw new WorkbenchError(
      "path_outside_root",
      "repository path is outside the configured source root",
    );
  return candidate;
}
export async function discover(config: Config, includeManual = false, signal?: AbortSignal) {
  if (config.discovery.mode === "manual" && !includeManual)
    return { repositories: [] as Json[], incomplete: false, scannedDirectories: 0 };
  const results: Json[] = [],
    used = new Set(config.repositories.map((repo) => repo.id)),
    explicit = new Set(
      config.repositories.map((repo) => repositoryPath(config, repo)),
    );
  const scan = await scanGitRoots({
    roots: config.discovery.roots, sourceRoot: config.sourceRoot,
    maxDepth: config.discovery.maxDepth, excludeNames: config.discovery.exclude,
    excludePaths: [config.stateRoot, config.recordsRoot, config.treesRoot, config.workspaceRoot],
    descendIntoRepositories: [...explicit],
    followSymlinks: config.discovery.followSymlinks,
    signal,
  });
  for (const real of scan.roots) {
    if (explicit.has(real) || [...explicit].some(path => path !== real && inside(path, real))) continue;
    const part = relative(config.sourceRoot, real) || ".",
      candidate = part.replaceAll("/", "-").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "repository";
    const id = used.has(candidate) ? `${candidate}-${createHash("sha1").update(part).digest("hex").slice(0, 8)}` : candidate;
    used.add(id);
    results.push({ id, path: real, display_name: basename(real), enabled: false, role: null, default_base: null, metadata: {} });
  }
  return { repositories: results.sort((a, b) => a.path.localeCompare(b.path)), incomplete: scan.incomplete,
    ...(scan.reason ? { reason: scan.reason } : {}), scannedDirectories: scan.scannedDirectories };
}
