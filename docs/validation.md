# Workbench validation

The integration remains in parallel validation. Existing integrations must not be retired until
their owner accepts the public plugin in the actual Paseo client.

## Implemented boundaries

| Area | Implementation and evidence |
| --- | --- |
| Navigation | Global surface, Explorer workspace/Agent panels, workspace header button and subscription cleanup |
| Selection | Saved selection before identify, managed paths before live root, independent filters, settings conflict retry and in-process preference notifications |
| Layout | Separate navigation, repositories, graph, changes, review and Agent components; two resize handles; bottom changes section has no resize handle |
| Git | Root/merge commit Diff, renames, untracked files, refs and graph pagination; isolated Git regression fixtures |
| Review | Real target relations, counts, overlaps, issue propagation and per-repository brief; fixture UI selection and expansion |
| Files | Workspace/scope-aware tab identities, active-neighbor closing, Split/Unified, syntax highlighting, overview rail and hunk navigation |
| Cache | Bounded L1 and SQLite snapshots, bounded background workers, partial merging, durable invalidation, corruption fallback and restart tests |
| Lifecycle | Request identity, process lock, creation journal, rollback evidence, cleanup preview, dirty/identity rejection and retained history |
| Runtimes | Optional mise provider, explicit prepare, direct runtime version verification and fail-closed runtime lookup |
| Agent | Optional capability, persisted handoff, placement verification, concurrent request coalescing and guarded reuse |

## Repeatable checks

```sh
PYTHONPATH=src python3 -m unittest discover -s tests
PYTHONPATH=src python3 tests/benchmark.py
cd paseo-plugin
npm run typecheck
npm test
```

The validation run passed 15 Python tests, 7 plugin tests and TypeScript checking. The consumer
adapter passed its two configuration tests. Git operations in fixtures affect temporary repositories only.

The ten-repository benchmark performed 100 warm detail reads: approximately 369 ms for cold detail,
1.03 ms median / 1.06 ms P95 for warm reads, 123 ms to observe a new untracked file, and 1.33 ms to
restore a snapshot after reopening the service. This benchmark uses a 0.5-second TTL; the production
default is 3 seconds. UI polling adds its own delay. These are local fixture measurements, not a latency SLA.

## Rendering evidence and remaining acceptance

Actual panel components were rendered with fixed data in a React Native Web harness at 420, 480,
720 and 1440 pixels in light and dark themes, alongside the reference implementation. Host icons,
settings and RPC were substituted by fixture adapters. Review selection/brief expansion, section
collapse, file opening, narrow Unified layout and middle-click tab closing were exercised.

This does not establish pixel equivalence or native-client acceptance. The original design sketch
and the actual Paseo Explorer placement, conversation switching, native rendering, clipboard,
drag gestures and persistence across a real client restart still require client-side acceptance.
Live Agent creation and real runtime installation were not performed during fixture verification.

The consumer preview deliberately enables live-source observation only. New managed manifests,
runtime preparation and Agent delegation are separate capabilities; existing consumer records are
not imported automatically. Runtime fixtures verify their contracts without changing existing workspaces.
