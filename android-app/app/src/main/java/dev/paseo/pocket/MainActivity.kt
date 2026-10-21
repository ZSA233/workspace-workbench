package dev.paseo.pocket

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    private lateinit var session: WebSession
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        session = WebSession(this, ShellPreferences(this))
        setContentView(session.webView)
        session.start()
    }

    override fun onResume() { super.onResume(); if (::session.isInitialized) session.webView.onResume() }
    override fun onPause() { if (::session.isInitialized) session.webView.onPause(); super.onPause() }
    override fun onDestroy() { if (::session.isInitialized) session.destroy(); super.onDestroy() }
}
