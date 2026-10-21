package dev.paseo.pocket.observation

data class Counters(val at: Long, val cpuMs: Long, val rx: Long, val tx: Long)
data class PerformanceReading(val cpuPercent: Double? = null, val rxBps: Long? = null, val txBps: Long? = null,
    val pssKiB: Long? = null)

class PerformanceMath {
    private var previous: Counters? = null
    fun reset() { previous = null }
    fun sample(current: Counters): PerformanceReading {
        val old = previous; previous = current
        if (old == null) return PerformanceReading()
        val duration = current.at - old.at
        if (duration !in 1..10000) return PerformanceReading()
        fun rate(value: Long, before: Long): Long? = if (value < 0 || before < 0 || value < before) null
            else ((value - before).toDouble() * 1000 / duration).coerceAtMost(1e12).toLong()
        return PerformanceReading(if (current.cpuMs >= old.cpuMs) (current.cpuMs - old.cpuMs) * 100.0 / duration else null,
            rate(current.rx, old.rx), rate(current.tx, old.tx))
    }
}
