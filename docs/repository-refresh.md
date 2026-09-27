# Current repository refresh and prewarming

Version remains 0.4.10. These changes do not reload or publish the daily plugin.

## Ownership and cache policy

`RepositoryRefresh` owns one captured Git read generation for summary, graph and
change names. `SnapshotGit` shares identical command promises between those
regions. Regions publish independently into the existing observation cache;
optional line statistics publish afterwards. Graph decorations enumerate refs
without `--merged=HEAD`. Working change discovery reuses status candidates.

The internal `observer.refresh` start/status/release protocol uses the existing
file-read task registry, its absolute deadline, subscriptions, cancellation and
bounded admission. It is not an Agent MCP tool. `repository.summary` and legacy
graph/changes requests use the same producers. Manual requests have a distinct
identity so they cannot join a snapshot captured before the click; retries of
the same manual identity still merge.

The panel consumes independently published results through React Query. Its
shared observation coordinator owns pending status polls and version validation.
There is no additional refresh timer loop. Summary roster loading does not wait
for other repositories, runtime setup or Agent information. Even the menu action
must not await a full workspace detail request before starting current-repository
work.

Gitlink pointer details are a separate bounded background supplement to the
roster. The initial rows do not wait for it; subsequent results include the
committed, indexed and checked-out child pointers. Its reads are cancelled at
shutdown and use the existing observation cache and Git queue.

After the selected repository, the visible panel sequentially prewarms up to ten
other repositories in the current workspace. Watcher changes can prewarm leased
repositories again. A click can promote an existing queued prewarm rather than
duplicate it. Background work occupies at most two of four Git slots; ordinary
observation can use a third, leaving capacity for a file read. Writes retain
their existing ownership and are not preempted.

Successful snapshots persist in the existing bounded backend cache. Reopening or
restarting returns those contents before watcher initialization and Git checks.
A new backend generation still validates them: showing retained content is not
proof that it is current. A matching version reuses content without Git work;
age alone does not demand recomputation. Frontend leaf caches receive successful
group validation timestamps without changing content observation timestamps.

Departure releases subscriptions. Optional statistics have separate owned abort
signals and are drained at shutdown. Older producers cannot replace newer
snapshots or publish after cache invalidation. A manual refresh past five seconds
remains explicitly unfinished; background statistics do not hold the top spinner.

## Process cancellation boundary

A Git spawn can fail before acquiring a PID, for example when a workspace has
just disappeared. Cancellation must never call `ChildProcess.kill` in that state.
The process wrapper rejects already-aborted requests before spawn and only kills
positive owned PIDs. A detached subprocess regression verifies this without
putting the test runner's process group at risk.

Backend startup diagnostics distinguish no health response from a responding
process with a mismatched version/identity. Status retains the last startup
failure while reconnecting instead of discarding it behind a generic state.

## Reproducible validation

- `tests/repository-refresh.test.ts`: shared commands, independent publication,
  retained snapshots after restart, manual-generation isolation, zero-Git cached
  reuse, validation propagation and prewarm promotion under occupied capacity.
- `scripts/verify-refresh-performance.mjs`: six groups of 20 backend samples
  using isolated copies of five real repositories on the same disk. No original
  refs, working files or registry entries are modified.
- `scripts/verify-refresh-ui.mjs`: actual isolated Paseo and its bundled webpage;
  20 pointer-triggered refreshes verify the newly committed subject, HEAD and
  changed-file content, then 20 switches across five prewarmed repositories.
- `scripts/verify-live.mjs`: actual plugin reload, stable MCP URL/headers, worker
  crash recovery and unload. Model Agents are a separately opt-in test.

The fixtures use frozen plugin copies with recorded fingerprints. Shared source
Git objects are read-only; all test commits and refs belong to isolated clones.
Application-cache cold samples do not flush operating-system file caches.

Latest local evidence is in `.local/verification/panel-refresh/`. Backend timings
must not be presented as click-to-visible timings. First-ever filesystem/index
warming can be much slower than repeated reads, and historical timeouts without
matching traces remain unattributed.
