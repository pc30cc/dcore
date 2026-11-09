package app.core.sync

import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.model.Plan
import app.core.net.Fetched
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The subscription link survives the worker's events, which carry none; a read never outlives its account. */
class EntitlementRepositoryTest {

    private val link = "https://example.com/brand/subscriptions"
    private val read = Entitlements(plan = Plan.Plus, source = EntitlementSource.Bazaar, manageUrl = link)

    @Test
    fun anEventWithoutALinkKeepsTheOneReadForTheSamePlanAndStore() = runTest {
        var answer = read
        val repo = EntitlementRepository(fetch = { Fetched(answer, true) })
        repo.refresh()
        // A renewal from the worker: same plan, same store, no link.
        repo.apply(read.copy(manageUrl = null, autoRenew = true))
        assertEquals(link, repo.entitlements.value?.manageUrl)
        assertEquals(true, repo.entitlements.value?.autoRenew)

        // The API's own read always wins, a link it no longer sends included.
        answer = read.copy(manageUrl = null)
        repo.refresh()
        assertNull(repo.entitlements.value?.manageUrl)
    }

    @Test
    fun anotherPlanStoreOrAGrantDoesNotInheritTheLink() = runTest {
        val repo = EntitlementRepository(fetch = { Fetched(read, true) })
        repo.refresh()
        repo.apply(read.copy(plan = Plan.Premium, manageUrl = null))
        assertNull(repo.entitlements.value?.manageUrl)

        repo.apply(read)
        repo.apply(read.copy(source = EntitlementSource.Grant, manageUrl = null))
        assertNull(repo.entitlements.value?.manageUrl)

        repo.apply(read)
        repo.apply(Entitlements())
        assertNull("free has no store page", repo.entitlements.value?.manageUrl)
    }

    @Test
    fun aNewLinkReplacesTheOldOne() = runTest {
        val repo = EntitlementRepository(fetch = { Fetched(read, true) })
        repo.refresh()
        repo.apply(read.copy(manageUrl = "https://example.com/other"))
        assertEquals("https://example.com/other", repo.entitlements.value?.manageUrl)
    }

    @Test
    fun aReadInFlightWhenTheAccountSignsOutIsNotKept() = runTest {
        val gate = CompletableDeferred<Unit>()
        val repo = EntitlementRepository(fetch = { gate.await(); Fetched(read, true) })
        val reading = launch { repo.refresh() }
        runCurrent()
        repo.clear()
        gate.complete(Unit)
        advanceUntilIdle()
        reading.join()
        assertNull("the account that left: nothing of it is shown to the next one", repo.entitlements.value)
    }

    @Test
    fun aPlainRefreshStillReplacesWhatWasAppliedMeanwhile() = runTest {
        val gate = CompletableDeferred<Unit>()
        val repo = EntitlementRepository(fetch = { gate.await(); Fetched(read, true) })
        val reading = launch { repo.refresh() }
        runCurrent()
        repo.apply(read.copy(plan = Plan.Premium))
        gate.complete(Unit)
        reading.join()
        assertEquals("the API's own read wins, as before", read, repo.entitlements.value)
    }

    @Test
    fun aHintsReadSaysWhetherItWasAnswered() = runTest {
        var down = true
        val repo = EntitlementRepository(fetch = {
            if (down) throw app.core.net.ApiError.Network(java.io.IOException("offline"))
            Fetched(read, true)
        })
        assertFalse("no answer: the hint still stands", repo.reread())
        assertNull(repo.entitlements.value)
        down = false
        assertTrue(repo.reread())
        assertEquals(read, repo.entitlements.value)
    }

    @Test
    fun aPatchDuringAHintsReadDoesNotThrowItsAnswerAway() = runTest {
        val gate = CompletableDeferred<Unit>()
        val premium = read.copy(plan = Plan.Premium)
        val repo = EntitlementRepository(fetch = { gate.await(); Fetched(premium, true) })
        repo.apply(read)
        val reading = async { repo.reread() }
        runCurrent()
        val end = java.time.Instant.parse("2026-11-09T08:30:00Z")
        repo.patch { it.copy(boostEndsAt = end) }
        assertEquals("shown at once", end, repo.entitlements.value?.boostEndsAt)
        gate.complete(Unit)
        assertTrue(reading.await())
        assertEquals("the server's newer answer", Plan.Premium, repo.entitlements.value?.plan)
        assertEquals("with the patch made while it was read", end, repo.entitlements.value?.boostEndsAt)

        // A view the server published meanwhile still wins over the read, as before.
        val gate2 = CompletableDeferred<Unit>()
        val repo2 = EntitlementRepository(fetch = { gate2.await(); Fetched(read, true) })
        val reading2 = async { repo2.reread() }
        runCurrent()
        repo2.apply(premium)
        gate2.complete(Unit)
        assertTrue("answered by the view", reading2.await())
        assertEquals(premium, repo2.entitlements.value)

        // A patch before anything is known is ignored; one made after a read is not re-applied to the next.
        val repo3 = EntitlementRepository(fetch = { Fetched(read, true) })
        repo3.patch { it.copy(boostEndsAt = end) }
        assertNull(repo3.entitlements.value)
        repo3.refresh()
        assertNull(repo3.entitlements.value?.boostEndsAt)
    }
}
