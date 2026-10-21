package dev.paseo.pocket.appupdates

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import dev.paseo.pocket.BuildConfig
import dev.paseo.pocket.updates.compareVersions
import java.io.File
import java.security.MessageDigest

data class InstalledPocket(val packageName: String, val version: String, val code: Long, val certificate: String) {
    companion object {
        fun current(context: Context): InstalledPocket {
            @Suppress("DEPRECATION")
            val info = context.packageManager.getPackageInfo(context.packageName,
                if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES)
            @Suppress("DEPRECATION")
            val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
            requireUpdate(signatures?.size == 1, "signer_mismatch")
            val cert = ApkTrust.hex(MessageDigest.getInstance("SHA-256").digest(requireNotNull(signatures).single().toByteArray()))
            return InstalledPocket(context.packageName, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE.toLong(), cert)
        }
    }
}

/** Hash and platform package/signing identity are checked before handing off to Android's installer. */
class ApkTrust(private val context: Context, val installed: InstalledPocket = InstalledPocket.current(context)) {
    fun verify(file: File, update: AppUpdatePackage, check: () -> Unit = {}) {
        requireUpdate(file.isFile && file.length() == update.release.apkBytes && file.length() <= AppReleasePolicy.MAX_APK_BYTES, "apk_incomplete")
        requireUpdate(update.certificateSha256 == installed.certificate, "signer_mismatch")
        requireUpdate(compareVersions(update.release.version, installed.version) > 0 && update.versionCode > installed.code, "downgrade_blocked")
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(32 * 1024)
            while (true) { check(); val size = input.read(buffer); if (size < 0) break; digest.update(buffer, 0, size) }
        }
        requireUpdate(hex(digest.digest()) == update.sha256, "digest_mismatch"); check()
        @Suppress("DEPRECATION")
        val info = context.packageManager.getPackageArchiveInfo(file.path,
            if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES)
        requireUpdate(info != null, "apk_invalid")
        requireNotNull(info)
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
        requireUpdate(info.packageName == installed.packageName && info.versionName == update.release.version && code == update.versionCode, "apk_identity")
        requireUpdate((info.applicationInfo?.minSdkVersion ?: Int.MAX_VALUE) <= Build.VERSION.SDK_INT, "android_unsupported")
        @Suppress("DEPRECATION")
        val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        requireUpdate(signatures?.size == 1, "signer_mismatch")
        val actual = hex(MessageDigest.getInstance("SHA-256").digest(requireNotNull(signatures).single().toByteArray()))
        requireUpdate(actual == installed.certificate, "signer_mismatch"); check()
    }
    companion object { fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) } }
}
