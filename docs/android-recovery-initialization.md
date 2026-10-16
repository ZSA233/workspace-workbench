# Native recovery registration failure

## Cause and reproduction

The recovery UI added an eagerly constructed `RecoveryClientStore` class before
Workbench registration and before client diagnostics were configured. A failure
there prevented every Workbench entry from registering and left only the outer
`registration` error in the client.

Evaluating the former production store with the host's ES2020 / async-lowering
settings in the installed React Native Hermes engine reproduced
`Cannot read property 'prototype' of undefined` at
`new module.RecoveryClientStore(...)`. The probe used a large source string and
lazy source evaluation, with a substitute schema boundary. It loaded neither
Prism nor icon implementations. This identifies a recovery-state construction
regression; it does not establish that every class or every Hermes build fails.

## Implementation

- Recovery state now uses a factory and closure-owned state. Its existing shared
  observation interval and request coalescing remain; start and cleanup are
  idempotent, late responses cannot publish after cleanup, and queued reads are
  not dispatched after unload.
- Diagnostics are configured before registration. Individual stages retain a
  bounded message, stack and client generation through the existing diagnostic
  RPC. The client generation is `init-v18-native-recovery-registration`.
- Core Workbench and optional recovery UI own separate registration scopes.
  Partial setup rolls back in reverse order; a cleanup failure does not skip the
  remaining removals. Recovery UI failure preserves core browsing and Diff.
- The recovery screen body loads only when a screen or status pill opens.
  Registration does not initialize its forms, native controls or render hooks.
  Backend recovery authorization and message delivery are unchanged.

## Verification boundaries

`client-registration.test.ts` evaluates the actual compiled client entry in a
Node VM with real SDK/schema modules and substituted host APIs. It checks
partial failure, missing host capability, cleanup, repeat loading, diagnostics,
late responses and lack of eager DOM/UI access.

`native-registration-runtime.test.ts` evaluates the production recovery state
and the actual compiled client entry in Hermes, including repeated registration
and cleanup. Its host and schema substitutes isolate source evaluation; they are
not Android rendering or real RPC evidence. Missing Hermes executables produce
an explicit skip.

Actual-host verification uses `verify-live.mjs` with an isolated home and project
registry. Web UI checks are separate from native-engine checks. Android device
appearance, interaction and reconnect acceptance still require a real device;
no native device was connected during this investigation.
