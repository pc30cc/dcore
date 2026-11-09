package app.core.sync

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.cache.CacheDatabaseHolder
import app.core.cache.ChatStore
import app.core.cache.SendState
import app.core.common.Diag
import app.core.common.FakeClock
import app.core.model.MessageKind
import app.core.model.Problem
import app.core.model.ProblemCodes
import app.core.net.ApiError
import app.core.testing.ChatApi
import app.core.testing.ChatApi.Companion.ME
import kotlinx.coroutines.flow.first
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
 * Threads on a real (in-memory) database: the first read, catch-ups from the
 * server's `syncCursor`, paging back, realtime fills, and the outbox with its
 * one client id per message.
 */
@RunWith(AndroidJUnit4::class)
class MessageRepositoryTest {

    private val api = ChatApi()
    private val clock = FakeClock()
    private var ids = 0
    private val store = ChatStore(CacheDatabaseHolder(ApplicationProvider.getApplicationContext(), name = null, diag = Diag.Silent), Diag.Silent)
    private val repo = MessageRepository(api, store, clock, newClientId = { "client-${++ids}" }, diag = Diag.Silent)
    private val c = "1287390234923400001"

    private suspend fun rows() = repo.observeNewest(ME, c, 500).first()
    private suspend fun serverIds() = rows().mapNotNull { it.serverId }.sorted()

    @Test
    fun aNewMatchWithNothingWrittenIsNotRead() = runTest {
        assertEquals(ThreadRead.UpToDate, repo.open(ME, c, lastMessageId = null))
        assertTrue(api.log.isEmpty())
    }

    @Test
    fun theFirstOpenReadsTheNewestFiftyAndRemembersWhereItStopped() = runTest {
        api.conversation(c)
        api.fill(c, 1_000, 80)
        val read = repo.open(ME, c, lastMessageId = 1_079)
        assertEquals(ThreadRead.Read(50, ReadPointers(null, null, null)), read)
        assertEquals(listOf("before:$c:-"), api.log)
        assertEquals((1_030L..1_079L).toList(), serverIds())
        val state = repo.syncState(ME, c)!!
        assertEquals("1079", state.cursor)
        assertEquals(1_030L, state.oldestId)
        assertTrue(state.hasMoreBefore)
        assertFalse(state.stale)
    }

    @Test
    fun anOpenThreadThatHasEverythingAsksNothing() = runTest {
        api.conversation(c)
        api.fill(c, 1_000, 5)
        repo.open(ME, c, 1_004)
        api.log.clear()
        assertEquals(ThreadRead.UpToDate, repo.open(ME, c, 1_004))
        assertTrue(api.log.isEmpty())
    }

    @Test
    fun aMissingLastMessageIsCaughtUpFromTheCursor() = runTest {
        api.conversation(c)
        api.fill(c, 1_000, 5)
        repo.open(ME, c, 1_004)
        api.fill(c, 1_005, 3)
        api.log.clear()
        val read = repo.open(ME, c, 1_007)
        assertTrue(read is ThreadRead.Read)
        assertEquals(listOf("after:$c:1004"), api.log)
        assertEquals((1_000L..1_007L).toList(), serverIds())
    }

    @Test
    fun theCatchUpStartsFromSyncCursorSoAHeldBackMessageIsNotLost() = runTest {
        api.conversation(c)
        api.fill(c, 1_000, 3)
        // 1003 waits in the server's write-behind; 1004 and 1005 already reached the database.
        api.fill(c, 1_003, 3)
        api.held += 1_003
        repo.open(ME, c, 1_005)
        assertEquals(listOf(1_000L, 1_001L, 1_002L, 1_004L, 1_005L), serverIds())
        val state = repo.syncState(ME, c)!!
        assertEquals("the cursor is the watermark, not the newest id seen", "1002", state.cursor)
        assertTrue("a lagging read leaves the thread stale", state.stale)

        api.held.clear()
        api.log.clear()
        repo.open(ME, c, 1_005)
        assertEquals(listOf("after:$c:1002"), api.log)
        assertEquals("every message, none twice", (1_000L..1_005L).toList(), serverIds())
        assertFalse(repo.syncState(ME, c)!!.stale)
    }

