package app.core.sync

import app.core.common.FakeClock
import app.core.model.Conversation
import app.core.model.ConversationPeer
import app.core.model.DeckPage
import app.core.model.DeckSuggestion
import app.core.model.ItemKind
import app.core.model.LikedItem
import app.core.model.Problem
import app.core.model.ProfileCard
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.time.Instant

@OptIn(ExperimentalCoroutinesApi::class)
class DeckRepositoryTest {

    private fun card(id: String) = ProfileCard(id = id, v = 1, name = id)

    /** A server with a queue of people; a swipe takes its target off the head, like LREM. */
    private class Server(people: List<String>) {
        val deck = ArrayDeque(people)
        val likesBack = mutableSetOf<String>()
        val pages = mutableListOf<Int>()
        val swipes = mutableListOf<List<Swipe>>()
        var pageError: ApiError? = null
        var swipeError: ApiError? = null
        var likesLeft = 10
        var exhaustedWhenEmpty = true

        suspend fun page(limit: Int): DeckPage {
            pageError?.let { throw it }
            pages += limit
            val cards = deck.take(limit).map { ProfileCard(id = it, v = 1, name = it) }
            return DeckPage(
                cards = cards,
                remaining = (deck.size - cards.size).coerceAtLeast(0),
                exhausted = exhaustedWhenEmpty && deck.size <= limit,
                suggestions = if (deck.size <= limit) listOf(DeckSuggestion.WidenDistance, DeckSuggestion.WidenAge) else emptyList(),
            )
        }

        suspend fun swipe(batch: List<Swipe>): SwipesResult {
            swipeError?.let { throw it }
            swipes += batch
            val results = batch.map { s ->
                deck.remove(s.target)
                val outcome = when {
                    s.action == SwipeAction.Pass -> SwipeOutcome.Passed
                    likesLeft <= 0 -> SwipeOutcome.Quota
                    s.target in likesBack -> SwipeOutcome.Matched
                    else -> SwipeOutcome.Liked
                }
                if (s.action != SwipeAction.Pass && outcome != SwipeOutcome.Quota) likesLeft--
                SwipeResult(
                    s.target,
                    outcome,
                    if (outcome == SwipeOutcome.Matched) {
                        Conversation("m-${s.target}", ConversationPeer(s.target, s.target), createdAt = Instant.EPOCH)
                    } else {
                        null
                    },
                )
            }
            return SwipesResult(results, Quotas(likes = Quota(limit = 10, used = 10 - likesLeft, resetsAt = Instant.parse("2026-11-07T00:00:00Z"))))
        }
    }

    private fun TestScope.repository(
        server: Server,
        store: DeckSnapshotStore = MemoryDeckSnapshotStore(),
        clock: FakeClock = FakeClock(),
        account: String? = "me00000000000",
    ) = DeckRepository(
        scope = backgroundScope,
        fetchPage = server::page,
        sendSwipes = server::swipe,
        account = { account },
        store = store,
        clock = clock,
    )

    /**
     * Runs everything due in the next minute. Not advanceUntilIdle: the
     * repository's coroutines run in backgroundScope, which that skips.
     */
    private fun TestScope.settle() {
        advanceTimeBy(60_000)
        runCurrent()
    }

    private fun people(n: Int) = (1..n).map { "p%02d".format(it) }

    @Test
    fun theFirstPageFillsTheDeck() = runTest {
        val server = Server(people(25))
        val deck = repository(server)
        assertEquals(DeckStatus.Loading, deck.state.value.status)
        deck.start()
        settle()
        assertEquals(DeckStatus.Ready, deck.state.value.status)
        assertEquals(people(10), deck.state.value.cards.map { it.id })
        assertEquals(listOf(10), server.pages)
    }

    @Test
    fun theNextPageIsAskedForAtFiveLeftAfterThePassesAreSent() = runTest {
        val server = Server(people(25))
        val deck = repository(server)
        deck.start()
        settle()
        repeat(4) { deck.pass(deck.state.value.cards.first()) }
        runCurrent()
        assertEquals("six left: no page yet", 1, server.pages.size)
        deck.pass(deck.state.value.cards.first())
        settle()
        assertEquals(2, server.pages.size)
        // The five passes went first (one request), so the page starts past them.
        assertEquals(listOf("p01", "p02", "p03", "p04"), server.swipes.first().map { it.target })
        // p05, the held pass, is still on the phone: the page repeats it and it is dropped.
        assertEquals((6..14).map { "p%02d".format(it) }, deck.state.value.cards.map { it.id })
        assertTrue(deck.state.value.cards.none { it.id in setOf("p01", "p02", "p03", "p04", "p05") })
    }

