package dev.paseo.pocket.updates

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class BundleStoreTest {
    @get:Rule val temporary = TemporaryFolder()
    private fun setup(): Triple<PackageFixtures, VerifiedBundle, BundleStore> {
        val fixtures = PackageFixtures(temporary.root)
        val builtin = fixtures.builtin()
        val store = BundleStore(File(temporary.root, "pages"), fixtures.trust, builtin) { Long.MAX_VALUE }
        return Triple(fixtures, builtin, store)
    }
    @Test fun verifiesBeforeAtomicActivationAndKeepsPairingOutOfStore() {
        val (fixtures, builtin, store) = setup()
        val (file, metadata) = fixtures.archive("0.13.0")
        val installed = store.install(file, metadata)
        assertEquals(builtin.metadata.version, store.activeMetadata().version)
        assertEquals(installed.metadata.id, store.pending()!!.metadata.id)
        val restarted = BundleStore(store.root, fixtures.trust, builtin)
        restarted.cleanInterrupted()
        assertEquals("0.13.0", restarted.pending()!!.metadata.version)
        restarted.activate(installed.metadata.id)
        assertEquals("0.13.0", store.activeMetadata().version)
        assertNull(restarted.pending())
        assertFalse(File(store.root, "cookies").exists())
        val (nextFile, nextMeta) = fixtures.archive("0.14.0")
        restarted.install(nextFile, nextMeta); restarted.activate(nextMeta.id)
        assertTrue(File(store.root, installed.metadata.id).isDirectory)
        val older = fixtures.archive("0.12.0")
        restarted.install(older.first, older.second)
        try { restarted.activate(older.second.id); fail() } catch (e: UpdateFailure) { assertEquals("downgrade_blocked", e.code) }
        assertEquals("0.14.0", restarted.activeMetadata().version)
    }
    @Test fun interruptedSelectionWriteAndFailedPreparationLeaveActiveIntact() {
        val (fixtures, builtin, store) = setup()
        val (file, metadata) = fixtures.archive("0.13.0")
        store.install(file, metadata); store.activate(metadata.id)
        File(store.root, "active.json.new").writeText("incomplete")
        val interrupted = File(store.root, "install-1234abcd").apply { mkdirs() }
        File(interrupted, "partial.js").writeText("partial")
        val restarted = BundleStore(store.root, fixtures.trust, builtin)
        restarted.cleanInterrupted()
        assertFalse(interrupted.exists())
        assertEquals("0.13.0", restarted.activeMetadata().version)
        val (next, candidate) = fixtures.archive("0.14.0")
        restarted.install(next, candidate)
        File(store.root, "active.json.new").mkdir()
        try { restarted.activate(candidate.id); fail() } catch (_: java.io.IOException) { /* atomic record cannot be prepared */ }
        assertEquals("0.13.0", restarted.activeMetadata().version)
    }
    @Test fun lowSpaceOrTamperedInstalledFileCannotReplaceCurrent() {
        val (fixtures, builtin, store) = setup()
        val limited = BundleStore(store.root, fixtures.trust, builtin) { 0 }
        val (file, metadata) = fixtures.archive("0.13.0")
        try { limited.install(file, metadata); fail() } catch (e: UpdateFailure) { assertEquals("space_low", e.code) }
        assertEquals("0.12.0", store.activeMetadata().version)
        store.install(file, metadata)
        File(store.root, metadata.id + "/app.js").writeText("X".repeat("window.fixture=true".length))
        try { store.activate(metadata.id); fail() } catch (e: UpdateFailure) { assertEquals("digest_mismatch", e.code) }
        assertEquals("0.12.0", store.activeMetadata().version)
    }
    @Test fun selectionCannotPointOutsideOwnedDirectoryAndSemverOrderingIsCorrect() {
        val (_, _, store) = setup()
        File(store.root, "active.json").writeText(JSONObject().put("schema", 1).put("active", "../../elsewhere").toString())
        try { store.activeDirectory(); fail() } catch (e: UpdateFailure) { assertEquals("selection_invalid", e.code) }
        assertTrue(compareVersions("0.12.0", "0.12.0-rc.2") > 0)
        assertTrue(compareVersions("0.12.0-rc.10", "0.12.0-rc.2") > 0)
        assertTrue(compareVersions("0.13.0", "0.12.100") > 0)
    }
}
