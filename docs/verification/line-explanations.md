# Line-anchored comparison explanations

Normal text previously accepted `side: "file"` without a location. It did not
discard supplied line numbers: incomplete `old`/`new` ranges already failed.
The permissive file branch let Agents avoid line placement altogether.

New text writes must use captured old/new line ranges. The MCP schema exposes
that requirement, the copied comparison request asks for the smallest relevant
range, and backend validation rejects file anchors on complete text patches with
code lines. Captured line sets are computed lazily and reused within a batch.
Binary, Gitlink, truncated and line-free metadata changes retain file anchors.
Existing schema-v1 records, request retries, user text edits and history remain
available; saved locations are never guessed or silently migrated.

Validation on 2026-10-23:

- Plugin typecheck passed.
- Real temporary Git repositories: 12 backend note tests passed, including
  atomic batches, missing/reversed ranges, deletion/context anchors, exceptions
  and seeded legacy persisted notes.
- MCP/client model and popover tests: 27 passed.
- Full Node suite: 726 passed, no skips. One test belongs to pre-existing local
  Workspace-tree changes that are excluded from the note fix commit.
- `verify-comparison-notes-ui.mjs` loaded the actual plugin in an isolated Paseo
  home and project registry. Authenticated MCP rejected file-only text comments
  and missing ranges without creating notes. A valid line-3 explanation displayed
  its marker and highlight on the actual changed code. Fixed/historical versions,
  copy instructions and six light/dark narrow layouts passed; no page/console
  errors, and the isolated host exited successfully.

The rendered evidence is Chromium on macOS. It does not establish Windows or
Pocket physical-device acceptance. Reviewer findings are a separate mechanism;
this change applies to Workbench change explanations, including branch compares.
