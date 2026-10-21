package dev.paseo.pocket.observation

import org.junit.Assert.*
import org.junit.Test

class BackgroundPolicyTest {
    private class Fixture {
        var now = 0L
        var pauses = 0
        var resumes = 0
        val work = mutableMapOf<Int, Pair<Long, () -> Unit>>()
        private var next = 0
        val events = mutableListOf<String>()
        val policy = BackgroundPolicy({ now }, { delay, action ->
            val id = ++next; work[id] = now + delay to action
            val cancel: () -> Unit = { work.remove(id); Unit }
            cancel
        }, { pauses++ }, { resumes++ }) { name, _ -> events.add(name) }
        fun advance(ms: Long) {
            val end = now + ms
            while (true) {
                val entry = work.entries.filter { it.value.first <= end }.minByOrNull { it.value.first } ?: break
                work.remove(entry.key); now = entry.value.first; entry.value.second()
            }
            now = end
        }
    }
    @Test fun shortBackgroundHasThirtySecondGraceAndNoReload() {
        val f = Fixture(); assertNull(f.policy.foreground())
        f.policy.background(); f.advance(29999); assertEquals(0, f.pauses)
        assertEquals(29999L, f.policy.foreground()); f.advance(60000)
        assertEquals(0, f.pauses); assertTrue(f.work.isEmpty())
    }
    @Test fun longBackgroundPausesExactlyOnceAtTheDeadline() {
        val f = Fixture(); f.policy.background(); f.advance(30000)
        assertEquals(1, f.pauses); assertTrue(f.policy.suspended)
        f.advance(30000); assertEquals(1, f.pauses)
        assertEquals(60000L, f.policy.foreground()); assertFalse(f.policy.suspended)
    }
    @Test fun duplicateStopAndPageReplacementDoNotResetTheDeadline() {
        val f = Fixture(); f.policy.background(); f.advance(10000)
        f.policy.background(); f.policy.pageReplaced(); f.advance(19999)
        assertEquals(0, f.pauses); f.advance(1); assertEquals(1, f.pauses)
        f.policy.pageReplaced(); assertEquals(2, f.pauses)
    }
    @Test fun cancelledCallbackCannotPauseTheNextForegroundOrAnotherGeneration() {
        val f = Fixture(); f.policy.background(); val late = f.work.values.single().second
        f.policy.foreground(); f.policy.background(); f.policy.pageReplaced()
        late(); assertEquals(0, f.pauses)
        f.advance(30000); assertEquals(1, f.pauses)
    }
    @Test fun destroyOnlyRetiresThisPolicyTimer() {
        val f = Fixture(); f.policy.background(); val late = f.work.values.single().second
        f.policy.close(); late(); f.advance(60000)
        assertEquals(0, f.pauses); assertEquals(0, f.resumes); assertTrue(f.work.isEmpty())
    }
}
