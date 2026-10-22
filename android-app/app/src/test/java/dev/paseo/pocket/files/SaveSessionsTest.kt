package dev.paseo.pocket.files

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream

class SaveSessionsTest {
    @Test fun targetsAreLazyAndIndependent() {
        val outputs = mutableMapOf<String, ByteArrayOutputStream>()
        val deleted = mutableListOf<String>()
        val sessions = SaveSessions<String>({ ByteArrayOutputStream().also { stream -> outputs[it] = stream } }, { deleted.add(it); Unit })
        sessions.register("a", "first"); sessions.register("b", "second"); sessions.register("zero", "empty")
        assertTrue(outputs.isEmpty())
        assertEquals(2L, sessions.write("a", 0, byteArrayOf(1, 2)))
        assertEquals(1L, sessions.write("b", 0, byteArrayOf(3)))
        sessions.abort("b")
        assertEquals(3L, sessions.write("a", 2, byteArrayOf(4)))
        assertEquals(3L, sessions.close("a")); assertEquals(0L, sessions.close("zero"))
        assertArrayEquals(byteArrayOf(1, 2, 4), outputs["first"]!!.toByteArray())
        assertEquals(0, outputs["empty"]!!.size()); assertEquals(listOf("second"), deleted)
    }
    @Test fun failedCloseDoesNotCompleteAndPageCleanupReleasesEveryUnfinishedTarget() {
        var closeFails = true
        val deleted = mutableListOf<String>()
        val sessions = SaveSessions<String>({ object : ByteArrayOutputStream() { override fun close() { if (closeFails) error("disk full") } } }, { deleted.add(it); Unit })
        sessions.register("a", "first"); sessions.register("b", "second")
        assertThrows(IllegalStateException::class.java) { sessions.close("a") }
        closeFails = false; sessions.clear()
        assertEquals(setOf("first", "second"), deleted.toSet())
        assertThrows(IllegalStateException::class.java) { sessions.write("a", 0, byteArrayOf(1)) }
    }
}
