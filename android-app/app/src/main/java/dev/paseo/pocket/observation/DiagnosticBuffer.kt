package dev.paseo.pocket.observation

/** Numeric fields only. A shared allowlist protects both newly written and restored logs. */
class DiagnosticBuffer {
    private val rows = ArrayDeque<String>()
    private var bytes = 0
    companion object {
        const val MAX_EVENTS = 200
        const val MAX_BYTES = 128 * 1024
        private val code = Regex("[a-z0-9_]{1,50}")
        private val keys = setOf("duration_ms", "background_ms", "host", "elapsed_ms", "connection_ms", "sync_ms", "ready_ms", "total_ready_ms",
            "cpu_milli", "pss_kib", "rx_bps", "tx_bps", "tasks", "task_total_ms", "task_max_ms", "supported")
        private val row = Regex("[0-9]{1,16} [a-z0-9_]{1,50}( [a-z_]{1,30}=[0-9]{1,16})*")
    }
    @Synchronized fun add(at: Long, name: String, fields: Map<String, Long> = emptyMap()) {
        require(code.matches(name) && at >= 0)
        require(fields.keys.all { it in keys } && fields.values.all { it in 0..9999999999999999L })
        append("$at $name" + fields.toSortedMap().entries.joinToString("") { " ${it.key}=${it.value}" })
    }
    private fun append(row: String) {
        rows.addLast(row); bytes += row.length + 1
        while (rows.size > MAX_EVENTS || bytes > MAX_BYTES) bytes -= rows.removeFirst().length + 1
    }
    @Synchronized fun restore(saved: String) {
        val valid = saved.takeLast(MAX_BYTES).lineSequence().filter { line ->
            line.length <= 2048 && row.matches(line) && line.split(' ').drop(2).all { it.substringBefore('=') in keys }
        }.toList().takeLast(MAX_EVENTS)
        val current = rows.toList(); rows.clear(); bytes = 0
        (valid + current).takeLast(MAX_EVENTS).forEach(::append)
    }
    @Synchronized fun snapshot(): String = rows.joinToString("\n")
}
