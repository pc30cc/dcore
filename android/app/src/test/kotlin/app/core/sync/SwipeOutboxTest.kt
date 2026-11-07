package app.core.sync

import app.core.model.Problem
import app.core.model.Quota
import app.core.model.Quotas
import app.core.model.Swipe
import app.core.model.SwipeAction
import app.core.model.SwipeOutcome
import app.core.model.SwipeResult
import app.core.model.SwipesResult
import app.core.net.ApiError
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

/** Passes are batched (2 s or 10), likes go at once and take the passes with them, the last pass can be taken back. */
@OptIn(ExperimentalCoroutinesApi::class)
class SwipeOutboxTest {

    private class Server {
        val requests = mutableListOf<List<Swipe>>()
        var failWith: ApiError? = null

        suspend fun send(batch: List<Swipe>): SwipesResult {
            failWith?.let { throw it }
            requests += batch
            return SwipesResult(
                batch.map { SwipeResult(it.target, if (it.action == SwipeAction.Pass) SwipeOutcome.Passed else SwipeOutcome.Liked) },
                Quotas(likes = Quota(limit = 50, used = requests.size)),
            )
        }
    }

    private fun TestScope.outbox(server: Server, hold: Boolean = false) =
        SwipeOutbox(scope = backgroundScope, send = server::send).apply { holdLastPass = hold }

    private fun network() = ApiError.Network(IOException("offline"))

    @Test
    fun passesWaitForTheTwoSecondWindow() = runTest {
        val server = Server()
        val outbox = outbox(server)
        outbox.pass("a")
        advanceTimeBy(500)
        outbox.pass("b")
        advanceTimeBy(1_000)
        outbox.pass("c")
        runCurrent()
        assertTrue("nothing before the window closes", server.requests.isEmpty())
        advanceTimeBy(600)
        runCurrent()
        assertEquals(listOf(listOf("a", "b", "c")), server.requests.map { batch -> batch.map { it.target } })
        assertEquals(0, outbox.pendingCount)
    }

    @Test
    fun tenPassesGoAtOnce() = runTest {
        val server = Server()
        val outbox = outbox(server)
        repeat(10) { outbox.pass("p$it") }
        runCurrent()
        assertEquals(1, server.requests.size)
        assertEquals(10, server.requests[0].size)
        assertTrue(server.requests[0].all { it.action == SwipeAction.Pass })
    }

    @Test
    fun fiftyFastPassesCostFiveRequests() = runTest {
        val server = Server()
        val outbox = outbox(server)
        repeat(50) {
            outbox.pass("p$it")
            advanceTimeBy(100)
        }
        advanceTimeBy(2_100)
        runCurrent()
        assertEquals(5, server.requests.size)
        assertEquals(50, server.requests.sumOf { it.size })
    }

    @Test
    fun aLikeGoesAtOnceWithTheWaitingPasses() = runTest {
        val server = Server()
        val outbox = outbox(server)
        outbox.pass("a")
        outbox.pass("b")
        val result = outbox.sendNow(Swipe("c", SwipeAction.Like))
        assertEquals(1, server.requests.size)
        assertEquals(listOf("a" to SwipeAction.Pass, "b" to SwipeAction.Pass, "c" to SwipeAction.Like), server.requests[0].map { it.target to it.action })
        assertEquals(SwipeOutcome.Liked, result.results.last().result)
        advanceTimeBy(5_000)
        runCurrent()
        assertEquals("the passes are not sent twice", 1, server.requests.size)
    }

    @Test
    fun aRequestNeverCarriesMoreThanTwentySwipes() = runTest {
        val server = Server()
        server.failWith = network()
        val outbox = outbox(server)
        repeat(30) { outbox.pass("p$it") }
        server.failWith = null
        outbox.sendNow(Swipe("liked", SwipeAction.Like))
        assertEquals(20, server.requests[0].size)
        assertEquals("liked", server.requests[0].last().target)
        advanceTimeBy(70_000)
        runCurrent()
        assertEquals(0, outbox.pendingCount)
        assertTrue(server.requests.all { it.size <= 20 })
    }

