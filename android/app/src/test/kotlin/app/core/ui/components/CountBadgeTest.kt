package app.core.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Counts in one column stand equally tall: "3", "12", "9+" and "99+" share a
 * height (from the font size), one figure is a circle and more figures a
 * short pill, never a bigger disc. Real text metrics.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xhdpi")
class CountBadgeTest {

    @get:Rule val compose = createComposeRule()

    private fun sizes(vararg counts: String): Map<String, androidx.compose.ui.geometry.Rect> {
        compose.setContent {
            AppTheme {
                Column { counts.forEach { CountBadge(it, Modifier.testTag("badge.$it")) } }
            }
        }
        return counts.associateWith { compose.onNodeWithTag("badge.$it").fetchSemanticsNode().boundsInRoot }
    }

    private fun assertOneHeight(sizes: Map<String, androidx.compose.ui.geometry.Rect>, one: String) {
        val heights = sizes.mapValues { it.value.height }
        assertTrue("one height for every count: $heights", heights.values.max() - heights.values.min() <= 1f)
        val single = sizes.getValue(one)
        assertEquals("one figure is round: $single", single.width, single.height, 1f)
        for ((text, box) in sizes) assertTrue("$text is never taller than wide: $box", box.width >= box.height - 1f)
    }

    @Test
    fun latinCountsShareOneHeight() {
        val sizes = sizes("3", "4", "12", "9+", "99+")
        assertOneHeight(sizes, "3")
        // The design's 22 px over its 12 px caption (22/12 em, never under 16 dp), at 1x text.
        assertEquals(22f * compose.density.density, sizes.getValue("3").height, 1f)
        assertTrue("two figures are a pill a little wider than a circle", sizes.getValue("12").width < sizes.getValue("99+").width)
    }

    @Test
    @Config(qualifiers = "fa-w411dp-h891dp-xhdpi", fontScale = 1.5f)
    fun persianCountsAtLargeTextShareOneHeightToo() {
        val sizes = sizes("۳", "۱۲", "۹+", "۹۹+")
        assertOneHeight(sizes, "۳")
        assertTrue("grew with the text: ${sizes.getValue("۳")}", sizes.getValue("۳").height > 17f * compose.density.density)
    }
}
