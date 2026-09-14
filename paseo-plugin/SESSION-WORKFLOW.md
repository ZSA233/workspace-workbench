# Workspace sessions and coordinator review

The coordinator delegates implementation to the bound Workspace worker. A successful
`workbench_workspace_execute` returns `nextAction: end_turn`: announce the handoff
and end the current turn. This is model guidance, not a filesystem permission boundary.

## Session tools

All tools address a `workspaceId`, not arbitrary Agent IDs. MCP callers must be the
original coordinator. UI callers use the same server service through the host RPC.

- `workbench_session_status`: worker/turn, coordinator identity and review phase.
- `workbench_session_message`: required `requestId` and `text`; optional registered
  `attachments` and `behavior` (`steer` by default, or explicitly `interrupt`).
- `workbench_session_history`: public messages and compact tool metadata; default
  20 entries, maximum 100 and 32 KiB, with an opaque epoch/sequence cursor.
- `workbench_session_wait`: one bounded wait, at most 30 seconds. Do not loop automatically.
- `workbench_session_stop`: explicitly cancel the worker turn and inspect confirmation.

Reuse the same request ID when checking a message after a timeout. Different content
under that ID is rejected. An accepted message is not proof that the worker read it.
Uncertain delivery is checked against recent history, never automatically resent.
Supplements and registered references are retained for subsequent reviews. They do
not change repository scope or the host permission/planning mode. Stop an active
review before requesting further implementation.

## Review routing

New review flows default to `review.reviewerTarget: "coordinator"`; choose
`"independent"` in review settings to use a separate read-only Reviewer. Existing
flows retain their original routing. The existing `manual`, `automatic`, and `off`
settings continue to control whether/when review starts.

Automatic review waits for the worker's `ready_for_review` report and completed
turn. Manual review waits for the Review button. The coordinator queue checks
idle state on turn completion and every 15 seconds, without invoking a model while
waiting. Each coordinator receives at most one outstanding review request.

The request supplies `workspaceId`, `sessionId`, `round` and `assignmentId`. Call
`workbench_review_read` to accept the assigned round, then `workbench_review_result`
with a structured result referring to the supplied snapshot/diff. Review time starts
at acceptance. Only a completed matching turn finalizes a candidate result. Code
changes invalidate the old snapshot; repairs remain the worker's responsibility.

The coordinator retains its own model and permissions. Read-only behavior is an
instruction; snapshot checks reject changed code but do not prevent writes. Paseo
does not provide atomic idle-and-send, so `steer` and explicit acceptance handle
the race with new user input without intentionally interrupting that turn.

While waiting, use **Use independent Reviewer** to switch this round. Stop an
already-delivered review first. Stopping coordinator review revokes its authorization
without canceling unrelated coordinator work. Later rounds follow the configured
target. Missing/archived coordinators do not trigger an automatic fallback.

## Verification

Run typecheck, the session/MCP/orchestration/review tests, and `scripts/verify-live.mjs`.
The live script uses an isolated Paseo home and registry and checks real RPC
authorization boundaries. By default it does not invoke a real model; mocked
lifecycle tests verify the state machine, not model compliance. Run
`WORKBENCH_LIVE_AGENTS=1 node scripts/verify-live.mjs` for a real Codex inspection
handoff and coordinator review in the temporary project. It consumes model usage
and requires an available authenticated Codex provider. `WORKBENCH_LIVE_MODEL`
optionally selects the model. The report distinguishes model evidence from RPC checks.
