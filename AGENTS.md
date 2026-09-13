# Workspace Workbench engineering guide

The production backend is TypeScript under `paseo-plugin/server/backend/`.
`main.ts` only assembles the service and transport. Keep configuration/storage,
Git/process execution, Workspace lifecycle, runtime preparation, observation/cache,
and review-set logic in their respective modules. Python under `src/` is retained
for legacy compatibility and protocol-oracle tests; do not reintroduce it into the
plugin's production startup path.

`server/backend-supervisor.ts` owns one Node worker per canonical project config.
Plugin unload must retire only its own generation. Replacing a worker requires
verified socket/process ownership; do not kill a PID from an unverified file.
Keep the socket available for health checks during draining, release the SQLite
project lease on exit, and preserve unrelated socket paths. Git subprocesses use
argument arrays, bounded concurrency/output/timeouts and owned process groups.

Preserve schema-v1 records, Workspace IDs and unknown/history fields. Journal Git
mutations before execution and reconcile timed-out creation before retrying. Scope
additions must not silently expand an active execution or review. Permanent deletion
must preserve user modifications/commits and retain runtime history when filesystem
deletion fails. Do not add force-removal fallbacks.

Permission presets, initial worker intent and host planning state are separate.
Neither `running` nor `full-access` proves planning/execution state. Recheck host
mode at execution boundaries; never reset a reused worker to its initial mode or
redeliver an uncertain handoff automatically.

Use `npm --prefix paseo-plugin run typecheck` and the affected Node tests; the full
suite includes protocol, runtime/cache, handoff-image and Reviewer regressions.
Python comparisons use real temporary Git repositories when Python is available.
`node paseo-plugin/scripts/verify-live.mjs` loads the actual plugin in an isolated
Paseo home with an isolated project registry; it must not reload the user's normal
plugin or register temporary projects in their normal registry. Distinguish this
actual-host evidence from mocked Agent/session tests in execution reports.
