package dev.paseo.pocket

import android.content.Context

class ShellPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("shell", Context.MODE_PRIVATE)
    var route: String
        get() = prefs.getString("route", "/")?.takeIf { PageOrigin.safeRestorePath(PageOrigin.BASE + it) != null } ?: "/"
        set(value) { PageOrigin.safeRestorePath(value)?.let { prefs.edit().putString("route", it).apply() } }
    var dockRight: Boolean
        get() = prefs.getBoolean("dockRight", true)
        set(value) { prefs.edit().putBoolean("dockRight", value).apply() }
    var dockFraction: Float
        get() = prefs.getFloat("dockFraction", .68f).coerceIn(0f, 1f)
        set(value) { prefs.edit().putFloat("dockFraction", value.coerceIn(0f, 1f)).apply() }
    var appearance: String
        get() = prefs.getString("appearance", "system") ?: "system"
        set(value) { require(value in setOf("system", "light", "dark")); prefs.edit().putString("appearance", value).apply() }
    var customSource: Boolean
        get() = prefs.getBoolean("customSource", false)
        set(value) { prefs.edit().putBoolean("customSource", value).apply() }
    var customSourceUrl: String
        get() = prefs.getString("customSourceUrl", "") ?: ""
        set(value) { prefs.edit().putString("customSourceUrl", value).apply() }
    fun updateUrl(official: String): String = if (customSource) customSourceUrl else official
}