    @Test
    fun theHeldPassCanBeTakenBackWithoutARequest() = runTest {
        val server = Server()
        val outbox = outbox(server, hold = true)
        outbox.pass("a")
        outbox.pass("b")
        advanceTimeBy(2_100)
        runCurrent()
        // "a" left with the batch; "b", the last action, is held.
        assertEquals(listOf(listOf("a")), server.requests.map { batch -> batch.map { it.target } })
        assertEquals("b", outbox.rewindable.value)
        assertTrue(outbox.takeBack("b"))
        assertNull(outbox.rewindable.value)
        assertFalse("only the last pass, once", outbox.takeBack("a"))
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(1, server.requests.size)
    }

    @Test
    fun theHeldPassLeavesWithTheNextActionOrTheBackground() = runTest {
        val server = Server()
        val outbox = outbox(server, hold = true)
        outbox.pass("a")
        advanceTimeBy(5_000)
        runCurrent()
        assertTrue("held while it is the last action", server.requests.isEmpty())
        outbox.sendNow(Swipe("b", SwipeAction.Like))
        assertEquals(listOf("a", "b"), server.requests.single().map { it.target })
        assertFalse(outbox.takeBack("a"))

        outbox.pass("c")
        outbox.flushAll()
        runCurrent()
        assertEquals(listOf("c"), server.requests.last().map { it.target })
    }

    @Test
    fun aPassAlreadySentCannotBeTakenBack() = runTest {
        val server = Server()
        val outbox = outbox(server, hold = false)
        outbox.pass("a")
        advanceTimeBy(2_100)
        runCurrent()
        assertEquals(1, server.requests.size)
        assertFalse(outbox.takeBack("a"))
    }

    @Test
    fun anUnansweredBatchIsSentAgainWithBackoff() = runTest {
        val server = Server()
        val outbox = outbox(server)
        server.failWith = network()
        outbox.pass("a")
        advanceTimeBy(2_100)
        runCurrent()
        assertTrue(server.requests.isEmpty())
        assertEquals(1, outbox.pendingCount)
        server.failWith = null
        advanceTimeBy(1_800)
        runCurrent()
        assertTrue("backoff not over yet", server.requests.isEmpty())
        advanceTimeBy(300)
        runCurrent()
        assertEquals(listOf("a"), server.requests.single().map { it.target })
        assertEquals(0, outbox.pendingCount)
    }

    @Test
    fun aRefusedBatchIsDroppedNotResentForever() = runTest {
        val server = Server()
        val outbox = outbox(server)
        server.failWith = ApiError.Http(422, Problem.of(422, "field_invalid"))
        outbox.pass("a")
        advanceTimeBy(2_100)
        runCurrent()
        assertEquals(0, outbox.pendingCount)
        server.failWith = null
        advanceTimeBy(120_000)
        runCurrent()
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun aFailedLikeIsThrownAndItsPassesStay() = runTest {
        val server = Server()
        val outbox = outbox(server)
        outbox.pass("a")
        server.failWith = network()
        try {
            outbox.sendNow(Swipe("b", SwipeAction.Like))
            fail("expected the network error")
        } catch (e: ApiError.Network) {
            // expected
        }
        assertEquals(listOf("a"), outbox.pending().map { it.target })
        server.failWith = null
        advanceTimeBy(2_100)
        runCurrent()
        assertEquals(listOf("a"), server.requests.single().map { it.target })
    }

    @Test
    fun savedPassesFromAnEarlierLaunchAreSent() = runTest {
        val server = Server()
        val outbox = outbox(server, hold = true)
        outbox.restore(listOf(Swipe("old1", SwipeAction.Pass), Swipe("old2", SwipeAction.Pass)))
        assertNull("a restored pass is not rewindable", outbox.rewindable.value)
        advanceTimeBy(2_100)
        runCurrent()
        assertEquals(listOf("old1", "old2"), server.requests.single().map { it.target })
    }

    @Test
    fun theSameTargetIsNeverQueuedTwice() = runTest {
        val server = Server()
        val outbox = outbox(server)
        outbox.pass("a")
        outbox.pass("a")
        assertEquals(1, outbox.pendingCount)
    }

    @Test
    fun retryableErrors() {
        assertTrue(SwipeOutbox.isRetryable(network()))
        assertTrue(SwipeOutbox.isRetryable(ApiError.Http(503, Problem.of(503, "service_unavailable"))))
        assertTrue(SwipeOutbox.isRetryable(ApiError.Http(429, Problem.of(429, "rate_limited"))))
        assertFalse(SwipeOutbox.isRetryable(ApiError.Http(403, Problem.of(403, "snoozed"))))
        assertFalse(SwipeOutbox.isRetryable(ApiError.Unauthorized(null)))
    }
}
