import { resolveRuntimeDeclarations } from './runtime-declarations.ts';
import { Runtime } from './runtime.ts';
import { runtimeIdentity } from "./identity.ts";
import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { Service } from "./service.ts";
import { WorkbenchError } from "./storage.ts";
/** Explicit local CLI only. There is intentionally no arbitrary-command RPC. */
export async function executeLocal(
  service: Service,
  workspaceId: string,
  repositoryId: string,
  argv: string[],
) {
  if (!argv.length)
    throw new WorkbenchError(
      "argument_invalid",
      "an explicit command is required",
    );
  const workspace = service.workspaces.get(workspaceId),
    repository = service.workspaces.repository(workspace, repositoryId);
  if (!workspace.managed || workspace.state !== "active")
    throw new WorkbenchError(
      "workspace_state_invalid",
      "local execution requires an active managed workspace",
    );
  if (Object.keys(workspace.repositoryAdditions || {}).length)
    throw new WorkbenchError(
      "repository_addition_pending",
      "recover additions before local execution",
    );
  await runtimeIdentity(repository, service.config);
  const resolved = await resolveRuntimeDeclarations(service.config,{...workspace,repositories:[repository]});
  const runtime = new Runtime(resolved.config);
  const needed = runtime.requirements[repository.id] || {};
  const entry = runtime.load(workspace)[repository.id];
  if (Object.keys(needed).length && (!entry || !runtime.ready(entry, needed))) {
    const task = await service.preparations.request({
      action: "start", workspaceId, repositories: [repository.id],
      requestId: `local:${workspaceId}:${repository.id}:${resolved.identity}`,
    });
    const finished = await service.preparations.wait(task.operationId, 120000);
    if (finished.state !== "ready") throw new WorkbenchError(
      ["failed", "interrupted"].includes(finished.state) ? "toolchain_prepare_failed" : "operation_pending",
      "Runtime preparation incomplete", { operationId: task.operationId, state: finished.state },
    );
  }
  const vars: NodeJS.ProcessEnv = runtime
    ? { ...runtime.environment(workspace, [], true), GOTOOLCHAIN: "local" }
    : { ...process.env, GOTOOLCHAIN: "local" };
  if (runtime) {
    const requested = Object.hasOwn(runtime.requirements, repository.id)
        ? runtime.requirements[repository.id]
        : {},
      saved = runtime.load(workspace)[repository.id] || {};
    if (
      Object.keys(requested).length &&
      (saved.status !== "ready" || !runtime.ready(saved, requested))
    )
      throw new WorkbenchError(
        "toolchain_not_ready",
        "prepare this repository's runtimes first",
      );
    for (const [tool, version] of Object.entries(requested)) {
      const actual = await runtime.version(
        workspace,
        tool,
        runtime.entryExecutable(saved, tool),
      );
      if (
        actual !== saved.resolved?.[tool] ||
        !(actual === version || actual.startsWith(version + "."))
      )
        throw new WorkbenchError(
          "toolchain_not_ready",
          "runtime executable version changed; prepare again",
        );
    }
    Object.assign(vars, runtime.cache(workspace, Object.keys(requested), true), runtime.executionVariables(saved, requested));
    vars.PATH = [
      ...runtime.bins(saved, requested),
      process.env.PATH || "",
    ].join(delimiter);
  }
  return new Promise<number>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: repository.worktreePath,
      env: vars,
      stdio: "inherit",
    });
    child.once("error", (error) =>
      reject(new WorkbenchError("command_failed", error.message)),
    );
    child.once("close", (code) => resolve(code ?? 1));
  });
}
