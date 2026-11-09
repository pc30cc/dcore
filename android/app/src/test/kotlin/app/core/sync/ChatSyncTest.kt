package app.core.sync

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.cache.CacheDatabaseHolder
import app.core.cache.ChatStore
import app.core.common.Clock
import app.core.common.Diag
import app.core.model.ConversationChange
import app.core.model.ConversationEndEvent
import app.core.model.ConversationEvent
import app.core.model.ConversationState
import app.core.model.IncomingRequest
import app.core.model.PeerSummary
import app.core.model.Problem
import app.core.model.ProblemCodes
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
import java.time.Instant

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
        // Past the server's 2 s between two read receipts of one conversation.
        advanceTimeBy(2_000)
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

    /** A thread on screen with its first read receipt (for 1000) sent at about 700 ms. */
    private suspend fun TestScope.openWithOneMessage(): Harness {
        val h = harness()
        api.conversation(c)
        api.fill(c, 1_000, 1)
        h.sync.reconcile("test")
        h.sync.openThread(c)
        h.sync.setVisible(c, shown = true)
        runCurrent()
        return h
    }

    @Test
    fun aSecondReadReceiptWaitsForTheServersTwoSecondsBetweenThem() = runTest(dispatcher) {
        val h = openWithOneMessage()
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals("1000", api.receipts.single().second.readUpTo)

        h.sync.onEvent(message(1_001))
        runCurrent()
        advanceTimeBy(800)
        runCurrent()
        assertEquals("not 1 s after the last: the server would refuse it", 1, api.receipts.size)
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(listOf("1000", "1001"), api.receipts.map { it.second.readUpTo })
        assertEquals(1_001L, h.conversation()!!.myReadId)
    }

    @Test
    fun aRefusedReadReceiptIsSentAgainAfterItsRetryAfter() = runTest(dispatcher) {
        api.receiptErrors += ApiError.Http(429, Problem.of(429, ProblemCodes.RATE_LIMITED, "retryAfterSeconds" to 3))
        val h = openWithOneMessage()
        advanceTimeBy(1_000)
        runCurrent()
        assertTrue("the first one was refused", api.receipts.isEmpty())
        advanceTimeBy(2_000)
        runCurrent()
        assertTrue("not before its Retry-After", api.receipts.isEmpty())
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals("1000", api.receipts.single().second.readUpTo)
        assertEquals(1_000L, h.conversation()!!.myReadId)
    }

    @Test
    fun aReadReceiptAnswered404EndsTheConversation() = runTest(dispatcher) {
        api.receiptErrors += ApiError.Http(404, Problem.of(404, ProblemCodes.NOT_FOUND))
        val h = openWithOneMessage()
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(ConversationState.Ended.wire, h.conversation()!!.state)
    }

    @Test
    fun aSendIntoAConversationThatEndedEndsItHereToo() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c)
        h.sync.reconcile("test")
        // Sends, receipts and typing answer 404 for an ended conversation; only its history says 410.
        api.sendError = ApiError.Http(404, Problem.of(404, ProblemCodes.NOT_FOUND))
        h.sync.send(c, "still there?")
        runCurrent()
        assertEquals("tried once, not again", 1, api.sent.size)
        assertEquals(ProblemCodes.CONVERSATION_ENDED, h.rows().single().errorCode)
        assertEquals(ConversationState.Ended.wire, h.conversation()!!.state)
    }

    @Test
    fun anAcceptedRequestLeavesTheBoxesWhenItsConversationArrives() = runTest(dispatcher) {
        val h = harness()
        val from = PeerSummary(PEER, "Negar")
        h.sync.requests.onRealtime(IncomingRequest("1287390234923440001", from, "Hello", Instant.parse("2026-11-06T09:14:03.120Z")))
        assertEquals(1, h.sync.requests.inbox.value.items.size)
        h.sync.onEvent(RealtimeEvent.ConversationChanged("1287390234923400001", null, ConversationEvent(api.conversation(c), ConversationChange.Updated)))
        runCurrent()
        assertEquals("a settings change is not an accept", 1, h.sync.requests.inbox.value.items.size)
        h.sync.onEvent(RealtimeEvent.ConversationChanged("1287390234923400002", null, ConversationEvent(api.conversation(c), ConversationChange.Accepted)))
        runCurrent()
        assertTrue(h.sync.requests.inbox.value.items.isEmpty())
        assertEquals(c, h.conversation()?.conversationId)
    }

    @Test
    fun typingIsOneSignalEveryThreeSecondsForThePersonWhicheverConversation() = runTest(dispatcher) {
        val h = harness()
        h.sync.onHealth(RealtimeHealth.CONNECTED)
        h.sync.typed(c)
        advanceTimeBy(1_000)
        h.sync.typed("1287390234923400002")
        runCurrent()
        assertEquals("the server counts typing per person", 1, api.typing)
        advanceTimeBy(2_100)
        h.sync.typed("1287390234923400002")
        runCurrent()
        assertEquals(2, api.typing)
    }

    @Test
    fun aReadOnAnotherPhoneOfAThreadThisOneDoesNotHoldTakesTheCountFromOneListRead() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c, last = api.message(c, 1_001), unread = 1)
        h.sync.reconcile("test")
        runCurrent()
        // This account's reply from its other phone: the newest message is not the peer's.
        h.sync.onEvent(message(1_002, from = ME))
        runCurrent()
        assertEquals(1, h.conversation()!!.unread)
        api.log.clear()

        // The server, which counted 1001 for this account and has the read pointer there now.
        api.conversations[c] = api.conversations.getValue(c).copy(lastMessage = api.message(c, 1_002, from = ME), unread = 0, myReadId = "1001")
        api.listChanged = true
        h.sync.onEvent(RealtimeEvent.ReceiptMoved("r1", null, ReceiptEvent(c, ME, readUpTo = "1001")))
        runCurrent()
        advanceTimeBy(600)
        runCurrent()
        assertEquals(listOf("conversations"), api.log)
        assertEquals(0, h.conversation()!!.unread)
    }

    @Test
    fun acceptingARequestFromSomeoneAlreadyInAConversationPutsItsTextThereInTheSameRow() = runTest(dispatcher) {
        val h = harness()
        api.conversation(c)
        api.fill(c, 1_000, 2)
        h.sync.reconcile("test")
        h.sync.openThread(c)
        runCurrent()
        // Requests both ways: theirs stayed pending when the other one was accepted into this conversation.
        val theirs = IncomingRequest("1287390234923440001", PeerSummary(PEER, "Negar"), "Still up for coffee?", Instant.parse("2026-11-06T09:14:03.120Z"))
        h.sync.requests.onRealtime(theirs)
        api.acceptInto[theirs.id] = c to theirs.body

        // 201 with the conversation that exists.
        val conversation = h.sync.requests.accept(theirs.id).getOrThrow()
        h.sync.adopt(conversation)
        runCurrent()
        assertEquals(c, conversation.id)
        assertEquals("one row for the one conversation", listOf(c), h.sync.conversations.observeList(ME).first().map { it.id })
        val row = h.conversation()!!
        assertEquals(1_002L, row.lastMessageId)
        assertEquals("read by the one who accepted it", 0, row.unread)
        assertTrue(h.sync.requests.inbox.value.items.isEmpty())

        // The thread reads it (its last message is not here yet), and its realtime copy changes nothing.
        api.log.clear()
        assertTrue(h.sync.openThread(c) is ThreadRead.Read)
        assertEquals(listOf("after:$c:1001"), api.log.filter { it.startsWith("after") || it.startsWith("before") })
        h.sync.onEvent(RealtimeEvent.MessageArrived("1002", null, api.threads.getValue(c).last()))
        h.sync.onEvent(RealtimeEvent.ConversationChanged("e2", null, ConversationEvent(conversation, ConversationChange.Accepted)))
        runCurrent()
        assertEquals("the text, once", 1, h.rows().count { it.body == "Still up for coffee?" })
        assertEquals(listOf(1_000L, 1_001L, 1_002L), h.rows().mapNotNull { it.serverId }.sorted())
        assertEquals(0, h.conversation()!!.unread)
        assertEquals(listOf(c), h.sync.conversations.observeList(ME).first().map { it.id })
    }
}
