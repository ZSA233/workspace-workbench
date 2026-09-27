# Connection and request lifecycle

Paseo endpoint normalization is a pure shared function. Reading `paseo.pid`
belongs to the server runtime; shared plugin bundles must not import Node file
system APIs. MCP, the plugin host connection and Reviewer cancellation use the
same parser. Wildcard bind addresses connect through loopback.

HTTP and stdio use `shared/request-scheduler.mjs`. Business calls have four
active slots and sixteen queued slots. Discovery uses a separate bounded lane.
A request deadline includes queue time. Cancellation responds once, and an active
slot is retained until the handler and its owned cleanup settle. An expired queued
request never dispatches. An expired dispatched mutation is uncertain and must be
reconciled with its durable identity before retrying.

MCP connection probes inherit their caller's deadline and cancellation. The
observation bridge forwards an absolute deadline to the local backend; its
independent Git priority scheduler remains responsible for Git admission.
Background cache refreshes retain their own bounded lifetimes.

Gateway readiness probes are single flight. A missing Paseo endpoint does not
terminate a listening gateway. Process exit recovery retains the saved URL/key.
Host endpoint replacement retires the old connection; requests already dispatched
through `HostConnection.run` finish before it is disposed. New work uses the new
endpoint. Callers retaining a raw `api()` handle must not assume it survives a
host endpoint replacement.

Diagnostics expose current-generation events separately from history. Bridge
failure samples are bounded and omit request arguments. Historical timeout
counts alone are not evidence of a current incident.

CI and Release call the same verification workflow. Release tags do not trigger
a second CI run. Publication consumes the exact archive produced by verification,
with checksums, and remains blocked on validation failure. Do not automatically
retry failing tests to turn a release green. The HTTP queue test holds RPCs through
a test-only preload fixture; production has no delay flags or test RPC routes.
