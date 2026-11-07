package app.core.sync

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.cache.CacheDatabaseHolder
import app.core.cache.ChatStore
import app.core.common.Clock
import app.core.common.Diag
import app.core.model.ConversationEndEvent
import app.core.model.RealtimeEvent
import app.core.model.ReceiptEvent
import app.core.model.TypingEvent
import app.core.net.ApiError
import app.core.realtime.RealtimeHealth
import app.core.testing.ChatApi
import app.core.testing.ChatApi.Companion.ME
import app.core.testing.ChatApi.Companion.PEER
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

/**
 * The chat's one door, on a virtual clock: what realtime events do to the
 * cache, what a reconnect costs, receipts and typing, the outbox's retries,
 * and the timers that run only in front.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class ChatSyncTest {

    private val dispatcher = StandardTestDispatcher()
    private val api = ChatApi()
    private val c = "1287390234923400001"

    private inner class Harness(test: TestScope) {
        val clock = Clock { test.testScheduler.currentTime }
        val holder = CacheDatabaseHolder(ApplicationProvider.getApplicationContext(), name = null, diag = Diag.Silent) {
            // The test's own clock and thread: every query runs when the test lets it.
            it.setQueryCoroutineContext(dispatcher).allowMainThreadQueries()
        }
        val store = ChatStore(holder, Diag.Silent)
        val sync = ChatSync(
            api = api,
            conversations = ConversationRepository(api, store, clock, Diag.Silent),
            messages = MessageRepository(api, store, clock, diag = Diag.Silent),
            requests = MessageRequestsRepository(api, clock, diag = Diag.Silent),
            scope = test.backgroundScope,
            clearStore = store::clearAll,
            keepOnly = store::keepOnly,
            clock = clock,
            diag = Diag.Silent,
        )

        suspend fun conversation() = sync.conversations.get(ME, c)
        suspend fun rows() = sync.messages.observeNewest(ME, c, 100).first()
    }

    private suspend fun TestScope.harness(): Harness {
        val h = Harness(this)
        // Opened here, off the test's clock, so every later query runs on it.
        h.holder.get()
        h.sync.setAccount(ME, active = true)
        h.sync.setForeground(true)
        runCurrent()
        return h
    }

    private fun message(id: Long, from: String = PEER) = RealtimeEvent.MessageArrived(id.toString(), null, api.message(c, id, from = from))

    @Test
    fun aRecoveredReconnectCostsNothingAndAnUnrecoveredOneOneListRead() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c)
        h.sync.onConnected(recovered = true, first = false)
        runCurrent()
        assertTrue(api.log.isEmpty())
        h.sync.onConnected(recovered = false, first = true)
        runCurrent()
        assertEquals(listOf("conversations"), api.log)
        assertEquals(c, h.conversation()?.conversationId)
    }

    @Test
    fun aMessageForTheThreadOnScreenIsReadAfterAPause() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c)
        api.fill(c, 1_000, 1)
        h.sync.reconcile("test")
        h.sync.openThread(c)
        h.sync.setVisible(c, shown = true)
        runCurrent()
        advanceTimeBy(1_000)
        runCurrent()
        api.receipts.clear()
        api.log.clear()

        h.sync.onEvent(message(1_001))
        runCurrent()
        assertEquals(listOf(1_000L, 1_001L), h.rows().mapNotNull { it.serverId }.sorted())
        assertEquals(0, h.conversation()!!.unread)
        assertTrue("debounced", api.receipts.isEmpty())
        advanceTimeBy(800)
        runCurrent()
        assertEquals("1001", api.receipts.single().second.readUpTo)
        assertEquals(1_001L, h.conversation()!!.myReadId)
    }

    @Test
    fun aMessageForAnotherThreadCountsAsUnreadAndIsAcknowledgedAsDelivered() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c)
        h.sync.reconcile("test")
        runCurrent()
        h.sync.onEvent(message(1_001))
        h.sync.onEvent(message(1_002))
        runCurrent()
        val row = h.conversation()!!
        assertEquals(2, row.unread)
        assertEquals(1_002L, row.lastMessageId)
        assertTrue("never read, not on screen: no transcript of one message and a gap", h.rows().isEmpty())
        advanceTimeBy(3_500)
        runCurrent()
        val delivered = api.receipts.single()
        assertEquals("1002", delivered.second.deliveredUpTo)
        assertNull(delivered.second.readUpTo)
    }

    @Test
    fun typingShowsForAFewSecondsAndAMessageEndsIt() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c)
        h.sync.reconcile("test")
        h.sync.onEvent(RealtimeEvent.PeerTyping("1", null, TypingEvent(c, PEER)))
        runCurrent()
        assertTrue(c in h.sync.typing.value)
        advanceTimeBy(5_100)
        runCurrent()
        assertFalse(c in h.sync.typing.value)
        h.sync.onEvent(RealtimeEvent.PeerTyping("2", null, TypingEvent(c, PEER)))
        h.sync.onEvent(message(1_001))
        runCurrent()
        assertFalse(c in h.sync.typing.value)
        // The account's own typing (another phone) is never shown.
        h.sync.onEvent(RealtimeEvent.PeerTyping("3", null, TypingEvent(c, ME)))
        runCurrent()
        assertFalse(c in h.sync.typing.value)
    }

    @Test
    fun receiptsMoveThePointers() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c, last = api.message(c, 1_005, from = ME))
        h.sync.reconcile("test")
        h.sync.onEvent(RealtimeEvent.ReceiptMoved("r1", null, ReceiptEvent(c, PEER, deliveredUpTo = "1005")))
        runCurrent()
        assertEquals(1_005L, h.conversation()!!.peerDeliveredId)
        assertNull(h.conversation()!!.peerReadId)
        h.sync.onEvent(RealtimeEvent.ReceiptMoved("r2", null, ReceiptEvent(c, PEER, readUpTo = "1005")))
        runCurrent()
        assertEquals(1_005L, h.conversation()!!.peerReadId)
    }

    @Test
    fun anEndedConversationLeavesTheList() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c)
        h.sync.reconcile("test")
        h.sync.onEvent(RealtimeEvent.ConversationEnded("e1", null, ConversationEndEvent(c).conversationId))
        runCurrent()
        assertNull(h.conversation())
    }

    @Test
    fun aMessageForAnUnknownConversationReadsTheListOnce() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c)
        h.sync.onEvent(message(1_001))
        h.sync.onEvent(message(1_002))
        runCurrent()
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(listOf("conversations"), api.log)
    }

    @Test
    fun aSendOfflineWaitsForTheNetworkWithTheSameClientId() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c)
        h.sync.reconcile("test")
        api.sendError = ApiError.Network(IOException("offline"))
        h.sync.send(c, "hello")
        runCurrent()
        advanceTimeBy(2_500)
        runCurrent()
        assertEquals(2, api.sent.size)
        api.sendError = null
        h.sync.onNetworkAvailable()
        runCurrent()
        assertEquals(3, api.sent.size)
        assertEquals(1, api.sent.map { it.clientId }.toSet().size)
        assertTrue(h.rows().single().serverId != null)
        assertEquals("the preview moved", "hello", app.core.cache.ChatMapping.lastMessage(h.conversation()!!)?.body)
    }

    @Test
    fun whileConnectedOnlyTheThirtyMinuteSafetyReadRuns() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c)
        h.sync.onHealth(RealtimeHealth.CONNECTED)
        runCurrent()
        advanceTimeBy(29 * 60_000L)
        runCurrent()
        assertTrue(api.log.isEmpty())
        advanceTimeBy(2 * 60_000L)
        runCurrent()
        assertEquals(listOf("conversations"), api.log)
    }

    @Test
    fun whileRealtimeFailsTheListIsReadOnABackingOffTimerAndNeverInTheBackground() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c)
        h.sync.onHealth(RealtimeHealth.DEGRADED)
        runCurrent()
        assertEquals(1, api.log.size)
        advanceTimeBy(61_000)
        runCurrent()
        assertEquals(2, api.log.size)
        advanceTimeBy(121_000)
        runCurrent()
        assertEquals("60 s, then 120 s", 3, api.log.size)
        h.sync.setForeground(false)
        runCurrent()
        advanceTimeBy(30 * 60_000L)
        runCurrent()
        assertEquals(3, api.log.size)
    }

    @Test
    fun typingGoesOutAtMostOnceEveryThreeSecondsAndOnlyWhileConnected() = runTest(dispatcher) {
        val h = harness()
        h.sync.typed(c)
        runCurrent()
        assertEquals(0, api.typing)
        h.sync.onHealth(RealtimeHealth.CONNECTED)
        repeat(5) {
            h.sync.typed(c)
            advanceTimeBy(500)
        }
        runCurrent()
        assertEquals(1, api.typing)
        advanceTimeBy(1_000)
        h.sync.typed(c)
        runCurrent()
        assertEquals(2, api.typing)
    }

    @Test
    fun anotherAccountStartsFromAnEmptyCache() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c)
        h.sync.reconcile("test")
        runCurrent()
        assertTrue(h.conversation() != null)
        h.sync.setAccount(null, active = false)
        runCurrent()
        assertNull(h.conversation())
    }
}
