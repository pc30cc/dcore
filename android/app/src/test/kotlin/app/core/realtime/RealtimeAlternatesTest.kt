package app.core.realtime

import app.core.common.Diag
import app.core.model.RealtimeEvent
import app.core.model.RealtimeToken
import app.core.testing.FakeCentrifugo
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import kotlin.random.Random

/**
 * The realtime socket's fallback hosts (the signed origins list's
 * `hosts.realtime`): the token's address first, the alternates only after it
 * failed twice in a row, and back to the token's address once connected.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RealtimeAlternatesTest {

    private val server = FakeCentrifugo()

    private fun TestScope.client(alternates: List<String>): RealtimeClient {
        val sink = object : RealtimeSink {
            override fun onEvent(event: RealtimeEvent) = Unit
            override fun onConnected(recovered: Boolean, first: Boolean) = Unit
            override fun onHealth(health: RealtimeHealth) = Unit
        }
        return RealtimeClient(
            tokens = { RealtimeToken(TOKEN_URL, "t", Instant.ofEpochMilli(testScheduler.currentTime + 3_600_000), FakeCentrifugo.CHANNEL) },
            transport = server,
            sink = sink,
            fallbackUrl = "wss://build.test/connection/websocket",
            clock = { testScheduler.currentTime },
            random = Random(7),
            diag = Diag.Silent,
            alternates = { alternates },
        )
    }

    @Test
    fun theAlternatesAreTriedAfterTwoFailuresInARow() = runTest {
        server.failOpens = 3
        val client = client(listOf(ALT_1, ALT_2))
        backgroundScope.launch { client.run() }
        runCurrent()
        advanceTimeBy(30_000)
        runCurrent()
        assertEquals(listOf(TOKEN_URL, TOKEN_URL, ALT_1, ALT_2), server.opens)
    }

    @Test
    fun theRotationComesBackToTheTokensAddress() = runTest {
        val client = client(listOf(ALT_1))
        val token = RealtimeToken(TOKEN_URL, "t", Instant.EPOCH, FakeCentrifugo.CHANNEL)
        assertEquals(TOKEN_URL, client.socketUrl(token, failures = 0))
        assertEquals(TOKEN_URL, client.socketUrl(token, failures = 1))
        assertEquals(ALT_1, client.socketUrl(token, failures = 2))
        assertEquals(TOKEN_URL, client.socketUrl(token, failures = 3))
        assertEquals(ALT_1, client.socketUrl(token, failures = 4))
    }

    @Test
    fun withoutAlternatesNothingChanges() = runTest {
        val client = client(emptyList())
        val token = RealtimeToken(TOKEN_URL, "t", Instant.EPOCH, FakeCentrifugo.CHANNEL)
        assertEquals(TOKEN_URL, client.socketUrl(token, failures = 5))
        // Only WebSocket addresses are ever used as alternates.
        val odd = client(listOf("https://rt.test"))
        assertEquals(TOKEN_URL, odd.socketUrl(token, failures = 2))
    }

    private companion object {
        const val TOKEN_URL = "wss://rt.test/connection/websocket"
        const val ALT_1 = "wss://rt1.test/connection/websocket"
        const val ALT_2 = "wss://rt2.test/connection/websocket"
    }
}
