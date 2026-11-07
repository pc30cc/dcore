package app.core.sync

import app.core.common.FakeClock
import app.core.feature.deck.Widening
import app.core.model.SwipeAction
import app.core.net.SampleApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The deck against the sample backend: the request budget, the end of the deck, widening. */
@OptIn(ExperimentalCoroutinesApi::class)
class DeckSampleTest {

    private val clock = FakeClock()

    private fun TestScope.repository(api: SampleApi, store: DeckSnapshotStore = MemoryDeckSnapshotStore()) = DeckRepository(
        scope = backgroundScope,
        fetchPage = { api.deck(it) },
        sendSwipes = { api.swipe(it) },
        account = { api.sessionUser()?.id },
        store = store,
        clock = clock,
    )

    private fun TestScope.settle() {
        advanceTimeBy(60_000)
        runCurrent()
    }

    @Test
    fun passesCostOneRequestPerBatchAndPagesStartPastThem() = runTest {
        val api = SampleApi(clock = clock)
        val deck = repository(api)
        deck.start()
        settle()
        val first = deck.state.value.cards.map { it.id }
        assertTrue(first.isNotEmpty())
        first.forEach { id -> deck.pass(deck.state.value.cards.first { it.id == id }) }
        deck.onBackground()
        settle()
        assertEquals("one pass request for the whole run", 1, api.requestLog.count { it == "swipes" })
        assertTrue(api.requestLog.count { it == "deck" } <= 2)
    }

    @Test
    fun theEndOfTheSampleDeckIsWidenedToNewPeople() = runTest {
        val api = SampleApi(clock = clock)
        val deck = repository(api)
        deck.start()
        settle()
        val seen = mutableSetOf<String>()
        while (deck.state.value.cards.isNotEmpty()) {
            val card = deck.state.value.cards.first()
            seen += card.id
            deck.pass(card)
            settle()
        }
        assertEquals(DeckStatus.Exhausted, deck.state.value.status)
        assertTrue(deck.state.value.suggestions.isNotEmpty())

        val prefs = api.me().value.preferences!!
        api.updatePreferences(Widening.distance(prefs))
        deck.filtersChanged()
        settle()
        assertEquals(DeckStatus.Ready, deck.state.value.status)
        val fresh = deck.state.value.cards.map { it.id }
        assertTrue("widening brought someone new", fresh.any { it !in seen })
        assertFalse("nobody already passed comes back", fresh.any { it in seen })
    }

    @Test
    fun aColdStartWithARecentSavedDeckAsksTheServerForNoCards() = runTest {
        val store = MemoryDeckSnapshotStore()
        val first = repository(SampleApi(clock = clock), store)
        first.start()
        settle()
        first.onBackground()
        settle()

        clock.advance(10 * 60 * 1000L)
        val api = SampleApi(clock = clock)
        val second = repository(api, store)
        second.start()
        settle()
        assertTrue(second.state.value.cards.isNotEmpty())
        assertEquals("no deck request on a launch with saved cards", 0, api.requestLog.count { it == "deck" })
    }

    @Test
    fun aMutualLikeIsAMatchWithItsConversation() = runTest {
        val api = SampleApi(clock = clock)
        val deck = repository(api)
        deck.start()
        settle()
        val liker = deck.state.value.cards.first { it.likesYou }
        val outcome = deck.like(liker, SwipeAction.Like)
        assertTrue(outcome is LikeOutcome.Matched)
        assertTrue((outcome as LikeOutcome.Matched).conversation != null)
    }
}
