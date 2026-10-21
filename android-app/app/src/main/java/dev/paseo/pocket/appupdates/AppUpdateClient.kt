package dev.paseo.pocket.appupdates

import dev.paseo.pocket.updates.HttpsTransport
import dev.paseo.pocket.updates.TransferCancellation
import dev.paseo.pocket.updates.compareVersions
import java.io.File

class AppUpdateClient(val policy: AppReleasePolicy, private val transport: HttpsTransport = HttpsTransport()) {
    fun latest(installed: InstalledPocket, cancel: TransferCancellation): AppUpdatePackage? {
        val releases = mutableListOf<AppRelease>()
        for (page in 1..AppReleasePolicy.MAX_PAGES) {
            cancel.check()
            val (found, more) = policy.parsePage(transport.metadata(policy.api(page), cancel, 4L * 1024 * 1024))
            releases.addAll(found)
            if (!more) {
                val newest = policy.newest(releases) ?: return null
                if (compareVersions(newest.version, installed.version) <= 0) return null
                val manifest = transport.metadata(newest.asset(policy.repository, "release.json"), cancel)
                val update = policy.manifest(newest, manifest, installed.version, installed.code)
                policy.checksums(update, manifest, transport.metadata(newest.asset(policy.repository, "SHA256SUMS"), cancel, 8192))
                return update
            }
        }
        throw dev.paseo.pocket.updates.UpdateFailure("history_limit")
    }
    fun download(update: AppUpdatePackage, file: File, cancel: TransferCancellation, progress: (Long, Long) -> Unit) =
        transport.downloadFile(update.release.asset(policy.repository, update.release.apkName), file, AppReleasePolicy.MAX_APK_BYTES, cancel, progress)
}
