package dev.paseo.pocket

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.util.ArrayDeque
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Event-only, bounded, credential-free diagnostics. No URLs, DOM, prompts or console text. */
class Diagnostics(context: Context) : AutoCloseable {
    private val file = AtomicFile(File(context.filesDir, "diagnostics.txt"))
    private val events = ArrayDeque<String>()
    private val io = ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, ArrayBlockingQueue(16),
        ThreadPoolExecutor.DiscardPolicy())
    private var lastCode = ""
    private var lastTime = 0L

    init {
        io.execute {
            val saved = runCatching { file.openRead().use { input ->
                input.reader().readText().takeLast(16_384).lines().takeLast(80)
            } }.getOrDefault(emptyList())
            synchronized(events) { saved.filter { it.matches(Regex("[0-9]+ [a-z0-9_]{1,50}")) }.forEach(events::addLast) }
        }
    }

    fun record(code: String) {
        require(code.matches(Regex("[a-z0-9_]{1,50}")))
        val now = System.currentTimeMillis()
        synchronized(events) {
            if (code == lastCode && now - lastTime < 5000) return
            lastCode = code; lastTime = now
        }
        io.execute {
            val snapshot = synchronized(events) {
                events.addLast("$now $code")
                while (events.size > 80) events.removeFirst()
                events.joinToString("\n")
            }
            var stream: java.io.FileOutputStream? = null
            try { stream = file.startWrite(); stream.write(snapshot.toByteArray()); file.finishWrite(stream) }
            catch (_: Exception) { stream?.let(file::failWrite) }
        }
    }

    fun snapshot(): String = synchronized(events) { events.toList().takeLast(20).joinToString("\n") }
    override fun close() { io.shutdown() }
}
