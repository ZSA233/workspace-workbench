package dev.paseo.pocket

import android.content.Context
import android.util.AtomicFile
import java.io.File
import dev.paseo.pocket.observation.DiagnosticBuffer
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Event-only, bounded, credential-free diagnostics. No URLs, DOM, prompts or console text. */
class Diagnostics(context: Context) : AutoCloseable {
    private val file = AtomicFile(File(context.filesDir, "diagnostics.txt"))
    private val events = DiagnosticBuffer()
    private val scheduled = AtomicBoolean(false)
    private val io = ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, ArrayBlockingQueue(16),
        ThreadPoolExecutor.DiscardPolicy())

    init {
        io.execute {
            val saved = runCatching { file.openRead().use { input ->
                val bytes = ByteArray(DiagnosticBuffer.MAX_BYTES)
                var size = 0
                while (size < bytes.size) {
                    val count = input.read(bytes, size, bytes.size - size)
                    if (count < 0) break
                    size += count
                }
                String(bytes, 0, size, Charsets.UTF_8)
            } }.getOrDefault("")
            events.restore(saved)
        }
    }

    @Volatile private var closed = false
    fun record(code: String, fields: Map<String, Long> = emptyMap()) {
        if (closed) return
        events.add(System.currentTimeMillis(), code, fields)
        if (!scheduled.compareAndSet(false, true)) return
        io.execute {
            scheduled.set(false)
            val snapshot = events.snapshot()
            var stream: java.io.FileOutputStream? = null
            try { stream = file.startWrite(); stream.write(snapshot.toByteArray()); file.finishWrite(stream) }
            catch (_: Exception) { stream?.let(file::failWrite) }
        }
    }

    fun snapshot(): String = events.snapshot()
    override fun close() { closed = true; io.shutdown() }
}
