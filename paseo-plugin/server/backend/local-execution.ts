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
  const vars: NodeJS.ProcessEnv = { ...process.env, GOTOOLCHAIN: "local" };
  if (service.runtime) {
    const requested = Object.hasOwn(service.runtime.requirements, repository.id)
        ? service.runtime.requirements[repository.id]
        : {},
      saved = service.runtime.load(workspace)[repository.id] || {};
    if (
      Object.keys(requested).length &&
      (saved.status !== "ready" || !service.runtime.ready(saved, requested))
    )
      throw new WorkbenchError(
        "toolchain_not_ready",
        "prepare this repository's runtimes first",
      );
    for (const [tool, version] of Object.entries(requested)) {
      const actual = await service.runtime.version(
        tool,
        service.runtime.entryExecutable(saved, tool),
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
    Object.assign(vars, service.runtime.cache(Object.keys(requested), true));
    vars.PATH = [
      ...service.runtime.bins(saved, requested),
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