    @Test
    fun pagingBackReadsBeforeTheOldestAndStopsAtTheBeginning() = runTest {
        api.conversation(c)
        api.fill(c, 1_000, 80)
        repo.open(ME, c, 1_079)
        api.log.clear()
        val older = repo.loadOlder(ME, c)
        assertEquals(OlderRead.Read(30, hasMore = false), older)
        assertEquals(listOf("before:$c:1030"), api.log)
        assertEquals(80, serverIds().size)
        assertEquals(OlderRead.NothingMore, repo.loadOlder(ME, c))
        assertEquals(1, api.log.size)
    }

    @Test
    fun aThreadFarBehindIsReadAgainFromItsEnd() = runTest {
        api.conversation(c)
        api.fill(c, 1_000, 2)
        repo.open(ME, c, 1_001)
        api.fill(c, 1_002, 1_000)
        api.log.clear()
        repo.open(ME, c, 2_001)
        assertEquals(listOf("after:$c:1001", "after:$c:1201", "after:$c:1401", "before:$c:-"), api.log)
        assertEquals((1_952L..2_001L).toList(), serverIds())
        assertTrue(repo.syncState(ME, c)!!.hasMoreBefore)
    }

    @Test
    fun aGoneConversationIsForgottenAndAnEndedOneSaysSo() = runTest {
        api.conversation(c)
        api.fill(c, 1_000, 2)
        repo.open(ME, c, 1_001)
        api.nextReadError = ApiError.Http(404, Problem.of(404, ProblemCodes.NOT_FOUND))
        repo.markStale(ME, c)
        assertEquals(ThreadRead.Gone, repo.open(ME, c, 1_001))
        assertTrue(rows().isEmpty())
        assertNull(repo.syncState(ME, c))

        api.fill(c, 1_002, 1)
        api.nextReadError = ApiError.Http(410, Problem.of(410, ProblemCodes.CONVERSATION_ENDED))
        assertEquals(ThreadRead.Ended, repo.open(ME, c, 1_002))
    }

    @Test
    fun realtimeFillsOnlyThreadsThePhoneKeepsOrShows() = runTest {
        val m = api.message(c, 1_000)
        assertFalse("never read, not on screen: the preview shows it", repo.applyRealtime(ME, m))
        assertTrue(rows().isEmpty())
        repo.watch(c)
        assertTrue(repo.applyRealtime(ME, m))
        assertFalse("the same message again changes nothing", repo.applyRealtime(ME, m))
        assertEquals(listOf(1_000L), serverIds())
        assertNull("realtime never moves the cursor", repo.syncState(ME, c))
    }

    @Test
    fun aSendIsPendingFirstThenSentWithTheServersId() = runTest {
        api.conversation(c)
        val local = repo.enqueue(ME, c, MessageKind.Text, "hi")!!
        val pending = rows().single()
        assertEquals(SendState.PENDING.code, pending.sendState)
        assertNull(pending.serverId)
        assertTrue(repo.deliver(ME, local) is SendOutcome.Sent)
        val sent = rows().single()
        assertEquals("the bubble keeps its id", local, sent.localId)
        assertEquals(SendState.SENT.code, sent.sendState)
        assertEquals("client-1", api.sent.single().clientId)
    }

    @Test
    fun theRealtimeCopyArrivingFirstIsTheSameBubble() = runTest {
        api.conversation(c)
        repo.watch(c)
        val local = repo.enqueue(ME, c, MessageKind.Text, "hi")!!
        // The publication beats the HTTP answer.
        repo.applyRealtime(ME, api.message(c, 5_000, from = ME, body = "hi").copy(clientId = "client-1"))
        assertEquals(1, rows().size)
        assertEquals(local, rows().single().localId)
        assertEquals(5_000L, rows().single().serverId)
    }

    @Test
    fun aRetryAfterALostAnswerSendsTheSameClientIdAndMakesOneMessage() = runTest {
        api.conversation(c)
        val local = repo.enqueue(ME, c, MessageKind.Text, "hi")!!
        api.sendError = ApiError.Network(IOException("lost"))
        assertEquals(SendOutcome.RetryLater(null), repo.deliver(ME, local))
        assertEquals("still on its way", SendState.PENDING.code, rows().single().sendState)
        api.sendError = null
        assertTrue(repo.deliver(ME, local) is SendOutcome.Sent)
        assertTrue(repo.deliver(ME, local) is SendOutcome.Sent)
        assertEquals(listOf("client-1", "client-1"), api.sent.map { it.clientId })
        assertEquals(1, rows().size)
    }

