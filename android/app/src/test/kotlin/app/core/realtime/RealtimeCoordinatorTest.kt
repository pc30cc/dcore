package app.core.realtime

import app.core.common.Diag
import app.core.model.RealtimeEvent
import app.core.model.RealtimeToken
import app.core.testing.FakeCentrifugo
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** One socket exactly while the app is in front and an account may chat; none otherwise. */
@OptIn(ExperimentalCoroutinesApi::class)
class RealtimeCoordinatorTest {

    private class Listener : RealtimeListener {
        val events = mutableListOf<RealtimeEvent>()
        val connects = mutableListOf<Pair<Boolean, Boolean>>()
        var health = RealtimeHealth.IDLE
        var networks = 0
        override fun onEvent(event: RealtimeEvent) { events += event }
        override fun onConnected(recovered: Boolean, first: Boolean) { connects += recovered to first }
        override fun onHealth(health: RealtimeHealth) { this.health = health }
        override fun onNetworkAvailable() { networks++ }
    }

    @Test
    fun aSocketOnlyInFrontAndSignedIn() = runTest {
        val server = FakeCentrifugo()
        val listener = Listener()
        var tokens = 0
        val clock = { testScheduler.currentTime }
        val coordinator = RealtimeCoordinator(
            clientFactory = { sink, positions ->
                RealtimeClient(
                    tokens = { tokens++; RealtimeToken("wss://rt.test/c", "t$tokens", Instant.ofEpochMilli(clock() + 3_600_000), FakeCentrifugo.CHANNEL) },
                    transport = server,
                    sink = sink,
                    fallbackUrl = "wss://rt.test/c",
                    positions = positions,
                    clock = clock,
                    diag = Diag.Silent,
                )
            },
            listener = listener,
            scope = backgroundScope,
            diag = Diag.Silent,
        )
        runCurrent()
        coordinator.setAccount("abcdefghijklm")
        runCurrent()
        assertTrue("signed in but in the background: no socket", server.opens.isEmpty())

        coordinator.setForeground(true)
        runCurrent()
        assertEquals(1, server.opens.size)
        assertEquals(RealtimeHealth.CONNECTED, coordinator.health.value)
        assertEquals(listOf(false to true), listener.connects)

        server.publish(FakeCentrifugo.message(1001))
        runCurrent()
        assertEquals(1, listener.events.size)

        // To the background: the socket closes and nothing reopens it.
        coordinator.setForeground(false)
        runCurrent()
        assertTrue(server.sockets.single().closed)
        assertEquals(RealtimeHealth.IDLE, coordinator.health.value)
        advanceTimeBy(10 * 60_000)
        runCurrent()
        assertEquals(1, server.opens.size)

        // Back within the history window: recovered, the token reused.
        server.publish(FakeCentrifugo.message(1002))
        coordinator.setForeground(true)
        runCurrent()
        assertEquals(2, server.opens.size)
        assertEquals(true to true, listener.connects.last())
        assertEquals(listOf("1001", "1002"), listener.events.filterIsInstance<RealtimeEvent.MessageArrived>().map { it.message.id })

        // Another account: a new socket, and the old positions are not used.
        coordinator.setAccount("zzzzzzzzzzzzz")
        runCurrent()
        assertEquals(3, server.opens.size)
        assertEquals(false to true, listener.connects.last())

        coordinator.setAccount(null)
        runCurrent()
        assertTrue(server.sockets.all { it.closed })
    }

    @Test
    fun theNetworkReturningReachesTheSyncLayer() = runTest {
        val listener = Listener()
        val coordinator = RealtimeCoordinator(
            clientFactory = { _, _ -> error("not started") },
            listener = listener,
            scope = backgroundScope,
            diag = Diag.Silent,
        )
        coordinator.onNetworkAvailable()
        assertEquals(1, listener.networks)
    }
}
