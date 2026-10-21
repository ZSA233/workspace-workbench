package dev.paseo.pocket

object DockGeometry {
    /** Some older gesture shells report no lateral gesture insets and ignore exclusions.
     * A thin bottom gesture bar distinguishes them from ordinary three-button navigation. */
    fun legacyGestureGuard(api: Int, gestureLeft: Int, gestureRight: Int, navigationBottom: Int, density: Float): Int =
        if (api >= 29 && gestureLeft == 0 && gestureRight == 0 && navigationBottom > 0 && navigationBottom < 32 * density)
            (24 * density + .5f).toInt() else 0

    fun position(start: Float, end: Float, fraction: Float): Float =
        start + (end - start).coerceAtLeast(0f) * fraction.coerceIn(0f, 1f)
    fun fraction(position: Float, start: Float, end: Float): Float =
        if (end <= start) .5f else ((position - start) / (end - start)).coerceIn(0f, 1f)
}