    @Test
    fun pendingRowsOlderThanTenMinutesAreNotSentWithoutAsking() = runTest {
        api.conversation(c)
        val old = repo.enqueue(ME, c, MessageKind.Text, "old")!!
        clock.advance(11 * 60_000L)
        val fresh = repo.enqueue(ME, c, MessageKind.Text, "fresh")!!
        assertEquals(listOf(fresh), repo.resumeOutbox(ME))
        val expired = repo.message(ME, old)!!
        assertEquals(SendState.FAILED.code, expired.sendState)
        assertEquals(ChatErrors.EXPIRED, expired.errorCode)
        // A tap retries it: the same client id, at the end of the thread.
        assertTrue(repo.retry(ME, old))
        assertTrue(repo.deliver(ME, old) is SendOutcome.Sent)
        assertEquals("client-1", api.sent.single().clientId)
    }

    @Test
    fun theServersAreYouSureWaitsAndSendAnywayCarriesItsToken() = runTest {
        api.conversation(c)
        val local = repo.enqueue(ME, c, MessageKind.Text, "send money")!!
        api.sendError = ApiError.Http(409, Problem.of(409, ProblemCodes.CONFIRM_REQUIRED, "confirmToken" to "cf1", "category" to "money"))
        assertEquals(SendOutcome.NeedsConfirm("money"), repo.deliver(ME, local))
        assertEquals(SendState.CONFIRM.code, rows().single().sendState)
        assertTrue(repo.confirmSend(ME, local))
        api.sendError = null
        assertTrue(repo.deliver(ME, local) is SendOutcome.Sent)
        assertEquals("cf1", api.sent.last().confirm)
    }

    @Test
    fun aRefusedMessageFailsForGoodAndCanBeDeleted() = runTest {
        api.conversation(c)
        val local = repo.enqueue(ME, c, MessageKind.Text, "bad")!!
        api.sendError = ApiError.Http(422, Problem.of(422, ProblemCodes.MESSAGE_REFUSED))
        assertEquals(SendOutcome.Refused(ProblemCodes.MESSAGE_REFUSED), repo.deliver(ME, local))
        assertEquals(SendState.FAILED.code, rows().single().sendState)
        repo.discard(ME, local)
        assertTrue(rows().isEmpty())
    }

    @Test
    fun anUnsendKeepsNoTextOfTheMessage() = runTest {
        api.conversation(c)
        api.fill(c, 1_000, 1)
        repo.open(ME, c, 1_000)
        repo.watch(c)
        repo.applyRealtime(ME, api.message(c, 1_001, kind = MessageKind.Unsend, body = "", refId = "1000"))
        val target = rows().single { it.serverId == 1_000L }
        assertNull(target.body)
    }

    @Test
    fun aClientIdTheServerCallsSpentGetsANewOneOnRetryAndNothingElseDoes() = runTest {
        api.conversation(c)
        val local = repo.enqueue(ME, c, MessageKind.Text, "hi")!!
        // 409 conflict: this client id already named a message in another conversation.
        api.sendError = ApiError.Http(409, Problem.of(409, ProblemCodes.CONFLICT))
        assertEquals(SendOutcome.Refused(ProblemCodes.CONFLICT), repo.deliver(ME, local))
        assertEquals(SendState.FAILED.code, rows().single().sendState)
        assertEquals("a refusal, not something to send again on its own", SendOutcome.Refused(ProblemCodes.CONFLICT), repo.deliver(ME, local))
        assertEquals(1, api.sent.size)

        api.sendError = null
        assertTrue(repo.retry(ME, local))
        assertTrue(repo.deliver(ME, local) is SendOutcome.Sent)
        assertEquals(listOf("client-1", "client-2"), api.sent.map { it.clientId })
        val row = rows().single()
        assertEquals("the same bubble", local, row.localId)
        assertEquals("client-2", row.clientId)
        assertEquals(SendState.SENT.code, row.sendState)

        // Any other failure keeps its client id: the server may have the message already.
        val other = repo.enqueue(ME, c, MessageKind.Text, "again")!!
        api.sendError = ApiError.Http(422, Problem.of(422, ProblemCodes.FIELD_INVALID))
        repo.deliver(ME, other)
        api.sendError = null
        assertTrue(repo.retry(ME, other))
        repo.deliver(ME, other)
        assertEquals(listOf("client-3", "client-3"), api.sent.drop(2).map { it.clientId })
    }

