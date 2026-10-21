package dev.paseo.pocket.updates

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

class UpdateFailure(val code: String) : Exception(code)
internal fun ensure(condition: Boolean, code: String) { if (!condition) throw UpdateFailure(code) }

object PackageLimits {
    const val METADATA = 1024 * 1024L
    const val ARCHIVE = 64 * 1024 * 1024L
    const val EXPANDED = 256 * 1024 * 1024L
    const val FILE = 64 * 1024 * 1024L
    const val FILES = 4096
    const val RESERVED_SPACE = 32 * 1024 * 1024L
}

fun httpsUri(value: String): URI {
    val uri = runCatching { URI(value) }.getOrElse { throw UpdateFailure("invalid_url") }
    ensure(value.length <= 4096 && uri.scheme == "https" && !uri.host.isNullOrEmpty() &&
        uri.rawUserInfo == null && uri.rawFragment == null, "invalid_url")
    return uri
}

data class PackageSignature(val keyId: String, val signature: String)
data class PackageMetadata(val name: String, val version: String, val tarball: String,
    val integrity: String, val signatures: List<PackageSignature>) {
    fun json(): JSONObject = JSONObject().put("name", name).put("version", version).put("dist",
        JSONObject().put("tarball", tarball).put("integrity", integrity).put("signatures", JSONArray().apply {
            signatures.forEach { put(JSONObject().put("keyid", it.keyId).put("sig", it.signature)) }
        }))
    val id: String get() = version + "-" + Base64.getDecoder().decode(integrity.substring(7))
        .take(12).joinToString("") { "%02x".format(it.toInt() and 255) }

    companion object {
        fun parse(json: JSONObject): PackageMetadata {
            try {
                val dist = json.getJSONObject("dist")
                val signatures = dist.getJSONArray("signatures")
                ensure(signatures.length() in 1..16, "signature_invalid")
                return PackageMetadata(json.getString("name"), json.getString("version"), dist.getString("tarball"),
                    dist.getString("integrity"), (0 until signatures.length()).map {
                        val sig = signatures.getJSONObject(it)
                        PackageSignature(sig.getString("keyid"), sig.getString("sig"))
                    })
            } catch (failure: UpdateFailure) { throw failure }
            catch (_: Exception) { throw UpdateFailure("metadata_invalid") }
        }
    }
}

class PackageTrust(val packageName: String, private val keys: Map<String, String>, val officialUrl: String) {
    fun verify(metadata: PackageMetadata): PackageMetadata {
        ensure(metadata.name == packageName && metadata.version.length <= 80 &&
            metadata.version.matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-zA-Z0-9.-]+)?")), "identity_invalid")
        ensure(metadata.integrity.matches(Regex("sha512-[A-Za-z0-9+/]{86}==")), "integrity_invalid")
        httpsUri(metadata.tarball)
        val payload = "${metadata.name}@${metadata.version}:${metadata.integrity}".toByteArray(Charsets.UTF_8)
        val known = metadata.signatures.filter { it.keyId in keys }
        ensure(known.isNotEmpty(), "unknown_signing_key")
        val valid = known.any { sig -> runCatching {
            if (sig.signature.length > 512) return@runCatching false
            val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(keys.getValue(sig.keyId))))
            Signature.getInstance("SHA256withECDSA").run {
                initVerify(key); update(payload); verify(Base64.getDecoder().decode(sig.signature))
            }
        }.getOrDefault(false) }
        ensure(valid, "signature_invalid")
        return metadata
    }

    companion object {
        fun parse(json: JSONObject): PackageTrust {
            val keys = json.getJSONArray("keys")
            return PackageTrust(json.getString("packageName"), (0 until keys.length()).associate {
                val key = keys.getJSONObject(it); key.getString("keyid") to key.getString("publicKey")
            }, json.getString("officialMetadataUrl"))
        }
    }
}
