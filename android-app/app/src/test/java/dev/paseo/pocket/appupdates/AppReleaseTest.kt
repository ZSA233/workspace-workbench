package dev.paseo.pocket.appupdates

import dev.paseo.pocket.updates.HttpsTransport
import dev.paseo.pocket.updates.TransferCancellation
import dev.paseo.pocket.updates.UpdateFailure
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.net.URL
import java.security.MessageDigest
import java.security.cert.Certificate
import javax.net.ssl.HttpsURLConnection

class AppReleaseTest {
    private val cert = "a".repeat(64)
    private val policy = AppReleasePolicy("example/workbench", cert)
    private fun release(version: String, tag: String = "android-v$version") = JSONObject().put("tag_name", tag)
        .put("draft", false).put("prerelease", false).put("body", "Changes")
        .put("assets", JSONArray(listOf("paseo-pocket-$version.apk", "release.json", "SHA256SUMS").map { name ->
            JSONObject().put("name", name).put("size", 12000000).put("state", "uploaded")
                .put("browser_download_url", "https://github.com/example/workbench/releases/download/$tag/$name")
        }))
    private fun metadata(version: String = "0.1.5", code: Long = 6) = JSONObject().put("schemaVersion", 1)
        .put("applicationId", "dev.paseo.pocket").put("versionName", version).put("versionCode", code)
        .put("tag", "android-v$version").put("apk", "paseo-pocket-$version.apk")
        .put("sha256", "b".repeat(64)).put("certificateSha256", cert)
    private fun failWith(code: String, body: () -> Unit) {
        try { body(); fail("Expected $code") } catch (error: UpdateFailure) { assertEquals(code, error.code) }
    }
    @Test fun mixedRepositorySelectsHighestPocketSemverAndSkipsDraftsAndPrereleases() {
        val page = JSONArray().put(release("99.0.0", "v99.0.0")).put(release("0.1.9")).put(release("0.1.10"))
            .put(release("1.0.0").put("draft", true)).put(release("2.0.0").put("prerelease", true))
            .put(release("01.2.3")).put(release("0.1.11-rc.1"))
        val (found, more) = policy.parsePage(page.toString())
        assertFalse(more); assertEquals("0.1.10", policy.newest(found)?.version)
        assertEquals(2, found.size)
    }
    @Test fun incompleteDuplicateAndForeignAssetsAreNotUpdateCandidates() {
        val missing = release("0.1.5"); missing.getJSONArray("assets").remove(0)
        val duplicate = release("0.1.5"); duplicate.getJSONArray("assets").put(duplicate.getJSONArray("assets").getJSONObject(0))
        val foreign = release("0.1.5"); foreign.getJSONArray("assets").getJSONObject(0).put("browser_download_url", "https://other.test/app.apk")
        val huge = release("0.1.5"); huge.getJSONArray("assets").getJSONObject(0).put("size", AppReleasePolicy.MAX_APK_BYTES + 1)
        assertTrue(policy.parsePage(JSONArray(listOf(missing, duplicate, foreign, huge)).toString()).first.isEmpty())
    }
    @Test fun manifestBindsTagPackageVersionCodeAndCertificate() {
        val release = AppRelease("0.1.5", 12000000)
        val accepted = policy.manifest(release, metadata().toString(), "0.1.4", 5)
        assertEquals(6L, accepted.versionCode)
        assertEquals(accepted, AppUpdatePackage.restore(accepted.json()))
        failWith("release_invalid") { policy.manifest(release, metadata().put("applicationId", "other.app").toString(), "0.1.4", 5) }
        failWith("release_invalid") { policy.manifest(release, metadata().put("tag", "v0.1.5").toString(), "0.1.4", 5) }
        failWith("signer_mismatch") { policy.manifest(release, metadata().put("certificateSha256", "c".repeat(64)).toString(), "0.1.4", 5) }
        failWith("downgrade_blocked") { policy.manifest(release, metadata(code = 5).toString(), "0.1.4", 5) }
        failWith("downgrade_blocked") { policy.manifest(release, metadata().toString(), "0.1.5", 5) }
    }
    @Test fun checksumListBindsApkAndExactManifestBytes() {
        val raw = metadata().toString(); val update = policy.manifest(AppRelease("0.1.5", 12000000), raw, "0.1.4", 5)
        val sum = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
        val sums = "${update.sha256}  ${update.release.apkName}\n$sum  release.json\n"
        policy.checksums(update, raw, sums)
        failWith("digest_mismatch") { policy.checksums(update, "$raw\n", sums) }
        failWith("release_invalid") { policy.checksums(update, raw, sums + "$sum  release.json\n") }
    }
    private class Connection(url: URL, val body: String) : HttpsURLConnection(url) {
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun getCipherSuite() = "TLS_AES_128_GCM_SHA256"
        override fun getLocalCertificates(): Array<Certificate>? = null
        override fun getServerCertificates(): Array<Certificate> = emptyArray()
        override fun getResponseCode() = 200
        override fun getInputStream() = ByteArrayInputStream(body.toByteArray())
    }
    @Test fun paginationFindsPocketBehindOneHundredPluginReleases() {
        val requests = mutableListOf<String>(); val raw = metadata().toString()
        val sum = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
        val transport = HttpsTransport { url ->
            requests.add(url.toString())
            Connection(url, when {
                url.query?.endsWith("page=1") == true -> JSONArray(List(100) { release("9.0.$it", "v9.0.$it") }).toString()
                url.query?.endsWith("page=2") == true -> JSONArray(listOf(release("0.1.5"))).toString()
                url.path.endsWith("release.json") -> raw
                url.path.endsWith("SHA256SUMS") -> "${"b".repeat(64)}  paseo-pocket-0.1.5.apk\n$sum  release.json\n"
                else -> error("Unexpected request")
            })
        }
        val update = AppUpdateClient(policy, transport).latest(InstalledPocket("dev.paseo.pocket", "0.1.4", 5, cert), TransferCancellation())
        assertEquals("0.1.5", update?.release?.version); assertEquals(4, requests.size)
        assertTrue(requests.none { it.endsWith("/latest") })
    }
    @Test fun sameVersionDoesNotFetchOrDownloadAnApk() {
        var requests = 0
        val client = AppUpdateClient(policy, HttpsTransport { requests++; Connection(it, JSONArray(listOf(release("0.1.4"))).toString()) })
        assertNull(client.latest(InstalledPocket("dev.paseo.pocket", "0.1.4", 5, cert), TransferCancellation()))
        assertEquals(1, requests)
    }
    @Test fun tooManyReleasePagesAndCancellationStopTheCheck() {
        var requests = 0
        val client = AppUpdateClient(policy, HttpsTransport { requests++; Connection(it, JSONArray(List(100) { release("1.0.$it", "v1.0.$it") }).toString()) })
        failWith("history_limit") { client.latest(InstalledPocket("dev.paseo.pocket", "0.1.4", 5, cert), TransferCancellation()) }
        assertEquals(10, requests)
        val cancel = TransferCancellation().apply { cancel() }
        try { client.latest(InstalledPocket("dev.paseo.pocket", "0.1.4", 5, cert), cancel); fail() }
        catch (_: java.util.concurrent.CancellationException) { assertEquals(10, requests) }
    }
    @Test fun checksRunAtMostDailyOnForegroundAndCanBeDisabled() {
        val now = 1000000000L
        assertTrue(AppCheckSchedule.due(true, 0, now))
        assertFalse(AppCheckSchedule.due(false, 0, now))
        assertFalse(AppCheckSchedule.due(true, now - AppCheckSchedule.INTERVAL_MS + 1, now))
        assertTrue(AppCheckSchedule.due(true, now - AppCheckSchedule.INTERVAL_MS, now))
        assertTrue(AppCheckSchedule.due(true, now + 1000, now))
    }
}
