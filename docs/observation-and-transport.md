# Observation and MCP transport

The plugin owns repository observation and request lifetimes. Paseo's own Git
watcher/reconciliation is a separate subsystem and is not changed by this design.

## Repository observation

`ObservationScheduler` owns native subscriptions, worktree/shared-Git-directory
identity, invalidation revisions and 30-second visibility leases. Events debounce
for 300ms with a one-second maximum wait. It watches only exact registered Git
roots. Shared metadata watchers are reference-counted. Ignored directories are
excluded only when they contain no tracked files; index/ignore changes rebuild
subscriptions. Native subscription timeout is five seconds; late subscriptions
are unsubscribed. Idle leases release watchers and stop periodic Git work.

The visible panel batches an `observer.versions` request once per second. This
reads memory and renews demand; it performs no Git queries. It returns an instance
ID, a revision, repository state and validation tokens. A matching validation token
keeps an unchanged snapshot valid without pretending its original observation time
has advanced. Hidden/unmounted panels stop this loop. Transport failure backs off
up to 30 seconds and appears as a degraded status. On reconnect, the instance ID
invalidates old tokens.

Summary, graph, changes and diff use versioned cache entries. Summary counts dirty
paths without computing numstat or branch diffs. `changesLoaded: false` and nullable
statistics explicitly distinguish unloaded from zero. Changes supplies full
statistics on demand. A stale response can retain the last successful content
while the matching version is computed. A later event during computation cannot
certify that result as current.

A project has at most four running Git commands, with foreground requests ahead
of background work in the queue. Active subscriptions reconcile every five
minutes; degraded subscriptions reconcile every 30 seconds and retry native
registration with exponential backoff up to five minutes. Manual `force` invalidates
snapshots within the same concurrency/deadline policy. Mutations invalidate caches
without creating demand for previously idle repositories.

## MCP and bridge lifetimes

The MCP entrypoint assembles a tool router and an independent input dispatcher.
Tool calls have four execution slots and sixteen queue slots. Ping, initialization,
tool discovery and cancellation do not wait behind RPCs. Duplicate active JSON-RPC
IDs are rejected. The 55-second deadline begins at receipt, includes queueing,
limits connect to eight seconds, and reserves one second for cleanup.

Every call owns its SDK client and WebSocket. Cancellation, EOF, signals and
connection/RPC timeout close the client and terminate the owned socket. Cleanup
failure is counted/logged without replacing a successful result. Ping/initialize
metadata includes the MCP build ID, request phases, queue age and failure counts.
Backend health includes a separate build ID, watcher state and Git command counts.
These are local diagnostics and never contain credentials or full request bodies.

A failed response after dispatch is not proof that a mutation did not execute.
Neither MCP nor Observer automatically replays mutations; the caller reconciles
using the durable request/workspace identity. Observer recovery retries only a
read-only whitelist. Invalid JSON is parsed before marking a bridge request settled,
so malformed responses reject and close instead of losing both completion and timeout.
Plugin unload closes outstanding bridge sockets.

## Review and UI ownership

Review persistence, transition locking, host inspection and recovery timers live
in separate modules. Recovery indexes active sessions rather than scanning all
history each tick. Lifecycle events and explicit deadlines are primary; the
60-second fallback exists only while work is active. Historical records and
unknown fields retain their existing schema and ownership.

UI version subscriptions and manual-refresh coordination are separated from the
panel. Session lifecycle changes bump a separate version; session queries retain
a 60-second fallback. Privileged operations continue to verify host state at their
execution boundary; displaying a cached state does not authorize a mutation.

## Verification

Run from the repository root:

```sh
npm --prefix paseo-plugin run typecheck
npm --prefix paseo-plugin test
node paseo-plugin/scripts/verify-observation-performance.mjs
node paseo-plugin/scripts/verify-live.mjs
```

The performance script extracts the committed baseline into an isolated directory,
uses the same three-repository fixture and ten idle queries, counts Git invocations,
and measures twenty edits with a one-second client cadence. Output is saved under
`.local/verification/observation-performance.json`. Set `WORKBENCH_BASELINE_REF` to
an explicit pre-refactor revision when running after this change is committed.

The live script starts a separate Paseo home/registry and verifies real plugin
loading, authorization, reload, worker crash recovery and cleanup. It never reloads
the normal plugin. Optional `WORKBENCH_LIVE_UI=1` serves the bundled web UI and prints
an isolated URL and continuation-file path; create that file after visual inspection
so automated unload/cleanup continues. The wait is bounded to ten minutes.

Tests include real native filesystem events, exact-root rejection, linked worktree
refs, ignored-but-tracked files, event storms, expired leases, watcher recovery,
malformed bridge responses, uncertain writes, MCP queue/EOF cancellation and one
hundred real SDK WebSocket handshake failures.

## Loading the change and limits

Existing Agent MCP processes keep their loaded code. Reloading the Paseo plugin
only replaces plugin/backend processes. The host must reconnect MCP (or start a new
session) to load new MCP code. Compare the two diagnostic build IDs separately.
Do not kill unrelated session processes or move Workspace roots to force adoption.

This change does not eliminate Paseo's own outer-repository scans. Report their
latency separately from plugin Git metrics. Watcher degradation preserves snapshots
with a warning; unknown operation outcomes preserve recovery identity. Neither a
healthy process nor passing API tests substitutes for visual acceptance.
