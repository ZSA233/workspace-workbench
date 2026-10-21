package dev.paseo.pocket.observation

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import dev.paseo.pocket.Diagnostics

/** Activity-owned state shared by one WebSession and the disposable tool sheet. */
class ObservationController(private val diagnostics: Diagnostics) : AutoCloseable {
    private val handler = Handler(Looper.getMainLooper())
    private val listeners = mutableSetOf<() -> Unit>()
    private val clock = { SystemClock.elapsedRealtime() }
    val trace = ConnectionTrace(clock, diagnostics::record)
    private var bridge: ObservationBridge? = null
    private var foreground = false
    private var expanded = false
    private var recordingStarted: Long? = null
    private var closed = false
    private val sampler = PerformanceSampler { value ->
        if (recordingStarted?.let { clock() - it >= 60000 } == true) endRecording(false)
        if (recordingStarted != null) {
            val fields = mutableMapOf<String, Long>()
            value.cpuPercent?.let { fields["cpu_milli"] = (it * 1000).coerceIn(0.0, 1e9).toLong() }
            value.pssKiB?.let { fields["pss_kib"] = it }
            value.rxBps?.let { fields["rx_bps"] = it }; value.txBps?.let { fields["tx_bps"] = it }
            fields["tasks"] = trace.taskCount; fields["task_total_ms"] = trace.taskTotalMs; fields["task_max_ms"] = trace.taskMaxMs
            diagnostics.record("performance_sample", fields)
        }
        bridge?.refresh(); changed()
    }
    private val stopRecording = Runnable { endRecording(false) }
    val performance get() = sampler.reading
    val isRecording get() = recordingStarted != null
    val isForeground get() = foreground
    val recordingRemainingMs get() = recordingStarted?.let { (60000 - (clock() - it)).coerceAtLeast(0) } ?: 0
    fun subscribe(listener: () -> Unit): () -> Unit { listeners.add(listener); return { listeners.remove(listener); Unit } }
    private fun changed() { if (!closed) listeners.toList().forEach { it() } }
    fun bind(value: ObservationBridge) {
        bridge = value; value.foreground(foreground); value.inspect(foreground && (expanded || isRecording))
    }
    fun unbind(value: ObservationBridge) { if (bridge === value) bridge = null }
    fun pageStarted() { trace.pageStarted(); changed() }
    fun pageFinished() { trace.pageFinished(); changed() }
    fun progress(value: Int) { trace.progress(value); changed() }
    fun unavailable(reason: String) { trace.adapterUnavailable(reason); changed() }
    fun message(value: ObservationMessage) { trace.accept(value); changed() }
    fun foreground(value: Boolean, backgroundMs: Long? = null) {
        foreground = value
        if (value && backgroundMs != null) trace.beginRecovery(backgroundMs)
        if (!value) endRecording(true)
        bridge?.foreground(value, value && backgroundMs != null)
        updateSampling(); changed()
    }
    fun expandPerformance(value: Boolean) { expanded = value; updateSampling(); changed() }
    private fun updateSampling() {
        val enabled = foreground && (expanded || isRecording)
        if (enabled) sampler.start() else sampler.stop()
        bridge?.inspect(enabled)
    }
    fun verify() {
        if (!foreground || trace.verifying || trace.adapter != "attached") return
        bridge?.verify()
    }
    fun startRecording() {
        if (!foreground || isRecording) return
        recordingStarted = clock(); diagnostics.record("recording_started")
        bridge?.inspect(true, true); updateSampling()
        handler.postDelayed(stopRecording, 60000); changed()
    }
    fun endRecording(paused: Boolean = false) {
        val started = recordingStarted ?: return
        recordingStarted = null; handler.removeCallbacks(stopRecording)
        diagnostics.record(if (paused) "recording_interrupted" else "recording_finished", mapOf("duration_ms" to (clock() - started).coerceIn(0, 60000)))
        updateSampling(); changed()
    }
    override fun close() {
        if (closed) return
        endRecording(true); closed = true; handler.removeCallbacks(stopRecording)
        sampler.close(); bridge = null; listeners.clear()
    }
}
