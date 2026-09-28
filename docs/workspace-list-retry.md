# List retry and metadata display boundary

The deployed `f1ea9ae` backend subsequently reported a 21,411 ms roster read,
including 20,065 ms in validation/list assembly, despite content-cache hits.
Making JSON reads asynchronous had not removed synchronous worktree path checks
or the main/linked selection reads from that phase. List response assembly also
called runtime inspection for every workspace.

## Changes

- Main/linked selections use the bounded asynchronous record reader too.
- Roster presentation uses explicit, filesystem-free path normalization and
  structural record checks. Its output conveys saved identities, not verified
  worktree ownership or existence. The existing fresh physical path validation
  remains the default for detail/operation reads, Git and lifecycle actions.
- Roster assembly no longer inspects runtimes for every row. Selected workspace
  detail continues to provide its runtime summary.
- The visible Retry button directly refetches its current QueryObserver with
  `cancelRefetch:false`, rather than depending on coordinator registration or a
  scheduled timer. Concurrent presses merge; the button shows request progress.
- Retry clicks and list state diagnostics include project identity. Client
  revision `init-v16-explicit-list-retry` distinguishes the deployed handler.

## Evidence and limits

Tests replace synchronous filesystem APIs with throwing functions and assert
zero calls across both roster production and list-response assembly. Separate
cases prove that a displayed record cannot authorize a symlink escape, and that
configured in-root aliases retain their display identity. QueryObserver tests
cover failed-list retry with no coordinator and repeated-press coalescing.

A real isolated Paseo instance served a frozen plugin to a real browser. The
fixture held list requests in a structured timeout state, then released that
failure before clicking the actual Retry button. Automatic retry was deferred
in the fixture to distinguish the click from a scheduled retry. Repositories
appeared in 124 ms and the failure text disappeared, with no page errors.
Screenshots/report: `.local/verification/switch-cold/run-5Nm2YK/`.
This is web UI evidence, not Android device acceptance.

The serial full suite passed all 353 tests. The prior parallel suite had two
setup Git validation failures; the setup file passed all five tests alone.
An additional isolated cold-host probe (`run-zgZyo6`) failed during host
readiness, before collecting roster samples; its daemon log includes startup
event-loop delays and a gateway startup timeout. That attempt is retained as a
failure, not counted as successful roster verification.

Type checking and native runtime regressions are checked before deployment.
The current work does not establish that every source of host/OS delay is gone.
