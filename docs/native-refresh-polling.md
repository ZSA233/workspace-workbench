# Native refresh polling stall

## Reproduction

The Android screenshot showed summary, graph and changes still running while
the graph displayed an empty-result message. A Hermes dynamic-source test of
the production observation coordinator reproduced the stalled lifecycle:
three active queries each fetched once, an inactive query followed them in the
iteration, all three active entries remained `running:true`, and no timer was
scheduled. The same coordinator's ordinary Node tests had passed.

The asynchronous completion callback was created inside a loop. In this Hermes
evaluation path it used the wrong loop-local entry when releasing `running`.
This prevented subsequent task polling and could leave the last running snapshot
on screen even after the backend task ended or its subscription expired.

## Change

Each query is dispatched by `runQuery(q)`, giving its entry and completion
callbacks their own function scope. There is no platform-specific timer or
additional polling loop. The Hermes regression now verifies that all active
queries poll to completion independently, including when an inactive query is
last in the list.

Graph and change-list loading indicators now follow their refresh-task regions,
rather than disabled legacy query fetch flags. Empty-result labels require
actual graph/change data. Cached content remains visible during refresh.
Client identity is `init-v17-concurrent-query-polling`; graph diagnostics include
project, workspace, repository and node count.

## Evidence and limits

- Hermes before: calls `[1,1,1,0]`, all active entries stuck running, no timer.
- Hermes after: each active query completes two polls, all running flags clear.
- Type checking and all 355 tests passed, including native runtime execution.
- A real read-only refresh of `example-workspace/server` returned a ready graph
  containing 31 nodes after about 1.1 seconds of tracked reading. This was not a
  cold-cache benchmark or an Android UI measurement.
- An earlier diagnostic read also hit a control-request timeout. That transient
  backend/host delay remains separate from this proven frontend lifecycle bug;
  this fix does not claim to eliminate every Git or host timeout.

No branch/worktree mutation, version bump or release is part of this fix.
