# Plugin lifecycle ownership

The production implementation is TypeScript. Public RPC names and schema-v1
Workspace records remain compatible. Python remains a legacy protocol oracle.

## Environment and sessions

`runtime-declarations.ts` parses bounded project declarations without executing
configuration. `runtime-observation.ts` asynchronously inspects prepared tools;
`runtime-summary.ts` defines readiness for both installation and observation.
`runtime-layout.ts` owns cache placement. `RuntimeReadQueue` admits two active
observations and 32 queued requests, shares identical reads, and propagates
cancellation. Installation remains owned by durable preparation tasks.

`environment-snapshots.ts` publishes content-addressed files with an exclusive
link. Existing snapshots are never overwritten or automatically deleted. Snapshot
identity excludes observation timestamps. `session-environment.ts` records the
actual default/override ownership in an immutable injection receipt; it stores no
unrelated session variables. A value explicitly set to the former default is
still an override. Unknown legacy ownership remains explicit rather than guessed.
Ordinary creation retains its two-second degradation budget. These descriptions
do not impose a one-session/one-Workspace association.

## Frontend

React Query is the sole business-result cache. `observation-content.ts` retains
last usable content alongside the current protocol response in that same entry;
it must not conceal pending task identity or failure. Hook status bookkeeping
contains no independent response cache. A retained result keeps its original
observation time.

`observation-publication.ts` publishes region results, hydrates placeholder rows,
and applies confirmed Workspace lifecycle outcomes. Leaf read timestamps prevent
older observations from replacing newer content. Aggregate task completion is not
ordered by a retained leaf timestamp: a refresh may reuse one region while
publishing another.

The panel assembles domain controllers:

- Workspace selection/catalog and target-scoped management actions.
- Repository observation and file-view interactions.
- Handoff, review sessions, and settings.

The observation coordinator owns version checks, request coalescing and recovery.
Session-backed regions follow version changes rather than separate polling.
Dropdown activity scans and durable preparation retain their distinct lifecycle.
Selection, expansion and layout are UI state; query results must not reset them.

Workspace action state is keyed by target. Uncertain writes require read-only
reconciliation before another mutation. Opening an inspection does not erase an
uncertain write. Completion reads the latest selection, and an earlier inspection
cannot replace a newer confirmation target.

## Workspace lifecycle

`workspaces.ts` is the public composition boundary. Domain modules do not import
it or call through it:

- `workspace-records.ts`: record encoding, preservation and identity checks.
- `workspace-catalog.ts`: selections and bounded discovery.
- `workspace-directory.ts`: authoritative roster assembly and lookup.
- `workspace-creation.ts`: journaled creation, adoption and scope changes.
- `workspace-activity-guard.ts`: active-operation checks.
- `workspace-removal.ts`: logical removal and restoration.
- `workspace-deletion.ts`: deletion boundaries, recovery and physical cleanup.

Dependencies identify the exact owner methods each module uses. Filesystem,
storage, Git construction and clocks are supplied at assembly. Record publication
precedes derived manifest writes. Failed deletion retains records and history.
Existing deletion authorization, source preservation and process ownership rules
are unchanged.

## Review lifecycle

`agent-review.ts` preserves the external API and assembles the review owners.
Settings, session records, caller authorization, material capture, transitions,
host dispatch, recovery and RPC adapters live separately under `server/review/`.
Dependencies across owners are explicit; no owner imports the public entrypoint.
Runtime monitor and recovery state belong to an assembly, not shared module globals.
The previous internal forwarding entrypoint has been removed.

Storage, filesystem operations, observation calls, identities and clocks are
injectable. The existing automatic-review opt-in remains a product policy: ordinary
browsing must not implicitly start or steer an Agent. Permission mode remains
separate from planning state, and uncertain handoffs are never automatically sent
again.

## Verification

Use type checking, owner contract tests, the complete Node suite, and Linux CI.
`verify-live.mjs` and `verify-ui.mjs` use isolated homes and registries. Freeze the
source before running long host/UI tests; editing files under a running test
instance invalidates its build evidence. `WORKBENCH_LIVE_ENVIRONMENT=1` additionally
runs an actual Agent shell probe against two isolated Workspace directories.

Report actual-host RPC, Agent command execution, web UI, simulated failures and
native-device evidence separately. Automatic change visibility includes the
version-check interval; it is not a cached-click or manual-refresh latency.
