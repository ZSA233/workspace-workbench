# Pocket 0.1.8 image selection verification

Version: 0.1.8 / versionCode 9. Bundled Paseo Web: locked 0.12.0.

## Reproduced failure and change

Executing the real locked Expo picker with an empty or generic image MIME type
throws `Unsupported file type` inside its async change handler while the outer
picker Promise remains pending. This reproduces selection with no draft image,
but does not establish the exact cause on the user's phone.

The APK-owned adapter runs only on the trusted main page and the known image-only
Expo input. It repairs missing/generic MIME metadata and non-image MIME only when
the header identifies an image. Valid image Files remain the original objects.
The original picker, normalization, IndexedDB draft storage and send path remain
in use. Read failures resolve cancellation so the picker can be used again.
Storage failures gain feedback rather than a false success. Slow processing stays
an uncertain status and never triggers duplicate selection or automatic sending.

## Deterministic checks

- Pocket Node scripts: 47 passed, no skips, including 13 image regressions.
- Post-bundle adapter checks: 28 passed, no skips. Both Android CI and release CI
  now require the observation and image tests after verified assets are present.
- Web asset tests: 5 passed.
- JVM unit tests: 43 passed, no failures/errors.
- Lint: no errors; existing warnings remain. The new adapter has no lint finding.
- Final-version QA debug, instrumentation-test APK and signed production release
  APK built successfully. QA package is `dev.paseo.pocket.qa`; release is
  `dev.paseo.pocket`. Both report 0.1.8/code 9.
- APK checks verified 39 upstream assets plus byte-identical Pocket adapters and
  native classes. The release signature matches the persistent certificate pin.

## Actual Chromium boundary

Chromium 151 at 1120×820 and 390×844 loaded a fresh isolated page at the trusted
appassets origin for each scenario. The real locked upstream picker,
`normalizePickedImageAssets`, raster resolver, `pickAndPersistImages`, blob
persistence and IndexedDB store were executed inside a minimal composer fixture.

Seven adapted scenarios passed: empty MIME, generic MIME, incorrect non-image
MIME with PNG bytes, a normal image File, cancellation, unsupported PDF bytes and
slow persistence. Two pre-fix scenarios reproduced the permanently pending picker
and missing attachment. Successful 96×64 PNGs retained all 1,624 bytes after real
IndexedDB read-back and produced exactly one fixture attachment pill. A normal
image retained the same File object. Adapted scenarios had no page or console
warning/error. Slow persistence stayed `role=status`; releasing it added one
attachment. Cancellation and unsupported bytes added none.

Generic/incorrect/normal types used actual browser file-chooser delivery. Empty
MIME used real File/DataTransfer/change because Playwright fills an empty MIME
with `application/octet-stream`. Cancellation used the HTML cancel event. Native
diagnostics were stubbed. This is browser boundary evidence, not a full Paseo-host
or Android WebView/system photo-picker test.

## Platform limits

No physical Android device was available. The isolated API 37 emulator failed to
boot with mprotect errors and adb offline; its temporary instance was removed.
No user app data or existing device installation was changed. Actual WebView,
photo-provider behavior and the user's specific failure still require device
acceptance. A real device can inspect the bounded `file_picker_*` and
`image_input_*`/`image_attachment_*` diagnostic events after reproducing selection.

The mobile Workbench sidebar limitation is independently documented in
[the Paseo 0.12 entry-point verification](../docs/verification/mobile-entry-0.12.md).
