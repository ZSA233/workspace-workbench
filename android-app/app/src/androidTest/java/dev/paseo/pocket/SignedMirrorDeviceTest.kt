package dev.paseo.pocket

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.paseo.pocket.updates.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CancellationException

@RunWith(AndroidJUnit4::class)
class SignedMirrorDeviceTest {
    @Test fun downloadsOriginalSignedPackageOverLocalHttpsAndAppliesAtomically() {
        val url = InstrumentationRegistry.getArguments().getString("mirrorUrl")
        assumeTrue("Supply mirrorUrl and adb reverse for the isolated HTTPS integration", url != null)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val trust = PackageTrust.parse(JSONObject(context.assets.open("paseo/_trust.json").bufferedReader().use { it.readText() }))
        val builtin = VerifiedBundle.parse(JSONObject(context.assets.open("paseo/_workbench.json").bufferedReader().use { it.readText() }), trust)
        val root = File(context.cacheDir, "pocket-update-test-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val transport = HttpsTransport()
            val metadata = trust.verify(PackageMetadata.parse(JSONObject(transport.metadata(url!!, TransferCancellation()))))
            assertEquals("0.12.0", metadata.version)
            assertEquals("localhost", httpsUri(metadata.tarball).host)
            val cancelled = TransferCancellation()
            val partial = File(root, "cancelled.part")
            try { transport.download(metadata, partial, cancelled) { _, _ -> cancelled.cancel() }; fail() }
            catch (_: CancellationException) { assertFalse(partial.exists()) }
            val store = BundleStore(File(root, "pages"), trust, builtin)
            val archive = store.downloadFile()
            transport.download(metadata, archive, TransferCancellation()) { _, _ -> }
            val installed = store.install(archive, metadata)
            assertEquals(39, installed.files.size)
            assertNull(store.activeId())
            store.activate(installed.metadata.id)
            val restarted = BundleStore(store.root, trust, builtin)
            assertEquals(installed.metadata.id, restarted.activeId())
            assertNotNull(restarted.activeDirectory())
            assertNull(restarted.pending())
        } finally { root.deleteRecursively() }
    }
}
