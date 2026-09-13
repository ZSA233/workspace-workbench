import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, delimiter, basename } from "node:path";
import { homedir } from "node:os";
import { type Config } from "./config.ts";
import {
  atomicJson,
  canonical,
  hash,
  inside,
  issue,
  optionalJson,
  stable,
  WorkbenchError,
  type Json,
} from "./storage.ts";
import { command } from "./process.ts";

const adapters: Record<
  string,
  {
    names: string[];
    args: string[];
    pattern: RegExp;
    cache: Record<string, string>;
  }
> = {
  node: {
    names: ["node"],
    args: ["--version"],
    pattern: /\bv(\d+\.\d+(?:\.\d+)?)/,
    cache: { NPM_CONFIG_CACHE: "npm" },
  },
  python: {
    names: ["python", "python3"],
    args: ["--version"],
    pattern: /\bPython\s+(\d+\.\d+(?:\.\d+)?)/,
    cache: { PIP_CACHE_DIR: "pip" },
  },
  go: {
    names: ["go"],
    args: ["version"],
    pattern: /\bgo(\d+\.\d+(?:\.\d+)?)/,
    cache: { GOCACHE: "go-build", GOMODCACHE: "go-mod" },
  },
};
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
  load(workspace: Json): Json {
    try {
      return optionalJson(this.file(workspace));
    } catch {
      return {};
    }
  }
  cache(tools: string[], create = false) {
    const vars: Record<string, string> = {};
    if (!this.config.cacheEnabled) return vars;
    const paths = Object.assign(
      {},
      this.manager === "mise" && this.mode !== "system"
        ? { MISE_CACHE_DIR: "mise" }
        : {},
      ...tools.map((tool) => adapters[tool]?.cache || {}),
    );
    for (const [name, part] of Object.entries(paths)) {
      const path = join(this.config.cacheRoot, String(part));
      try {
        if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
        accessSync(path, constants.W_OK);
        vars[name] = path;
      } catch {}
    }
    return vars;
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
    if (!workspace.managed)
      return {
        manager: this.manager,
        mode: this.mode,
        status: "not_applicable",
        requirements: {},
        preparedRepositories: {},
        issues: [],
      };
    const saved = this.load(workspace),
      repositories: Json = Object.create(null),
      requirements: Json = {},
      tools = new Set<string>(),
      bins = new Set<string>();
    for (const repo of workspace.repositories) {
      const requested = Object.hasOwn(this.requirements, repo.id)
          ? this.requirements[repo.id]
          : {},
        previous = Object.hasOwn(saved, repo.id) ? saved[repo.id] : {},
        matches = stable(previous.requested) === stable(requested),
        ready = this.ready(previous, requested);
      let status = matches
        ? previous.status || "needs_prepare"
        : "needs_prepare";
      if (status === "ready" && !ready) status = "needs_prepare";
      if (!Object.keys(requested).length) status = "not_applicable";
      const paths =
        status === "ready" && ready ? this.bins(previous, requested) : [];
      paths.forEach((path) => bins.add(path));
      repositories[repo.id] = {
        status,
        tools: Object.keys(requested),
        issues: matches ? previous.issues || [] : [],
        sources: matches ? previous.sources || {} : {},
        binPaths: paths,
      };
      for (const [tool, version] of Object.entries(requested)) {
        tools.add(tool);
        const r = (requirements[tool] ||= { requested: [], resolved: [] });
        r.requested.push(version);
        if (matches && previous.resolved?.[tool])
          r.resolved.push(previous.resolved[tool]);
      }
    }
    const entries = Object.values(repositories) as Json[],
      states = entries.map((entry) => entry.status);
    const status = states.every((state) =>
      ["ready", "not_applicable"].includes(state),
    )
      ? "ready"
      : states.includes("ready")
        ? "partial"
        : states.includes("prepare_failed")
          ? "prepare_failed"
          : "needs_prepare";
    const managerPath = this.mode !== "system" ? this.managerPath() : null;
    return {
      manager: this.manager,
      mode: this.mode,
      managerAvailable: !!managerPath,
      managerPath,
      cache: {
        scope: "project",
        root: this.config.cacheRoot,
        enabled: this.config.cacheEnabled,
      },
      requirements,
      preparedRepositories: Object.fromEntries(Object.entries(repositories)),
      issues: entries.flatMap((entry) => entry.issues),
      status,
      environment: {
        pathEntries: status === "ready" ? [...bins] : [],
        variables: {
          ...this.cache([...tools]),
          ...(status === "ready" ? { GOTOOLCHAIN: "local" } : {}),
        },
      },
    };
  }
  candidates(tool: string) {
    const home = homedir(),
      dirs = [
        ...this.runtimePaths,
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
      join(this.root, "mise/installs", tool),
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
  async version(tool: string, path: string) {
    try {
      const r = await command(path, adapters[tool].args, {
        cwd: this.root,
        timeout: 10000,
        env: {
          ...process.env,
          ...this.cache([tool], true),
          GOTOOLCHAIN: "local",
        },
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
    this.cache(Object.keys(requested), true);
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
        const matches = (resolved: string) =>
          resolved === version || resolved.startsWith(version + ".");
        let found = false;
        if (this.mode !== "mise")
          for (const path of this.candidates(tool)) {
            if (
              !executable(path) ||
              this.shim(path) ||
              (this.mode === "system" && this.managed(path))
            )
              continue;
            const resolved = await this.version(tool, path);
            if (!matches(resolved)) continue;
            entry.resolved[tool] = resolved;
            entry.paths[tool] = dirname(path);
            entry.executables[tool] = path;
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
        const env = { ...process.env, ...this.cache([tool], true) },
          spec = `${tool}@${version}`;
        const install = await command(manager, ["install", spec, "--yes"], {
          cwd: this.root,
          timeout: 300000,
          env,
        });
        if (install.code)
          throw new WorkbenchError("prepare_failed", install.stderr);
        const where = await command(manager, ["where", spec], {
            cwd: this.root,
            timeout: 10000,
            env,
          }),
          root = where.stdout.trim(),
          path = join(root, "bin", tool);
        if (where.code || !root.startsWith("/") || !executable(path))
          throw new WorkbenchError(
            "toolchain_not_ready",
            "runtime executable missing",
          );
        const resolved = await this.version(tool, path);
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
    } catch (error) {
      entry.status = "prepare_failed";
      entry.issues = [issue(error)];
    }
    atomicJson(this.file(workspace), { ...saved, [repositoryId]: entry });
    return { workspaceId: workspace.id, repositoryId, ...entry };
  }
}
