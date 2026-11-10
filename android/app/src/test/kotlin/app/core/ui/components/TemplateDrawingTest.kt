package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PixelMap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTemplate
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import app.core.ui.theme.stop
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs

/**
 * What the components draw, read back from the pixels (2 px a dp): each
 * fill shows its whole gradient, a fresh match is ringed outside its photo
 * in `--primary`, the code cells sit in the middle with the hairline over
 * the filled band, the slider's track meets both content edges, and the
 * shadows the design gives a glass button and a sheet are drawn.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w600dp-h900dp-xhdpi")
class TemplateDrawingTest {

    @get:Rule val compose = createComposeRule()

    private fun draw(template: AppTemplate, direction: LayoutDirection = LayoutDirection.Ltr, content: @Composable () -> Unit): PixelMap {
        compose.setContent {
            AppTheme(template = template) {
                CompositionLocalProvider(LocalLayoutDirection provides direction) {
                    Box(Modifier.background(template.colors.bg)) { content() }
                }
            }
        }
        compose.waitForIdle()
        return compose.onRoot().captureToImage().toPixelMap()
    }

    private fun distance(a: Color, b: Color): Float = abs(a.red - b.red) + abs(a.green - b.green) + abs(a.blue - b.blue)

    /** Which of [candidates] [c] is closest to. */
    private fun nearest(c: Color, candidates: Map<String, Color>): String = candidates.minBy { distance(c, it.value) }.key

    private fun stops(t: AppTemplate) = mapOf(
        "first" to t.paints.progressFill.stop(0),
        "middle" to t.paints.progressFill.stop(1),
        "last" to t.paints.progressFill.stop(2),
    )

    @Test
    fun `a 40 percent progress fill shows the violet and the pink stop at its two ends, left to right`() {
        val t = Templates.Neon
        val px = draw(t) { Box(Modifier.width(400.dp)) { ProgressBar(0.4f) } }
        // 270deg runs right to left: the first (violet) stop at the fill's right end, the last (pink) at its left end.
        assertEquals("right end", "first", nearest(px[314, 4], stops(t)))
        assertEquals("left end", "last", nearest(px[6, 4], stops(t)))
    }

    @Test
    fun `a 40 percent progress fill shows the violet and the pink stop at its two ends, right to left`() {
        val t = Templates.Neon
        val px = draw(t, LayoutDirection.Rtl) { Box(Modifier.width(400.dp)) { ProgressBar(0.4f) } }
        // The fill runs from the right edge to 60 %: the gradient is physical, so the ends are the same colours.
        assertEquals("right end", "first", nearest(px[793, 4], stops(t)))
        assertEquals("left end", "last", nearest(px[486, 4], stops(t)))
    }

    @Test
    fun `the swatch's like disc is the whole like gradient`() {
        val t = Templates.Neon
        val px = draw(t) { TemplateSwatch(Templates.NEON, Modifier.size(100.dp, 58.dp)) }
        // The disc: centre (18, 40) dp, radius 6 dp. 250deg: violet on the right, pink on the left.
        val like = mapOf("violet" to t.paints.likeFill.stop(0), "pink" to t.paints.likeFill.stop(2))
        assertEquals("disc's right side", "violet", nearest(px[36 + 9, 80], like))
        assertEquals("disc's left side", "pink", nearest(px[36 - 9, 80], like))
    }

    @Test
    fun `a fresh match keeps its 76 by 100 photo and is ringed outside it in the accent`() {
        val t = Templates.Neon
        val px = draw(t) {
            Box(Modifier.padding(10.dp)) {
                MatchTile(isNew = true) { Box(Modifier.fillMaxSize().background(Color.Black).testTag("photo")) }
            }
        }
        val bounds = compose.onNodeWithTag("photo").fetchSemanticsNode().size
        assertEquals(152 to 200, bounds.width to bounds.height)
        // From the photo's left edge (x = 20 px) outwards, at mid height: 2 dp of page, then 2 dp of --primary.
        val y = 20 + 100
        val roles = mapOf("page" to t.colors.bg, "primary" to t.colors.primary, "photo" to Color.Black)
        assertEquals("the gap", "page", nearest(px[20 - 2, y], roles))
        assertEquals("the ring", "primary", nearest(px[20 - 6, y], roles))
        assertTrue("the ring is solid --primary", distance(px[20 - 6, y], t.colors.primary) < 0.05f)
        assertEquals("outside the ring", "page", nearest(px[20 - 10, y], roles))
    }

    /** The six cells' left and right margins in a 412 dp row, in px, and the pixels. */
    private fun otp(): Triple<Int, Int, PixelMap> {
        val t = Templates.Neon
        val px = draw(t) { Box(Modifier.width(412.dp)) { OtpCells("4", 6, focused = false) } }
        val inked = (0 until px.width).filter { distance(px[it, 62], t.colors.bg) > 0.02f }
        return Triple(inked.first(), px.width - 1 - inked.last(), px)
    }

    @Test
    fun `the code cells sit in the middle of their row`() {
        val (left, right, _) = otp()
        assertTrue("left $left, right $right", abs(left - right) <= 2)
        assertTrue("31 dp each side, as six 50 dp cells in 412 dp leave: $left px", abs(left - 62) <= 2)
    }

    @Test
    fun `a filled code cell shows the hairline over its band`() {
        val t = Templates.Neon
        val (left, _, px) = otp()
        // The first cell, filled: its bottom 1 dp is --field-line, the 2 dp above it --otp-filled.
        val x = left + 50
        val roles = mapOf(
            "line" to t.shadows.fieldLine.first().color,
            "band" to t.shadows.otpFilled.first().color,
            "field" to t.colors.surfaceField,
        )
        val bottom = 2 * 62 - 1
        assertEquals("bottom row", "line", nearest(px[x, bottom], roles))
        assertEquals("1 dp up", "band", nearest(px[x, bottom - 3], roles))
        assertEquals("2 dp up", "band", nearest(px[x, bottom - 4], roles))
        assertEquals("4 dp up", "field", nearest(px[x, bottom - 8], roles))
    }

    @Test
    fun `the slider's track meets both content edges`() {
        val t = Templates.Neon
        val px = draw(t) { Box(Modifier.width(300.dp).padding(horizontal = 0.dp)) { AppSlider(0.4f, {}) } }
        val y = 48
        val roles = mapOf("page" to t.colors.bg, "track" to t.colors.sliderTrack, "fill" to t.paints.sliderFill.stop(2))
        assertEquals("at the start edge", "fill", nearest(px[3, y], roles))
        assertEquals("at the end edge", "track", nearest(px[596, y], roles))
    }

    @Test
    fun `a glass icon button on white has its shadow`() {
        val t = Templates.White
        val px = draw(t) {
            Box(Modifier.size(120.dp), contentAlignment = Alignment.Center) {
                AppIconButton(AppIcons.Tune, "Filters", {}, kind = IconButtonKind.Glass)
            }
        }
        // The disc ends 24 dp below the centre (120 px); 4 dp lower is shadow, not page.
        val below = px[120, 120 + 48 + 8]
        assertTrue("below the disc: $below", distance(below, Color.White) > 0.03f)
    }

    @Test
    fun `a sheet has its top highlight in neon`() {
        val t = Templates.Neon
        val px = draw(t) {
            Box(Modifier.size(300.dp, 200.dp)) {
                Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(120.dp).sheetSurface())
            }
        }
        val top = 2 * 80 + 1
        assertTrue("the highlight row ${px[300, top]}", distance(px[300, top], t.colors.surfaceSheet) > 0.03f)
        assertTrue("under it, the sheet", distance(px[300, top + 10], t.colors.surfaceSheet) < 0.01f)
    }

    @Test
    fun `a sheet casts its shadow upward in white`() {
        val t = Templates.White
        val px = draw(t) {
            Box(Modifier.size(300.dp, 200.dp)) {
                Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(120.dp).sheetSurface())
            }
        }
        val above = px[300, 2 * 80 - 12]
        assertTrue("above the sheet: $above", distance(above, Color.White) > 0.02f)
    }
}
