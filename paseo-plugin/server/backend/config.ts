import { createHash } from "node:crypto";
import { dirname, join, basename, resolve, relative } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  canonical,
  hash,
  inside,
  readJson,
  slug,
  WorkbenchError,
  type Json,
} from "./storage.ts";

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
    gitTimeout: number("gitTimeoutSeconds", 3, 0.5, 30) * 1000,
    operationTimeout:
      number("workspaceOperationTimeoutSeconds", 120, 5, 600) * 1000,
    maxDiffBytes: number("maxDiffBytes", 262144, 16384, 4194304),
    cacheEntries: number("cacheMaxEntries", 500, 20, 10000),
    cacheBytes: number("cacheMaxBytes", 33554432, 1048576, 536870912),
    cacheTtl: number("cacheTtlSeconds", 3, 0.5, 60) * 1000,
    discovery: {
      mode: discovery.mode || "hybrid",
      roots: (discovery.roots || [sourceRoot]).map((value: string) =>
        path(value, sourceRoot, sourceRoot),
      ),
      maxDepth: Math.min(12, Math.max(0, Number(discovery.maxDepth ?? 3))),
      exclude: discovery.exclude || [
        ".git",
        "node_modules",
        ".workspace-workbench",
        "vendor",
        ".venv",
        "dist",
        "build",
      ],
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
export function discover(config: Config): Json[] {
  if (config.discovery.mode === "manual") return [];
  const results: Json[] = [],
    used = new Set(config.repositories.map((repo) => repo.id)),
    seen = new Set<string>(),
    explicit = new Set(
      config.repositories.map((repo) => repositoryPath(config, repo)),
    );
  function visit(directory: string, root: string, depth: number) {
    const real = canonical(directory);
    if (
      seen.has(real) ||
      !inside(real, root, true) ||
      !inside(real, config.sourceRoot, true)
    )
      return;
    seen.add(real);
    if (existsSync(join(real, ".git"))) {
      if (!explicit.has(real)) {
        const part = relative(root, real) || ".",
          candidate =
            part
              .replaceAll("/", "-")
              .replace(/[^a-zA-Z0-9._-]+/g, "-")
              .replace(/^[-.]+|[-.]+$/g, "") || "repository";
        const id = used.has(candidate)
          ? `${candidate}-${createHash("sha1").update(part).digest("hex").slice(0, 8)}`
          : candidate;
        used.add(id);
        results.push({
          id,
          path: real,
          display_name: basename(real),
          enabled: false,
          role: null,
          default_base: null,
          metadata: {},
        });
      }
      return;
    }
    if (depth >= config.discovery.maxDepth) return;
    try {
      for (const item of readdirSync(real, { withFileTypes: true }))
        if (
          !item.name.startsWith(".") &&
          !config.discovery.exclude.includes(item.name) &&
          (item.isDirectory() ||
            (config.discovery.followSymlinks && item.isSymbolicLink()))
        )
          visit(join(real, item.name), root, depth + 1);
    } catch {}
  }
  for (const root of config.discovery.roots) visit(root, root, 0);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}