    @Test
    fun aMatchIsReturnedWithItsConversation() = runTest {
        val server = Server(people(12)).apply { likesBack += "p01" }
        val deck = repository(server)
        deck.start()
        settle()
        val top = deck.state.value.cards.first()
        val outcome = deck.like(top)
        assertTrue(outcome is LikeOutcome.Matched)
        assertEquals("m-p01", (outcome as LikeOutcome.Matched).conversation?.id)
        assertEquals("p02", deck.state.value.cards.first().id)
    }

    @Test
    fun aLikeOnAPhotoCarriesTheItemAndTheTrimmedComment() = runTest {
        val server = Server(people(12))
        val deck = repository(server)
        deck.start()
        settle()
        deck.like(deck.state.value.cards.first(), item = LikedItem(ItemKind.Photo, "901"), comment = "  nice view  ")
        val sent = server.swipes.last().single()
        assertEquals(LikedItem(ItemKind.Photo, "901"), sent.item)
        assertEquals("nice view", sent.comment)
    }

    @Test
    fun aLikeThatDoesNotGoThroughPutsTheCardBack() = runTest {
        val server = Server(people(12))
        val deck = repository(server)
        deck.start()
        settle()
        server.swipeError = ApiError.Network(IOException("offline"))
        val outcome = deck.like(deck.state.value.cards.first())
        assertEquals(LikeOutcome.Offline, outcome)
        assertEquals("p01", deck.state.value.cards.first().id)
        assertEquals(ReturningCard("p01", ReturnSide.Right), deck.state.value.returning)
        deck.returnShown("p01")
        assertNull(deck.state.value.returning)
    }

    @Test
    fun outOfLikesSaysWhenTheyComeBackAndKeepsTheCard() = runTest {
        val server = Server(people(12)).apply { likesLeft = 0 }
        val deck = repository(server)
        deck.start()
        settle()
        val outcome = deck.like(deck.state.value.cards.first())
        assertEquals(LikeOutcome.OutOfQuota(SwipeAction.Like, Instant.parse("2026-11-07T00:00:00Z")), outcome)
        assertEquals("p01", deck.state.value.cards.first().id)
    }

    @Test
    fun aRefusedCommentIsReportedAndNothingIsLost() = runTest {
        val server = Server(people(12))
        val deck = repository(server)
        deck.start()
        settle()
        server.swipeError = ApiError.Http(422, Problem.of(422, "text_refused"))
        val outcome = deck.like(deck.state.value.cards.first(), comment = "rude")
        assertEquals(LikeOutcome.CommentRefused, outcome)
        assertEquals("p01", deck.state.value.cards.first().id)
    }

    @Test
    fun rewindBringsTheLastPassBackWithoutARequest() = runTest {
        val server = Server(people(12))
        val deck = repository(server)
        deck.start()
        settle()
        deck.pass(deck.state.value.cards[0])
        deck.pass(deck.state.value.cards[0])
        advanceTimeBy(2_100)
        runCurrent()
        assertEquals("p02", deck.state.value.rewindable)
        val back = deck.rewind()
        assertEquals("p02", back?.id)
        assertEquals("p02", deck.state.value.cards.first().id)
        assertEquals(ReturningCard("p02", ReturnSide.Left), deck.state.value.returning)
        assertNull("one rewind only", deck.rewind())
        settle()
        assertTrue("p02's pass never left the phone", server.swipes.flatten().none { it.target == "p02" })
    }

    @Test
    fun theEndOfTheDeckOffersTheServersSuggestions() = runTest {
        val server = Server(people(3))
        val deck = repository(server)
        deck.start()
        settle()
        assertEquals(listOf(DeckSuggestion.WidenDistance, DeckSuggestion.WidenAge), deck.state.value.suggestions)
        repeat(3) { deck.pass(deck.state.value.cards.first()) }
        settle()
        assertTrue(deck.state.value.cards.isEmpty())
        assertEquals(DeckStatus.Exhausted, deck.state.value.status)
        assertEquals("no page asked for once the server said there is nobody more", 1, server.pages.size)
    }

    @Test
    fun anEmptyPageWhileTheServerRefillsIsAskedAgainWithBackoff() = runTest {
        val server = Server(emptyList()).apply { exhaustedWhenEmpty = false }
        val deck = repository(server)
        deck.start()
        runCurrent()
        assertEquals(DeckStatus.Loading, deck.state.value.status)
        server.deck.addAll(people(4))
        settle()
        assertEquals(DeckStatus.Ready, deck.state.value.status)
        assertEquals(2, server.pages.size)
    }

