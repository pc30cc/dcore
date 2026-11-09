package app.core.sync

import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.model.Plan
import app.core.model.RealtimeEvent
import app.core.model.StoreName
import app.core.net.Fetched
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * An `entitlement` event of this build's store (or of no store) is applied;
 * another store's view is only a hint, answered by one coalesced read of
 * `GET /v1/me/entitlements`.
 */
class EntitlementEventsTest {

    /** What the server answers this build's `GET /v1/me/entitlements` with. */
    private val read = Entitlements(plan = Plan.Plus, source = EntitlementSource.Bazaar, manageUrl = "https://example.com/subscriptions")

    /** The same account as the other build sees it: its own store's plan. */
    private val playView = Entitlements(plan = Plan.Premium, source = EntitlementSource.Play)

    private class Rig(scope: TestScope, answer: Entitlements) {
        var reads = 0
        var gate: CompletableDeferred<Unit>? = null
        val repo = EntitlementRepository(fetch = {
            reads++
            gate?.await()
            Fetched(answer, true)
        })
        // The runs are finite: the test's own scope, so runTest waits for them.
        val events = EntitlementEvents(repo, StoreName.Bazaar, scope)
    }

    private fun event(entitlements: Entitlements, store: StoreName?, id: String = "1") =
        RealtimeEvent.EntitlementsChanged(id, null, entitlements, store)

    @Test
    fun aViewOfThisBuildsStoreIsAppliedWithoutARead() = runTest {
        val r = Rig(this, read)
        val renewed = read.copy(autoRenew = true, manageUrl = null)
        r.events.onEvent(event(renewed, StoreName.Bazaar))
        advanceUntilIdle()
        assertEquals(Plan.Plus, r.repo.entitlements.value?.plan)
        assertEquals(true, r.repo.entitlements.value?.autoRenew)
        assertEquals("no request", 0, r.reads)
    }

    @Test
    fun aViewOfNoStoreIsApplied() = runTest {
        val r = Rig(this, read)
        val grant = Entitlements(plan = Plan.Premium, source = EntitlementSource.Grant)
        r.events.onEvent(event(grant, store = null))
        advanceUntilIdle()
        assertEquals(grant, r.repo.entitlements.value)
        assertEquals(0, r.reads)
    }

    @Test
    fun anotherStoresViewIsNotAppliedAndCausesExactlyOneRead() = runTest {
        val r = Rig(this, read)
        r.events.onEvent(event(playView, StoreName.Play))
        assertNull("nothing of the other build's view is shown", r.repo.entitlements.value)
        advanceUntilIdle()
        assertEquals(1, r.reads)
        assertEquals("this build's own view, as the server answered it", read, r.repo.entitlements.value)
    }

    @Test
    fun aStoreThisBuildDoesNotKnowIsAHintToo() = runTest {
        val r = Rig(this, read)
        r.events.onEvent(event(playView, StoreName.Unknown))
        advanceUntilIdle()
        assertEquals(1, r.reads)
        assertEquals(read, r.repo.entitlements.value)
    }

    @Test
    fun aBurstOfHintsCostsAtMostOneReadInFlightAndOneQueued() = runTest {
        val r = Rig(this, read)
        val gate = CompletableDeferred<Unit>()
        r.gate = gate

        // Before anything runs: all of them ride on the first read.
        repeat(10) { r.events.onEvent(event(playView, StoreName.Play, id = "a$it")) }
        runCurrent()
        assertEquals("one read in flight", 1, r.reads)

        // While it is in flight: one more read after it, however many arrive.
        repeat(25) { r.events.onEvent(event(playView, StoreName.Play, id = "b$it")) }
        runCurrent()
        assertEquals("the second waits for the first", 1, r.reads)

        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals("one in flight plus one queued", 2, r.reads)
        assertEquals(read, r.repo.entitlements.value)

        // Quiet again: the next hint reads once more.
        r.events.onEvent(event(playView, StoreName.Play, id = "c"))
        advanceUntilIdle()
        assertEquals(3, r.reads)
    }

    @Test
    fun anOwnStoreEventDuringTheReadIsAppliedAtOnceAndNotUndoneByIt() = runTest {
        val r = Rig(this, read)
        val gate = CompletableDeferred<Unit>()
        r.gate = gate
        r.events.onEvent(event(playView, StoreName.Play))
        runCurrent()
        val wallet = read.copy(wallet = read.wallet.copy(boost = 2))
        r.events.onEvent(event(wallet, StoreName.Bazaar))
        assertEquals("applied while the read is in flight", 2, r.repo.entitlements.value?.wallet?.boost)
        // The read began before that event was published: its older answer is not kept.
        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals(1, r.reads)
        assertEquals(wallet, r.repo.entitlements.value)
    }

