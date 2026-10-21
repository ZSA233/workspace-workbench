package dev.paseo.pocket.updates

import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.archivers.tar.TarConstants
import java.io.File
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.util.Base64
import java.util.zip.GZIPOutputStream

data class FixtureEntry(val path: String, val body: String = "", val link: Boolean = false)
class PackageFixtures(private val root: File) {
    private val key = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
    val trust = PackageTrust("@getpaseo/server", mapOf("fixture" to Base64.getEncoder().encodeToString(key.public.encoded)), "https://fixture.test/latest.json")
    val entries = listOf(FixtureEntry("package/dist/server/web-ui/index.html", "<script src=\"/app.js\"></script>"),
        FixtureEntry("package/dist/server/web-ui/app.js", "window.fixture=true"), FixtureEntry("package/LICENSE", "test license"))
    private var sequence = 0
    fun archive(version: String = "0.12.0", rows: List<FixtureEntry> = entries): Pair<File, PackageMetadata> {
        val file = File(root, "fixture-${++sequence}.tgz")
        TarArchiveOutputStream(GZIPOutputStream(file.outputStream())).use { tar ->
            for (row in rows) {
                val entry = if (row.link) TarArchiveEntry(row.path, TarConstants.LF_SYMLINK).apply { linkName = "/etc/passwd" }
                    else TarArchiveEntry(row.path, true).apply { size = row.body.toByteArray().size.toLong() }
                tar.putArchiveEntry(entry)
                if (!row.link) tar.write(row.body.toByteArray())
                tar.closeArchiveEntry()
            }
        }
        val integrity = "sha512-" + Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-512").digest(file.readBytes()))
        val payload = "@getpaseo/server@$version:$integrity"
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(key.private); update(payload.toByteArray()); sign()
        }
        return file to PackageMetadata("@getpaseo/server", version, "https://fixture.test/server.tgz", integrity,
            listOf(PackageSignature("fixture", Base64.getEncoder().encodeToString(signature))))
    }
    fun builtin(): VerifiedBundle {
        val (file, metadata) = archive()
        return ArchiveVerifier(trust).extract(file, File(root, "builtin"), metadata)
    }
}
