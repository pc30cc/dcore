package app.core.feature.card

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onChildren
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.media.LocalRemoteImages
import app.core.ui.components.GlassStats
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalGlass
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs

/**
 * The full profile keeps one close and one «بیشتر» on screen at every scroll
 * position, in both templates: pinned over the first screen while it scrolls
 * away, then in the app bar that replaces them.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class ProfileDetailsChromeTest {

    @get:Rule val compose = createComposeRule()

    // One composition per test (the rule allows one setContent): a test that draws both templates swaps these.
    private var neon by mutableStateOf(false)
    private var shown by mutableStateOf(false)
    private var composed = false
    private var closes = 0
    private var reports = 0
    private var scrolled = 0.dp

    private fun show(neon: Boolean) {
        // Off the screen first, so the page starts again at its top.
        shown = false
        compose.waitForIdle()
        this.neon = neon
        shown = true
        scrolled = 0.dp
        if (!composed) {
            composed = true
            compose.setContent {
                if (shown) Page()
            }
        }
        compose.waitForIdle()
    }

    @androidx.compose.runtime.Composable
    private fun Page() {
        AppTheme(template = Templates.of(if (neon) Templates.NEON else Templates.WHITE)) {
            // The glass blurs (the device gate is off under Robolectric, which reports no RAM).
            CompositionLocalProvider(LocalRemoteImages provides false, LocalGlass provides true) {
                Box(Modifier.fillMaxSize()) {
                    ProfileDetails(
                        ScreenTestData.negar,
                        ScreenTestData.catalog,
                        DetailsSource.Deck,
                        onDismiss = { closes++ },
                        onPass = {},
                        onLike = {},
                        onSuperlike = null,
                        onLikeItem = {},
                        onReport = { reports++ },
                        onBlock = {},
                    )
                }
            }
        }
    }

    private val viewport: Dp get() = compose.onRoot().getBoundsInRoot().let { it.bottom - it.top }

    /** Scrolls the page to [to] from the top, in one step. */
    private fun scrollTo(to: Dp) {
        val px = with(compose.density) { (to - scrolled).toPx() }
        if (px != 0f) {
            compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, px) }
            compose.waitForIdle()
        }
        scrolled = to
    }

    private fun closeBounds(): DpRect {
        compose.onAllNodesWithContentDescription("Close").assertCountEquals(1)
        compose.onAllNodesWithContentDescription("More").assertCountEquals(1)
        compose.onNodeWithContentDescription("Close").assertIsDisplayed()
        compose.onNodeWithContentDescription("More").assertIsDisplayed()
        return compose.onNodeWithContentDescription("Close").getBoundsInRoot()
    }

    private fun closeAndMoreWork() {
        val before = closes
        compose.onNodeWithContentDescription("Close").performClick()
        assertEquals(before + 1, closes)
        compose.onNodeWithContentDescription("More").performClick()
        compose.waitForIdle()
        // The sheet's row (its window is the newest): it closes the sheet and reports.
        val reported = reports
        compose.onAllNodesWithText("Report ⁨Negar⁩").onLast().performClick()
        compose.waitForIdle()
        assertEquals(reported + 1, reports)
    }

    private fun everyScrollPosition(neon: Boolean) {
        show(neon)
        val v = viewport
        for (at in listOf(0.dp, 24.dp, 60.dp, 120.dp, 300.dp, 600.dp, v - 110.dp, v - 80.dp, v + 150.dp)) {
            scrollTo(at)
            val close = closeBounds()
            assertTrue("at $at the close starts on screen (${close.top})", close.top >= 0.dp)
            assertTrue("at $at the close is at the top (${close.bottom})", close.bottom <= 130.dp)
            if (at == 300.dp || at == v + 150.dp) closeAndMoreWork()
        }
    }

    @Test
    fun aCloseAndMoreAreOnScreenAtEveryScrollPositionOnWhite() = everyScrollPosition(neon = false)

    @Test
    fun aCloseAndMoreAreOnScreenAtEveryScrollPositionOnNeon() = everyScrollPosition(neon = true)

    private fun staysPinned(neon: Boolean) {
        show(neon)
        val v = viewport
        val rest = closeBounds()
        for (at in listOf(300.dp, v - 110.dp)) {
            scrollTo(at)
            val now = closeBounds()
            assertTrue("at $at the close stays where it was ($rest, now $now)", abs((now.top - rest.top).value) < 0.5f && abs((now.left - rest.left).value) < 0.5f)
        }
    }

    @Test
    fun theGlassChromeStaysPinnedWhileThePhotoScrollsUnderIt() = staysPinned(neon = true)

    @Test
    fun thePlainHeaderStaysPinnedToo() = staysPinned(neon = false)

    @Test
    fun oneCloseAtRestAndAfterTheHandover() {
        for (dark in listOf(false, true)) {
            show(dark)
            closeBounds()
            // The app bar's heading is not up while the first screen is.
            compose.onAllNodesWithText("⁨Negar⁩, 27").assertCountEquals(0)
            compose.onNode(hasScrollAction()).performScrollToIndex(1)
            compose.waitForIdle()
            closeBounds()
            compose.onAllNodesWithText("⁨Negar⁩, 27").assertCountEquals(1)
            scrolled = 0.dp
            if (!dark) compose.onNode(hasScrollAction()).performScrollToIndex(0)
            compose.waitForIdle()
        }
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun scrollingUnderThePinnedGlassSettlesAfterEveryStep() {
        show(neon = true)
        // A draw or invalidation loop would keep the test from ever going idle.
        for (step in 1..10) scrollTo(30.dp * step)
        closeBounds()
    }

    private fun draw() {
        compose.waitForIdle()
        compose.onRoot().captureToImage()
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun draggingTheFirstScreenUnderThePinnedGlassRecordsNoBlurUntilItRests() {
        show(neon = true)
        draw()
        val rest = GlassStats.blurRecordings
        val page = compose.onNode(hasScrollAction())
        val close = closeBounds()
        // The first screen's bottom edge (its bounds are clipped to the page, so the top stays at 0).
        val heroBottom = page.onChildren().onFirst().getBoundsInRoot().bottom
        // The press and a move past the touch slop in one batch: the drag starts with the first frame.
        page.performTouchInput {
            down(center)
            moveBy(Offset(0f, -24f))
        }
        draw()
        repeat(11) {
            page.performTouchInput { moveBy(Offset(0f, -24f)) }
            draw()
        }
        val moved = heroBottom - page.onChildren().onFirst().getBoundsInRoot().bottom
        assertTrue("the drag moved the photo under the close ($moved)", moved > 150.dp)
        assertEquals("the close stayed", close.top, closeBounds().top)
        assertEquals("no frame of the drag records a blur", rest, GlassStats.blurRecordings)
        // Still before letting go: no fling, the page rests where the finger left it.
        page.performTouchInput {
            advanceEventTime(300)
            up()
        }
        draw()
        val taken = GlassStats.blurRecordings - rest
        // Rested: the close and «بیشتر» take their blur once each from where the photo now is.
        assertTrue("taken again once the page rests ($taken)", taken in 1..2)
        draw()
        assertEquals(rest + taken, GlassStats.blurRecordings)
        assertEquals(close.top, closeBounds().top)
    }
}
