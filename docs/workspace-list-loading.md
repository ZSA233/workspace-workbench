# Workspace list loading (2026-09-28)

## Evidence

The daily bridge recorded two `workspace.list` failures at 07:51:46 and
07:51:53 UTC, both in `backend-response` after 5003 ms. The socket was connected;
this was not merely a phone-side network timeout. Later direct reads returned
the existing workspaces successfully. The historical logs do not identify the
individual filesystem operation responsible for each stall.

The roster worker previously started orphan discovery and waited for it before
reading records. Subsequent discovery callbacks and record reads shared the same
worker, so blocking filesystem work in discovery could also delay later reads.

## Changes

- The authoritative roster worker only reads records. A separate bounded worker
  runs supplementary orphan/repository discovery through the same reader manager.
- Supplementary results are retained and publish roster invalidation on change.
  A late pre-mutation result cannot overwrite the newer supplementary state.
- Pending discovery is marked as a background refresh, allowing the existing
  coordinator to perform bounded follow-up reads. No new UI timer is introduced.
- Health includes active metadata operation, elapsed time, and bounded recent
  queue/execution timings. Bridge failures retain method, request identity and stage.
- UI counts require a successful roster. Initial loading and initial failure
  have distinct states; failure has a retry action. Available cached content is
  retained, including a successfully read genuinely empty list.

## Verification

A worker integration test blocks discovery with an atomic wait while initial
and subsequent roster/context reads complete independently. Existing orphan
adoption tests wait for the separately published discovery result, and still
verify invalid records, partial adoption recovery and successful adoption.

Five read-only samples against the real project returned 48 records including
history: new metadata workers took 1728, 154, 201, 216 and 211 ms; subsequent
reads took 21, 19, 24, 11 and 51 ms. This is worker startup sampling, not a phone
UI measurement or an operating-system cold-cache benchmark. It does not prove
that all filesystem stalls have been eliminated.

The isolated `verify-live.mjs` host run passed. No daily plugin reload, commit
or release is part of this fix.

Final type checking and 18 affected tests passed. The full suite passed all
344 tests with concurrency set to one. The earlier parallel run had six
gateway child startup timeouts; the gateway file alone passed all nine tests.
This suggests load-sensitive startup behavior but does not establish its cause.
Those failed-run logs were retained; they are not reported as a clean parallel
suite. The final scan-notification refinements were covered by the affected and
serial suites, after the isolated host run.
