package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalGlass
import app.core.ui.theme.Templates
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Glass records its blur again only when its place over the source changes:
 * scrolling a list that holds both the source and the glass re-records
 * nothing, a glass that moves over the source re-records once, a glass with
 * nothing to blur never records, and a glass that stays put while its
 * source scrolls under it follows the source, or, while the backdrop is
 * held, keeps its blur until the hold ends and then takes it once.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w400dp-h800dp-xhdpi")
class GlassScrollTest {

    @get:Rule val compose = createComposeRule()

    private val list = LazyListState()
    private var pad by mutableStateOf(40.dp)
    private lateinit var backdrop: GlassBackdrop

    @Before
    fun reset() {
        GlassStats.blurRecordings = 0
    }

    private fun draw() {
        compose.waitForIdle()
        compose.onRoot().captureToImage()
    }

    private fun scroll(px: Float) {
        compose.runOnIdle { runBlocking { list.scrollBy(px) } }
        draw()
    }

    /** A 600 dp photo-like source in the list's first item, [glass] drawn over it in the same item, 20 more items after. */
    private fun show(glass: @Composable (GlassBackdrop) -> Unit, pinned: (@Composable (GlassBackdrop) -> Unit)? = null) {
        compose.setContent {
            AppTheme(template = Templates.Neon) {
                // The device gate is off under Robolectric (it reports no RAM); these tests are about the drawing.
                CompositionLocalProvider(LocalGlass provides true) {
                    val backdrop = rememberGlassBackdrop().also { this@GlassScrollTest.backdrop = it }
                    Box(Modifier.fillMaxSize()) {
                        LazyColumn(state = list, modifier = Modifier.fillMaxSize()) {
                            item {
                                Box(Modifier.fillMaxWidth().height(600.dp)) {
                                    Box(Modifier.fillMaxSize().glassSource(backdrop).background(Brush.verticalGradient(listOf(Color.Red, Color.Blue))))
                                    glass(backdrop)
                                }
                            }
                            items(20) { Box(Modifier.fillMaxWidth().height(100.dp)) }
                        }
                        pinned?.invoke(backdrop)
                    }
                }
            }
        }
        draw()
    }

    @Composable
    private fun Button(backdrop: GlassBackdrop?, top: Dp) {
        GlassBox(CircleShape, GlassStyle.photoChrome(), Modifier.padding(top = top).size(48.dp), backdrop) {}
    }

    @Test
    fun scrollingTheSourceAndItsGlassTogetherRecordsTheBlurOnce() {
        show({ Button(it, pad) })
        assertEquals("the blur is recorded at all", 1, GlassStats.blurRecordings)
        repeat(10) { scroll(30f) }
        assertEquals("ten scroll frames re-record nothing", 1, GlassStats.blurRecordings)
    }

    @Test
    fun aGlassThatMovesOverItsSourceRecordsAgainOnce() {
        show({ Button(it, pad) })
        assertEquals(1, GlassStats.blurRecordings)
        pad += 8.dp
        draw()
        assertEquals(2, GlassStats.blurRecordings)
        scroll(30f)
        assertEquals(2, GlassStats.blurRecordings)
    }

    @Test
    fun aGlassWithNothingToBlurNeverRecords() {
        show({ Button(null, 200.dp) })
        repeat(5) { scroll(30f) }
        assertEquals(0, GlassStats.blurRecordings)
    }

    @Test
    fun aGlassPinnedOverAScrollingSourceFollowsIt() {
        show(glass = {}, pinned = { Button(it, 40.dp) })
        assertEquals(1, GlassStats.blurRecordings)
        repeat(4) { scroll(30f) }
        // Not held: each scroll frame moves the source under the still glass, and its blur is taken from the new place.
        assertEquals(5, GlassStats.blurRecordings)
        // Once the source has left the composition, the glass draws its fallback and records nothing more.
        compose.runOnIdle { runBlocking { list.scrollToItem(5) } }
        draw()
        val after = GlassStats.blurRecordings
        scroll(30f)
        assertEquals(after, GlassStats.blurRecordings)
        assertTrue(after >= 5)
    }

    @Test
    fun aHeldBackdropKeepsThePinnedBlurWhileTheSourceScrollsThenTakesItOnce() {
        show(glass = {}, pinned = { Button(it, 40.dp) })
        assertEquals(1, GlassStats.blurRecordings)
        compose.runOnIdle { backdrop.held = true }
        repeat(6) { scroll(30f) }
        assertEquals("no scroll frame records a blur while held", 1, GlassStats.blurRecordings)
        compose.runOnIdle { backdrop.held = false }
        draw()
        assertEquals("released, the glass takes its blur from where the source now is, once", 2, GlassStats.blurRecordings)
        draw()
        assertEquals(2, GlassStats.blurRecordings)
        // Held again with nothing moving, then released: nothing to take again.
        compose.runOnIdle { backdrop.held = true }
        compose.runOnIdle { backdrop.held = false }
        draw()
        assertEquals(2, GlassStats.blurRecordings)
    }

    @Test
    fun aHeldBackdropStillLetsTheGlassMoveWithItsSourceForFree() {
        show({ Button(it, pad) }, pinned = { Button(it, 40.dp) })
        assertEquals(2, GlassStats.blurRecordings)
        compose.runOnIdle { backdrop.held = true }
        repeat(5) { scroll(30f) }
        assertEquals(2, GlassStats.blurRecordings)
        compose.runOnIdle { backdrop.held = false }
        draw()
        // Only the pinned one moved over the source.
        assertEquals(3, GlassStats.blurRecordings)
    }

    @Test
    fun aHeldGlassWhoseSourceLeavesDrawsItsFallback() {
        show(glass = {}, pinned = { Button(it, 40.dp) })
        compose.runOnIdle { backdrop.held = true }
        compose.runOnIdle { runBlocking { list.scrollToItem(5) } }
        draw()
        val gone = GlassStats.blurRecordings
        compose.runOnIdle { backdrop.held = false }
        repeat(3) { scroll(30f) }
        assertEquals("no blur of a source that is no longer there", gone, GlassStats.blurRecordings)
        assertEquals(1, gone)
    }
}
