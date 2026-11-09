package app.core.feature.deck

import app.core.common.FakeClock
import app.core.feature.paywall.PaywallEntry
import app.core.feature.paywall.PaywallLauncher
import app.core.feature.paywall.PaywallRequest
import app.core.media.PhotoPreloader
import app.core.model.BoostStarted
import app.core.model.DeckPage
import app.core.model.DiscoveryPreferences
import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.model.Me
import app.core.model.Plan
import app.core.model.PreferencesPatch
import app.core.model.Problem
import app.core.model.Settings
import app.core.model.SettingsPatch
import app.core.model.SwipesResult
import app.core.model.WalletItem
import app.core.net.ApiError
import app.core.net.Fetched
import app.core.sync.DeckRepository
import app.core.sync.EntitlementRepository
import app.core.sync.MemoryDeckSnapshotStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant

/** The deck's boost: its end shows at once; none left opens the boost packs when they are sold. */
@OptIn(ExperimentalCoroutinesApi::class)
class DeckBoostTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() = Dispatchers.resetMain()

    private var answer: () -> BoostStarted = { BoostStarted(Instant.parse("2026-11-09T08:30:00Z")) }
    private val opened = mutableListOf<PaywallRequest>()

    private val services = object : DeckServices {
        override suspend fun me() = Me(id = "me00000000000", preferences = DiscoveryPreferences())
        override suspend fun updatePreferences(patch: PreferencesPatch) = DiscoveryPreferences()
        override suspend fun updateSettings(patch: SettingsPatch) = Settings()
        override suspend fun boost() = answer()
    }

    private fun TestScope.model(
        entitlements: EntitlementRepository = EntitlementRepository(fetch = { Fetched(Entitlements(), changed = true) }),
    ): Pair<DeckViewModel, EntitlementRepository> {
        val deck = DeckRepository(
            scope = backgroundScope,
            fetchPage = { DeckPage(cards = emptyList(), exhausted = true) },
            sendSwipes = { SwipesResult() },
            account = { "me00000000000" },
            store = MemoryDeckSnapshotStore(),
            clock = FakeClock(),
        )
        entitlements.apply(Entitlements())
        return DeckViewModel(deck, entitlements, services, PhotoPreloader.None, PaywallLauncher { opened += it }) to entitlements
    }

    @Test
    fun aStartedBoostShowsItsEndAtOnce() = runTest(dispatcher) {
        val (vm, entitlements) = model()
        vm.boost()
        advanceUntilIdle()
        assertEquals(Instant.parse("2026-11-09T08:30:00Z"), entitlements.entitlements.value?.boostEndsAt)
        assertEquals(DeckNotice.BoostStarted, vm.state.value.message?.notice)
        assertTrue(opened.isEmpty())
    }

    @Test
    fun noBoostLeftOpensTheBoostPacksWhenTheyAreSold() = runTest(dispatcher) {
        val (vm, _) = model()
        answer = { throw ApiError.Http(429, Problem.of(429, "quota_exceeded", "feature" to "boosts", "canBuy" to true)) }
        vm.boost()
        advanceUntilIdle()
        assertEquals(listOf(PaywallRequest.Packs(WalletItem.Boost, PaywallEntry.BOOSTS)), opened)

        answer = { throw ApiError.Http(429, Problem.of(429, "quota_exceeded", "feature" to "boosts", "canBuy" to false)) }
        vm.boost()
        advanceUntilIdle()
        assertEquals("nothing to buy: said, not sold", DeckNotice.BoostNone, vm.state.value.message?.notice)
        assertEquals(1, opened.size)
    }

    /**
     * Another store's `entitlement` hint is being answered when the boost
     * starts: the boost's end is the app's own patch, not a view the server
     * published, so the read keeps its newer answer, and the boost stays.
     */
    @Test
    fun aBoostWhileAHintIsReadKeepsTheReadsAnswerAndTheBoost() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val premium = Entitlements(plan = Plan.Premium, source = EntitlementSource.Bazaar)
        val (vm, entitlements) = model(EntitlementRepository(fetch = { gate.await(); Fetched(premium, changed = true) }))
        val reading = async { entitlements.reread() }
        runCurrent()
        vm.boost()
        advanceUntilIdle()
        assertEquals("shown at once", Instant.parse("2026-11-09T08:30:00Z"), entitlements.entitlements.value?.boostEndsAt)
        gate.complete(Unit)
        advanceUntilIdle()
        assertTrue("the hint is answered", reading.await())
        assertEquals(Plan.Premium, entitlements.entitlements.value?.plan)
        assertEquals(Instant.parse("2026-11-09T08:30:00Z"), entitlements.entitlements.value?.boostEndsAt)
    }
}
