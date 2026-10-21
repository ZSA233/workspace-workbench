package dev.paseo.pocket.updates

import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID

/** Immutable page directories plus one atomic selection. Never touches WebView storage. */
class BundleStore(val root: File, private val trust: PackageTrust, val builtIn: VerifiedBundle,
    private val availableBytes: () -> Long = { root.usableSpace }) {
    private val activeFile = File(root, "active.json")
    private val pendingFile = File(root, "pending.json")
    private val verifier = ArchiveVerifier(trust)

    init { ensure(root.isDirectory || root.mkdirs(), "storage_failed") }

    @Synchronized fun activeId(): String? = selection()?.optString("active")?.takeIf { it.isNotEmpty() }
    @Synchronized fun activeDirectory(): File? = activeId()?.let { directory(it).also(::validateDirectory) }
    @Synchronized fun activeMetadata(): PackageMetadata = activeDirectory()?.let(::readBundle)?.metadata ?: builtIn.metadata
    @Synchronized fun pending(): VerifiedBundle? = if (!pendingFile.exists()) null else {
        val id = readObject(pendingFile).getString("id")
        readBundle(directory(id)).also { validateDirectory(directory(id)) }
    }

    @Synchronized fun cleanInterrupted() {
        root.listFiles()?.filter { it.name.matches(Regex("(?:download|install)-[a-f0-9-]+(?:\\.part)?")) }
            ?.forEach { it.deleteRecursively() }
        // An interrupted pointer write leaves the complete active selection intact.
        File(root, "active.json.new").delete(); File(root, "pending.json.new").delete()
    }

    fun reserveSpace() { ensure(availableBytes() > PackageLimits.ARCHIVE + PackageLimits.EXPANDED + PackageLimits.RESERVED_SPACE, "space_low") }
    fun downloadFile() = File(root, "download-${UUID.randomUUID()}.part")

    fun install(archive: File, metadata: PackageMetadata, check: () -> Unit = {}): VerifiedBundle {
        reserveSpace(); trust.verify(metadata)
        val temporary = File(root, "install-${UUID.randomUUID()}")
        try {
            val bundle = verifier.extract(archive, temporary, metadata, check)
            check()
            synchronized(this) {
                val final = directory(metadata.id)
                if (final.exists()) { validateDirectory(final, hashes = true); temporary.deleteRecursively() }
                else Files.move(temporary.toPath(), final.toPath(), StandardCopyOption.ATOMIC_MOVE)
                check()
                atomicWrite(pendingFile, JSONObject().put("id", bundle.metadata.id))
            }
            return bundle
        } finally { temporary.deleteRecursively(); archive.delete() }
    }

    @Synchronized fun activate(id: String) {
        val target = directory(id)
        validateDirectory(target, hashes = true)
        val current = activeMetadata()
        val next = readBundle(target).metadata
        // No arbitrary web-storage rollback. Version 0.12.0 is the minimum supported bundle.
        ensure(compareVersions(next.version, current.version) >= 0, "downgrade_blocked")
        val old = activeId()
        val previous = if (old == id) selection()?.optString("previous") else old
        val pointer = JSONObject().put("schema", 1).put("active", id)
        if (!previous.isNullOrEmpty()) pointer.put("previous", previous)
        atomicWrite(activeFile, pointer)
        pendingFile.delete()
        val keep = setOf(id, previous)
        root.listFiles()?.filter { it.isDirectory && it.name.matches(ID) && it.name !in keep }?.forEach { it.deleteRecursively() }
    }

    @Synchronized private fun selection(): JSONObject? {
        if (!activeFile.exists()) return null
        val json = readObject(activeFile)
        ensure(json.getInt("schema") == 1 && json.getString("active").matches(ID), "selection_invalid")
        return json
    }
    private fun directory(id: String): File { ensure(id.matches(ID), "selection_invalid"); return File(root, id) }
    private fun readBundle(directory: File): VerifiedBundle = VerifiedBundle.parse(readObject(File(directory, "_workbench.json")), trust).also {
        ensure(it.metadata.id == directory.name, "bundle_invalid")
    }
    private fun validateDirectory(directory: File, hashes: Boolean = false) {
        val bundle = readBundle(directory)
        for (resource in bundle.files) {
            val file = File(directory, resource.path)
            ensure(file.canonicalPath.startsWith(directory.canonicalPath + File.separator) && file.isFile && file.length() == resource.size, "resources_missing")
            if (hashes) {
                val digest = MessageDigest.getInstance("SHA-256")
                file.inputStream().use { input -> val buffer = ByteArray(32 * 1024)
                    while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
                }
                ensure(digest.digest().toHex() == resource.sha256, "digest_mismatch")
            }
        }
    }

    companion object {
        private val ID = Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-zA-Z0-9.-]+)?-[a-f0-9]{24}")
        fun readObject(file: File): JSONObject {
            ensure(file.isFile && file.length() <= PackageLimits.METADATA, "bundle_invalid")
            return JSONObject(file.readText())
        }
        fun atomicWrite(file: File, value: JSONObject) {
            val temporary = File(file.parentFile, file.name + ".new")
            writeSynced(temporary, value.toString())
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        }
    }
}

/** Semver ordering; release builds sort after prereleases. */
fun compareVersions(a: String, b: String): Int {
    val mainA = a.substringBefore('-').split('.').map { it.toBigInteger() }
    val mainB = b.substringBefore('-').split('.').map { it.toBigInteger() }
    for (i in 0..2) { val result = mainA[i].compareTo(mainB[i]); if (result != 0) return result }
    val preA = a.substringAfter('-', ""); val preB = b.substringAfter('-', "")
    if (preA == preB) return 0
    if (preA.isEmpty()) return 1
    if (preB.isEmpty()) return -1
    val left = preA.split('.'); val right = preB.split('.')
    for (i in 0 until minOf(left.size, right.size)) {
        val l = left[i]; val r = right[i]; val ln = l.toBigIntegerOrNull(); val rn = r.toBigIntegerOrNull()
        val result = when { ln != null && rn != null -> ln.compareTo(rn); ln != null -> -1; rn != null -> 1; else -> l.compareTo(r) }
        if (result != 0) return result
    }
    return left.size.compareTo(right.size)
}
