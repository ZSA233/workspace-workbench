package dev.paseo.pocket.files

object SaveProtocol {
    const val CHUNK_BYTES = 512 * 1024
    fun name(value: String): String? = value.takeIf { it.isNotBlank() && it.length <= 255 &&
        it != "." && it != ".." && it.none { ch -> ch == '/' || ch == '\\' || ch.code < 32 } }
    fun chunk(confirmed: Long, requested: Long, size: Int) {
        require(confirmed == requested && requested >= 0) { "Save offset mismatch" }
        require(size in 1..CHUNK_BYTES) { "Invalid save chunk" }
        require(confirmed <= Long.MAX_VALUE - size) { "Save offset overflow" }
    }
}
