package app.core.feature.deck

import app.core.common.FakeClock
import app.core.feature.card.LikeTarget
import app.core.feature.paywall.PaywallEntry
import app.core.feature.paywall.PaywallLauncher
import app.core.feature.paywall.PaywallRequest
import app.core.media.PhotoPreloader
import app.core.model.BoostStarted
import app.core.model.Conversation
import app.core.model.ConversationPeer
import app.core.model.DeckPage
import app.core.model.DiscoveryPreferences
import app.core.model.Entitlements
import app.core.model.Features
import app.core.model.ItemKind
import app.core.model.LikedItem
import app.core.model.Me
import app.core.model.OwnPhoto
import app.core.model.OwnProfile
import app.core.model.PhotoStatus
import app.core.model.PreferencesPatch
import app.core.model.Quota
import app.core.model.Quotas
import app.core.model.ReportContext
import app.core.model.ReportReason
import app.core.model.ReportRequest
import app.core.model.AccountLocation
import app.core.model.Problem
import app.core.model.ProfileCard
import app.core.model.Settings
import app.core.model.SettingsPatch
import app.core.model.Swipe
import app.core.model.SwipeAction
import app.core.model.SwipeOutcome
import app.core.model.SwipeResult
import app.core.model.SwipesResult
import app.core.net.ApiError
import app.core.net.Fetched
import app.core.sync.DeckRepository
import app.core.sync.DeckStatus
import app.core.sync.EntitlementRepository
import app.core.sync.MemoryDeckSnapshotStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant

