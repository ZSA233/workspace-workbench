package dev.paseo.pocket.observation

/** One owned timer. Page replacement preserves the original background deadline. */
class BackgroundPolicy(private val clock: () -> Long, private val schedule: (Long, () -> Unit) -> (() -> Unit),
    private val pause: () -> Unit, private val resume: () -> Unit,
    private val event: (String, Map<String, Long>) -> Unit) : AutoCloseable {
    companion object { const val GRACE_MS = 30000L }
    private var stoppedAt: Long? = null
    private var cancellation: (() -> Unit)? = null
    private var generation = 0L
    private var closed = false
    var suspended = false; private set
    fun foreground(): Long? {
        if (closed) return null
        val duration = stoppedAt?.let { (clock() - it).coerceAtLeast(0) }
        cancellation?.invoke(); cancellation = null; generation++
        stoppedAt = null; suspended = false; resume()
        return duration
    }
    fun background() {
        if (closed || stoppedAt != null) return
        stoppedAt = clock(); event("activity_stopped", emptyMap()); arm()
    }
    fun pageReplaced() {
        if (closed) return
        cancellation?.invoke(); cancellation = null; generation++
        if (stoppedAt == null) { suspended = false; resume() }
        else if (suspended) pause() else arm()
    }
    private fun arm() {
        val started = stoppedAt ?: return
        val ticket = ++generation
        cancellation = schedule((GRACE_MS - (clock() - started)).coerceAtLeast(0)) {
            if (!closed && generation == ticket && stoppedAt == started) {
                cancellation = null; suspended = true; pause()
                event("web_timers_paused", mapOf("background_ms" to (clock() - started).coerceAtLeast(0)))
            }
        }
    }
    override fun close() { closed = true; generation++; cancellation?.invoke(); cancellation = null }
}
