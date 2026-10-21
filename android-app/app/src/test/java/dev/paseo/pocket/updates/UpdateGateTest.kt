package dev.paseo.pocket.updates

import org.junit.Assert.*
import org.junit.Test

class UpdateGateTest {
    @Test fun onlyOneUpdateCanOwnTheTransferAndObserversSeeItsRelease() {
        val gate = UpdateGate()
        val events = mutableListOf<UpdateGate.Target?>()
        val stop = gate.subscribe { events.add(gate.owner) }
        val finish = requireNotNull(gate.acquire(UpdateGate.Target.WEB))
        assertTrue(gate.blocked(UpdateGate.Target.APP))
        assertNull(gate.acquire(UpdateGate.Target.APP))
        finish()
        val app = requireNotNull(gate.acquire(UpdateGate.Target.APP))
        assertTrue(gate.blocked(UpdateGate.Target.WEB))
        app(); stop()
        assertEquals(listOf(UpdateGate.Target.WEB, null, UpdateGate.Target.APP, null), events)
    }
    @Test fun oldCompletionCannotReleaseANewerOperation() {
        val gate = UpdateGate()
        val old = requireNotNull(gate.acquire(UpdateGate.Target.APP))
        old()
        val current = requireNotNull(gate.acquire(UpdateGate.Target.APP))
        old()
        assertEquals(UpdateGate.Target.APP, gate.owner)
        assertNull(gate.acquire(UpdateGate.Target.WEB))
        current()
        assertNull(gate.owner)
    }
}