    @Test
    fun aFailedReadDoesNotStopLaterOnes() = runTest {
        var reads = 0
        val repo = EntitlementRepository(fetch = {
            reads++
            if (reads == 1) throw app.core.net.ApiError.Network(java.io.IOException("offline"))
            Fetched(read, true)
        })
        val events = EntitlementEvents(repo, StoreName.Bazaar, this)
        events.onEvent(event(playView, StoreName.Play))
        runCurrent()
        assertNull(repo.entitlements.value)
        events.onEvent(event(playView, StoreName.Play))
        runCurrent()
        assertEquals(2, reads)
        assertEquals(read, repo.entitlements.value)
        advanceUntilIdle()
        assertEquals("answered: the retry the failure planned reads nothing", 2, reads)
    }

    /** A hint whose read failed is not lost: it is read again after 5 s, 30 s, 2 min and 10 min, until answered. */
    @Test
    fun aFailedReadIsTriedAgainLaterUntilTheHintIsAnswered() = runTest {
        var reads = 0
        val repo = EntitlementRepository(fetch = {
            reads++
            if (reads <= 2) throw app.core.net.ApiError.Network(java.io.IOException("offline"))
            Fetched(read, true)
        })
        val events = EntitlementEvents(repo, StoreName.Bazaar, this)
        events.onEvent(event(playView, StoreName.Play))
        runCurrent()
        assertEquals(1, reads)
        advanceTimeBy(4_999)
        runCurrent()
        assertEquals("not before its wait", 1, reads)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(2, reads)
        assertNull(repo.entitlements.value)
        advanceTimeBy(30_000)
        runCurrent()
        assertEquals(3, reads)
        assertEquals(read, repo.entitlements.value)
        advanceUntilIdle()
        assertEquals("answered: no more reads", 3, reads)
    }

    /**
     * After the last timed retry, a hint still pending is read when the
     * network comes back or the app returns to the front; nothing is read
     * when no hint is pending.
     */
    @Test
    fun aHintStillPendingIsReadWhenTheNetworkOrTheAppComesBack() = runTest {
        var reads = 0
        var down = true
        val repo = EntitlementRepository(fetch = {
            reads++
            if (down) throw app.core.net.ApiError.Network(java.io.IOException("offline"))
            Fetched(read, true)
        })
        val events = EntitlementEvents(repo, StoreName.Bazaar, this)
        events.onEvent(event(playView, StoreName.Play))
        advanceUntilIdle()
        assertEquals("the first read and four timed retries, then it waits", 1 + EntitlementEvents.RETRY_DELAYS_MS.size, reads)
        assertNull(repo.entitlements.value)

        down = false
        events.retryPending()
        advanceUntilIdle()
        assertEquals(EntitlementEvents.RETRY_DELAYS_MS.size + 2, reads)
        assertEquals(read, repo.entitlements.value)

        events.retryPending()
        advanceUntilIdle()
        assertEquals("nothing pending: no read", EntitlementEvents.RETRY_DELAYS_MS.size + 2, reads)
    }

    /** Once the timed retries are spent, a new hint (its socket is up) starts them again. */
    @Test
    fun aNewHintStartsTheWaitsAgain() = runTest {
        var reads = 0
        val repo = EntitlementRepository(fetch = {
            reads++
            throw app.core.net.ApiError.Network(java.io.IOException("offline"))
        })
        val events = EntitlementEvents(repo, StoreName.Bazaar, this)
        events.onEvent(event(playView, StoreName.Play))
        advanceUntilIdle()
        val spent = reads
        events.onEvent(event(playView, StoreName.Play, id = "2"))
        runCurrent()
        assertEquals(spent + 1, reads)
        advanceTimeBy(EntitlementEvents.RETRY_DELAYS_MS.first())
        runCurrent()
        assertEquals("retried after the first wait again", spent + 2, reads)
        advanceUntilIdle()
    }

    /** A view of this build's store published after the hint counts the same change: the hint is answered. */
    @Test
    fun anOwnStoreViewAnswersAPendingHint() = runTest {
        var reads = 0
        val repo = EntitlementRepository(fetch = {
            reads++
            throw app.core.net.ApiError.Network(java.io.IOException("offline"))
        })
        val events = EntitlementEvents(repo, StoreName.Bazaar, this)
        events.onEvent(event(playView, StoreName.Play))
        runCurrent()
        assertEquals(1, reads)
        events.onEvent(event(read, StoreName.Bazaar))
        advanceUntilIdle()
        assertEquals("no retry", 1, reads)
        assertEquals(read, repo.entitlements.value)
        events.retryPending()
        advanceUntilIdle()
        assertEquals(1, reads)
    }

    @Test
    fun signingOutDropsAPendingHint() = runTest {
        var reads = 0
        val repo = EntitlementRepository(fetch = {
            reads++
            throw app.core.net.ApiError.Network(java.io.IOException("offline"))
        })
        val events = EntitlementEvents(repo, StoreName.Bazaar, this)
        events.onEvent(event(playView, StoreName.Play))
        runCurrent()
        repo.clear()
        events.reset()
        advanceUntilIdle()
        events.retryPending()
        advanceUntilIdle()
        assertEquals("nothing of the account that left is read", 1, reads)
    }
}
