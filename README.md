# Workspace Workbench

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

workspace-workbench init --root ~/src/my-project --output ~/.config/workspace-workbench/my-project.json
workspace-workbench discover --config ~/.config/workspace-workbench/my-project.json
workspace-workbench serve --config ~/.config/workspace-workbench/my-project.json
```

Discovery only prints candidates. In `hybrid` mode, add accepted repositories to the configuration before they become observed targets.

For a local protocol smoke test:

```sh
printf '%s\n' '{"id":1,"method":"observer.health","params":{}}' \
  | workspace-workbench serve --config examples/project.json --stdio
```

## Configuration

See [`examples/project.json`](examples/project.json) and [`schemas/project.schema.json`](schemas/project.schema.json). Paths may be absolute or relative to the configuration file. Repository paths must resolve below `sourceRoot`.

Each service instance is scoped to one project configuration. This keeps SQLite snapshots, workspace IDs and discovery results isolated. The default state path is project-local; a deployment may set a dedicated state directory and Unix Socket path.

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
python -m unittest discover -s tests
```

The Paseo package has its own `npm run typecheck`. Test fixtures create temporary Git repositories and never depend on a developer's source tree.

Run the cache and refresh benchmark with `PYTHONPATH=src python3 tests/benchmark.py`. It creates ten
temporary repositories, measures 100 warm reads, observes a new file, and reopens the SQLite cache.
The benchmark uses a 0.5-second TTL; the service default is 3 seconds. UI polling intervals also affect
when a new observation becomes visible. SQLite is a reusable snapshot cache, never the Git source of truth.

The UI is split into navigation, repositories, graph, changed files, review and Agent components.
Fixed copy is maintained in `paseo-plugin/shared/copy.ts`. Workspace selection and section layout
are host settings; Diff tabs are keyed by target workspace, repository, path and change scope.

## Security and privacy

The service does not store secrets, environment variables or access tokens. It does not accept shell strings, and repository paths are constrained to the configured source root. Logs and protocol errors should use stable error codes; diagnostic paths are opt-in details rather than default panel text.
