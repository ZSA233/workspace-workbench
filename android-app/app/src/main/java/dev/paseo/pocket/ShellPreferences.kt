package dev.paseo.pocket

import android.content.Context

class ShellPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("shell", Context.MODE_PRIVATE)
    var route: String
        get() = prefs.getString("route", "/")?.takeIf { PageOrigin.safeRestorePath(PageOrigin.BASE + it) != null } ?: "/"
        set(value) { PageOrigin.safeRestorePath(value)?.let { prefs.edit().putString("route", it).apply() } }
}
