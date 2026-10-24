package dev.paseo.pocket.updates

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CancellationException

class PackageSecurityTest {
    @get:Rule val temporary = TemporaryFolder()
    private fun failure(code: String, action: () -> Unit) {
        try { action(); fail("Expected $code") } catch (e: UpdateFailure) { assertEquals(code, e.code) }
    }

    @Test fun validatesRealNpmSignatureAndMirrorAddress() {
        val trust = PackageTrust.parse(JSONObject(File("../../web-assets/trust.json").readText()))
        val metadata = PackageMetadata.parse(JSONObject(File("../../web-assets/upstream.lock.json").readText()))
        assertEquals("0.13.0", trust.verify(metadata).version)
        trust.verify(metadata.copy(tarball = "https://mirror.test/server.tgz"))
        failure("signature_invalid") { trust.verify(metadata.copy(version = "0.13.1")) }
        failure("identity_invalid") { trust.verify(metadata.copy(name = "another-package")) }
        failure("unknown_signing_key") { trust.verify(metadata.copy(signatures = listOf(PackageSignature("unknown", "")))) }
        for (url in listOf("http://test.local/", "https://u:p@test.local/", "https://test.local/#secret"))
            failure("invalid_url") { httpsUri(url) }
    }

    @Test fun rejectsCorruptDigestAndRetainsOnlyWebAndLicense() {
        val fixtures = PackageFixtures(temporary.root)
        val (archive, metadata) = fixtures.archive(rows = fixtures.entries + FixtureEntry("package/postinstall.js", "throw Error('never run')"))
        val output = File(temporary.root, "web")
        val bundle = ArchiveVerifier(fixtures.trust).extract(archive, output, metadata)
        assertEquals(3, bundle.files.size)
        assertFalse(File(output, "postinstall.js").exists())
        assertEquals("test license", File(output, "licenses/LICENSE").readText())
        archive.appendText("changed")
        failure("digest_mismatch") { ArchiveVerifier(fixtures.trust).verifyDigest(archive, metadata) }
    }

    @Test fun refusesTraversalLinksDuplicatesMissingAssetsAndCancellation() {
        val fixtures = PackageFixtures(temporary.root)
        for ((code, rows) in listOf(
            "unsafe_path" to (fixtures.entries + FixtureEntry("package/../../escape")),
            "unsafe_path" to (fixtures.entries + FixtureEntry("/absolute")),
            "archive_type" to (fixtures.entries + FixtureEntry("package/link", link = true)),
            "duplicate_path" to (fixtures.entries + fixtures.entries.first()),
            "resources_missing" to fixtures.entries.take(1),
            "resources_missing" to listOf(FixtureEntry("package/dist/server/web-ui/index.html", "<script src=\"/missing.js\"></script>"), fixtures.entries[1])
        )) {
            val (file, metadata) = fixtures.archive(rows = rows)
            val out = File(temporary.root, "out-$code")
            failure(code) { ArchiveVerifier(fixtures.trust).extract(file, out, metadata) }
            assertFalse(out.exists())
        }
        val (file, metadata) = fixtures.archive()
        var checks = 0
        try { ArchiveVerifier(fixtures.trust).extract(file, File(temporary.root, "cancel"), metadata) {
            if (++checks > 4) throw CancellationException()
        }; fail() } catch (_: CancellationException) { assertFalse(File(temporary.root, "cancel").exists()) }
    }

    @Test fun boundsCountAndPaths() {
        val fixtures = PackageFixtures(temporary.root)
        val rows = fixtures.entries + (1..PackageLimits.FILES).map { FixtureEntry("package/file$it") }
        val (file, metadata) = fixtures.archive(rows = rows)
        failure("size_limit") { ArchiveVerifier(fixtures.trust).extract(file, File(temporary.root, "too-many"), metadata) }
        for (path in listOf("../x", "a//b", "a\\b", "C:drive", "a\u0000b"))
            failure("unsafe_path") { ArchiveVerifier.safePath(path) }
    }
}
