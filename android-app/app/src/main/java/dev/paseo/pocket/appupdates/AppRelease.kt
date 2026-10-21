package dev.paseo.pocket.appupdates

import dev.paseo.pocket.updates.UpdateFailure
import dev.paseo.pocket.updates.compareVersions
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

internal fun requireUpdate(value: Boolean, code: String = "release_invalid") { if (!value) throw UpdateFailure(code) }

data class AppRelease(val version: String, val apkBytes: Long, val notes: String = "") {
    val tag get() = "android-v$version"
    val apkName get() = "paseo-pocket-$version.apk"
    fun page(repository: String) = "https://github.com/$repository/releases/tag/$tag"
    fun asset(repository: String, name: String) = "https://github.com/$repository/releases/download/$tag/$name"
}

data class AppUpdatePackage(val release: AppRelease, val versionCode: Long, val sha256: String, val certificateSha256: String) {
    fun json() = JSONObject().put("version", release.version).put("bytes", release.apkBytes).put("notes", release.notes)
        .put("versionCode", versionCode).put("sha256", sha256).put("certificateSha256", certificateSha256)
    companion object {
        fun restore(json: JSONObject): AppUpdatePackage {
            val release = AppRelease(json.getString("version"), json.getLong("bytes"), json.optString("notes").take(2000))
            AppReleasePolicy.validateRelease(release)
            val code = json.getLong("versionCode"); val sha = json.getString("sha256"); val cert = json.getString("certificateSha256")
            requireUpdate(code in 1..2100000000 && sha.matches(AppReleasePolicy.HASH) && cert.matches(AppReleasePolicy.HASH))
            return AppUpdatePackage(release, code, sha, cert)
        }
    }
}

/** GitHub's global latest release belongs to the plugin. Select only complete Pocket releases. */
class AppReleasePolicy(val repository: String, private val certificate: String) {
    init { require(repository.matches(Regex("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"))); require(certificate.matches(HASH)) }
    val releasesPage get() = "https://github.com/$repository/releases?q=android-v&expanded=true"
    fun api(page: Int): String { require(page in 1..MAX_PAGES); return "https://api.github.com/repos/$repository/releases?per_page=$PAGE_SIZE&page=$page" }
    fun parsePage(text: String): Pair<List<AppRelease>, Boolean> {
        val rows = JSONArray(text)
        requireUpdate(rows.length() <= PAGE_SIZE)
        val releases = (0 until rows.length()).mapNotNull { index ->
            val row = rows.optJSONObject(index) ?: return@mapNotNull null
            if (row.optBoolean("draft", true) || row.optBoolean("prerelease", true)) return@mapNotNull null
            val version = row.optString("tag_name").removePrefix("android-v")
            if (row.optString("tag_name") != "android-v$version" || !VERSION.matches(version) || version.length > 60) return@mapNotNull null
            val assets = row.optJSONArray("assets") ?: return@mapNotNull null
            val wanted = setOf("paseo-pocket-$version.apk", "release.json", "SHA256SUMS")
            val selected = (0 until assets.length()).mapNotNull { assets.optJSONObject(it) }.filter { it.optString("name") in wanted }
            if (selected.size != 3 || selected.map { it.optString("name") }.toSet() != wanted) return@mapNotNull null
            val release = AppRelease(version, selected.single { it.optString("name").endsWith(".apk") }.optLong("size", -1), row.optString("body").take(2000))
            if (release.apkBytes !in 1..MAX_APK_BYTES) return@mapNotNull null
            if (selected.any { it.optString("browser_download_url") != release.asset(repository, it.optString("name")) || it.optString("state") != "uploaded" }) return@mapNotNull null
            release
        }
        return releases to (rows.length() == PAGE_SIZE)
    }
    fun newest(releases: List<AppRelease>): AppRelease? = releases.maxWithOrNull { a, b -> compareVersions(a.version, b.version) }
    fun manifest(release: AppRelease, text: String, installedVersion: String, installedCode: Long): AppUpdatePackage {
        validateRelease(release)
        val json = JSONObject(text)
        requireUpdate(json.getInt("schemaVersion") == 1 && json.getString("applicationId") == "dev.paseo.pocket")
        requireUpdate(json.getString("versionName") == release.version && json.getString("tag") == release.tag && json.getString("apk") == release.apkName)
        val result = AppUpdatePackage.restore(JSONObject().put("version", release.version).put("bytes", release.apkBytes)
            .put("notes", release.notes).put("versionCode", json.getLong("versionCode"))
            .put("sha256", json.getString("sha256")).put("certificateSha256", json.getString("certificateSha256")))
        requireUpdate(result.certificateSha256 == certificate, "signer_mismatch")
        requireUpdate(compareVersions(release.version, installedVersion) > 0 && result.versionCode > installedCode, "downgrade_blocked")
        return result
    }
    fun checksums(update: AppUpdatePackage, manifest: String, sums: String) {
        val entries = linkedMapOf<String, String>()
        for (line in sums.lineSequence().filter { it.isNotBlank() }) {
            val match = Regex("([a-f0-9]{64})  ([a-zA-Z0-9._-]+)").matchEntire(line) ?: throw UpdateFailure("release_invalid")
            requireUpdate(entries.put(match.groupValues[2], match.groupValues[1]) == null)
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(manifest.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
        requireUpdate(entries[update.release.apkName] == update.sha256 && entries["release.json"] == digest, "digest_mismatch")
    }
    companion object {
        const val PAGE_SIZE = 100
        const val MAX_PAGES = 10
        const val MAX_APK_BYTES = 80L * 1024 * 1024
        val VERSION = Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")
        val HASH = Regex("[a-f0-9]{64}")
        fun validateRelease(release: AppRelease) { requireUpdate(release.version.length <= 60 && release.version.matches(VERSION) && release.apkBytes in 1..MAX_APK_BYTES) }
    }
}

object AppCheckSchedule {
    const val INTERVAL_MS = 24 * 60 * 60 * 1000L
    fun due(enabled: Boolean, lastAttempt: Long, now: Long) = enabled && (lastAttempt <= 0 || now < lastAttempt || now - lastAttempt >= INTERVAL_MS)
}
