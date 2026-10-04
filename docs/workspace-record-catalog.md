# Workspace roster timeout follow-up

## Evidence after cc3568d

The deployed backend reported a roster operation lasting **48,832 ms**, with
zero queue time. The Git queue was empty and the service event loop remained
responsive. Splitting supplemental discovery therefore did not resolve the
record reader itself. That earlier change must not be described as a complete
fix for the reported timeout.

A read-only instrumented run of the existing record reader returned 50 rows in
1,041 ms. It performed 51 synchronous JSON reads, taking 965 ms in total;
287 realpath calls took about 4 ms. A subsequent native process sample caught
idle threads after the operation had finished, so it does not identify the exact
filesystem call or OS condition responsible for the historical 48.8-second run.

## Change

`RecordCatalog` reads record files asynchronously with at most four readers.
Unchanged contents are reused only when device, inode, size, modification time
and change time match. Changed/new records are reread and deleted records are
removed. Metadata is checked again after reading to avoid caching a concurrent
write under the wrong identity. Failed batches retain their worker slot until
all readers finish. Non-regular JSON entries are reported as invalid records.

The cache is bounded to 500 entries and 16 MiB. Unknown/history fields remain
intact. `Workspaces.validateRecord` still performs the existing path and schema
checks for every displayed record; mutation reads continue to use fresh records.
Getting the main or a linked workspace no longer enumerates every other record.

Worker diagnostics now include content-read/cache-hit counts, bytes, directory,
file-version and content-read timings, and validation time. No file contents are
logged. Request timeouts and frontend rendering have not been lengthened or
hidden.

## Verification scope

- Unit cases cover concurrency, unchanged-file reuse, updates/additions/deletions,
  concurrent writes, invalid JSON, I/O failures and non-regular files.
- Real-project read-only worker sampling returned 50 records. New workers took
  820, 81, 80, 75 and 83 ms; repeats took 7, 7, 7, 8 and 10 ms. Repeats reused all
  49 unchanged record contents and performed no additional content reads.
- A frozen plugin in an isolated real Paseo instance used copied records and
  the real source paths, with management disabled and a separate registry/home.
  Three backend starts returned the full roster through actual plugin RPC in
  354, 337 and 268 ms; subsequent reads took 10, 10 and 9 ms. Distinct harmless
  request parameters bypassed the bridge response cache. Evidence is retained
  in `.local/verification/switch-cold/run-RnzvrN/report.json`.

Type checking and the full 348-test suite passed. This is actual-host RPC
evidence, not Android UI evidence or an OS cold-cache benchmark. It does not
prove every future storage stall impossible. Daily deployment is checked
separately following the user's authorized commit/reload flow; no version bump
or release is included.
