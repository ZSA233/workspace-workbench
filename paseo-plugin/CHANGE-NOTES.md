# Change explanations

Ask the current Agent to explain meaningful changes against a chosen comparison.
This creates metadata in the plugin's project state directory, not comments in
source files. It does not start another Agent, dispatch a message, or approve code.

## Agent workflow

1. Call `workbench_change_notes_read` with `workspaceId`, `repoPath`, and a scope:
   - `compare`: `comparison: {fromRef, toRef, mode: "endpoints" | "contribution"}`.
   - `branch`: recorded creation base to current HEAD.
   - `commit`: `commitSha` (first parent, or empty tree for a root commit).
   - `working`: a frozen copy of the selected uncommitted file patches.
2. Inspect `result.snapshot.files`. Pagination captures up to four files per page;
   follow `nextOffset`, or specify up to eight `paths` to explain related files in
   one snapshot. Each page is a separate immutable snapshot; never combine anchors
   from different snapshot identities into one write. Use `list: true` and
   `nextOffset` to read existing explanations without running Git.
3. Submit `workbench_change_notes_write` with the same workspace/repository and a
   `batch` containing `requestId`, `snapshotId`, and up to 32 `operations`.
4. Each operation has a caller-stable `id`, `expectedRevision` (zero for creation),
   and `action: "upsert" | "withdraw"`. Upserts supply `content`:
   - `title`, `reason`, `behavior`;
   - `basis: "requirement" | "autonomous" | "missing-context"`, plus `requirement`
     when citing requirements;
   - `perspective: "implementer" | "inferred"`;
   - optional `question` and author-provided `evidence`;
   - `anchors: [{path, side: "file" | "old" | "new", start?, end?}]`.
5. Reuse the exact request ID and content after an uncertain response. On a
   revision conflict, read the current note and explicitly reconcile the edit.
   Never blindly retry with a new request ID.

Explain the requirement and observable behavior, including compatibility changes
and assumptions needing the user's decision. Do not invent a requirement citation
or turn test claims into verified evidence. Group meaningful changes; trivial
formatting does not require repetitive explanations. Indentation and comments are
not automatically trivial.

Only captured patch lines can receive line anchors. Binary, Gitlink and truncated
patches support file-level explanations. Snapshots use bounded file reads (128 KiB
per patch); the Agent must not claim it inspected content beyond truncation.

## Reading and feedback

Files display counts of explanations valid for the selected scope. The speech
bubble filter offers with/without explanations, needs confirmation, and needs
update. Counts are not review coverage. Click the file's explanation icon to open its subject directory, or open the
Diff's explanation menu. Selecting a file does not expand a prose list.

Code markers open a compact floating explanation on desktop; native clients and
web reading regions narrower than 480px use a bottom sheet. Default content is a
title, up to three lines of the original reason, and necessary status indicators.
Details and actions occupy the same popup when requested. A note may link multiple
files. Only one popup is open at once, and it never changes code-row measurements.
Click outside, press Escape, click the same marker, or scroll desktop code to close
it. Unsaved feedback remains in the current file-panel session. Multiple notes at
one location open a subject chooser.
The original saved patch is available on demand. No fuzzy anchor migration occurs.
A changed comparison or file content marks the note as needing update.

Read marks, questions and user confirmation text are separate from Agent-authored
revisions. Reading is not approval; a revision becomes unread. Questions remain
local until the user copies them to a conversation. Copy includes snapshot identity,
comparison endpoints and anchors. If clipboard permission is unavailable, selectable
manual-copy text is provided.

The service observes note revisions through the existing version check; no new
poll loop is added. Opening the explanation menu also refreshes note metadata (no
Git query). A note failure does not block the Diff or clear successful content.

## Storage and boundaries

Records live under the project's `stateRoot/change-notes`, keyed by workspace
creation instance and repository. Workspace schema-v1 is unchanged. Moving to
history/restoring retains notes. Permanent deletion leaves historical metadata;
a same-name workspace cannot adopt it. Records are not automatically pruned.

