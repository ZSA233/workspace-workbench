# Workspace Workbench Paseo plugin

This is the Paseo v0.8 integration for Workspace Workbench. It keeps the primary view in the Explorer side panel and leaves the Agent conversation in Paseo's main area.

The plugin contains three deliberately separate capabilities:

- Observer: Workspace selector, repository branch matrix, commit graph, changed files and service freshness state.
- Workspace management: creates a multi-repository worktree through the configured provider. It does not fetch, merge, push or switch branches.
- Agent provider: reads and creates/reuses a child Agent through Paseo, using a generic structured handoff and project-neutral labels.

The service socket is selected in this order:

1. `WORKSPACE_WORKBENCH_SOCKET`
2. `socketPath` in `WORKSPACE_WORKBENCH_CONFIG`
3. `~/.config/workspace-workbench/observer.sock`

Install from a checked-out copy with:

```sh
paseo plugin install /absolute/path/to/workspace-workbench/paseo-plugin --json
paseo plugin reload workspace-workbench-paseo --json
```

For a GitHub Release download the `workspace-workbench-paseo-*.tar.gz` asset,
extract it, install the locked dependencies, and install the extracted package
directory:

```sh
mkdir -p workspace-workbench-paseo
tar -xzf workspace-workbench-paseo-*.tar.gz -C workspace-workbench-paseo
cd workspace-workbench-paseo
npm ci
paseo plugin install "$PWD" --json
paseo plugin reload workspace-workbench-paseo --json
```

The package does not contain project configuration, observer caches, sockets,
Agent bindings or secrets. Configure and start the matching Workbench service
separately before opening the plugin.

The service must be started separately:

```sh
workspace-workbench serve --config /absolute/path/to/project.json
```

The plugin never starts Python, reads a project registry, or receives secrets from the Paseo daemon. Those concerns belong to the service configuration and provider.