    @Test
    fun anEndedConversationAnswers410ForItsHistoryAnd404ForASend() = runTest {
        api.conversation(c)
        api.fill(c, 1_000, 2)
        repo.open(ME, c, 1_001)
        api.nextReadError = ApiError.Http(410, Problem.of(410, ProblemCodes.CONVERSATION_ENDED))
        repo.markStale(ME, c)
        assertEquals("history of an ended conversation: kept here, read-only", ThreadRead.Ended, repo.open(ME, c, 1_001))
        assertEquals(listOf(1_000L, 1_001L), serverIds())
        val local = repo.enqueue(ME, c, MessageKind.Text, "hello?")!!
        api.sendError = ApiError.Http(404, Problem.of(404, ProblemCodes.NOT_FOUND))
        assertEquals(SendOutcome.Closed, repo.deliver(ME, local))
        assertEquals(ProblemCodes.CONVERSATION_ENDED, repo.message(ME, local)!!.errorCode)
    }

    // The server answers a client id with its message for 15 minutes only, and its history rows carry no client id.

    /** The phone's clock and the server's, together from [at]. */
    private fun startAt(at: String) {
        clock.millis = Instant.parse(at).toEpochMilli()
        api.now = { clock.now() }
    }

    private suspend fun thread() {
        api.conversation(c)
        api.fill(c, 1_000, 2)
        repo.open(ME, c, 1_001)
    }

    /** Fails [local] for good the way the outbox does: pending past its ten minutes, at the next resume. */
    private suspend fun expireAfter(minutes: Long, local: String) {
        clock.advance(minutes * 60_000L)
        repo.resumeOutbox(ME)
        assertEquals(ChatErrors.EXPIRED, repo.message(ME, local)!!.errorCode)
    }

    private fun serverCopies(body: String) = api.threads.getValue(c).count { it.senderId == ME && it.body == body }

    @Test
    fun aRetryPastTheReplayWindowTakesTheMessageAnEarlierAttemptMadeAndSendsNothing() = runTest {
        startAt("2026-11-06T10:00:00Z")
        thread()
        val local = repo.enqueue(ME, c, MessageKind.Text, "See you at eight")!!
        // The server makes it; the answer never comes back.
        api.loseNextAnswer = true
        assertEquals(SendOutcome.RetryLater(null), repo.deliver(ME, local))
        expireAfter(11, local)
        clock.advance(9 * 60_000L)
        api.forgetSendRecords()
        api.log.clear()

        assertTrue(repo.retry(ME, local))
        assertEquals(SendOutcome.Sent(null), repo.deliver(ME, local))
        assertEquals("the catch-up, and no second send", listOf("after:$c:1001"), api.log)
        assertEquals(1, api.sent.size)
        assertEquals(1, serverCopies("See you at eight"))
        val mine = rows().filter { it.senderId == ME }
        assertEquals("one bubble for the one message", 1, mine.size)
        assertEquals(local, mine.single().localId)
        assertEquals(SendState.SENT.code, mine.single().sendState)
        assertEquals(api.threads.getValue(c).last().id.toLong(), mine.single().serverId)
    }

    @Test
    fun aRetryPastTheReplayWindowSendsAgainWhenTheHistoryHoldsNoEarlierAttempt() = runTest {
        startAt("2026-11-06T09:59:30Z")
        api.conversation(c)
        api.fill(c, 1_000, 2)
        val list = api.threads.getValue(c)
        // The same words, sent before this message was typed: an hour before, and (by the server's clock) a minute
        // before but already on this phone when it was typed. Neither is this message.
        list += api.message(c, 1_002, from = ME, body = "ok")
        list += api.message(c, 1_003, from = ME, body = "ok").copy(at = Instant.parse("2026-11-06T09:59:00Z"))
        repo.open(ME, c, 1_003)
        clock.advance(30_000)
        val local = repo.enqueue(ME, c, MessageKind.Text, "ok")!!
        // Never reached the server.
        api.sendError = ApiError.Network(IOException("down"))
        assertEquals(SendOutcome.RetryLater(null), repo.deliver(ME, local))
        api.sendError = null
        expireAfter(11, local)
        clock.advance(9 * 60_000L)
        api.log.clear()

        assertTrue(repo.retry(ME, local))
        assertTrue(repo.deliver(ME, local) is SendOutcome.Sent)
        assertEquals(listOf("after:$c:1003", "send:$c"), api.log)
        assertEquals("the same client id both times", listOf("client-1", "client-1"), api.sent.map { it.clientId })
        assertEquals(3, serverCopies("ok"))
        val mine = rows().filter { it.senderId == ME }
        assertEquals(listOf("s:1002", "s:1003", local), mine.sortedBy { it.sortKey }.map { it.localId })
        assertTrue(mine.all { it.sendState == SendState.SENT.code })
    }

