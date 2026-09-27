# Observation metadata and cache I/O

Continuous switching across the real project exposed a second bottleneck after
Git scheduling was separated: record validation performed repeated synchronous
path checks, and cancelling/completing activity scans synchronously flushed and
renamed the derived time index. A slow filesystem could therefore stop health,
version and roster responses along with the selected repository's read.

Actual process samples on the real worktrees captured `lstat`, `fsync` and
`rename` on the backend's main thread. One complete three-second sample remained
in synchronous rename. This is evidence of storage blocking, not Git queue wait.

## Read-only metadata

`ObservationRecords` owns one lazy worker thread per project backend, at most 32
distinct pending reads, and coalesces identical requests. Selected context reads
take priority over queued background metadata reads. The worker executes the
existing `Workspaces` validators, including canonical paths and boundary checks.
Canonical resolutions are shared only within one read operation, never across
requests or for a durable mutation.

Roster/orphan/discovery observation runs in that worker as well. Completion
notifies the existing roster version; mutations invalidate its orphan scan.
The reader performs no Git commands and creates no second project writer or
project lease. Workspace lifecycle and Git mutation validation remain with the
original owner. Worker failure rejects readers; shutdown terminates its owned
thread. The new worker entry is required by archive validation.

Already validated repository paths avoid repeating synchronous resolution on the
main thread. Activity scanning and watcher initialization use asynchronous path
resolution; version token lookup only reads memory.

## Derived data persistence

`DerivedJsonWriter` uses asynchronous temporary-file writes, sync and rename.
There is one active write and at most one replacement snapshot; the latest value
supersedes queued intermediate values. Cancelling a scan does not wait for disk
storage before another scan or a foreground request can proceed. Shutdown flushes
the latest snapshot. Persistent observation-cache shutdown also writes
asynchronously.

These helpers are only for recomputable caches. Durable workspace records and
mutation journals retain their existing writer and recovery rules.

## Evidence

- `observation-storage.test.ts` blocks a real record read with a temporary FIFO
  while health and the event loop remain responsive. It also checks merged reads,
  coalesced slow writes and atomic file replacement.
- `.local/verification/switch-cold/run-L3Qdgr` contains the baseline profiles.
- `.local/verification/switch-cold/run-EIju4a` contains the after-change cold-cache
  run: 22 switches across 16 real workspaces, with independent records/cache and
  management disabled. Every selected repository roster appeared; maximum 225ms.
- The after-change run still had one 500ms health probe timeout. Its subsequent
  sample showed an idle main thread. This does not prove every historical timeout
  has been eliminated.

Daily-cache backups are kept under `.local/verification/switch-cold`; original
workspace files, branches and durable records were not cleared. UI reproduction
uses a separate host because the daily host disallows additional web origins.
