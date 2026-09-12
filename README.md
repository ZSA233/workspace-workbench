# Workspace Workbench

## Agent orchestration

The optional Paseo bridge is configured per project, alongside the existing
`agent.provider` setting:

```json
{"agent":{"provider":"paseo","bridge":{"script":"../workspace-workbench/paseo-plugin/mcp.mjs","endpoint":"auto"}}}
```

`script` is relative to the project JSON. `endpoint: "auto"` reads the local
Paseo service registration; an explicit Unix socket or loopback `host:port` is
also supported. This does not expose an unauthenticated remote command service.
Install the plugin's production Node dependencies before enabling this bridge.

New coordinator Agents receive `workbench_workspace_preview`,
`workbench_workspace_execute`, and `workbench_workspace_status`. Existing
sessions are not restarted or silently reconfigured. Session-bound context is
stored under the project's local `stateRoot/orchestration/`; never commit it.
MCP calls and the panel delegate entry use the same server orchestrator.

Preview does not create worktrees, prepare runtimes, or create children. Execute
requires a verified non-planning coordinator and explicit repository selection
for a new Workspace. Codex permission presets and its separate `plan_mode`
feature are checked independently. Other providers currently fail closed until
their execution-mode semantics have an adapter and tests. Child Agents retain
normal sandbox approvals; full-access is not inherited automatically. MCP
execute approvals remain owned by Paseo/Codex and may need user confirmation.
Workers do not receive coordinator tools or recursively delegate.

Keep `requestId` and the full request unchanged when retrying. The journal tracks
creation, preparation and handoff independently. An unknown create/delivery
result, an archived worker, conflicting handoff, or mismatched identity blocks
automatic replacement; inspect the saved state and existing Agent first. A
successful handoff is not task acceptance. Parent notifications use steering,
not interruption, and failed delivery remains in the local outbox for retry.

The create dialog only creates the selected worktrees; it does not start an
Agent. It defaults to the selected repository at source `HEAD`. Repository and
ref validation occurs before Git mutation. Graph/Repositories/Changes use a
shared height budget; only very short panels use a single outer scroller.

Workspace Workbench is a configurable, read-first control surface for projects that contain multiple Git repositories and isolated workspaces. It presents branch history, merge topology, working-tree changes and Agent state in one Paseo panel, while keeping project-specific rules behind providers.

The repository is intentionally independent from any one application. A project supplies a JSON configuration and may add a provider for its own workspace lifecycle or Agent host.

## What is included

- A Python service with stdio and user-owned Unix Socket transports.
- Git Graph, branch references, working-tree changes and structured Diff data.
- Bounded in-memory LRU and rebuildable SQLite cache with stale-while-revalidate behavior.
- A safe default Git worktree provider for creating isolated multi-repository workspaces.
- A TypeScript Paseo plugin with Workspace, Review set, Diff and Agent integration modules.
- Manual, auto-discovery and hybrid repository configuration.

The default provider never performs fetch, merge, push or branch switching. Workspace creation and optional lifecycle actions are explicit operations and are capability-checked by the provider.

## Quick start

```sh
python -m venv .venv
. .venv/bin/activate
pip install -e .

workspace-workbench init --root ~/src/my-project --output ~/src/my-project/workbench.json
workspace-workbench discover --config ~/src/my-project/workbench.json
workspace-workbench serve --config ~/src/my-project/workbench.json
```

Discovery only prints candidates. In `hybrid` mode, add accepted repositories to the configuration before they become observed targets.

For a local protocol smoke test:

```sh
printf '%s\n' '{"id":1,"method":"observer.health","params":{}}' \
  | workspace-workbench serve --config examples/project.json --stdio
```

To install a released service and Paseo plugin, download the Python wheel and
the `workspace-workbench-paseo-*.tar.gz` asset from the GitHub Release. Install the
wheel with `python -m pip install workspace_workbench-*.whl`. Extract the plugin
package, install its locked dependencies, and register the extracted directory:

```sh
mkdir -p workspace-workbench-paseo
tar -xzf workspace-workbench-paseo-*.tar.gz -C workspace-workbench-paseo
cd workspace-workbench-paseo
npm ci
paseo plugin install "$PWD" --json
paseo plugin reload workspace-workbench-paseo --json
```

The release also includes `SHA256SUMS`. Verify the downloaded files with
`sha256sum -c SHA256SUMS` before installing them.

## Configuration

See [`examples/project.json`](examples/project.json) and [`schemas/project.schema.json`](schemas/project.schema.json). Paths may be absolute or relative to the configuration file. Repository paths must resolve below `sourceRoot`.

Each service instance is scoped to one project configuration. This keeps SQLite snapshots, workspace IDs and discovery results isolated. The default state path is project-local; a deployment may set a dedicated state directory and Unix Socket path.

