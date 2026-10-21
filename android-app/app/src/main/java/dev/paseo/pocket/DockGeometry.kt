package dev.paseo.pocket

object DockGeometry {
    fun position(start: Float, end: Float, fraction: Float): Float =
        start + (end - start).coerceAtLeast(0f) * fraction.coerceIn(0f, 1f)
    fun fraction(position: Float, start: Float, end: Float): Float =
        if (end <= start) .5f else ((position - start) / (end - start)).coerceIn(0f, 1f)
}