    @Test
    fun offlineAndBlockedStatesComeFromTheError() = runTest {
        val server = Server(people(5)).apply { pageError = ApiError.Network(IOException("x")) }
        val deck = repository(server)
        deck.start()
        settle()
        assertEquals(DeckStatus.Offline, deck.state.value.status)

        server.pageError = ApiError.Http(403, Problem.of(403, "snoozed"))
        deck.retry()
        settle()
        assertEquals(DeckStatus.Blocked(DeckBlock.Snoozed), deck.state.value.status)

        server.pageError = ApiError.Http(403, Problem.of(403, "location_required"))
        deck.retry()
        settle()
        assertEquals(DeckStatus.Blocked(DeckBlock.LocationRequired), deck.state.value.status)

        server.pageError = ApiError.Http(500, Problem.of(500, "internal"))
        deck.retry()
        settle()
        assertEquals(DeckStatus.Failed, deck.state.value.status)

        server.pageError = null
        deck.retry()
        settle()
        assertEquals(DeckStatus.Ready, deck.state.value.status)
    }

    @Test
    fun aLaunchStartsFromTheSavedCardsWithNoRequest() = runTest {
        val store = MemoryDeckSnapshotStore()
        val clock = FakeClock()
        val server = Server(people(20))
        val first = repository(server, store, clock)
        first.start()
        settle()
        first.pass(first.state.value.cards.first())
        first.onBackground()
        settle()
        val saved = store.saved
        assertNotNull(saved)
        assertEquals(9, saved!!.cards.size)

        // The next launch, an hour later.
        clock.advance(60 * 60 * 1000L)
        val pagesBefore = server.pages.size
        val second = repository(server, store, clock)
        second.start()
        settle()
        assertEquals(pagesBefore, server.pages.size)
        assertEquals("p02", second.state.value.cards.first().id)
    }

    @Test
    fun oldSavedCardsAreNotShownButTheirSwipesAreStillSent() = runTest {
        val store = MemoryDeckSnapshotStore()
        val clock = FakeClock()
        store.saved = DeckSnapshot(
            account = "me00000000000",
            savedAtMillis = clock.millis - DeckSnapshot.MAX_CARD_AGE_MS - 1,
            cards = listOf(card("old1"), card("old2")),
            pending = listOf(Swipe("gone", SwipeAction.Pass)),
        )
        val server = Server(people(12))
        val deck = repository(server, store, clock)
        deck.start()
        settle()
        assertEquals("p01", deck.state.value.cards.first().id)
        assertTrue(server.swipes.flatten().any { it.target == "gone" })
    }

    @Test
    fun aSavedEndOfTheDeckIsCheckedAgainOnceItsCardsRunOut() = runTest {
        val store = MemoryDeckSnapshotStore()
        val clock = FakeClock()
        store.saved = DeckSnapshot(account = "me00000000000", savedAtMillis = clock.millis, cards = listOf(card("last")), exhausted = true)
        val server = Server(people(3))
        val deck = repository(server, store, clock)
        deck.start()
        settle()
        assertEquals("the saved card, and no page", 0, server.pages.size)
        deck.pass(deck.state.value.cards.single())
        settle()
        assertEquals(1, server.pages.size)
        assertEquals("p01", deck.state.value.cards.first().id)
    }

    @Test
    fun anotherAccountsSnapshotIsIgnored() = runTest {
        val store = MemoryDeckSnapshotStore()
        val clock = FakeClock()
        store.saved = DeckSnapshot(account = "someoneelse00", savedAtMillis = clock.millis, cards = listOf(card("theirs")))
        val server = Server(people(12))
        val deck = repository(server, store, clock)
        deck.start()
        settle()
        assertTrue(deck.state.value.cards.none { it.id == "theirs" })
    }

    @Test
    fun changedFiltersStartTheDeckAgain() = runTest {
        val server = Server(people(12))
        val deck = repository(server)
        deck.start()
        settle()
        deck.pass(deck.state.value.cards.first())
        deck.filtersChanged()
        assertEquals(DeckStatus.Loading, deck.state.value.status)
        assertTrue(deck.state.value.cards.isEmpty())
        settle()
        assertEquals(DeckStatus.Ready, deck.state.value.status)
        assertTrue("the passed person stays out", deck.state.value.cards.none { it.id == "p01" })
    }

    @Test
    fun aLikeBackFromTheLikesListKeepsThatPersonOutOfTheDeck() = runTest {
        val server = Server(people(12))
        val deck = repository(server)
        deck.start()
        settle()
        deck.like(card("p08"))
        assertTrue(deck.state.value.cards.none { it.id == "p08" })
        server.swipeError = ApiError.Network(IOException("offline"))
        deck.like(card("outside"))
        assertTrue("not queued before, not added on failure", deck.state.value.cards.none { it.id == "outside" })
    }
}
