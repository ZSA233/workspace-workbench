# Android client investigation

**October 21 device evidence:** an Android device is now connected. Historical
ANRs show severe Java heap pressure and repeated Hermes Intl/ICU frames in both
Paseo 0.11.2 and 0.12.0. This changes the investigation beyond plugin startup
work; see [the device findings](android-device-findings-20261021.md). The
no-device limits below describe the earlier investigation, not the new capture.

## Evidence and limits

The October 20 host log contained 24 Android plugin initializations using
`init-v18-native-recovery-registration`. Their core and recovery registrations
completed; the existing narrow render-error hook captured no Android exception.
Those records cannot distinguish app restarts, reconnects or native crashes.
No Android device was attached to ADB, so there is no device crash, ANR, exit-reason
or memory evidence yet. Host heap figures in daemon metrics are not phone memory.
The user's normal plugin was already disabled and remains disabled.

The first mitigation (`init-v20-native-demand-only-recovery`) passed its
controlled tests, but the user reports worse freezes with that bundle. New host
diagnostics confirm Android actually loaded v20; it was not merely a test against
an older cached generation. Successful registration and desktop/Hermes tests did
not establish that Android performance improved. The user identifies the period
before October as usable, so the regression window includes earlier October
refactors and UI changes, rather than assuming recovery is the root cause.

The user reports that disabling the plugin removes frequent freezes and crashes;
enabling it restores them. Recent code adds a plausible global interference path:
the recovery client polls the full session list every five seconds, publishes
fresh snapshots even when no values change, and registers a composer pill for
every session. These tasks run without opening Workbench or the recovery page.

Read-only inspection of the installed Paseo 0.11.0 client bundle confirmed that
`PluginButtonStore` publishes one shared array to all subscribers on every button
add/update/remove. Its consumer hook subscribes to that entire array before
filtering by workspace/agent. Recovery button updates therefore also notify
unrelated chat consumers. Core Workbench's per-workspace header registration
predates recovery and contributes another startup burst. This confirms avoidable
global work; it does not prove an Android OOM, ANR or native crash cause.

## Controlled comparison

The actual compiled plugin entry from each revision was evaluated against the
installed host's `PluginButtonStore` and `buttonMatches`, using Node VM host/React
substitutes, a deterministic clock, 248 workspaces, 53 sessions and 20 unrelated
button consumers. One session's status changes every ten seconds. No recovery
page is mounted during the 60-second run.

| Work in the controlled Android run | Sep 28 (`ea9096e`) | Before recovery (`833ca4f`) | Published 0.5.1 (`c0185ff`) | v21 isolation |
| --- | ---: | ---: | ---: | ---: |
| Recovery list requests, including startup | 0 | 0 | 13 | 0 |
| Per-session composer pills | 0 | 0 | 53 | 0 |
| Shared host button broadcasts | 248 | 248 | 307 | 0 |
| Entries scanned by unrelated consumers | 617,520 | 617,520 | 945,140 | 0 |
| Recurring plugin timers after startup | 0 | 0 | 1 | 0 |
| Client diagnostic RPC requests | 19 | 17 | 45 | 1 |

All revisions leave zero timers after unload. The first v20 mitigation still
registered 248 headers and broadcast 248 updates; v21 removes that path on
Android. It preserves one bounded installation-policy diagnostic.

Compiled sizes grew from approximately 0.89 MB on September 28 to 1.04 MB on
October 6 (`bc6a562`), 1.23 MB before recovery, and 1.27 MB at 0.5.1. Therefore
recovery is not the only addition in the user's regression window. The October
native diff syntax/continuous comparison changes operate after panel loading;
the v21 Android entry also stops eagerly importing native control inventory.
Dynamic imports defer module initialization; they do not remove its source from
the host's single client bundle, which remains about 1.26 MB. The comparison does
not establish device parsing cost, render cost or memory usage. Reports are
available locally at `/tmp/workbench-october-client-comparison.json` and the
preserved v20 comparison `/tmp/workbench-october-client-comparison-v20.json`.
These are work counts, not
Android frame timings, memory measurements or a reproduced device crash.

## Changes

- Android skips recovery module initialization entirely: no recovery surface,
  sidebar, settings screen, command, composer pill, state store, AppState listener
  or timer. Backend recovery remains enabled for eligible sessions independently
  of the device opening them. Recovery settings remain accessible from web/iOS.
- Android ordinary chat also skips the workspace directory read/subscription and
  all per-workspace header registration. Workbench surfaces, commands and file
  panels remain. Mounting Workbench performs one shared paginated directory read
  without subscribing; closing its final view releases snapshots and discards
  late responses. Pagination supports modern `workspaceDirectory` and legacy
  `directory` fields and rejects missing/repeated cursors.
- Android never intercepts the host's console or global error handler and has no
  health sampling timer, including inside Workbench. Routine telemetry returns
  before formatting/deduplication. One `android-client-policy` event records
  `init-v21-android-server-only-recovery`; explicit plugin failures are retained.
