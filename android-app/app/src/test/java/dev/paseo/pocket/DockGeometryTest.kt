package dev.paseo.pocket

import org.junit.Assert.*
import org.junit.Test

class DockGeometryTest {
    @Test fun gestureGuardDistinguishesMissingInsetsFromThreeButtonNavigation() {
        assertEquals(48, DockGeometry.legacyGestureGuard(29, 0, 0, 32, 2f))
        assertEquals(0, DockGeometry.legacyGestureGuard(37, 48, 48, 32, 2f))
        assertEquals(0, DockGeometry.legacyGestureGuard(29, 0, 0, 96, 2f))
        assertEquals(0, DockGeometry.legacyGestureGuard(26, 0, 0, 32, 2f))
        assertEquals(0, DockGeometry.legacyGestureGuard(29, 0, 0, 0, 2f))
    }
    @Test fun clampAndRestoreDockAcrossKeyboardBounds() {
        val fraction = DockGeometry.fraction(680f, 0f, 1000f)
        assertEquals(680f, DockGeometry.position(0f, 1000f, fraction), .01f)
        assertEquals(340f, DockGeometry.position(0f, 500f, fraction), .01f)
        assertEquals(680f, DockGeometry.position(0f, 1000f, fraction), .01f)
        assertEquals(10f, DockGeometry.position(10f, 5f, .9f), .01f)
    }
}
