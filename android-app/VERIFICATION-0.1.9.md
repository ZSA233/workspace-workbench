# Pocket 0.1.9 image selection verification

Version: 0.1.9 / versionCode 10. Bundled Paseo Web: locked 0.12.0.

## Native failure reproduced and fixed

On the isolated API 37 arm64 emulator with Android System WebView 145.0.7632.218,
the unchanged 0.1.8 QA APK reproduced the reported behavior twice: select a real
PNG in the Android PhotoPicker, press Done, and return without an attachment.
Pocket recorded `file_picker_cancelled`; the page received an empty selection,
with zero composer pills and zero stored attachment blobs.

The system returns `RESULT_OK` with `ClipData`, including when only one photo is
selected from this multiple-selection input. The WebView provider's
`FileChooserParams.parseResult` only reads `Intent.data`. The new small
`FileChooserResult` helper collects both fields, preserves order, removes
duplicates and still returns cancellation for cancelled or empty results. No
additional URI permissions or native image copying are needed.

The actual installed provider was independently exercised in an Android device
test: `result_ok=1 data_count=0 clip_count=1 provider_count=0 parsed_count=1`.

## MIME compatibility

The actual full Paseo composer also rejected a valid PNG labelled `image/x-png`:
the upstream attachment hook caught an unsupported-type error and returned no
attachment. The adapter now normalizes unsupported image MIME aliases from the
actual image header. Known upstream types retain their original File objects;
normalized files preserve bytes, name and modification time. Spoofed or truncated
alias-labelled files resolve cancellation and show retry feedback.

The verified Paseo JavaScript bundle, attachment storage and send protocol remain
unchanged. The full normalizer/hook regression covers PNG, JPEG and BMP aliases;
this is separate from native PhotoPicker evidence.

## Actual Android pipeline

The QA APK (`dev.paseo.pocket.qa`) ran the complete bundled page and connected to
an actual isolated Paseo daemon using the deterministic local Codex protocol
fixture. No real agent task or normal project registry was used.

- Real Android PhotoPicker selection produced the actual composer thumbnail and
  an IndexedDB attachment, then the actual Send action delivered `localImage` to
  the fixture. Its on-disk SHA-256 matched the source PNG.
- Cancelling the native picker produced no attachment and allowed a new selection.
- Two selected PNGs produced two thumbnails and two submitted images; both hashes
  matched. Keeping the native picker open for over 30 seconds preserved the page
  and did not prevent attachment processing after return.
- Six Android Intent/ClipData regression tests passed. The affected device suite
  passed all 12 tests, including document upload/save, independent save targets,
  cancellation, background timer suspension and retained WebView/draft state.

The repeatable full-pipeline command is:

```sh
node android-app/scripts/verify-device-images.mjs \
  --serial emulator-5580 --cancel-first --images 2 --chooser-delay-ms 32000 \
  --output /tmp/pocket-device-images-019
```

It resets only the installed QA package, starts its own isolated TLS host, selects
through native picker controls, and checks actual stored and delivered image
bytes. It does not substitute `setFileInputFiles`, synthetic picker results or
fixture attachment pills. Native screenshots, event traces and hashes are saved
in the output directory.

The final 0.1.9/code 10 run passed with no page errors. Committed evidence:
[summary and hashes](../docs/verification/pocket-image-0.1.9/summary.json),
[native selection](../docs/verification/pocket-image-0.1.9/03-photo-picker-selected.png),
[actual composer thumbnails](../docs/verification/pocket-image-0.1.9/04-real-composer-pills.png).

## Build and regression checks

- Pocket Node scripts: 60 passed, no skips, including 26 image regression cases.
- Post-bundle observation/image checks: 41 passed, no skips.
- Web asset tests: 5 passed.
- JVM unit tests: 43 passed, no failures/errors/skips.
- TypeScript plugin typecheck passed; this fix changes only Pocket production code.
- Debug, instrumentation and signed release APK builds succeeded; lint has no
  errors. APK checks verified all 39 locked upstream assets and the Pocket
  adapters; release package/version and persistent signing certificate matched.

## Evidence limits

This is actual Android emulator/WebView and actual isolated-host evidence, rather
than the browser-only boundary tests used for 0.1.8. No physical Android device
was available. The user's device and other vendor/cloud photo providers remain
physical-device acceptance items. No new background upload service or WebView
content-access permission was introduced.
