package dev.paseo.pocket.updates

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.net.URL
import java.security.cert.Certificate
import java.util.concurrent.CancellationException
import javax.net.ssl.HttpsURLConnection

class HttpsTransportTest {
    @get:Rule val temporary = TemporaryFolder()
    private class Connection(url: URL, private val body: ByteArray, private val status: Int = 200,
        private val location: String? = null, private val expectedLength: Long = body.size.toLong()) : HttpsURLConnection(url) {
        var disconnected = false
        override fun connect() {}
        override fun disconnect() { disconnected = true }
        override fun usingProxy() = false
        override fun getCipherSuite() = "TLS_AES_128_GCM_SHA256"
        override fun getLocalCertificates(): Array<Certificate>? = null
        override fun getServerCertificates(): Array<Certificate> = emptyArray()
        override fun getInputStream(): InputStream = ByteArrayInputStream(body)
        override fun getResponseCode() = status
        override fun getHeaderField(name: String?): String? = if (name == "Location") location else null
        override fun getContentLengthLong() = expectedLength
    }
    @Test fun metadataSizeAndHttpsRedirectsAreBounded() {
        val tooLarge = HttpsTransport { Connection(it, ByteArray(PackageLimits.METADATA.toInt() + 1)) }
        try { tooLarge.metadata("https://mirror.test/latest.json", TransferCancellation()); fail() }
        catch (e: UpdateFailure) { assertEquals("size_limit", e.code) }
        val downgrade = HttpsTransport { Connection(it, byteArrayOf(), 302, "http://insecure.test/latest.json") }
        try { downgrade.metadata("https://mirror.test/latest.json", TransferCancellation()); fail() }
        catch (e: UpdateFailure) { assertEquals("invalid_url", e.code) }
        var requests = 0
        val loop = HttpsTransport { requests++; Connection(it, byteArrayOf(), 302, "/again") }
        try { loop.metadata("https://mirror.test/latest.json", TransferCancellation()); fail() }
        catch (e: UpdateFailure) { assertEquals("network_failed", e.code) }
        assertEquals(6, requests)
    }
    @Test fun partialDownloadAndCancellationRemoveTemporaryArchive() {
        val fixtures = PackageFixtures(temporary.root)
        val (_, metadata) = fixtures.archive()
        val destination = File(temporary.root, "download.part")
        val broken = HttpsTransport { Connection(it, ByteArray(4), expectedLength = 8) }
        try { broken.download(metadata, destination, TransferCancellation()) { _, _ -> }; fail() }
        catch (e: UpdateFailure) { assertEquals("archive_truncated", e.code) }
        assertFalse(destination.exists())
        val cancellation = TransferCancellation()
        val normal = HttpsTransport { Connection(it, ByteArray(1024 * 1024)) }
        try { normal.download(metadata, destination, cancellation) { _, _ -> cancellation.cancel() }; fail() }
        catch (_: CancellationException) { assertFalse(destination.exists()) }
    }
}
