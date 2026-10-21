package dev.paseo.pocket.updates

import dev.paseo.pocket.AppVersion

import java.io.File
import java.net.URL
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection

class TransferCancellation {
    private val cancelled = AtomicBoolean(false)
    @Volatile private var connection: HttpsURLConnection? = null
    fun check() { if (cancelled.get() || Thread.currentThread().isInterrupted) throw CancellationException() }
    fun cancel() { cancelled.set(true); connection?.disconnect() }
    fun attach(value: HttpsURLConnection) { connection = value; if (cancelled.get()) { value.disconnect(); check() } }
    fun detach() { connection = null }
}

class HttpsTransport(private val factory: (URL) -> HttpsURLConnection = { it.openConnection() as HttpsURLConnection }) {
    private fun open(address: String, cancellation: TransferCancellation): HttpsURLConnection {
        var uri = httpsUri(address)
        repeat(6) {
            cancellation.check()
            val connection = factory(uri.toURL())
            cancellation.attach(connection)
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000; connection.readTimeout = 20_000
            connection.setRequestProperty("Accept-Encoding", "identity")
            connection.setRequestProperty("User-Agent", "PaseoPocket/${AppVersion.name}")
            val status = try { connection.responseCode } catch (error: Exception) {
                connection.disconnect(); cancellation.detach(); throw error
            }
            if (status in 300..399) {
                val location = connection.getHeaderField("Location")
                connection.disconnect(); cancellation.detach()
                ensure(location != null, "network_failed")
                uri = httpsUri(uri.resolve(location).toString())
            } else {
                if (status !in 200..299) { connection.disconnect(); cancellation.detach(); throw UpdateFailure("network_failed") }
                return connection
            }
        }
        throw UpdateFailure("network_failed")
    }

    fun metadata(address: String, cancellation: TransferCancellation): String {
        val connection = open(address, cancellation)
        return try {
            LimitedInput(connection.inputStream, PackageLimits.METADATA, cancellation::check).use { it.readBytes().toString(Charsets.UTF_8) }
        } finally { connection.disconnect(); cancellation.detach() }
    }

    fun download(metadata: PackageMetadata, destination: File, cancellation: TransferCancellation, progress: (Long, Long) -> Unit) {
        val connection = open(metadata.tarball, cancellation)
        try {
            val length = connection.contentLengthLong
            ensure(length <= PackageLimits.ARCHIVE, "size_limit")
            ensure(!destination.exists() && destination.createNewFile(), "storage_failed")
            connection.inputStream.use { input -> destination.outputStream().use { output ->
                val buffer = ByteArray(32 * 1024); var bytes = 0L; var lastReport = 0L
                while (true) {
                    cancellation.check(); val n = input.read(buffer); if (n < 0) break
                    bytes += n; ensure(bytes <= PackageLimits.ARCHIVE, "size_limit")
                    output.write(buffer, 0, n)
                    val now = System.nanoTime()
                    if (now - lastReport >= 250_000_000) { progress(bytes, length); lastReport = now }
                }
                ensure(length < 0 || bytes == length, "archive_truncated")
                output.fd.sync(); progress(bytes, length)
            } }
        } catch (error: Exception) { destination.delete(); throw error }
        finally { connection.disconnect(); cancellation.detach() }
    }
}
