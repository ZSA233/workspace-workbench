package dev.paseo.pocket.observation

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import dev.paseo.pocket.R
import dev.paseo.pocket.ShellUi
import java.util.Locale
import java.text.DateFormat
import java.util.Date

class ObservationUi(private val observation: ObservationController) {
    private val handler = Handler(Looper.getMainLooper())
    private var off: (() -> Unit)? = null
    private var repaint: (() -> Unit)? = null
    private fun needsClock(): Boolean {
        val trace = observation.trace
        return observation.isForeground && (observation.isRecording || trace.adapter == "initializing" ||
            (trace.adapter == "attached" && trace.hosts.any { it.observation.phase in setOf("connecting", "syncing") }))
    }
    private val tick = object : Runnable {
        override fun run() { if (repaint != null && needsClock()) { repaint?.invoke(); handler.postDelayed(this, 1000) } }
    }
    fun summary(): String {
        val trace = observation.trace
        if (trace.adapter !in setOf("attached", "initializing")) return "详细连接状态不可用"
        if (trace.progress < 100) return "加载网页 · ${trace.progress}%"
        if (trace.adapter != "attached") return "连接与性能查看"
        val host = trace.hosts.firstOrNull { it.observation.selected } ?: trace.hosts.firstOrNull()
        return host?.let { phase(it.observation.phase) } ?: "尚未添加主机"
    }
    fun content(context: Context): View {
        val root = ShellUi.column(context)
        val card = ShellUi.column(context).apply {
            setPadding(ShellUi.dp(context, 14), ShellUi.dp(context, 14), ShellUi.dp(context, 14), ShellUi.dp(context, 14))
            ShellUi.paint(this, R.color.shell_soft, radius = 16)
        }
        val status = ShellUi.text(context, "", medium = true).apply { id = R.id.observation_status }
        val details = ShellUi.text(context, "", 12f, muted = true)
        val progress = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }
        ShellUi.add(card, status); ShellUi.add(card, progress); ShellUi.add(card, details)
        ShellUi.add(root, card)
        val check = ShellUi.button(context, "检查连接", action = observation::verify)
        ShellUi.add(root, check)
        var expanded = false
        val metrics = ShellUi.text(context, "", 12f).apply { id = R.id.observation_performance; visibility = View.GONE }
        lateinit var toggle: com.google.android.material.button.MaterialButton
        toggle = ShellUi.button(context, "查看性能") {
            expanded = !expanded; observation.expandPerformance(expanded)
            metrics.visibility = if (expanded) View.VISIBLE else View.GONE
            toggle.text = if (expanded) "收起性能" else "查看性能"
        }
        ShellUi.add(root, toggle); ShellUi.add(root, metrics)
        val recording = ShellUi.button(context, "录制 60 秒诊断") {
            if (observation.isRecording) observation.endRecording() else observation.startRecording()
        }
        ShellUi.add(root, recording)
        ShellUi.add(root, ShellUi.text(context, "就绪表示主机连接与会话列表已准备好，不包含会话历史和附件加载。阶段耗时从实际观测到的起点计算。", 12f, muted = true))
        ShellUi.add(root, ShellUi.text(context, "后台保留 30 秒运行机会，之后休眠。性能查看仅在前台采样；录制可在关闭面板后继续，切到后台即结束。", 12f, muted = true))
        val render = {
            val trace = observation.trace
            status.show(summary())
            progress.visibility = if (trace.progress < 100 && trace.adapter in setOf("initializing", "attached")) View.VISIBLE else View.GONE
            if (progress.progress != trace.progress) progress.progress = trace.progress
            details.show(buildString {
                trace.pageLoadedMs?.let { append("本地网页加载 ${seconds(it)}\n") }
                if (trace.adapter != "attached") {
                    append(if (trace.adapter == "initializing") "等待网页连接状态；已等待 ${seconds(trace.elapsed())}。"
                        else "详细连接状态不可用，网页可继续使用。")
                } else if (trace.hosts.isEmpty()) append("在网页中添加主机后，这里会显示连接状态。")
                else trace.hosts.forEachIndexed { index, host ->
                    if (index > 0) append("\n\n")
                    val value = host.observation
                    append("主机 ${value.host}${if (value.selected) " · 当前" else ""} · ${transport(value.transport)}\n")
                    append(phase(value.phase))
                    if (value.reason != "none") append(" · ${when (value.reason) {
                        "auth" -> "认证问题"; "sync" -> "列表同步失败"; "timeout" -> "验证或连接超时"; "network" -> "网络连接异常"; else -> "原因待确认"
                    }}")
                    if (host.readyMs == null && value.phase in setOf("connecting", "syncing"))
                        append(" · 已等待 ${seconds((SystemClock.elapsedRealtime() - host.cycleStart).coerceAtLeast(0))}")
                    host.connectionMs?.let { append("\n连接观察耗时 ${seconds(it)}") }
                        ?: if (value.phase in setOf("syncing", "ready")) append("\n连接起点未观测到") else Unit
                    host.syncMs?.let { append(" · 同步 ${seconds(it)}") }
                    (host.totalReadyMs ?: host.readyMs)?.let { append("\n本轮就绪 ${seconds(it)}") }
                        ?: if (value.phase == "ready") append("\n首次观察时已就绪") else Unit
                    value.rttMs?.let { rtt ->
                        val age = (value.rttAgeMs ?: 0) + (SystemClock.elapsedRealtime() - host.receivedAt).coerceAtLeast(0)
                        val observedAt = DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date(System.currentTimeMillis() - age))
                        append("\n现有心跳延迟 ${rtt}ms · $observedAt 观察")
                    }
                }
            })
            check.isEnabled = observation.isForeground && trace.adapter == "attached" && !trace.verifying
            check.show(if (trace.verifying) "正在检查连接…" else "检查连接")
            val reading = observation.performance
            metrics.show(buildString {
                append("CPU（App 进程，单核 100%）：${reading.cpuPercent?.let { String.format(Locale.ROOT, "%.1f%%", it) } ?: "采样中"}\n")
                append("内存（App 进程 PSS）：${reading.pssKiB?.let { String.format(Locale.ROOT, "%.1f MiB", it / 1024.0) } ?: "不可用"}\n")
                append("App UID 收／发：${rate(reading.rxBps)} / ${rate(reading.txBps)}\n")
                append(when (trace.taskSupported) {
                    true -> "网页长任务：${trace.taskCount} 次 · 累计 ${trace.taskTotalMs}ms · 最长 ${trace.taskMaxMs}ms"
                    false -> "网页长任务：当前引擎不支持"
                    null -> if (trace.adapter == "attached") "网页长任务：等待观察" else "网页长任务：当前网页适配不可用"
                })
                append("\n\nCPU、内存不代表整个 WebView；流量不专属于主机连接。长任务不等于整体帧率。")
            })
            recording.show(if (observation.isRecording) "结束录制 · 剩余 ${(observation.recordingRemainingMs + 999) / 1000} 秒" else "录制 60 秒诊断")
        }
        root.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(view: View) {
                detach(); repaint = render
                off = observation.subscribe {
                    if (observation.isForeground) render()
                    handler.removeCallbacks(tick)
                    if (needsClock()) handler.postDelayed(tick, 1000)
                }
                observation.expandPerformance(expanded)
                render(); if (needsClock()) handler.post(tick)
            }
            override fun onViewDetachedFromWindow(view: View) { detach() }
        })
        return root
    }
    fun detach() {
        off?.invoke(); off = null; repaint = null; handler.removeCallbacks(tick)
        observation.expandPerformance(false)
    }
    companion object {
        private fun TextView.show(value: String) { if (text.toString() != value) text = value }
        fun phase(value: String) = when (value) {
            "ready" -> "就绪"; "syncing" -> "同步列表"; "connecting" -> "连接主机"; "error" -> "连接或同步出错"; else -> "离线"
        }
        private fun transport(value: String) = when (value) { "relay" -> "Relay"; "directTcp" -> "直接连接"; "remoteSsh" -> "SSH"; "directSocket", "directPipe" -> "本地连接"; else -> "连接方式待确认" }
        private fun seconds(value: Long) = String.format(Locale.ROOT, "%.1f 秒", value / 1000.0)
        private fun rate(value: Long?) = value?.let { String.format(Locale.ROOT, "%.1f KiB/s", it / 1024.0) } ?: "不可用"
    }
}
