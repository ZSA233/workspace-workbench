package dev.paseo.pocket.files

import org.junit.Assert.*
import org.junit.Test

class SaveProtocolTest {
    @Test fun namesCannotBecomePaths() {
        assertEquals("photo.png", SaveProtocol.name("photo.png"))
        for (name in listOf("", "../secret", "a/b", "a\\b", "..", "a\u0000b")) assertNull(SaveProtocol.name(name))
    }
    @Test fun chunksAreBoundedButTotalOffsetsSupportLargeFiles() {
        SaveProtocol.chunk(5L * 1024 * 1024 * 1024, 5L * 1024 * 1024 * 1024, SaveProtocol.CHUNK_BYTES)
        for (size in listOf(0, -1, SaveProtocol.CHUNK_BYTES + 1)) assertThrows(IllegalArgumentException::class.java) { SaveProtocol.chunk(0, 0, size) }
        assertThrows(IllegalArgumentException::class.java) { SaveProtocol.chunk(1, 0, 1) }
        assertThrows(IllegalArgumentException::class.java) { SaveProtocol.chunk(Long.MAX_VALUE, Long.MAX_VALUE, 1) }
    }
}