    @Test
    fun aRetryInsideTheReplayWindowSendsTheSameClientIdAndReadsNothing() = runTest {
        startAt("2026-11-06T10:00:00Z")
        thread()
        val local = repo.enqueue(ME, c, MessageKind.Text, "On my way")!!
        api.loseNextAnswer = true
        assertEquals(SendOutcome.RetryLater(null), repo.deliver(ME, local))
        expireAfter(11, local)
        // Thirteen minutes after the first attempt: the server still knows the client id.
        clock.advance(2 * 60_000L)
        api.log.clear()

        assertTrue(repo.retry(ME, local))
        assertTrue(repo.deliver(ME, local) is SendOutcome.Sent)
        assertEquals(listOf("send:$c"), api.log)
        assertEquals(listOf("client-1", "client-1"), api.sent.map { it.clientId })
        assertEquals(1, serverCopies("On my way"))
        val mine = rows().single { it.senderId == ME }
        assertEquals(local, mine.localId)
        assertEquals(SendState.SENT.code, mine.sendState)
    }

    @Test
    fun theWindowCountsFromTheClientIdsFirstAttemptNotFromTheLastRetry() = runTest {
        startAt("2026-11-06T10:00:00Z")
        thread()
        val local = repo.enqueue(ME, c, MessageKind.Text, "hi")!!
        api.loseNextAnswer = true
        repo.deliver(ME, local)
        expireAfter(11, local)
        // A retry twelve minutes in, inside the window, that never reaches the server...
        clock.advance(60_000L)
        assertTrue(repo.retry(ME, local))
        api.sendError = ApiError.Network(IOException("down"))
        assertEquals(SendOutcome.RetryLater(null), repo.deliver(ME, local))
        api.sendError = null
        expireAfter(11, local)
        // ...and another 25 minutes after the first attempt, two after the last one.
        clock.advance(2 * 60_000L)
        api.forgetSendRecords()
        api.log.clear()

        assertTrue(repo.retry(ME, local))
        assertEquals(SendOutcome.Sent(null), repo.deliver(ME, local))
        assertEquals(listOf("after:$c:1001"), api.log)
        assertEquals(1, serverCopies("hi"))
        assertEquals(local, rows().single { it.senderId == ME }.localId)
    }

    @Test
    fun aHistoryLaggingPastTheWindowIsAskedAgainLaterAndNothingIsSentMeanwhile() = runTest {
        startAt("2026-11-06T10:00:00Z")
        thread()
        val local = repo.enqueue(ME, c, MessageKind.Text, "hi")!!
        api.loseNextAnswer = true
        repo.deliver(ME, local)
        expireAfter(11, local)
        clock.advance(9 * 60_000L)
        api.forgetSendRecords()
        assertTrue(repo.retry(ME, local))

        // The write-behind is 16 minutes behind: a message made 20 minutes ago may not be in the history yet.
        api.writeLagMs = 16 * 60_000L
        api.log.clear()
        val waiting = repo.deliver(ME, local)
        assertTrue(waiting is SendOutcome.RetryLater && waiting.afterMs != null)
        assertEquals(listOf("after:$c:1001"), api.log)
        assertEquals(SendState.PENDING.code, repo.message(ME, local)!!.sendState)

        api.writeLagMs = 3_000
        assertEquals(SendOutcome.Sent(null), repo.deliver(ME, local))
        assertEquals(1, api.sent.size)
        assertEquals(1, serverCopies("hi"))
    }
}