Commit the project JSON with relative paths. Keep `stateRoot`, workspace records,
Agent bindings and SQLite files ignored. `recordsRoot` and `treesRoot` can be set
separately to adopt existing worktrees without relocating code. Records remain
JSON authority; SQLite contains only rebuildable observations, not configuration.
`socketPath: "auto"` uses a short, per-config-path socket under the user's runtime
configuration directory, avoiding Unix Socket path-length limits.

The Paseo plugin discovers explicitly registered configs from
`~/.config/workspace-workbench/projects.json` (`{"configs":["/path/to/workbench.json"]}`),
or an explicit `WORKSPACE_WORKBENCH_CONFIG`. This machine-local file holds only
config locations. Workspace panels match their directory to a registered project;
the global surface offers project selection. Requests, file tabs and Agent stores
are project-scoped. Unknown projects do not fall back to another project's socket.

The Graph loads another 50 commits when scrolling near its bottom, at most once
per observed page automatically. The footer remains a manual retry/accessibility
fallback. The current history window is capped at 200 commits. Native and Web
renderers share curve geometry; Android device verification remains necessary.

Projects that only need a live read-only view can set `management.enabled` to `false`. The service
then advertises no workspace create/cleanup capability, rejects those methods, and the Paseo panel
hides its create action.

## Provider model

The observation engine consumes normalized Workspace and Repository targets. Providers own project-specific decisions:

- `GitWorktreeProvider` supplies the default `main` live checkout and managed worktrees.
- A project adapter can supply different manifests, remote workspaces, toolchain preparation or lifecycle operations.
- Paseo uses an `AgentProvider` abstraction. The built-in adapter manages Paseo Agents; other hosts can implement the same contract without changing Git observation.

Providers must not silently widen the operation boundary. Any write operation must be explicit, idempotent where possible, and return a structured capability or error when unsupported.

### Optional runtimes and Agents

Configure `toolchain` with `manager: "mise"` and a `repositories` object mapping repository IDs to
runtime requirements, for example `{"api":{"go":"1.26"},"web":{"node":"22"}}`.
Only Go, Python and Node version selectors are accepted. `workspace.prepare` requires an explicit
repository ID and installs the declared runtime through mise. `workspace.runtime` rejects an
unprepared managed workspace with `toolchain_not_ready`; live checkouts are not prepared or managed.
No shell configuration is changed.

For explicit local commands use `workspace-workbench exec --config workbench.json
--workspace WORKSPACE_ID --repo api -- go version`. This validates the selected
repository's prepared binaries before building its PATH; it never exposes an
arbitrary command through the observer RPC. Missing or mismatched runtimes fail
with `toolchain_not_ready` instead of using a system version.

Set `agent: {"provider":"paseo"}` to enable execution Agent controls. Agent delegation persists a
structured handoff, validates the existing Agent's placement, and reuses it when available. A failed
status lookup does not create another Agent. Host permissions and sandbox settings remain authoritative.

Workspace cleanup is a preview unless `confirm: true` is supplied. It rejects dirty or mismatched
worktrees, preserves branches, and retains a removed record for the history filter. Creation retries
with the same request return the original workspace; conflicting requests are rejected.

## Protocol

The service accepts one JSON object per line and returns one JSON object per line. The public method names are project-neutral:

```text
observer.health
workspace.list
workspace.detail
workspace.identify
workspace.create
workspace.prepare
workspace.cleanup
workspace.runtime
repository.graph
repository.changes
repository.diff
review-set.compare
review-set.brief
```

The protocol is versioned independently from the Paseo package so a future Go service can replace the Python implementation without changing the plugin contract.

## Development

```sh
make check
make package
```

`make check` runs the Python service tests, Paseo typecheck and Paseo plugin
tests. `make package` builds Python distributions and the Paseo plugin package
under `dist/`; it requires the `build` Python package. Test fixtures create
temporary Git repositories and never depend on a developer's source tree.

The same checks run in GitHub Actions for every push and pull request. A tag
such as `v0.1.0` builds the release attachments; the workflow does not publish
to PyPI or npm.

Run the cache and refresh benchmark with `PYTHONPATH=src python3 tests/benchmark.py`. It creates ten
temporary repositories, measures 100 warm reads, observes a new file, and reopens the SQLite cache.
The benchmark uses a 0.5-second TTL; the service default is 3 seconds. UI polling intervals also affect
when a new observation becomes visible. SQLite is a reusable snapshot cache, never the Git source of truth.

The UI is split into navigation, repositories, graph, changed files, review and Agent components.
Fixed copy is maintained in `paseo-plugin/shared/copy.ts`. Workspace selection and section layout
are host settings; Diff tabs are keyed by target workspace, repository, path and change scope.

## Security and privacy

The service does not store secrets, environment variables or access tokens. It does not accept shell strings, and repository paths are constrained to the configured source root. Logs and protocol errors should use stable error codes; diagnostic paths are opt-in details rather than default panel text.
