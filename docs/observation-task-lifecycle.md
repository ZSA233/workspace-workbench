# Observation and preparation task lifecycles

## Responsibilities

- The roster is metadata, immediately displayable without waiting for Git.
- Every visible roster member independently subscribes to a basic summary through
  the existing observation coordinator. There is no ten-repository cutoff or
  dependency on the selected repository's graph. Basic summaries use observation
  priority; watcher setup and speculative content stay in the background tier.
- Basic dirty checks collapse untracked directories and disable rename detection;
  they do not pretend those directory entries are exact file counts. References
  can publish before the dirty check finishes, without marking the summary ready.
- Graphs, changes and Diff retain their existing bounded read tasks and cache.
  Basic Git reads share in-flight work by repository, source version and command;
  cancelling one subscriber does not cancel another subscriber's work.
- Runtime preparation is a durable mutation, independent of panel visibility.
  It has its own execution owner; read-task subscription leases do not cancel it.

## Preparation protocol

`workspace.prepare.task` is an internal plugin RPC, not an Agent MCP tool.

- `start`: workspaceId, repositories and requestId. Persist the fixed target and
  requirements before dispatch; return an operation identity and current state.
- `status`: operationId, requestId or workspaceId. It never starts installation.
- `continue`: operationId, the same target and requirements, and requestId. Only
  failed/interrupted tasks may continue, after an explicit user action.

One operation executes per project. Installation is additionally serialized by
resolved installation location and tool/version with a kernel-owned SQLite lock.
Existing installed executables are checked under the lock before invoking install.
A worker owns runtime filesystem checks and subprocesses; cancellation on service
shutdown propagates to the existing owned process-group cleanup. Runtime result
and task records use asynchronous atomic writes with file and directory fsync.

On restart, uncertain operations are reconciled against saved executable records.
A fully verified result becomes ready; the remainder becomes interrupted and is
never automatically replayed. Active operations participate in workspace deletion
and mutation guards. The active preparation queue is bounded to 32 entries per project; persisted
request identities remain available for reconciliation.

Legacy `workspace.prepare` uses this executor. A quick completion preserves its
old success shape. A longer operation returns `operation_pending` and a status
lookup identity, rather than holding the host RPC for the duration of installation.
Internal orchestration rechecks execution permission before each repository's
preparation and resumes the same identity before proceeding to Agent handoff.

## Passive discovery

Model discovery previously requested a complete review runtime (including binary
diffs and file digests) just to obtain its working directory. It now reads roster
metadata and runs only when the review settings are open. Real review execution
keeps its original content and identity checks.

## Cache and UI

Mutation completion no longer deletes the whole observation cache. Workspace
versions invalidate affected observations while keeping their previous content.
Per-workspace publication epochs prevent pre-mutation reads from replacing newer
state. Preparation publishes runtime changes without clearing unrelated Git data.

Summary publication also repairs a newly created roster placeholder when the
leaf query already contains the same cached summary. Unknown is neutral, not a
claim of detached HEAD. Failed observations retain prior content and carry their
actual issue. The state menu reports confirmed/total repository counts separately
from selected-repository refresh. Runtime progress is independent of refresh and
can reconnect to an operation after leaving and reopening the panel.

## Evidence and boundaries

Regression coverage includes lightweight summary command selection, twelve
independent repository subscriptions with one blocked repository, placeholder
rehydration, durable admission failure, duplicate preparation, restart recovery,
existing runtime/CLI behavior, and cache preservation.

`WORKBENCH_LIVE_PREPARE=1 node paseo-plugin/scripts/verify-live.mjs` uses an isolated
Paseo home and a fake installer delayed for 35 seconds. Actual host RPC acceptance
must take less than two seconds; status remains queryable and duplicate starts
must execute exactly one installation. This is actual-host transport evidence with
a simulated installer, not a production installation or a real model Agent.

Performance reports under `.local/verification/switch-cold` retain intermediate
failed runs. UI timing must distinguish existing-cache switching from application
cold start; the OS filesystem cache is not cleared. Historical uncorrelated host
errors are not treated as fixed by these tests.

## Verification, 2026-09-28

Final six-repository UI sample: `.local/verification/switch-cold/run-yszvVR`
(frozen build `e16f6304443adb30`). It reads the real
`representative-workspace` worktrees with independent records/state and
management disabled. Each cold trial stops its verified owned backend, removes
only its derived cache after exit, and starts a fresh backend. OS caches remain
untouched. Timing starts at workspace selection; completion requires both the
visible UI's verified count and actual boolean dirty observations for all six
repositories. Cold observations must postdate the measured click.

| Scenario | Samples | P50 | P95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Cold: roster visible | 20 | 107 ms | 134 ms | 136 ms |
| Cold: all six basic states confirmed | 20 | 1,087 ms | 1,665 ms | 2,201 ms |
| Cached: roster visible | 20 | 39 ms | 52 ms | 68 ms |
| Cached: confirmed state visible | 20 | 82 ms | 113 ms | 365 ms |

The run had no page errors and asserts that browsing never invokes
`workspace.reviewRuntime`. Graph/diff/statistics completion is not included in
these basic-state timings. Earlier failed and intermediate runs remain alongside
this report; independent direct Git sampling also observed a real server status
command exceed five seconds, so this result does not imply all filesystem/Git
latency has disappeared.

The isolated actual-host run in `/tmp/wb-lifecycle-live-complete.log` passed,
including `WORKBENCH_LIVE_PREPARE=1 WORKBENCH_LIVE_SLOW_GIT=1`: a 35-second fake
installation was admitted within two seconds, duplicate starts installed once,
and a status command delayed beyond 30 seconds did not prevent another repository
from completing its basic state within five seconds. The slow read ended with an
explicit failure. Backend recovery, plugin reload, stable MCP endpoint, archive
lifecycle and normal authorization regressions were also exercised. No real model
Agent was run and no daily plugin was reloaded for this change.

Final local checks: TypeScript typecheck, all 340 Node tests, version consistency
(0.4.11), `git diff --check`, and plugin archive construction passed. The service
advertises independent `basicSummaryProtocol` and `prepareProtocol` capabilities;
new clients use compatibility observation when the service has not yet updated.
No commit, version increment, publication or daily-plugin reload was performed.
