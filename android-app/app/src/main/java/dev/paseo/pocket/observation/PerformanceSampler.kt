package dev.paseo.pocket.observation

import android.net.TrafficStats
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Only runs while explicitly requested in the foreground. Stale worker results are discarded. */
class PerformanceSampler(private val changed: (PerformanceReading) -> Unit) : AutoCloseable {
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val inFlight = AtomicBoolean(false)
    private val math = PerformanceMath()
    private var epoch = 0
    private var running = false
    private var closed = false
    var reading = PerformanceReading(); private set
    private val cpuTick = object : Runnable {
        override fun run() { if (running) { sample(false); handler.postDelayed(this, 2000) } }
    }
    private val memoryTick = object : Runnable {
        override fun run() { if (running) { sample(true); handler.postDelayed(this, 5000) } }
    }
    fun start() {
        if (running || closed) return
        running = true; epoch++; math.reset(); reading = PerformanceReading()
        // Offset the independent memory tick so it cannot crowd out the CPU baseline.
        handler.post(cpuTick); handler.postDelayed(memoryTick, 250)
    }
    fun stop() {
        if (!running) return
        running = false; epoch++; math.reset()
        handler.removeCallbacks(cpuTick); handler.removeCallbacks(memoryTick)
    }
    private fun sample(memory: Boolean) {
        if (!inFlight.compareAndSet(false, true)) return
        val ticket = epoch
        worker.execute {
            val counters = if (!memory) runCatching { Counters(SystemClock.elapsedRealtime(), Process.getElapsedCpuTime(),
                TrafficStats.getUidRxBytes(Process.myUid()), TrafficStats.getUidTxBytes(Process.myUid())) }.getOrNull() else null
            val pss = if (memory) runCatching { Debug.MemoryInfo().also(Debug::getMemoryInfo).totalPss.toLong().takeIf { it > 0 } }.getOrNull() else null
            handler.post {
                inFlight.set(false)
                if (!running || closed || epoch != ticket) return@post
                reading = if (memory) reading.copy(pssKiB = pss) else counters?.let { math.sample(it).copy(pssKiB = reading.pssKiB) } ?: reading
                changed(reading)
            }
        }
    }
    override fun close() { stop(); closed = true; worker.shutdown() }
}
