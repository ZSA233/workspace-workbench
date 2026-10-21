package dev.paseo.pocket.updates

import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.zip.GZIPInputStream

data class ResourceFile(val path: String, val size: Long, val sha256: String)
data class VerifiedBundle(val metadata: PackageMetadata, val files: List<ResourceFile>) {
    fun json() = JSONObject().put("schema", 1).put("metadata", metadata.json()).put("files", JSONArray().apply {
        files.sortedBy { it.path }.forEach { put(JSONObject().put("path", it.path).put("size", it.size).put("sha256", it.sha256)) }
    })
    companion object {
        fun parse(json: JSONObject, trust: PackageTrust): VerifiedBundle {
            ensure(json.getInt("schema") == 1, "bundle_invalid")
            val metadata = trust.verify(PackageMetadata.parse(json.getJSONObject("metadata")))
            val rows = json.getJSONArray("files")
            ensure(rows.length() in 2..PackageLimits.FILES, "bundle_invalid")
            val files = (0 until rows.length()).map {
                val row = rows.getJSONObject(it)
                val path = row.getString("path")
                ensure(ArchiveVerifier.safePath(path) == path && !path.startsWith("/"), "unsafe_path")
                val size = row.getLong("size"); val sha = row.getString("sha256")
                ensure(size in 0..PackageLimits.FILE && sha.matches(Regex("[a-f0-9]{64}")), "bundle_invalid")
                ResourceFile(path, size, sha)
            }
            ensure(files.map { it.path }.distinct().size == files.size && files.sumOf { it.size } <= PackageLimits.EXPANDED,
                "bundle_invalid")
            ensure(files.any { it.path == "index.html" } && files.any { it.path.endsWith(".js") }, "resources_missing")
            return VerifiedBundle(metadata, files)
        }
    }
}

class LimitedInput(input: InputStream, private val limit: Long, private val check: () -> Unit = {}) : FilterInputStream(input) {
    private var bytes = 0L
    private fun count(amount: Int) { check(); if (amount > 0) bytes += amount; ensure(bytes <= limit, "size_limit") }
    override fun read(): Int = super.read().also { count(if (it < 0) 0 else 1) }
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int = `in`.read(buffer, offset, length).also(::count)
    override fun skip(amount: Long): Long {
        // Tar skips count toward the expanded archive budget as well.
        val buffer = ByteArray(8192); var remaining = amount
        while (remaining > 0) { val n = read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt()); if (n < 0) break; remaining -= n }
        return amount - remaining
    }
}

class ArchiveVerifier(private val trust: PackageTrust) {
    fun verifyDigest(archive: File, metadata: PackageMetadata, check: () -> Unit = {}) {
        trust.verify(metadata)
        ensure(archive.length() <= PackageLimits.ARCHIVE, "size_limit")
        val digest = MessageDigest.getInstance("SHA-512")
        archive.inputStream().use { input ->
            val buffer = ByteArray(32 * 1024)
            while (true) { check(); val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
        }
        ensure(MessageDigest.isEqual(digest.digest(), Base64.getDecoder().decode(metadata.integrity.substring(7))), "digest_mismatch")
    }

    fun extract(archive: File, destination: File, metadata: PackageMetadata, check: () -> Unit = {}): VerifiedBundle {
        verifyDigest(archive, metadata, check)
        ensure(!destination.exists() && destination.mkdirs(), "storage_failed")
        val files = mutableListOf<ResourceFile>(); val seen = mutableSetOf<String>(); var count = 0
        try {
            GZIPInputStream(archive.inputStream()).use { gzip ->
                LimitedInput(gzip, PackageLimits.EXPANDED, check).use { bounded ->
                    TarArchiveInputStream(bounded).use { tar ->
                        while (true) {
                            check()
                            val entry = tar.nextEntry ?: break
                            val path = safePath(entry.name)
                            ensure(++count <= PackageLimits.FILES && entry.size in 0..PackageLimits.FILE, "size_limit")
                            ensure((entry.isFile || entry.isDirectory) && !entry.isSymbolicLink && !entry.isLink && tar.canReadEntryData(entry), "archive_type")
                            ensure(seen.add(path), "duplicate_path")
                            val relative = when {
                                entry.isFile && path.startsWith(PREFIX) && !path.matches(Regex(".*\\.(gz|br|map)$")) -> path.removePrefix(PREFIX)
                                entry.isFile && path.matches(Regex("package/(LICENSE(\\.md|\\.txt)?|NOTICE(\\.txt)?)", RegexOption.IGNORE_CASE)) -> "licenses/" + path.removePrefix("package/")
                                else -> null
                            }
                            if (relative != null) {
                                ensure(relative !in setOf("_workbench.json", "_trust.json"), "unsafe_path")
                                val file = File(destination, relative)
                                ensure(file.canonicalPath.startsWith(destination.canonicalPath + File.separator), "unsafe_path")
                                ensure(file.parentFile!!.isDirectory || file.parentFile!!.mkdirs(), "storage_failed")
                                ensure(file.createNewFile(), "duplicate_path")
                                val hash = MessageDigest.getInstance("SHA-256"); var written = 0L
                                file.outputStream().use { output ->
                                    val buffer = ByteArray(32 * 1024)
                                    while (true) { check(); val n = tar.read(buffer); if (n < 0) break
                                        written += n; ensure(written <= entry.size, "size_limit")
                                        hash.update(buffer, 0, n); output.write(buffer, 0, n)
                                    }
                                    output.fd.sync()
                                }
                                ensure(written == entry.size, "archive_truncated")
                                files.add(ResourceFile(relative, written, hash.digest().toHex()))
                            }
                        }
                        // Consume trailing tar data so an appended gzip bomb cannot evade the bound.
                        val buffer = ByteArray(8192)
                        while (bounded.read(buffer) != -1) check()
                    }
                }
            }
            ensure(files.any { it.path == "index.html" } && files.any { it.path.endsWith(".js") }, "resources_missing")
            val index = File(destination, "index.html")
            ensure(index.length() <= PackageLimits.METADATA, "size_limit")
            for (match in Regex("(?:src|href)=[\"']([^\"'#?]+)[\"']").findAll(index.readText())) {
                val resource = match.groupValues[1]
                ensure(!resource.startsWith("//") && !resource.contains("://") && files.any { it.path == resource.removePrefix("/") }, "resources_missing")
            }
            val bundle = VerifiedBundle(metadata, files)
            writeSynced(File(destination, "_workbench.json"), bundle.json().toString())
            return bundle
        } catch (error: Exception) { destination.deleteRecursively(); throw error }
    }

    companion object {
        const val PREFIX = "package/dist/server/web-ui/"
        fun safePath(name: String): String {
            val path = name.removeSuffix("/")
            ensure(path.isNotEmpty() && path.length <= 1024 && !path.startsWith('/') &&
                path.none { it == '\\' || it == ':' || it.code < 32 } &&
                path.split('/').none { it.isEmpty() || it == "." || it == ".." }, "unsafe_path")
            return path
        }
    }
}

fun ByteArray.toHex() = joinToString("") { "%02x".format(it.toInt() and 255) }
fun writeSynced(file: File, content: String) { file.outputStream().use { it.write(content.toByteArray(Charsets.UTF_8)); it.fd.sync() } }