/** The deck screen's model on top of the deck: sheets, rewind gating, the match moment, widening. */
@OptIn(ExperimentalCoroutinesApi::class)
class DeckViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() = Dispatchers.resetMain()

    private class Services(var preferences: DiscoveryPreferences) : DeckServices {
        val patches = mutableListOf<PreferencesPatch>()
        override suspend fun me() = Me(
            id = "me00000000000",
            preferences = preferences,
            profile = OwnProfile(
                id = "me00000000000",
                photos = listOf(OwnPhoto("8001", 0, PhotoStatus.Approved, url = "https://media.test/p/8001/1/640.webp")),
            ),
        )
        override suspend fun updatePreferences(patch: PreferencesPatch): DiscoveryPreferences {
            patches += patch
            preferences = preferences.copy(maxDistanceKm = patch.maxDistanceKm ?: preferences.maxDistanceKm)
            return preferences
        }
        override suspend fun updateSettings(patch: SettingsPatch) = Settings()
        override suspend fun boost() = BoostStarted(Instant.EPOCH)

        val reports = mutableListOf<ReportRequest>()
        val blocks = mutableListOf<String>()
        var safetyError: ApiError? = null
        override suspend fun report(request: ReportRequest) {
            safetyError?.let { throw it }
            reports += request
        }
        override suspend fun block(target: String) {
            safetyError?.let { throw it }
            blocks += target
        }
    }

    private var people = (1..8).map { ProfileCard(id = "p$it", v = 1, name = "P$it") }
    private var likesBack = setOf<String>()
    private var swipeError: ApiError? = null
    private val sent = mutableListOf<Swipe>()
    private val paywall = mutableListOf<PaywallRequest>()

    private fun TestScope.model(entitled: Boolean, services: Services = Services(DiscoveryPreferences(maxDistanceKm = 50))): DeckViewModel {
        val deck = DeckRepository(
            scope = backgroundScope,
            fetchPage = { DeckPage(cards = people, exhausted = true) },
            sendSwipes = { batch: List<Swipe> ->
                swipeError?.let { throw it }
                sent += batch
                SwipesResult(
                    batch.map {
                        if (it.target in likesBack && it.action != SwipeAction.Pass) {
                            SwipeResult(it.target, SwipeOutcome.Matched, Conversation("c-${it.target}", ConversationPeer(it.target, it.target), createdAt = Instant.EPOCH))
                        } else {
                            SwipeResult(it.target, SwipeOutcome.Liked)
                        }
                    },
                )
            },
            account = { "me00000000000" },
            store = MemoryDeckSnapshotStore(),
            clock = FakeClock(),
        )
        val entitlements = EntitlementRepository(fetch = { Fetched(Entitlements(features = Features(rewind = entitled)), changed = true) })
        return DeckViewModel(deck, entitlements, services, PhotoPreloader.None, PaywallLauncher { paywall += it }).also { it.start() }
    }

    private fun TestScope.settle() {
        advanceTimeBy(10_000)
        runCurrent()
    }

    @Test
    fun rewindWithoutThePlanOpensThePlansInsteadOfDoingNothing() = runTest(dispatcher) {
        val vm = model(entitled = false)
        settle()
        vm.swiped(vm.state.value.deck.cards.first(), SwipeAction.Pass)
        vm.rewind()
        settle()
        assertEquals(listOf<PaywallRequest>(PaywallRequest.Plans(PaywallEntry.REWIND)), paywall)
        assertNull("no sheet of its own", vm.state.value.sheet)
        assertEquals("p2", vm.state.value.deck.cards.first().id)
    }

    @Test
    fun rewindWithThePlanBringsTheLastPassBack() = runTest(dispatcher) {
        val vm = model(entitled = true)
        settle()
        vm.swiped(vm.state.value.deck.cards.first(), SwipeAction.Pass)
        vm.rewind()
        settle()
        assertNull(vm.state.value.sheet)
        assertEquals("p1", vm.state.value.deck.cards.first().id)
        vm.rewind()
        settle()
        assertEquals(DeckNotice.RewindNothing, vm.state.value.message?.notice)
    }

    @Test
    fun aMutualLikeShowsTheMatchMomentWithBothFaces() = runTest(dispatcher) {
        likesBack = setOf("p1")
        val vm = model(entitled = false)
        settle()
        vm.swiped(vm.state.value.deck.cards.first(), SwipeAction.Like)
        settle()
        val match = vm.state.value.match
        assertNotNull(match)
        assertEquals("p1", match!!.card.id)
        assertEquals("c-p1", match.conversationId)
        assertEquals("8001", match.myPhoto?.id)
        vm.dismissMatch()
        runCurrent()
        assertNull(vm.state.value.match)
    }

    @Test
    fun theEndOfTheDeckWidensOneStepAndStartsAgain() = runTest(dispatcher) {
        people = listOf(ProfileCard(id = "only", v = 1, name = "Only"))
        val services = Services(DiscoveryPreferences(maxDistanceKm = 50))
        val vm = model(entitled = false, services = services)
        settle()
        vm.swiped(vm.state.value.deck.cards.first(), SwipeAction.Pass)
        settle()
        assertEquals(DeckStatus.Exhausted, vm.state.value.deck.status)
        assertEquals("the filters are read for the widening labels", 50, vm.state.value.preferences?.maxDistanceKm)
        people = listOf(ProfileCard(id = "further", v = 1, name = "Further"))
        vm.widenDistance()
        settle()
        assertEquals(listOf(PreferencesPatch(maxDistanceKm = 100)), services.patches)
        assertEquals(DeckStatus.Ready, vm.state.value.deck.status)
        assertEquals("further", vm.state.value.deck.cards.first().id)
    }

    @Test
    fun aRefusedCommentKeepsTheSheetOpenToEditIt() = runTest(dispatcher) {
        val vm = model(entitled = false)
        settle()
        val card = vm.state.value.deck.cards.first()
        val target = LikeTarget(card, LikedItem(ItemKind.Prompt, "1"))
        vm.openItemLike(target)
        swipeError = ApiError.Http(422, Problem.of(422, "text_refused"))
        vm.sendItemLike(target, "rude")
        settle()
        assertTrue(vm.state.value.sheet is DeckSheet.LikeItem)
        assertEquals(ItemLikeError.Refused, vm.state.value.itemLike.error)
        assertEquals("the card is still there", card.id, vm.state.value.deck.cards.first().id)

        swipeError = null
        vm.sendItemLike(target, "kind words")
        settle()
        assertNull(vm.state.value.sheet)
        assertEquals("p2", vm.state.value.deck.cards.first().id)
    }

    @Test
    fun aLikeWithNoConnectionSaysSoAndKeepsTheCard() = runTest(dispatcher) {
        val vm = model(entitled = false)
        settle()
        swipeError = ApiError.Network(java.io.IOException("offline"))
        vm.swiped(vm.state.value.deck.cards.first(), SwipeAction.Like)
        settle()
        assertEquals(DeckNotice.LikeOffline, vm.state.value.message?.notice)
        assertEquals("p1", vm.state.value.deck.cards.first().id)
    }

    @Test
    fun aBlockFromTheProfileClosesItTakesTheCardAndSaysSo() = runTest(dispatcher) {
        val services = Services(DiscoveryPreferences())
        val vm = model(entitled = false, services = services)
        settle()
        val card = vm.state.value.deck.cards.first()
        vm.openDetails(card)
        vm.block(card)
        settle()
        assertEquals(listOf(card.id), services.blocks)
        assertNull("the profile closed", vm.state.value.details)
        assertTrue("the card left the deck", vm.state.value.deck.cards.none { it.id == card.id })
        assertEquals(DeckNotice.Blocked, vm.state.value.message?.notice)
        assertEquals(card.name, vm.state.value.message?.name)
        assertTrue("a block sends no pass", sent.none { it.target == card.id })
    }

    @Test
    fun aReportWithoutABlockAlsoPassesThem() = runTest(dispatcher) {
        val services = Services(DiscoveryPreferences())
        val vm = model(entitled = false, services = services)
        settle()
        val card = vm.state.value.deck.cards.first()
        vm.openDetails(card)
        vm.report(card, ReportReason.Fake, "fake photos", block = false)
        settle()
        assertEquals(ReportRequest(card.id, ReportContext.Profile, ReportReason.Fake, details = "fake photos", block = false), services.reports.single())
        assertNull(vm.state.value.details)
        assertEquals(DeckNotice.Reported, vm.state.value.message?.notice)
        assertTrue("the card left the deck", vm.state.value.deck.cards.none { it.id == card.id })
        assertTrue("the server hears a pass, so later pages leave them out", sent.any { it.target == card.id && it.action == SwipeAction.Pass })
    }

    @Test
    fun aReportWithABlockSendsNoPass() = runTest(dispatcher) {
        val services = Services(DiscoveryPreferences())
        val vm = model(entitled = false, services = services)
        settle()
        val card = vm.state.value.deck.cards.first()
        vm.report(card, ReportReason.Harassment, null, block = true)
        settle()
        assertEquals(true, services.reports.single().block)
        assertTrue(vm.state.value.deck.cards.none { it.id == card.id })
        assertTrue(sent.none { it.target == card.id })
    }

    @Test
    fun aSafetyCallThatFailsKeepsTheProfileAndTheCardAndSaysWhy() = runTest(dispatcher) {
        val services = Services(DiscoveryPreferences())
        val vm = model(entitled = false, services = services)
        settle()
        val card = vm.state.value.deck.cards.first()
        vm.openDetails(card)

        services.safetyError = ApiError.Network(java.io.IOException("offline"))
        vm.block(card)
        settle()
        assertEquals("still open: the failure is told over it", card.id, vm.state.value.details?.id)
        assertEquals(card.id, vm.state.value.deck.cards.first().id)
        assertEquals(DeckNotice.Offline, vm.state.value.message?.notice)

        services.safetyError = ApiError.Http(503, Problem.of(503, "unavailable"))
        vm.report(card, ReportReason.Spam, null, block = false)
        settle()
        assertEquals(card.id, vm.state.value.details?.id)
        assertEquals(card.id, vm.state.value.deck.cards.first().id)
        assertEquals(DeckNotice.SafetyFailed, vm.state.value.message?.notice)
        assertTrue("nothing was passed", sent.none { it.target == card.id })
    }

    @Test
    fun aSuperLikeFromTheLikeSheetCarriesTheItemAndTheNote() = runTest(dispatcher) {
        val vm = model(entitled = false)
        settle()
        val card = vm.state.value.deck.cards.first()
        val target = LikeTarget(card, LikedItem(ItemKind.Photo, "9002"), photoIndex = 1)
        vm.openItemLike(target)
        vm.sendItemLike(target, "Great view", SwipeAction.Superlike)
        settle()
        val swipe = sent.single { it.target == card.id }
        assertEquals(SwipeAction.Superlike, swipe.action)
        assertEquals(LikedItem(ItemKind.Photo, "9002"), swipe.item)
        assertEquals("Great view", swipe.comment)
        assertNull("the sheet closed", vm.state.value.sheet)
    }

    @Test
    fun theCountryComesFromTheAccountsLocation() = runTest(dispatcher) {
        val services = object : DeckServices by Services(DiscoveryPreferences()) {
            override suspend fun me() = Me(id = "me00000000000", preferences = DiscoveryPreferences(), location = AccountLocation(country = "IR"))
        }
        val deck = DeckRepository(
            scope = backgroundScope,
            fetchPage = { DeckPage(cards = people, exhausted = true) },
            sendSwipes = { batch: List<Swipe> -> SwipesResult(batch.map { SwipeResult(it.target, SwipeOutcome.Liked) }) },
            account = { "me00000000000" },
            store = MemoryDeckSnapshotStore(),
            clock = FakeClock(),
        )
        val vm = DeckViewModel(deck, EntitlementRepository(fetch = { Fetched(Entitlements(), changed = true) }), services, PhotoPreloader.None).also { it.start() }
        vm.openFilters()
        settle()
        assertEquals("IR", vm.state.value.country)
    }

    @Test
    fun superLikesLeftIsNullBothWhenUnlimitedAndWhileUnknown() {
        assertNull(DeckUiState(entitlements = null).superlikesLeft)
        assertNull(DeckUiState(entitlements = Entitlements(quotas = Quotas(superlikes = Quota(limit = -1)))).superlikesLeft)
        assertEquals(2, DeckUiState(entitlements = Entitlements(quotas = Quotas(superlikes = Quota(limit = 3, used = 1)))).superlikesLeft)
    }
}
