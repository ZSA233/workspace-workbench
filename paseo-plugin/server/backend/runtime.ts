import {
accessSync,
constants,
mkdirSync,
readdirSync,
realpathSync,
statSync
} from "node:fs";
import { homedir } from "node:os";
import { basename,delimiter,dirname,join,resolve } from "node:path";
import { repositoryPath,type Config } from "./config.ts";
import { writeOperation } from "./operation-storage.ts";
import { command } from "./process.ts";
import { withRuntimeInstall } from "./runtime-install-lock.ts";
import {
canonical,
hash,
inside,
issue,
optionalJson,
stable,
WorkbenchError,
type Json
} from "./storage.ts";

import { runtimeCacheLayout,runtimeCacheRoot } from './runtime-layout.ts';
import { summarizeRuntime } from './runtime-summary.ts';
import { runtimeTools as adapters } from './runtime-tools.ts';
export function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
export function which(name: string): string | null {
  if (name.includes("/")) return executable(name) ? canonical(name) : null;
  return (
    (process.env.PATH || "")
      .split(delimiter)
      .map((dir) => join(dir, name))
      .find(executable) || null
  );
}
export class Runtime {
  signal?: AbortSignal;
  onProgress?: (phase: string, tool: string) => void;
  config: Config;
  mode: string;
  manager: string;
  requirements: Record<string, Record<string, string>>;
  root: string;
  runtimePaths: string[];
  constructor(config: Config) {
    this.config = config;
    const raw = config.toolchain || {};
    this.mode = raw.mode || (raw.manager === "system" ? "system" : "auto");
    this.manager = raw.manager || (this.mode === "system" ? "system" : "mise");
    if (
      !["auto", "system", "mise"].includes(this.mode) ||
      !["mise", "system"].includes(this.manager) ||
      (this.manager === "system" && this.mode !== "system")
    )
      throw new WorkbenchError(
        "config_invalid",
        "invalid runtime manager or mode",
      );
    this.requirements = raw.repositories || {};
    for (const tools of Object.values(this.requirements)) {
      if (!tools || typeof tools !== "object" || Array.isArray(tools))
        throw new WorkbenchError(
          "config_invalid",
          "runtime requirements must be objects",
        );
      for (const [tool, version] of Object.entries(tools))
        if (
          !adapters[tool] ||
          typeof version !== "string" ||
          !/^\d+(\.\d+){0,2}$/.test(version)
        )
          throw new WorkbenchError(
            "config_invalid",
            "unsupported runtime requirement",
          );
    }
    if (
      !Array.isArray(raw.runtimePaths || []) ||
      (raw.runtimePaths || []).some(
        (v: unknown) => typeof v !== "string" || !v.trim(),
      )
    )
      throw new WorkbenchError("config_invalid", "invalid runtimePaths");
    if (
      raw.managerPath !== undefined &&
      (typeof raw.managerPath !== "string" || !raw.managerPath.trim())
    )
      throw new WorkbenchError("config_invalid", "invalid managerPath");
    this.runtimePaths = (raw.runtimePaths || []).map((v: string) =>
      this.path(v),
    );
    this.root = join(config.stateRoot, "toolchains");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  path(value: string) {
    return canonical(
      value.startsWith("~/")
        ? value
        : resolve(dirname(this.config.configPath), value),
    );
  }
  managerPath() {
    const raw = this.config.toolchain || {};
    if (raw.managerPath) {
      const path = which(raw.managerPath) || this.path(raw.managerPath);
      return executable(path) ? path : null;
    }
    return (
      [
        which("mise"),
        process.env.WORKSPACE_WORKBENCH_MISE,
        "/opt/homebrew/bin/mise",
        "/usr/local/bin/mise",
        "/usr/bin/mise",
        join(homedir(), ".local/bin/mise"),
        join(homedir(), ".mise/bin/mise"),
        join(homedir(), ".local/share/mise/bin/mise"),
      ]
        .filter((v): v is string => !!v)
        .find(executable) || null
    );
  }
  managed(path: string) {
    return (
      [join(homedir(), ".local/share/mise"), join(this.root, "mise")].some(
        (root) => inside(path, root, true),
      ) ||
      (!!this.managerPath() &&
        canonical(path) === canonical(this.managerPath()!))
    );
  }
  shim(path: string) {
    const manager = this.managerPath();
    return !!manager && canonical(path) === canonical(manager);
  }
  file(workspace: Json) {
    return join(this.root, hash(workspace.id) + ".json");
  }
  miseDataRoot() {
    const configured = this.config.toolchain?.miseDataRoot;
    if (configured !== undefined && (typeof configured !== 'string' || !configured.trim()))
      throw new WorkbenchError('config_invalid', 'Invalid miseDataRoot');
    const path = configured ? this.path(configured) : join(this.root, 'mise');
    if (configured && (this.config.repositories.some(repo => inside(path, repositoryPath(this.config, repo), true)) || inside(path, this.config.treesRoot, true)))
      throw new WorkbenchError('config_invalid', 'mise data must be outside source and workspace trees');
    return path;
  }
  cacheRoot(workspace: Json) { return runtimeCacheRoot(this.config, workspace); }
  load(workspace: Json): Json {
    try {
      return optionalJson(this.file(workspace));
    } catch {
      return {};
    }
  }
  cache(workspace: Json, tools: string[], create = false) {
    const vars: Record<string, string> = {};
    if (this.manager === "mise" && this.mode !== "system") {
      const path = this.miseDataRoot();
      if (create) {
        try { mkdirSync(path, { recursive: true, mode: 0o700 }); accessSync(path, constants.W_OK); }
        catch { throw new WorkbenchError("runtime_cache_unavailable", `mise data directory is not writable: ${path}`); }
      }
      vars.MISE_DATA_DIR = path;
    }
    if (!this.config.cacheEnabled) return vars;
    const layout = runtimeCacheLayout(this.config, workspace, tools, this.requirements);
    for (const [name, path] of Object.entries(layout)) {
      if (name === 'MISE_DATA_DIR') continue;
      try {
        if (create) { mkdirSync(path, { recursive: true, mode: 0o700 }); accessSync(path, constants.W_OK); }
        vars[name] = path;
      } catch { throw new WorkbenchError('runtime_cache_unavailable', `runtime cache directory is not writable: ${path}`); }
    }
    return vars;
  }
  environment(workspace: Json, tools: string[], create = false) {
    const env = { ...process.env };
    for (const name of ["MISE_DATA_DIR", "MISE_CACHE_DIR"]) if (!env[name]?.trim()) delete env[name];
    return { ...env, ...this.cache(workspace, tools, create) };
  }
  executionVariables(entry: Json, requested: Json): Record<string, string> {
    if (!requested.go || !this.ready(entry, requested)) return {};
    const root = entry.goRoot || dirname(dirname(this.entryExecutable(entry, 'go')));
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'ia32' ? '386' : process.arch;
    return { GOROOT: root, GOTOOLDIR: entry.goToolDir || join(root, 'pkg', 'tool', `${platform}_${arch}`) };
  }
  entryExecutable(entry: Json, tool: string) {
    return (
      entry.executables?.[tool] || join(entry.paths?.[tool] || "", "bin", tool)
    );
  }
  ready(entry: Json, requested: Json) {
    return (
      stable(entry.requested) === stable(requested) &&
      Object.keys(requested).every(
        (tool) =>
          executable(this.entryExecutable(entry, tool)) &&
          !this.shim(this.entryExecutable(entry, tool)),
      )
    );
  }
  bins(entry: Json, requested: Json) {
    return [
      ...new Set(
        Object.keys(requested)
          .map((tool) => this.entryExecutable(entry, tool))
          .filter(executable)
          .map(dirname),
      ),
    ];
  }
  summary(workspace: Json): Json {
    const saved = this.load(workspace);
    const ready = Object.fromEntries(workspace.repositories.map((repo: Json) =>
      [repo.id, this.ready(saved[repo.id] || {}, this.requirements[repo.id] || {})]));
    const tools = [...new Set<string>(workspace.repositories.flatMap((repo: Json) => Object.keys(this.requirements[repo.id] || {})))];
    return summarizeRuntime(workspace, this.requirements, saved, ready,
      { manager: this.manager, mode: this.mode, managerPath: this.mode !== 'system' ? this.managerPath() : null,
        cache: {scope: this.config.cacheScope || 'workspace', root: this.cacheRoot(workspace), enabled: this.config.cacheEnabled},
        variables: this.cache(workspace, tools) });
  }
  candidates(tool: string, version?: string) {
    const home = homedir(),
      dirs = [
        ...this.runtimePaths,
        ...(version ? [join(this.miseDataRoot(), "installs", tool, version, "bin"),
          join(home, ".local/share/mise/installs", tool, version, "bin")] : []),
        ...(process.env.PATH || "").split(delimiter),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/local/go/bin",
        join(home, ".local/bin"),
        join(home, ".asdf/shims"),
        join(home, ".pyenv/shims"),
        join(home, ".local/share/mise/shims"),
      ];
    for (const root of [
      join(home, ".nvm/versions/node"),
      join(home, ".gvm/gos"),
      join(home, ".local/share/mise/installs", tool),
      join(this.miseDataRoot(), "installs", tool),
    ])
      try {
        dirs.push(...readdirSync(root).map((name) => join(root, name, "bin")));
      } catch {}
    return [
      ...new Set(
        dirs.filter(Boolean).flatMap((dir) => {
          try {
            if (statSync(dir).isFile())
              return adapters[tool].names.includes(basename(dir)) ? [dir] : [];
          } catch {}
          return adapters[tool].names.map((name) => join(dir, name));
        }),
      ),
    ];
  }
  async version(workspace: Json, tool: string, path: string) {
    const env = { ...this.environment(workspace, [tool], true), GOTOOLCHAIN: "local" };
    try {
      const r = await command(path, adapters[tool].args, {
        cwd: this.root,
        timeout: 10000,
        signal: this.signal,
        env,
      });
      return r.code === 0
        ? `${r.stdout}\n${r.stderr}`.match(adapters[tool].pattern)?.[1] || ""
        : "";
    } catch {
      return "";
    }
  }
  async prepare(workspace: Json, repositoryId: string) {
    if (!workspace.managed)
      throw new WorkbenchError(
        "workspace_not_managed",
        "live workspace is read only",
      );
    if (!workspace.repositories.some((repo: Json) => repo.id === repositoryId))
      throw new WorkbenchError("repository_missing", "repository unavailable");
    const saved = this.load(workspace),
      requested = Object.hasOwn(this.requirements, repositoryId)
        ? this.requirements[repositoryId]
        : {},
      previous = Object.hasOwn(saved, repositoryId) ? saved[repositoryId] : {};
    this.cache(workspace, Object.keys(requested), true);
    if (previous.status === "ready" && this.ready(previous, requested))
      return { workspaceId: workspace.id, repositoryId, ...previous };
    const entry: Json = {
      requested,
      resolved: {},
      paths: {},
      executables: {},
      sources: {},
      status: "ready",
      issues: [],
    };
    try {
      for (const [tool, version] of Object.entries(requested)) {
        if (this.signal?.aborted) throw new WorkbenchError("operation_interrupted", "Runtime preparation interrupted");
        this.onProgress?.("checking", tool);
        const matches = (resolved: string) =>
          resolved === version || resolved.startsWith(version + ".");
        let found = false;
        if (this.mode !== "mise")
          for (const path of this.candidates(tool, String(version))) {
            if (
              !executable(path) ||
              this.shim(path) ||
              (this.mode === "system" && this.managed(path))
            )
              continue;
            const resolved = await this.version(workspace, tool, path);
            if (!matches(resolved)) continue;
            entry.resolved[tool] = resolved;
            const installedPath = realpathSync(path);
            entry.paths[tool] = dirname(installedPath);
            entry.executables[tool] = installedPath;
            entry.sources[tool] = this.managed(path) ? "mise" : "system";
            found = true;
            break;
          }
        if (found) continue;
        if (this.mode === "system")
          throw new WorkbenchError(
            "runtime_missing",
            `system runtime unavailable: ${tool}@${version}`,
          );
        const manager = this.managerPath();
        if (!manager)
          throw new WorkbenchError(
            "missing_manager",
            `No compatible runtime for ${tool}@${version}; install mise or configure runtimePaths`,
            { missingRuntimes: [{ tool, version }], manager: "mise" },
          );
        const env = this.environment(workspace, [tool], true),
          spec = `${tool}@${version}`;
        this.onProgress?.("waiting-install-lock", tool);
        const root = await withRuntimeInstall(`${env.MISE_DATA_DIR || manager}:${spec}`, this.signal, async () => {
          let where = await command(manager, ["where", spec], {cwd:this.root,timeout:10000,env,signal:this.signal});
          if (where.code !== 0 || !where.stdout.trim().startsWith("/") || !executable(join(where.stdout.trim(), "bin", tool))) {
            this.onProgress?.("installing", tool);
            const install = await command(manager, ["install", spec, "--yes"], {cwd:this.root,timeout:300000,env,signal:this.signal});
            if (install.code) throw new WorkbenchError("prepare_failed", install.stderr);
            where = await command(manager, ["where", spec], {cwd:this.root,timeout:10000,env,signal:this.signal});
          }
          const root=where.stdout.trim();
          if(where.code || !root.startsWith("/") || !executable(join(root,"bin",tool))) throw new WorkbenchError("toolchain_not_ready","runtime executable missing");
          return root;
        });
        this.onProgress?.("verifying", tool);
        const path = join(root, "bin", tool);
        const resolved = await this.version(workspace, tool, path);
        if (!matches(resolved))
          throw new WorkbenchError(
            "toolchain_not_ready",
            "runtime version mismatch",
          );
        entry.resolved[tool] = resolved;
        entry.paths[tool] = root;
        entry.executables[tool] = path;
        entry.sources[tool] = "mise";
      }
      if (requested.go) {
        const env = this.environment(workspace, ['go'], true);
        delete env.GOROOT; delete env.GOTOOLDIR; delete env.GOENV;
        const metadata = await command(this.entryExecutable(entry, 'go'), ['env', 'GOROOT', 'GOTOOLDIR'],
          { cwd: this.root, env: { ...env, GOTOOLCHAIN: 'local' }, timeout: 10000, signal: this.signal });
        const [root, toolDir] = metadata.stdout.trim().split('\n');
        if (metadata.code === 0 && root?.startsWith('/') && toolDir?.startsWith('/')) {
          entry.goRoot = root; entry.goToolDir = toolDir;
        }
      }
    } catch (error) {
      entry.status = "prepare_failed";
      entry.issues = [issue(error)];
    }
    await writeOperation(this.file(workspace), { ...saved, [repositoryId]: entry });
    return { workspaceId: workspace.id, repositoryId, ...entry };
  }
}
