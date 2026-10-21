package dev.paseo.pocket

object WebRuntime {
    // Deliberate shell support floor for modern web syntax/APIs; use the newest
    // provider available for the OS. It does not claim upstream compatibility for every newer build.
    const val MINIMUM_CHROMIUM = 100
    fun chromiumMajor(userAgent: String): Int? = Regex("Chrome/([0-9]+)").find(userAgent)?.groupValues?.get(1)?.toIntOrNull()
}
