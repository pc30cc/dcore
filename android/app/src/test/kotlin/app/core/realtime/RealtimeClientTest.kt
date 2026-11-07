package app.core.realtime

import app.core.common.Diag
import app.core.model.RealtimeEvent
import app.core.model.RealtimeToken
import app.core.net.ApiError
import app.core.testing.FakeCentrifugo
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import kotlin.random.Random

/**
 * The realtime client against a scripted server on a virtual clock:
 * connect, the personal channel, recovery, dedupe, in-band refresh, backoff,
 * terminal codes, stale sockets, signed out.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RealtimeClientTest {

    private class Harness(val test: TestScope) {
        val server = FakeCentrifugo()
        val events = mutableListOf<RealtimeEvent>()
        val connects = mutableListOf<Pair<Boolean, Boolean>>()
        val health = mutableListOf<RealtimeHealth>()
        var tokens = 0
        var ttlMs = 3_600_000L
        var tokenError: Throwable? = null
        var wsUrl = "wss://rt.test/connection/websocket"
        val positions = RealtimePositions()
        val clock: () -> Long = { test.testScheduler.currentTime }

        val sink = object : RealtimeSink {
            override fun onEvent(event: RealtimeEvent) { events += event }
            override fun onConnected(recovered: Boolean, first: Boolean) { connects += recovered to first }
            override fun onHealth(health: RealtimeHealth) { this@Harness.health += health }
        }

        val client = RealtimeClient(
            tokens = {
                tokens++
                tokenError?.let { throw it }
                RealtimeToken(wsUrl, "t$tokens", Instant.ofEpochMilli(clock() + ttlMs), FakeCentrifugo.CHANNEL)
            },
            transport = server,
            sink = sink,
            fallbackUrl = "wss://fallback.test/connection/websocket",
            positions = positions,
            clock = clock,
            random = Random(7),
            diag = Diag.Silent,
        )

        var job: Job? = null

        fun start() {
            job = test.backgroundScope.launch { client.run() }
            test.runCurrent()
        }

        /** The server's ping every 25 s, so a long quiet test is not a stale socket. */
        fun keepAlive() {
            test.backgroundScope.launch {
                while (true) {
                    delay(25_000)
                    server.ping()
                }
            }
        }

        fun messages(): List<String> = events.filterIsInstance<RealtimeEvent.MessageArrived>().map { it.message.id }
    }

    private fun JsonObject.sub(): JsonObject = this["subscribe"]!!.jsonObject

    @Test
    fun connectsSubscribesThePersonalChannelAndDelivers() = runTest {
        val h = Harness(this)
        h.start()
        val commands = h.server.commands
        assertEquals("t1", commands[0]["connect"]!!.jsonObject["token"]!!.jsonPrimitive.content)
        assertEquals(FakeCentrifugo.CHANNEL, commands[1].sub()["channel"]!!.jsonPrimitive.content)
        assertNull("no recovery without a position", commands[1].sub()["recover"])
        assertEquals(RealtimeHealth.CONNECTED, h.health.last())
        assertEquals(listOf(false to true), h.connects)
        assertEquals(listOf("wss://rt.test/connection/websocket"), h.server.opens)

        h.server.publish(FakeCentrifugo.message(1001))
        runCurrent()
        assertEquals(listOf("1001"), h.messages())
    }

    @Test
    fun answersEveryPing() = runTest {
        val h = Harness(this)
        h.start()
        h.server.ping()
        h.server.ping()
        runCurrent()
        assertEquals(2, h.server.current!!.pongs)
    }

    @Test
    fun theSameEventTwiceIsDeliveredOnce() = runTest {
        val h = Harness(this)
        h.start()
        h.server.publish(FakeCentrifugo.message(1001))
        h.server.publish(FakeCentrifugo.message(1001))
        h.server.publishEphemeral(FakeCentrifugo.typing(5))
        h.server.publishEphemeral(FakeCentrifugo.typing(5))
        runCurrent()
        assertEquals(listOf("1001"), h.messages())
        assertEquals(1, h.events.count { it is RealtimeEvent.PeerTyping })
    }

    @Test
    fun aShortDropIsRecoveredFromHistoryWithNoNewTokenAndNoRead() = runTest {
        val h = Harness(this)
        h.start()
        h.server.publish(FakeCentrifugo.message(1001))
        runCurrent()
        h.server.drop()
        runCurrent()
        // Published while the phone was away.
        h.server.publish(FakeCentrifugo.message(1002))
        h.server.publish(FakeCentrifugo.message(1003))
        advanceTimeBy(2_000)
        runCurrent()

        assertEquals(2, h.server.sockets.size)
        val resume = h.server.commandsOf("subscribe").last().sub()
        assertEquals("true", resume["recover"]!!.jsonPrimitive.content)
        assertEquals("1", resume["offset"]!!.jsonPrimitive.content)
        assertEquals(true to false, h.connects.last())
        assertEquals(listOf("1001", "1002", "1003"), h.messages())
        assertEquals("the token was reused", 1, h.tokens)
    }

    @Test
    fun aNewEpochIsNotRecovered() = runTest {
        val h = Harness(this)
        h.start()
        h.server.publish(FakeCentrifugo.message(1001))
        runCurrent()
        h.server.drop()
        h.server.newEpoch()
        advanceTimeBy(2_000)
        runCurrent()
        assertEquals(false to false, h.connects.last())
    }

    @Test
    fun anUnrecoverablePositionSubscribesPlainly() = runTest {
        val h = Harness(this)
        h.start()
        h.server.publish(FakeCentrifugo.message(1001))
        runCurrent()
        h.server.unrecoverableError = true
        h.server.drop()
        advanceTimeBy(2_000)
        runCurrent()
        val subscribes = h.server.commandsOf("subscribe")
        assertEquals(3, subscribes.size)
        assertNull(subscribes.last().sub()["recover"])
        assertEquals(RealtimeHealth.CONNECTED, h.health.last())
        assertEquals(false to false, h.connects.last())
    }

    @Test
    fun theTokenIsRefreshedInBandBeforeItExpires() = runTest {
        val h = Harness(this)
        h.ttlMs = 10 * 60_000L
        h.keepAlive()
        h.start()
        advanceTimeBy(7 * 60_000L)
        runCurrent()
        assertTrue(h.server.commandsOf("refresh").isEmpty())
        advanceTimeBy(70_000L)
        runCurrent()
        val refresh = h.server.commandsOf("refresh").single()
        assertEquals("t2", refresh["refresh"]!!.jsonObject["token"]!!.jsonPrimitive.content)
        assertEquals("no new socket", 1, h.server.sockets.size)
        // And again before the new token runs out.
        advanceTimeBy(9 * 60_000L)
        runCurrent()
        assertEquals(2, h.server.commandsOf("refresh").size)
        assertEquals(1, h.server.sockets.size)
        assertEquals(listOf(false to true), h.connects)
    }

    @Test
    fun aRefusedRefreshReconnectsWithAFreshToken() = runTest {
        val h = Harness(this)
        h.ttlMs = 10 * 60_000L
        h.keepAlive()
        h.server.refreshError = 109
        h.start()
        advanceTimeBy(8 * 60_000L + 5_000)
        runCurrent()
        h.server.refreshError = null
        advanceTimeBy(3_000)
        runCurrent()
        assertEquals(2, h.server.sockets.size)
        assertEquals("the refused one, then a fresh one", 3, h.tokens)
    }

    @Test
    fun anExpiredTokenAtConnectIsReplaced() = runTest {
        val h = Harness(this)
        h.server.connectError = 109
        h.start()
        h.server.connectError = null
        advanceTimeBy(2_000)
        runCurrent()
        assertEquals(2, h.tokens)
        assertEquals(RealtimeHealth.CONNECTED, h.health.last())
    }

    @Test
    fun aTerminalDisconnectWaitsAtLeastThirtySeconds() = runTest {
        val h = Harness(this)
        h.start()
        h.server.disconnect(3501)
        runCurrent()
        advanceTimeBy(29_000)
        runCurrent()
        assertEquals(1, h.server.opens.size)
        advanceTimeBy(8_000)
        runCurrent()
        assertEquals(2, h.server.opens.size)
    }

    @Test
    fun aQuietSocketIsDeadAfterSixtySeconds() = runTest {
        val h = Harness(this)
        h.start()
        advanceTimeBy(59_000)
        runCurrent()
        assertEquals(1, h.server.opens.size)
        advanceTimeBy(4_000)
        runCurrent()
        advanceTimeBy(2_000)
        runCurrent()
        assertEquals(2, h.server.opens.size)
    }

    @Test
    fun failuresBackOffAndTheNetworkCutsTheWaitShort() = runTest {
        val h = Harness(this)
        h.server.failOpens = 10
        h.start()
        advanceTimeBy(1_300)
        runCurrent()
        advanceTimeBy(2_500)
        runCurrent()
        assertEquals(3, h.server.opens.size)
        assertEquals("degraded after two failures", RealtimeHealth.DEGRADED, h.health.last())
        // Next wait is about 4 s; the network comes back now.
        h.client.nudge()
        runCurrent()
        assertEquals(4, h.server.opens.size)
    }

    @Test
    fun backoffSteps() {
        val client = Harness(TestScope()).client
        repeat(20) {
            assertTrue(client.backoff(1, terminal = false) in 800L..1_200L)
            assertTrue(client.backoff(4, terminal = false) in 6_400L..9_600L)
            assertTrue(client.backoff(9, terminal = false) in 24_000L..36_000L)
            assertTrue(client.backoff(1, terminal = true) >= 30_000L)
        }
    }

    @Test
    fun signedOutStopsTheClient() = runTest {
        val h = Harness(this)
        h.tokenError = ApiError.Unauthorized(null)
        h.start()
        assertTrue(h.job!!.isCompleted)
        assertEquals(RealtimeHealth.IDLE, h.health.last())
        assertTrue(h.server.opens.isEmpty())
    }

    @Test
    fun aServerSideChannelComesWithTheConnectAndIsRecoveredThere() = runTest {
        val h = Harness(this)
        h.server.serverSide = true
        h.start()
        assertTrue("no client subscribe", h.server.commandsOf("subscribe").isEmpty())
        h.server.publish(FakeCentrifugo.message(1001))
        runCurrent()
        h.server.drop()
        h.server.publish(FakeCentrifugo.message(1002))
        advanceTimeBy(2_000)
        runCurrent()
        val subs = h.server.commandsOf("connect").last()["connect"]!!.jsonObject["subs"]!!.jsonObject
        assertEquals("1", subs[FakeCentrifugo.CHANNEL]!!.jsonObject["offset"]!!.jsonPrimitive.content)
        assertEquals(true to false, h.connects.last())
        assertEquals(listOf("1001", "1002"), h.messages())
    }

    @Test
    fun theTokensAddressIsUsedAndAnythingElseFallsBack() = runTest {
        val h = Harness(this)
        h.wsUrl = "https://not-a-socket.test"
        h.start()
        assertEquals("wss://fallback.test/connection/websocket", h.server.opens.single())
    }

    @Test
    fun aLifetimeThePhoneClockCannotHaveIsReplacedByAGuess() {
        val h = Harness(TestScope())
        val token = RealtimeToken("wss://x", "t", Instant.ofEpochMilli(1_000 + 60_000), FakeCentrifugo.CHANNEL)
        assertEquals(1_000 + 25 * 60_000L, h.client.deadlineOf(token, receivedAt = 1_000))
        val fine = RealtimeToken("wss://x", "t", Instant.ofEpochMilli(1_000 + 3_600_000), FakeCentrifugo.CHANNEL)
        assertEquals(1_000 + 3_600_000L, h.client.deadlineOf(fine, receivedAt = 1_000))
    }
}
