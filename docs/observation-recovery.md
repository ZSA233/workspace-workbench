# Observation recovery (0.4.12 working tree)

## Behavior

Repository refresh failures have an explicit `recovery: repository` classification
in their internal error details. The existing coordinator schedules visible reads
at 5/15/30/60 second backoff; pending-task polls do not reset failure counts or
inherit this backoff. Successful completion resets it. Unsubscription stops
queued work. File Diff and preparation recovery retain their existing policies.

A client deadline is not evidence that a server task ended. Both automatic and
manual recovery reconcile the original request/task identity. Only a confirmed
terminal result or a missing task permits replacement. Permanent errors require
explicit action. Region failures survive transport-level task completion and
cannot validate stale retained content. Healthy regions remain reusable.

Refresh acceptance now registers the bounded task before metadata validation.
Authoritative path checks still happen before Git/cache access. The validated
context is reused rather than sent to the metadata worker twice. Status/release
read the task registry directly. Production control/computation limits are unchanged.

Diagnostics separate start/status/release, request identity, backend generation,
metadata duration, command trace, response serialization bytes/time, and whether
the socket was available for sending. `sent` means written to the socket, not
acknowledged or rendered by the client. No file contents or credentials are logged.

## Verification, 2026-09-28

- Typecheck passed; complete Node suite: 363/363 passed. Final targeted suite:
  55/55 passed. Targeted tests additionally cover recovery
  backoff, hidden subscriptions, partial failures, same-token cache recovery,
  uncertain-task reconciliation, permanent failures, blocked metadata and native
  Hermes execution. See the delivery report for final counts.
- `verify-live.mjs`: actual isolated Paseo host passed. This is not a real Agent
  model execution or Android visual acceptance.
- Frozen isolated web UI build `6ed51bc404cf3f81`: injected Git failure, removed it
  without clicking refresh, automatic recovery in 14,864 ms. The window remained
  open for at least ten minutes, with 39 sampled UI observations and 42 successful
  version checks. An external commit became visible and stayed visible. No page
  errors. Artifact: `.local/verification/switch-cold/run-6B77T2/report.json`.
- That UI run also encountered two control deadline failures and two later missing
  task responses. It recovered automatically; the original scheduling delay is
  not fully attributed. This is evidence of recovery, not absence of timeouts.
- Screenshot project's `guild-ops-report-notifications-20260923` / `halh` was sampled
  through an isolated backend with copied records and separate state. Twenty
  read-only requests: acceptance P95 102 ms, first full result 607 ms, cache hits
  0–2 ms. First metadata read 55 ms; graph region 285 ms, summary 113 ms, changes
  155 ms. These are backend timings, not mouse-to-render measurements. Artifact:
  `.local/verification/recovery-real-TFVUZy/report.json`.

- A separate frozen isolated host injected a 30-second graph stall: operation
  ended at 30,071 ms with an explicit failure, control/status P95 3 ms and health
  P95 3 ms. Artifact: `.local/verification/switch-cold/run-eHkyIj/report.json`.
  An earlier fixture used the default lower Git budget and correctly stopped at
  about eight seconds; it is not counted as the 30-second acceptance run.

Version remains 0.4.12. No commit, publication, or daily plugin reload is performed
by this change. No ordinary project files, refs, or registry entries are modified.
