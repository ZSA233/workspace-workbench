package dev.paseo.pocket.observation

import org.json.JSONObject

data class HostObservation(val host: Int, val selected: Boolean, val phase: String, val transport: String,
    val rttMs: Long?, val rttAgeMs: Long?, val reason: String = "none")

data class ObservationMessage(val doc: String, val seq: Long, val type: String, val hosts: List<HostObservation> = emptyList(),
    val busy: Boolean = false, val reason: String = "", val supported: Boolean = false,
    val count: Long = 0, val totalMs: Long = 0, val maxMs: Long = 0) {
    companion object {
        val phases = setOf("connecting", "syncing", "ready", "offline", "error")
        val transports = setOf("relay", "directTcp", "directSocket", "directPipe", "remoteSsh", "unknown")
        private val types = setOf("hello", "activated", "attached", "state", "verification", "unavailable", "tasks")
        private val uuid = Regex("[a-f0-9-]{36}")
        fun parse(raw: String, token: String, generation: String, doc: String?): ObservationMessage? = runCatching {
            require(raw.length <= 16384)
            val value = JSONObject(raw)
            require(value.getInt("v") == 1 && value.getString("token") == token)
            val document = value.getString("doc"); require(uuid.matches(document))
            val type = value.getString("type"); require(type in types)
            val seq = value.getLong("seq"); require(seq in 1..Long.MAX_VALUE)
            if (type != "hello") require(value.getString("generation") == generation && document == doc)
            when (type) {
                "state" -> {
                    val array = value.getJSONArray("hosts"); require(array.length() <= 32)
                    val hosts = (0 until array.length()).map { index ->
                        val host = array.getJSONObject(index)
                        val slot = host.getInt("host"); require(slot in 1..10000)
                        val phase = host.getString("phase"); require(phase in phases)
                        val transport = host.getString("transport"); require(transport in transports)
                        val reason = host.getString("reason"); require(reason in setOf("none", "auth", "sync", "timeout", "network", "unknown"))
                        fun number(key: String, max: Long): Long? = if (host.isNull(key)) null else host.getLong(key).also { require(it in 0..max) }
                        HostObservation(slot, host.getBoolean("selected"), phase, transport,
                            number("rttMs", 60000), number("rttAgeMs", 86400000), reason)
                    }
                    require(hosts.map { it.host }.distinct().size == hosts.size)
                    ObservationMessage(document, seq, type, hosts, busy = value.getBoolean("verifying"))
                }
                "unavailable" -> {
                    val reason = value.getString("reason"); require(reason in setOf("version", "timeout", "incompatible", "disposed"))
                    ObservationMessage(document, seq, type, reason = reason)
                }
                "verification" -> ObservationMessage(document, seq, type, busy = value.getBoolean("busy"))
                "tasks" -> {
                    val count = value.getLong("count"); val total = value.getLong("totalMs"); val max = value.getLong("maxMs")
                    require(count in 0..100000 && total in 0..3600000 && max in 0..60000)
                    ObservationMessage(document, seq, type, supported = value.getBoolean("supported"), count = count, totalMs = total, maxMs = max)
                }
                else -> ObservationMessage(document, seq, type)
            }
        }.getOrNull()
    }
}
