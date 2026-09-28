# Android observation initialization failure

## Evidence (2026-09-28)

The daily host's Android client diagnostic at 07:09:05 and 07:09:36 UTC
reported `Cannot read property 'prototype' of undefined` at
`useRepositoryRefresh (:2179:71)`. The live plugin catalog bundle maps that
line to `new RepositoryRefreshClient()`. Registration had already succeeded.
This failure occurs during rendering, before the refresh request is dispatched.

Evaluating the corresponding live bundle modules with the installed React
Native 0.81.6 Hermes executable reproduced the same exception. Removing only
inheritance was insufficient. The observation coordinator's construction also
reproduced the exception under dynamic source evaluation. These results do
not establish that every Hermes version or every class expression fails.

## Change

The Diff reader, repository refresh adapter, observation coordinator and
subscription controller now use factory functions and closure-owned state.
Request identity, cancellation, deadlines, shared polling and cache publication
remain shared. No Git timeout or refresh frequency was increased.

The client initialization identity is `init-v15-native-observation-factories`,
so subsequent reports can distinguish the fixed bundle from an older client.

## Verification scope

`tests/native-refresh-runtime.test.ts` bundles the production modules with
the host's ES2020/async-lowering settings and evaluates them in Hermes. It
exercises lazy loading and repeated reader construction plus coordinator
construction/cleanup. A large-source fixture selects the lazy evaluation path
used by the plugin bundle. Node tests separately exercise asynchronous request
and scheduling behavior.

The Hermes test runs using the local React Native macOS executable or an
explicit `HERMES_BINARY`. Environments without an executable report a skip;
they must not be described as native runtime verification.

No Android device was connected through ADB during this investigation. Hermes
execution is native-engine evidence, not an Android UI acceptance test. The
daily plugin was not reloaded and no version was published by this change.
