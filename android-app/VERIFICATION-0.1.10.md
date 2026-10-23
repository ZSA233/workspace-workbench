# Pocket 0.1.10: unobstructed image selection

Version: 0.1.10 / versionCode 11; bundled Paseo Web 0.12.0.

Removed the APK adapter's “正在添加图片…” and delayed waiting overlays. The actual
composer thumbnail is the feedback for successful selection. A new selection also
clears any previous error notice. Actual read/storage failures retain their brief
error feedback; bounded diagnostics and the original image/send flow are preserved.

The final QA APK ran on the API 37 arm64 emulator with WebView 145.0.7632.218,
through the actual system PhotoPicker, full Paseo composer and isolated Paseo
daemon. Cancellation followed by reselection, two thumbnails, IndexedDB bytes and
actual message delivery all passed; both received image hashes matched the sources.
A continuous DOM observer started before selection and recorded zero image status
overlays, including transient creation/removal. The composer accepted and sent the
test text normally.

[Result and hashes](../docs/verification/pocket-image-0.1.10/summary.json) ·
[Actual composer](../docs/verification/pocket-image-0.1.10/04-real-composer-pills.png)

Checks: 60 Pocket Node cases, 41 post-bundle adapter cases and 43 JVM tests passed;
lint reported zero errors. Debug, instrumentation and signed release builds passed;
APK verification checked the 39 locked web assets and current adapter bytes.
The slow-processing regression confirms that neither selection nor its 15-second
diagnostic timeout creates a notice, and retry clears an earlier error notice.
No physical phone was available for this release's verification.

Repeat the native check with:

```sh
node android-app/scripts/verify-device-images.mjs --serial emulator-5580 \
  --cancel-first --images 2 --output /tmp/pocket-device-images-0110
```
