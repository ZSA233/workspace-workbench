package dev.paseo.pocket.observation

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ObservationTest {
    @Test fun logBoundsAndRestorationRejectContentAndUnknownFields() {
        val buffer = DiagnosticBuffer()
        buffer.restore("123 page_loaded\n124 error url=secret\n125 private prompt text\n126 page_loaded duration_ms=52")
        assertEquals(2, buffer.snapshot().lines().size)
        repeat(300) { buffer.add(1000L + it, "performance_sample", mapOf("cpu_milli" to it.toLong())) }
        assertEquals(200, buffer.snapshot().lines().size)
        assertTrue(buffer.snapshot().toByteArray().size < DiagnosticBuffer.MAX_BYTES)
        assertFalse(buffer.snapshot().contains("secret"))
        assertThrows(IllegalArgumentException::class.java) { buffer.add(1, "oops", mapOf("token" to 1)) }
    }
    @Test fun restoreDoesNotOverwriteEventsRecordedWhileDiskWasLoading() {
        val buffer = DiagnosticBuffer(); buffer.add(200, "page_loading")
        buffer.restore("100 process_started")
        assertEquals("100 process_started\n200 page_loading", buffer.snapshot())
    }
    @Test fun byteLimitAlsoHoldsForMaximumWidthNumericEvents() {
        val buffer = DiagnosticBuffer()
        val keys = listOf("duration_ms", "background_ms", "host", "elapsed_ms", "connection_ms", "sync_ms", "ready_ms", "total_ready_ms",
            "cpu_milli", "pss_kib", "rx_bps", "tx_bps", "tasks", "task_total_ms", "task_max_ms", "supported")
        repeat(500) { buffer.add(1000000000000000L + it, "a".repeat(50), keys.associateWith { 9999999999999999L }) }
        assertTrue(buffer.snapshot().toByteArray().size <= DiagnosticBuffer.MAX_BYTES)
        assertTrue(buffer.snapshot().lines().size <= DiagnosticBuffer.MAX_EVENTS)
        val restored = DiagnosticBuffer(); restored.restore(buffer.snapshot()); assertEquals(buffer.snapshot(), restored.snapshot())
    }
    @Test fun ratesUseMonotonicDeltasAndResetAfterSleep() {
        val math = PerformanceMath()
        assertNull(math.sample(Counters(1000, 10, 0, 0)).cpuPercent)
        val value = math.sample(Counters(3000, 510, 4000, 6000))
        assertEquals(25.0, value.cpuPercent!!, .001); assertEquals(2000L, value.rxBps); assertEquals(3000L, value.txBps)
        assertNull(math.sample(Counters(40000, 600, 4001, 6001)).cpuPercent)
        math.reset(); assertNull(math.sample(Counters(40001, 600, 4001, 6001)).cpuPercent)
    }
    @Test fun unsupportedOrResetTrafficCountersAreNotReportedAsZeroTraffic() {
        val math = PerformanceMath(); math.sample(Counters(0, 0, 100, -1))
        val value = math.sample(Counters(2000, 4000, 1, -1))
        assertEquals(200.0, value.cpuPercent!!, .001)
        assertNull(value.rxBps); assertNull(value.txBps)
    }
    private fun base(type: String) = JSONObject().put("v", 1).put("token", "token")
        .put("generation", "generation").put("doc", "12345678-1234-1234-1234-123456789012").put("seq", 2).put("type", type)
    private fun parse(value: JSONObject) = ObservationMessage.parse(value.toString(), "token", "generation", "12345678-1234-1234-1234-123456789012")
    @Test fun bridgeRejectsOldGenerationsWrongTokensAndUnknownEvents() {
        assertNotNull(parse(base("attached")))
        assertNull(parse(base("attached").put("generation", "old")))
        assertNull(parse(base("attached").put("token", "other")))
        assertNull(parse(base("send_task")))
        assertNull(ObservationMessage.parse("x".repeat(17000), "token", "generation", null))
    }
    @Test fun bridgeOnlyAcceptsBoundedNumericMetrics() {
        val value = base("tasks").put("supported", true).put("count", 2).put("totalMs", 123).put("maxMs", 80)
        assertEquals(123L, parse(value)!!.totalMs)
        assertNull(parse(value.put("totalMs", -1)))
    }
    @Test fun repeatedStatesDoNotResetRecoveryBudgetOrProduceDuplicateTransitions() {
        var now = 0L; val events = mutableListOf<Pair<String, Map<String, Long>>>()
        val trace = ConnectionTrace({ now }) { name, fields -> events.add(name to fields) }
        val host = HostObservation(1, true, "connecting", "relay", null, null)
        fun state(phase: String) = trace.accept(ObservationMessage("doc", 1, "state", listOf(host.copy(phase = phase))))
        trace.pageStarted(); state("connecting"); now = 3000; state("syncing"); now = 8000; state("ready")
        assertEquals(3000L, trace.hosts.single().connectionMs); assertEquals(5000L, trace.hosts.single().syncMs)
        val count = events.size; now = 10000; state("ready"); assertEquals(count, events.size)
        trace.beginRecovery(40000); now = 12000; state("syncing"); now = 13000; state("ready")
        assertEquals(3000L, trace.hosts.single().readyMs)
        now = 20000; state("offline"); now = 21000; state("ready")
        assertEquals(1000L, trace.hosts.single().readyMs)
    }
    @Test fun latePairingAndAlreadyConnectedHostsDoNotInventConnectionDurations() {
        var now = 0L
        val trace = ConnectionTrace({ now }) { _, _ -> }
        trace.pageStarted(); trace.accept(ObservationMessage("doc", 1, "state"))
        now = 20000
        trace.accept(ObservationMessage("doc", 2, "state", listOf(HostObservation(1, true, "syncing", "relay", null, null))))
        now = 20100
        trace.accept(ObservationMessage("doc", 3, "state", listOf(HostObservation(1, true, "ready", "relay", null, null))))
        assertNull(trace.hosts.single().connectionMs); assertNull(trace.hosts.single().totalReadyMs)
        assertEquals(100L, trace.hosts.single().syncMs)
        assertEquals(100L, trace.hosts.single().readyMs)
        trace.pageStarted(); now = 22000
        trace.accept(ObservationMessage("doc", 4, "state", listOf(HostObservation(1, true, "ready", "relay", null, null))))
        assertNull(trace.hosts.single().connectionMs); assertNull(trace.hosts.single().readyMs)
        assertEquals(1900L, trace.hosts.single().totalReadyMs)
    }
    @Test fun directoryRevalidationStartsANewSyncSpanWithoutInventingANewConnection() {
        var now = 0L; val trace = ConnectionTrace({ now }) { _, _ -> }
        fun phase(value: String) = trace.accept(ObservationMessage("doc", 1, "state", listOf(HostObservation(1, true, value, "relay", null, null))))
        phase("ready"); now = 1000; phase("syncing"); now = 1800; phase("ready")
        assertNull(trace.hosts.single().connectionMs)
        assertEquals(800L, trace.hosts.single().syncMs); assertEquals(800L, trace.hosts.single().totalReadyMs)
    }
}
