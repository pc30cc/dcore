package app.core.feature.likes

import app.core.common.FakeClock
import app.core.model.DeckPage
import app.core.model.Entitlements
import app.core.model.LikeItem
import app.core.model.LikeKind
import app.core.model.LikesPage
import app.core.model.Me
import app.core.model.ProfileCard
import app.core.model.Swipe
import app.core.model.SwipeOutcome
import app.core.model.SwipeResult
import app.core.model.SwipesResult
import app.core.net.ApiError
import app.core.net.Fetched
import app.core.sync.DeckRepository
import app.core.sync.EntitlementRepository
import app.core.sync.MemoryDeckSnapshotStore
import kotlinx.coroutines.CompletableDeferred
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The Likes tab's model: liking back from a tile. */
@OptIn(ExperimentalCoroutinesApi::class)
class LikesViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() = Dispatchers.resetMain()

    private val pariya = ProfileCard(id = "pariya0000001", v = 1, name = "Pariya")
    private val sent = mutableListOf<Swipe>()
    private var answer = CompletableDeferred<Unit>()
    private var swipeError: ApiError? = null
    private val reports = mutableListOf<app.core.model.ReportRequest>()
    private val blocks = mutableListOf<String>()
    private var safetyError: ApiError? = null

    private fun TestScope.model(): LikesViewModel {
        val deck = DeckRepository(
            scope = backgroundScope,
            fetchPage = { DeckPage(cards = emptyList(), exhausted = true) },
            sendSwipes = { batch: List<Swipe> ->
                sent += batch
                answer.await()
                swipeError?.let { throw it }
                SwipesResult(batch.map { SwipeResult(it.target, SwipeOutcome.Liked) })
            },
            account = { "me00000000000" },
            store = MemoryDeckSnapshotStore(),
            clock = FakeClock(),
        )
        val services = object : LikesServices {
            override suspend fun likes(cursor: String?, limit: Int) =
                LikesPage(total = 1, items = listOf(LikeItem(liker = pariya, kind = LikeKind.Like)))
            override suspend fun me() = Me(id = "me00000000000")
            override suspend fun report(request: app.core.model.ReportRequest) {
                safetyError?.let { throw it }
                reports += request
            }
            override suspend fun block(target: String) {
                safetyError?.let { throw it }
                blocks += target
            }
        }
        val entitlements = EntitlementRepository(fetch = { Fetched(Entitlements(), changed = true) })
        return LikesViewModel(services, deck, entitlements, FakeClock()).also { it.start() }
    }

    private fun TestScope.settle() {
        advanceTimeBy(10_000)
        runCurrent()
    }

    @Test
    fun aDoubleTapOnATilesLikeSendsOneLike() = runTest(dispatcher) {
        val vm = model()
        settle()
        val item = vm.state.value.items.single()
        vm.likeBack(item)
        runCurrent()
        assertTrue("the tile waits for the answer", pariya.id in vm.state.value.liking)
        vm.likeBack(item)
        vm.likeBack()
        settle()
        answer.complete(Unit)
        settle()
        assertEquals(1, sent.count { it.target == pariya.id })
        assertTrue("sent: the tile goes", vm.state.value.items.isEmpty())
        assertTrue(vm.state.value.liking.isEmpty())
    }

    @Test
    fun aLikeThatFailsLeavesTheTileWithItsButtonBack() = runTest(dispatcher) {
        val vm = model()
        settle()
        swipeError = ApiError.Network(java.io.IOException("offline"))
        answer.complete(Unit)
        vm.likeBack(vm.state.value.items.single())
        settle()
        assertEquals(1, vm.state.value.items.size)
        assertTrue(vm.state.value.liking.isEmpty())
        assertEquals(LikesNotice.LikeOffline, vm.state.value.message?.notice)
    }

    @Test
    fun aReportFromTheOpenProfileClosesItAndTheLikeLeavesTheList() = runTest(dispatcher) {
        val vm = model()
        settle()
        vm.open(vm.state.value.items.single())
        assertEquals(pariya, vm.state.value.details)
        vm.report(pariya, app.core.model.ReportReason.Harassment, "Rude note", block = false)
        settle()
        val sent = reports.single()
        assertEquals(pariya.id, sent.target)
        assertEquals(app.core.model.ReportContext.Profile, sent.context)
        assertEquals(app.core.model.ReportReason.Harassment, sent.reason)
        assertEquals(false, sent.block)
        assertEquals(null, vm.state.value.details)
        assertTrue("the like leaves the list", vm.state.value.items.isEmpty())
        assertEquals(LikesNotice.Reported, vm.state.value.message?.notice)
    }

    @Test
    fun aBlockThatCannotReachTheServerLeavesTheProfileOpenAndSaysSo() = runTest(dispatcher) {
        val vm = model()
        settle()
        vm.open(vm.state.value.items.single())
        safetyError = ApiError.Network(java.io.IOException("offline"))
        vm.block(pariya)
        settle()
        assertTrue(blocks.isEmpty())
        assertEquals(pariya, vm.state.value.details)
        assertEquals(1, vm.state.value.items.size)
        assertEquals(LikesNotice.Offline, vm.state.value.message?.notice)
        safetyError = null
        vm.block(pariya)
        settle()
        assertEquals(listOf(pariya.id), blocks)
        assertEquals(null, vm.state.value.details)
        assertTrue(vm.state.value.items.isEmpty())
        assertEquals(LikesNotice.Blocked, vm.state.value.message?.notice)
    }
}
