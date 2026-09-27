# File reads and background observation

The UI and legacy Diff RPC share the per-project content reader and task registry.
No Agent MCP tools were added. Workspace creation, deletion and write recovery are
unchanged. The existing Diff viewer remains the presentation layer.

## Ownership

- `server/backend/file-diff.ts` computes a selected file patch, with literal
  pathspecs, parent-boundary validation, no external diff/textconv and bounded
  output collection. It never calls whole-repository `files()`/`numstat`/`status`.
  Rename discovery can use a bounded names-only lookup. Untracked symlinks show
  link text without opening their target. Working, branch, root/merge commit,
  deleted and binary files use the same comparison semantics.
- `diff-content.ts` resolves workspace identity, captured source versions and
  cache keys. It checks cached content before preparing a watcher. Watcher setup
  is background Git work, not a dependency or an interactive-priority task.
- `diff-read-tasks.ts` owns work, deadlines and subscriptions. Consumers have
  separate request identities; an uncertain start response is retried with the
  same identity. A changed source snapshot cannot retarget an accepted request.
  A cancelled cache flight is drained before its replacement starts.
- `git-scheduler.ts` owns the shared four-slot queue. Ordinary read work is capped
  at three slots; interaction can use the reserved capacity. Five-second aging
  prevents starvation. Mutation scope preserves write ownership, and writes are
  never killed to make room for a file click. Slots survive cancellation until
  the process `close` event.

## Internal protocol and budgets

`repository.diff.read` accepts `start`, `status` and `release`. Responses include
protocol, worker generation, task/request identities, queue/running/ready/failed/
cancelled state, phase, acceptance time and absolute deadline. Start waits at most
100ms for a fast result; control RPCs have a 2s bridge budget. A task has a 30s
absolute budget including its queue wait; individual Git commands also respect
lower configured Git limits. Legacy `repository.diff` waits on the same registry
with its caller's original deadline and releases only that caller's subscription.

The registry caps unfinished tasks at 32, retained tasks at 128, total request
identities at 512 and consumers per task at 32. Result payloads share existing
cache values rather than creating a second persistent cache. Finished task
registrations expire after release or at most 60 seconds.

Only the observation coordinator schedules UI status reads: 250ms, 500ms, then
1s while a visible file is pending. It does not start the computation repeatedly.
Terminal file failures require an explicit retry; a lost backend generation gets
one recovery attempt. Native retains its existing no-version-poll policy while
using the same pending-read scheduler. No separate UI timer loop was added.

Departure releases the consumer, queued work cancels immediately, and running
work without consumers gets a 2s grace period. A 15s consumer lease bounds lost
connections. Successful contents stay visible across refreshing and read errors;
late responses remain scoped to their original file key. Window focus and actual panel intersection gate
subscriptions and the spinner (the host may retain hidden mounted panels); waiting for retry is not represented as running work.

## Statistics and diagnostics

Untracked statistics use asynchronous 64KiB chunks, two file slots, a 1MiB
first-pass file limit and 4MiB first-pass aggregate budget. Deferred jobs are
bounded to 32, yield between chunks and have cancellation/deadlines. Statistics
also pause between chunks while an interactive Git read owns an execution slot. Unknown
counts/binary classification stay null; incomplete directory/repository totals
are hidden. File statistics cache identities include inode, size and mtime.
List parsing uses path indexes and yields between batches instead of quadratic
searches. Completed statistics invalidate the affected repository only.

Backend status advertises reader protocol and plugin/backend build generations.
The client reports its compiled reader build; old services fall back to the
legacy RPC without affecting Agent creation. Diagnostic rings capture click-to-
visible time, read/bridge identities, job phases, queue time, bytes, cancellation,
merge counts and 30s event-loop-delay windows. Click records stay in a bounded
in-memory ring and do not print paths, patches or every successful status poll.

## Verification

- `tests/diff-read.test.ts`: real temporary Git repositories and controlled task/
  cancellation tests, including output boundaries, multiple consumers and lost
  responses. Coordinator tests cover pending cadence and terminal-error behavior.
- `scripts/verify-diff-performance.mjs`: isolated 20,000 tracked / 500 changed /
  32MiB untracked fixture; idle and three-background-reader cold timings, plus
  assertions that selected-file reads do not scan unrelated file content.
- `scripts/verify-ui.mjs`: actual isolated Paseo desktop UI, cold/cached file-click
  latency, multiple tabs, foreground return, reload, backend crash and commits.
  `WORKBENCH_UI_PERFORMANCE_ONLY=1` runs the focused performance portion after the
  normal host lifecycle checks; the default retains the complete UI regression.

These tests do not establish that every historical timeout has the same cause.
Real-machine sampling is read-only and reported separately from isolated fixtures.
No daily plugin reload, version increment or publication is part of this change.

The coordinator explicitly reconciles pending results after discarding a duplicate
initial fetch from QueryObserver. Without that transition, a completed backend
read could remain invisible until the next version check. A deterministic test
and the large-repository UI checks cover this race.

The live harness uses asynchronous CLI reload/disable calls so its own WebSocket
client and diagnostic streams continue being serviced during lifecycle checks.

Large web change lists render only their visible row window plus overscan after
200 rows. The existing row heights and styles are preserved; spacer heights keep
scroll range intact, and browser scroll anchoring is disabled for this subtree.
Small lists and native views retain the existing rendering. Large web lists keep
a bounded inner scroll viewport even when the panel uses outer scrolling; they
must not fall back to mounting every file when section allocation changes.
This addresses a measured UI stall during bulk fixture changes independently of
Git latency. Hidden panel queries are disabled, so another visible panel sharing
the coordinator cannot keep their observations active.

File rows use path identity, not Git status, as their React key. A transition from
untracked to modified must not destroy the pressed row. A bounded row-click
diagnostic records whether repository/workspace context was available without
recording the file path. The UI performance harness records the browser's actual
pointer event; Playwright's pre-input scrolling/layout wait is retained separately
as `fileActionabilityMs`, rather than counted as backend/file-open latency.