- Web retains recovery pills; iOS retains its demand-only recovery screen/agent
  command and batched workspace headers. Both retain their recovery controls.
  The non-Android workspace stream now releases its SDK-owned subscription on
  unload, even if its initial response arrives late. Panel import callbacks
  remain stable across rerenders.
- Actual-host acceptance exposed two event-order races: an async `turn_started`
  handler can finish after failure admission or successful recovery completion.
  The delayed start could cancel recovery or reset its successful status and
  attempt identity. Starts matching the known failed/completed recovery turn are
  now ignored; different user turns still cancel/reset as appropriate. Message
  and native recovery each have regression tests which failed before the fixes.
- Routine client diagnostics use batches of at most 16 with one RPC in flight
  and a 64-event queue. Fatal/error evidence dispatches immediately with a separate
  bounded concurrency limit. Telemetry is best-effort and never retried.
  Successful registration diagnostics use informational logging rather than
  triggering the native error-console path.
- iOS diagnostics retain panel-scoped responsiveness samples and fatal error
  forwarding without serializing arbitrary React/host objects. Diagnostic
  deduplication is bounded to 256 keys.

## Read-only device capture

Connect a USB-debugging-authorized Android device, then run:

```sh
node paseo-plugin/scripts/collect-android-diagnostics.mjs --duration 30
```

Reproduce the freeze during that interval. Output defaults to a private temporary
directory. The script prints the directory containing `report.json`, app-scoped
logcat and crash-buffer output, Android exit reasons, memory and frame statistics,
plus host/plugin status and recent Android client diagnostics. It reads the host
log again after reproduction to include the newest client events.

Use `--serial SERIAL` for multiple devices or `--package APP.ID` when automatic
Paseo package discovery is ambiguous. `--host-only` captures host evidence without
ADB. Missing devices, unsupported Android commands and exited app processes are
reported explicitly. The script does not clear logs, enable plugins, launch or
stop the app, restart Paseo, or change device settings. If no app PID can be found
before or after capture, app logcat files cannot be collected; exit-info may still
retain the system's last termination reason.

## Verification boundaries

Node VM tests execute the actual compiled Android entry with APIs that throw if
global Workspace listing/subscription, recovery or shared chat-button registration
is attempted. Multiple enable/unload cycles leave only Workbench contributions
and one policy event per generation; no timers, recovery contribution, global
error hook or eager injected native control imports are allowed. Android context
tests cover on-demand pagination, observer leases, cancellation, late responses
and snapshot release. Separate iOS tests retain header batching and the recovery
agent action; web tests retain pills and verify owned stream cleanup.
Controlled-clock tests cover observation foreground/demand, registration time
budgets, telemetry bounds, fatal forwarding and read-only ADB commands. Hermes
tests evaluate production code through lazy source loading. These are runtime and
contract tests, not Android rendering, device memory measurements or proof that
the reported crash is resolved. Actual-host acceptance uses only isolated Paseo
homes and protocol fixtures; the user's normal plugin is not enabled or reloaded.

Actual-host acceptance also creates and recovers a new Codex session without
recovery list/get polling, a recovery UI or `retryNow`. It uses a local Codex
protocol substitute and the actual plugin/host, rather than a real model.
Desktop recovery UI acceptance uses the existing Playwright flow; this does not
exercise native Android rendering. The in-app Browser runtime reported no
connected browser. Existing host evidence was saved to
`/tmp/workbench-android-investigation/report.json`; Android status was
`not_connected` and the normal plugin remained disabled. No version bump,
publication, normal plugin enable/reload or host patch is part of this change.

The previous v20 validation passed all 632 Node tests and desktop/host acceptance,
but the user still observed severe Android freezes. v21 validation must be
reported separately; neither these controlled tests nor desktop acceptance can
establish that the device freeze is fixed.

v21 local validation passed TypeScript checks, all 641 Node tests (including
Hermes engine execution), actual-host recovery with a Codex protocol substitute,
and the desktop recovery flow with zero page errors. The first desktop attempt
stopped before browser launch when the late-success start race reset a completed
episode; it was reproduced with failing unit tests and fixed before the final
passing run. Evidence is retained at `/tmp/workbench-android-isolation-tests-final.log`,
`/tmp/workbench-android-isolation-typecheck-final.log`,
`/tmp/workbench-android-isolation-full-tests-final.log`,
`/tmp/workbench-android-isolation-host.log`, and
`/tmp/workbench-android-isolation-ui-final/`. These are not Android device results.

## Pre-commit recheck

The pending changes were reviewed again on October 21 before being committed
separately from Paseo Pocket. TypeScript, all 83 affected Node tests and all 641
plugin tests passed. `WORKBENCH_LIVE_RECOVERY=1 node paseo-plugin/scripts/verify-live.mjs`
also passed against an isolated Paseo home and project registry, including recovery
without client status polling. The Codex endpoint was a protocol fixture; this is
actual-host evidence, not a real-model or Android rendering test. The normal plugin
was not enabled or reloaded. Earlier mobile interaction sketches are retained under
`docs/design/android-shell/` with an explicit historical-draft label.
