# Observation refresh ownership

`client/observation-coordinator.ts` owns the per-project refresh lifecycle. It does
not store response payloads. `observation-query-cache.ts` adapts the existing
QueryClient and `use-observation-versions.ts` binds foreground subscriptions.

## Scheduling

- First reads are provided by React Query/QueryObserver; the coordinator shares
  the same query flight. Cached activation never triggers an automatic mount
  refetch. The full query key identifies project, workspace, repository and view.
- The foreground project polls versions every 15 seconds. Multiple surfaces share
  a controller within the same renderer/QueryClient. Separate renderer processes
  keep separate controllers; no cross-process shared UI state is assumed.
- Returning to a cached repository compares its captured dependency tokens to
  the current versions, including changes while that query was inactive.
- Manual refresh, background completion and failure retries enter the same
  queue. One in-flight read per query; changes during it coalesce. QueryClient
  cancellation is not used to restart an active request.
- Background refresh completion gets at most three follow-ups (250/1000/3000ms).
  Selection changes retain the attempt count for that cache generation. After
  those attempts, the normal version poll checks completion again.
- Transport failures retry at 2/5/10/30 seconds. Missing files/commits and invalid
  paths require a deliberate new request rather than an automatic retry loop.
- Last subscriber departure clears pending work. Re-entry always schedules a
  version check, even when the last successful check was recent. This is critical
  during the workbench-to-Diff surface handoff. Already dispatched RPCs may finish
  in their own query cache; the host RPC API does not expose AbortSignal.
- Native clients use the same activation and recovery scheduler, with no versions
  RPC. Cached activation uses a 30-second minimum read interval.

Policy constants live in `shared/observation-policy.ts`. Observation leases are
90 seconds, well beyond the 15-second validation interval. Backend events still
coalesce at 300ms (maximum wait 1s); normal reconciliation remains five minutes.
Version reads themselves do not run Git or touch the filesystem.

A failed background computation retains its prior content but returns a partial
observation with the actual failure code. Partial versioned cache entries can
recover after the cache TTL cooldown on a later read with the same source token; they are not permanently
accepted as valid cache hits. These results use the same failure backoff as
transport errors, rather than restarting rapid completion reads indefinitely.

## Data and presentation

Responses may include `observation.validationDependencies` (token-key to captured
value), while legacy `validationKey`/`validationToken` remain readable. Historical
Diff/changes identified by a full commit SHA carry `immutableIdentity`; their HEAD
identifies that commit, not the moving worktree HEAD. Mutable base/ref parameters
remain part of the query identity. Immutable content is not invalidated by normal
working-tree edits. Graph views include working-tree dependencies for their
uncommitted state; branch-only changes depend on refs.

Backend cache keys exclude request-scoped `observationBudgetMs` and `force`; the
remaining request deadline still bounds execution. Changing a time budget must
not split identical content into multiple cache entries.

Backend cache production is not a source change: a ready response with matching
source tokens is validated without rereading solely because a publication counter
changed. Review-set observations capture dependencies for all compared workspaces.

Queries retain inactive cached results for ten minutes. Closed project controllers
are also reclaimed after ten minutes; pending tasks stop immediately. A successful
version check updates validation time, not observation time. Stale age alone never
raises the warning icon. Sustained observation failures require at least three
failures and the area's validation window. Cached contents stay usable while
refreshing; initial loading and manual refresh have their own feedback.

`observationRefreshDiagnostics(client, project)` returns bounded counters for
cache reuse, version polls, scheduled business reads, merged work and refresh
reasons. Backend `observer.health.git` provides actual Git execution counts.
These counters are cumulative per controller, not per-request success logs.

## Verification

Deterministic clock tests cover selection, completion retry limits, failures,
subscription handoff, native fallback, duplicate requests and late responses.
A real QueryObserver test checks that switching keys does not auto-fetch and
validation does not advance data observation timestamps. Real repository tests
check immutable Diff reuse and mutable edit detection. `verify-ui.mjs` exercises
the actual isolated Paseo bundle, measures warm switching and idle Git/RPC counts,
and verifies edits, foreground return, reload and backend recovery.
