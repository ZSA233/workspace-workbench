package dev.paseo.pocket.updates

/** Main-thread ownership shared by the two lifecycle-owned update workers. */
class UpdateGate {
    enum class Target(val title: String) { APP("应用升级"), WEB("网页更新") }
    var owner: Target? = null
        private set
    private var generation = 0
    private val listeners = mutableSetOf<() -> Unit>()

    fun blocked(target: Target) = owner != null && owner != target
    fun subscribe(listener: () -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener); Unit }
    }
    fun acquire(target: Target): (() -> Unit)? {
        if (owner != null) return null
        val ticket = ++generation
        owner = target
        listeners.toList().forEach { it() }
        return release@{
            if (ticket != generation || owner != target) return@release
            generation++
            owner = null
            listeners.toList().forEach { it() }
        }
    }
}
