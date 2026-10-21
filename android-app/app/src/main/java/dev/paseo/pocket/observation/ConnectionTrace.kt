package dev.paseo.pocket.observation

/** Monotonic, content-free timing. Timings describe observations, not hidden handshake phases. */
class ConnectionTrace(private val clock: () -> Long, private val event: (String, Map<String, Long>) -> Unit) {
    data class Host(val observation: HostObservation, val receivedAt: Long, val cycleStart: Long,
        val connectionMs: Long? = null, val syncStart: Long? = null, val syncMs: Long? = null, val readyMs: Long? = null)
    var hosts: List<Host> = emptyList(); private set
    var cycleStart = clock(); private set
    var progress = 0; private set
    var pageLoadedMs: Long? = null; private set
    var adapter = "initializing"; private set
    var verifying = false; private set
    var taskSupported: Boolean? = null; private set
    var taskCount = 0L; private set
    var taskTotalMs = 0L; private set
    var taskMaxMs = 0L; private set

    fun pageStarted() {
        cycleStart = clock(); hosts = emptyList(); pageLoadedMs = null; progress = 0
        adapter = "initializing"; verifying = false; resetTasks()
        event("page_loading", emptyMap())
    }
    fun progress(value: Int) { progress = value.coerceIn(0, 100) }
    fun pageFinished() {
        if (pageLoadedMs == null) { pageLoadedMs = (clock() - cycleStart).coerceAtLeast(0); event("page_loaded", mapOf("duration_ms" to pageLoadedMs!!)) }
        progress = 100
    }
    fun beginRecovery(backgroundMs: Long) {
        cycleStart = clock()
        hosts = hosts.map { Host(it.observation.copy(phase = "connecting"), it.receivedAt, cycleStart) }
        resetTasks()
        event("page_resumed", mapOf("background_ms" to backgroundMs.coerceAtLeast(0)))
    }
    fun adapterUnavailable(reason: String) { adapter = reason; verifying = false; event("adapter_unavailable", emptyMap()) }
    fun accept(message: ObservationMessage) {
        when (message.type) {
            "attached" -> { adapter = "attached"; event("adapter_attached", emptyMap()) }
            "unavailable" -> adapterUnavailable(message.reason)
            "verification" -> { verifying = message.busy; event(if (verifying) "connection_check_started" else "connection_check_finished", emptyMap()) }
            "tasks" -> { taskSupported = message.supported; taskCount = message.count; taskTotalMs = message.totalMs; taskMaxMs = message.maxMs }
            "state" -> {
                verifying = message.busy
                val at = clock(); val previous = hosts.associateBy { it.observation.host }
                hosts = message.hosts.map { observation ->
                    val old = previous[observation.host]
                    // A later outage creates a new span; an app resume already reset the span.
                    val restart = old?.readyMs != null && observation.phase in setOf("connecting", "offline", "error")
                    val start = if (restart) at else old?.cycleStart ?: cycleStart
                    val base = if (restart) null else old
                    val connected = observation.phase in setOf("syncing", "ready")
                    val connection = base?.connectionMs ?: if (connected) (at - start).coerceAtLeast(0) else null
                    val syncStart = base?.syncStart ?: if (connected) at else null
                    val ready = base?.readyMs ?: if (observation.phase == "ready") (at - start).coerceAtLeast(0) else null
                    val sync = base?.syncMs ?: if (observation.phase == "ready" && syncStart != null) (at - syncStart).coerceAtLeast(0) else null
                    if (old == null || old.observation.phase != observation.phase || restart) {
                        val fields = mutableMapOf("host" to observation.host.toLong(), "elapsed_ms" to (at - start).coerceAtLeast(0))
                        connection?.let { fields["connection_ms"] = it }; sync?.let { fields["sync_ms"] = it }
                        ready?.let { fields["ready_ms"] = it }
                        event("host_${observation.phase}", fields)
                    }
                    if (observation.reason != "none" && old?.observation?.reason != observation.reason)
                        event("host_reason_${observation.reason}", mapOf("host" to observation.host.toLong()))
                    Host(observation, at, start, connection, syncStart, sync, ready)
                }
            }
        }
    }
    private fun resetTasks() { taskSupported = null; taskCount = 0; taskTotalMs = 0; taskMaxMs = 0 }
    fun elapsed() = (clock() - cycleStart).coerceAtLeast(0)
}
