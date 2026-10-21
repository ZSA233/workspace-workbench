package dev.paseo.pocket

import org.junit.Assert.*
import org.junit.Test

class DockGeometryTest {
    @Test fun clampAndRestoreDockAcrossKeyboardBounds() {
        val fraction = DockGeometry.fraction(680f, 0f, 1000f)
        assertEquals(680f, DockGeometry.position(0f, 1000f, fraction), .01f)
        assertEquals(340f, DockGeometry.position(0f, 500f, fraction), .01f)
        assertEquals(680f, DockGeometry.position(0f, 1000f, fraction), .01f)
        assertEquals(10f, DockGeometry.position(10f, 5f, .9f), .01f)
    }
}
