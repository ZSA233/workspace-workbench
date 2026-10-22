# File-tree drag feedback — 0.7.2

The first valid drag-over inserted a blue path caption above the list, moving
every row down by 18 px in the actual Paseo host. The landing border also moved
the target label horizontally by 1 px. Both changes could alter the target under
the pointer.

Drag feedback now reuses the existing single-line bottom status area. The
landing border is an absolute, pointer-transparent overlay. Neither changes the
list's dimensions, row padding, 22 px desktop density or file-operation protocol.

## Evidence

- `npm --prefix paseo-plugin run typecheck`: passed.
- Affected file client, cache and service tests: 35 passed.
- Full Node regression: 722 passed, no skips, including protocol, runtime/cache,
  handoff-image, Reviewer and Hermes. The working checkout includes one existing
  Workspace-tree test beyond the release suite; its two unrelated modified files
  are excluded from this release commit.
- `node paseo-plugin/scripts/verify-files-ui.mjs`, with an isolated Paseo home,
  project registry and temporary repositories: 21 checks passed, no page or
  console errors. This loads the actual plugin, rather than mocked components.
- The added rendered regression fails on 0.7.1 with the 18 px displacement. With
  the fix, row and label x/y/width/height remain unchanged (maximum difference
  0 px) across internal and external hover, repeated hover, target switching,
  invalid self-targets, cancellation and leaving the tree.
- The same actual-host run passed hover expansion, browser-native tree moving,
  synthetic Windows Ctrl-copy, uploads, deletion, save cancellation and refresh
  recovery. Upload visibility lag was 78 ms; reviewed deletion took 132 ms to
  disappear from the tree in this run.

The rendered evidence is Chromium on macOS. Windows native drag still requires
Windows acceptance. Pocket remains at 0.1.7; this fix does not need a native bridge
change. Earlier performance and Android evidence is recorded in
[the 0.7.1 verification](ux-performance-0.7.1.md).
