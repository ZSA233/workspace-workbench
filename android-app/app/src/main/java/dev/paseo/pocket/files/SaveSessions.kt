package dev.paseo.pocket.files

import java.io.OutputStream

/** Owned by one serial I/O executor. Picking a URI does not truncate the document. */
class SaveSessions<T>(private val open: (T) -> OutputStream, private val delete: (T) -> Unit) {
    private class Session<T>(val target: T, var output: OutputStream? = null, var offset: Long = 0)
    private val sessions = linkedMapOf<String, Session<T>>()
    fun register(id: String, target: T) { check(!sessions.containsKey(id)); sessions[id] = Session(target) }
    private fun session(id: String) = sessions[id] ?: error("Save session expired")
    fun write(id: String, offset: Long, bytes: ByteArray): Long {
        val session = session(id)
        SaveProtocol.chunk(session.offset, offset, bytes.size)
        val output = session.output ?: open(session.target).also { session.output = it }
        output.write(bytes); session.offset += bytes.size
        return session.offset
    }
    fun close(id: String): Long {
        val session = session(id)
        val output = session.output ?: open(session.target).also { session.output = it }
        output.flush(); output.close() // A zero byte file must also close successfully.
        sessions.remove(id)
        return session.offset
    }
    fun abort(id: String): Long {
        val session = sessions.remove(id) ?: return 0
        runCatching { session.output?.close() }
        runCatching { delete(session.target) }
        return session.offset
    }
    fun clear() { sessions.keys.toList().forEach(::abort) }
}