Snapshots are immutable, writes are atomic and serialized, and old note revisions
are retained. Batches are limited to 256 KiB and 32 operations. Identity comes from
the verified host Agent context. Scoped workers cannot write another workspace;
reviewer tool catalogs do not expose note writes. Agent tools cannot set user
feedback. Existing MCP sessions may need to refresh their tool list after upgrading.

## Verification

`npm --prefix paseo-plugin run typecheck`

`node --experimental-strip-types --test paseo-plugin/tests/change-notes*.test.ts`

`node --experimental-strip-types paseo-plugin/scripts/verify-change-notes-ui.mjs`

The UI script starts the actual plugin in an isolated Paseo home and uses the
injected Agent identity through HTTP MCP. Its fixtures do not modify ordinary
projects or reload the daily plugin. Narrow web layouts do not establish Android
or iOS native-device acceptance.

### Acceptance evidence (2026-10-08)

- TypeScript checks and the 501-test full suite passed; focused notes/MCP tests
  exercise immutable snapshots, current-scope matching, atomic batch rejection,
  concurrent revisions, idempotence, working content, renames, binary/file anchors,
  cross-workspace rejection, withdrawal and independent user confirmation.
- The isolated real-host HTTP MCP/UI check passed, including forged-author and
  invalid-token rejection, denying Agent confirmation, cross-file navigation,
  question persistence, and clipboard contents. Fixture explanations were written
  by the verification script using the injected host identity: this verifies tool
  transport and presentation, not a model's ability to infer correct requirements.
- Actual web layouts at 320/720/1000px retained a 36px toolbar in light and dark
  themes. Existing Diff UI regression checks passed (wrapping, overview targeting,
  file tabs, font settings and code-only selection/copy).
- Two 1003-line warm-cache comparisons, 20 samples per variant per run, measured
  plain-file switching P95 at 319–342ms and collapsed-explanation switching at
  333–420ms. These end-to-end numbers include Playwright click actionability and
  two animation frames; they do not isolate rendering CPU or establish a native
  performance guarantee. Explanation loading begins after Diff content is ready.
- Native Android/iOS bottom sheets, long-press/copy and scrolling/memory remain
  device acceptance items. No daily plugin reload or release was performed.

The real-host harness now compares connection counts before/after its 100 injected
reconnects and checks the plugin session identity. Paseo 0.11.0 has more baseline
host sessions than the old hard-coded total of five; the no-growth assertion is
retained rather than increasing a fixed global session ceiling.

### Compact popover acceptance (2026-10-08)

- TypeScript checks and the 504-test full suite passed after replacing the inline
  card. The actual isolated-host Diff regression also passed.
- The real-host notes flow checks equality of code coordinates, scroll offsets and
  list height across open/close; default popovers measured 150px high at normal
  text size. Light/dark layouts at 320/480/720/1000px and 150% web text scaling were
  exercised. Below 480px the popup sits at the bottom of the reading region.
- Verified keyboard activation/Escape, click-outside, repeated marker click,
  same-location choices, three-line truncation, on-demand sidebar directories,
  cross-file navigation and an offscreen target at line 900. Explicit note
  navigation overrides saved tab offsets; duplicate scroll notifications do not
  dismiss a newly opened explanation.
- Injected a storage failure while saving a question, checked retained input,
  restored storage and retried successfully. Closed-popup drafts, full-context
  clipboard contents and stale-scope warnings were checked independently.
- The latest 1003-line warm-cache sample (20 switches per variant) measured P95
  about 150ms without explanations and 136ms with explanations closed. These are
  automation-inclusive measurements, not proof that explanations make rendering
  faster. Native Android/iOS appearance, keyboard behavior and performance remain
  device acceptance items.

Browser-plugin discovery returned no connected browsers; web verification used the
approved isolated Playwright harness. It did not reload the daily plugin, publish
an artifact or alter ordinary project workspaces.
