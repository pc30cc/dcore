package app.core.feature.deck

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.feature.card.LikeTarget
import app.core.feature.card.ScreenTestData
import app.core.media.LocalRemoteImages
import app.core.model.Id
import app.core.model.PreferencesPatch
import app.core.model.ProfileCard
import app.core.model.SwipeAction
import app.core.sync.DeckState
import app.core.sync.DeckStatus
import app.core.ui.components.GlassBackdrop
import app.core.ui.components.rememberGlassBackdrop
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalGlass
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The deck at rest changes nothing from one frame to the next (no pulse, no
 * timer, nothing under the glass), in both templates; the loading sweep is
 * the one thing that runs, and it is not under the glass.
 *
 * The clock is held from the start where frames are counted: with it
 * advancing by itself the test rule cancels infinite animations.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp")
class DeckIdleTest {

    @get:Rule val compose = createComposeRule()

    private var state by mutableStateOf(DeckUiState())
    private lateinit var backdrop: GlassBackdrop

    private val ready = DeckUiState(deck = DeckState(cards = listOf(ScreenTestData.negar, ScreenTestData.elif), status = DeckStatus.Ready))
    private val loading = DeckUiState(deck = DeckState(status = DeckStatus.Loading))

    private val none = object : DeckActions {
        override fun swiped(card: ProfileCard, action: SwipeAction) = Unit
        override fun returnShown(id: String) = Unit
        override fun openDetails(card: ProfileCard) = Unit
        override fun closeDetails() = Unit
        override fun fromDetails(action: SwipeAction) = Unit
        override fun openItemLike(target: LikeTarget) = Unit
        override fun sendItemLike(target: LikeTarget, comment: String) = Unit
        override fun rewind() = Unit
        override fun openFilters() = Unit
        override fun applyFilters(patch: PreferencesPatch) = Unit
        override fun widenDistance() = Unit
        override fun widenAge() = Unit
        override fun boost() = Unit
        override fun wakeUp() = Unit
        override fun retry() = Unit
        override fun dismissSheet() = Unit
        override fun dismissMatch() = Unit
        override fun messageShown(id: Long) = Unit
        override fun openChat(conversationId: Id?) = Unit
        override fun openProfile() = Unit
    }

    private fun show(template: String, initial: DeckUiState) {
        state = initial
        compose.setContent {
            AppTheme(template = Templates.of(template)) {
                // The device gate is off under Robolectric (it reports no RAM); these tests are about the drawing.
                CompositionLocalProvider(LocalRemoteImages provides false, LocalGlass provides true) {
                    backdrop = rememberGlassBackdrop()
                    DeckScreen(state, ScreenTestData.catalog, 300, none, backdrop = backdrop)
                }
            }
        }
    }

    /** The snapshot state changes applied over [frames] frames. */
    private fun appliedOver(frames: Int): List<Set<Any>> {
        val applied = mutableListOf<Set<Any>>()
        val observer = Snapshot.registerApplyObserver { changed, _ -> if (changed.isNotEmpty()) applied += changed }
        try {
            repeat(frames) { compose.mainClock.advanceTimeByFrame() }
        } finally {
            observer.dispose()
        }
        return applied
    }

    private fun atRest(template: String) {
        compose.mainClock.autoAdvance = false
        show(template, ready)
        // The cards' springs and the first layouts settle.
        repeat(SETTLE_FRAMES) { compose.mainClock.advanceTimeByFrame() }
        compose.waitForIdle()
        assertEquals("state changes at rest", emptyList<Set<Any>>(), appliedOver(120))
    }

    @Test
    fun aBleedDeckAtRestChangesNothingFrameAfterFrame() {
        atRest(Templates.NEON)
        assertNotNull("the cards are the glass's source", backdrop.source)
    }

    @Test
    fun aCardDeckAtRestChangesNothingFrameAfterFrame() = atRest(Templates.WHITE)

    @Test
    fun theLoadingSweepIsSeenByThisHarness() {
        compose.mainClock.autoAdvance = false
        show(Templates.NEON, loading)
        repeat(3) { compose.mainClock.advanceTimeByFrame() }
        assertTrue("an animation that never ends is seen here", appliedOver(30).isNotEmpty())
    }

    @Test
    fun whileTheFirstPageLoadsTheSkeletonIsNotAGlassSource() {
        show(Templates.NEON, loading)
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Loading").assertExists()
        assertNull("the sweep would re-render every blur over it", backdrop.source)
        state = ready
        compose.waitForIdle()
        assertNotNull(backdrop.source)
    }

    private companion object {
        const val SETTLE_FRAMES = 90
    }
}
