# Native Node backend

Normal operation uses `server/backend/main.ts` with Node.js 22.14+ and Git. No
Python executable, package, PyInstaller artifact or backend download is used.
The source is under `server/` because Paseo only bundles plugin imports from
`client/`, `server/` and `shared/`. The worker runs in its own Node process.

## Responsibilities

- `config.ts`, `storage.ts`, `lease.ts`: legacy project paths, configuration, atomic records and a kernel-backed SQLite project lock.
- `git.ts`, `process.ts`: shell-free Git calls, four subprocess slots, time/output limits.
- `workspaces.ts`: creation, additions, recovery journals, removal/restore/deletion.
- `runtime.ts`, `local-execution.ts`: system/mise resolution, executable validation,
  prepared runtime records, project Go/NPM/pip caches and explicit local execution.
- `identity.ts`: Git and file digests used in frozen handoffs/review snapshots.
- `observation.ts`, `review.ts`, `cache.ts`: roster, graph/diff, review sets, bounded
  single-flight stale-while-revalidate observations with disk persistence.
- `service.ts`, `transport.ts`, `main.ts`: protocol dispatch, bounded JSONL transport,
  socket ownership, draining and process entry.
- `server/backend-supervisor.ts`: plugin-generation ownership, project isolation,
  authenticated retirement, startup coalescing and crash recovery.

## Compatibility and safety

Schema-v1 Workspace records and manifests retain their IDs, paths, timestamps and
unknown/history fields. Existing `stateRoot/toolchains/<sha256(workspaceId)>.json`
files and project dependency caches are reused. Derived observation caches restart
cold in `observer-node-cache.json`; legacy SQLite files are preserved untouched.
NUL-containing untracked files are now classified as binary, matching Git.

Deletion refuses dirty worktrees, commits after the recorded base, unknown files,
unregistered paths and identity changes. Branches remain intact. Partial additions
retain their journal and can be retried without deleting user work. A manifest write
failure is visible; repeating the same request repairs it from the durable record.

The worker publishes a mode-0600 ownership record next to its socket, with PID,
canonical project path, instance ID and a private shutdown token. Replacement
requires matching health and ownership identity and an authenticated shutdown.
The socket stays available for health checks while operations drain, then is removed
only by its owning instance. Plugin unload closes IPC; daemon death is also detected
through the IPC lease, including disconnects before initialization finishes. Unknown socket services are retained. Old Python workers
are retired only when lsof and repeated ps identity checks match the exact local
`-m workspace_workbench serve --config` invocation; unverifiable legacy workers
remain visible as errors rather than being killed by a guessed PID.

No plugin code changes host planning features. Permission presets, startup intent,
and host planning state remain separate. Reuse does not redeliver the same handoff
or reset its mode. Host mode is refreshed at execution boundaries; the host SDK has
no atomic mode-conditioned create/send, so a change after the final check remains
a host-protocol race, not a reason to equate all running sessions with unknown mode.

## Verification

`npm test` includes native Node/Git and supervisor process tests. When Python is
available, parity tests compare the legacy and Node protocols on real temporary
repositories, including existing records and runtime files. Python is only a test
oracle. `node scripts/verify-live.mjs` is opt-in and loads this plugin in an actual
isolated Paseo daemon with two temporary projects; it exercises hook-induced partial
failure/recovery, repeated addition, reload, backend crash and unload. It does not
change the user's installed plugin or start an execution Agent. The optional
`WORKSPACE_WORKBENCH_PROJECT_REGISTRY` variable isolates the registry for this test.

The project lease uses built-in `node:sqlite` (available in the required Node version), not a native npm addon or Python. It is held for the transport lifetime and released by the OS after a crash, avoiding stale PID-lock deletion races. Production sockets reject overlong Unix paths rather than allowing truncation. Filesystem deletion completes before runtime history cleanup; a refused Git deletion preserves the associated sessions and review history.
