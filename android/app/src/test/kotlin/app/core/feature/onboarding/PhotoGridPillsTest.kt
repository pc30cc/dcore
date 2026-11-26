package app.core.feature.onboarding

import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.R
import app.core.media.LocalRemoteImages
import app.core.model.OwnPhoto
import app.core.model.PhotoStatus
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs

/**
 * The pills on a photo tile, measured in the app's own fonts: on the first
 * photo the status pill sits above «اصلی», never over it, and each pill is
 * whole on one line inside its tile, on the narrowest phone with large text,
 * in Persian and in English. A tile with only a status keeps it centred.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PhotoGridPillsTest {

    @get:Rule val compose = createComposeRule()

    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun show() {
        compose.setContent {
            AppTheme(template = Templates.Neon) {
                CompositionLocalProvider(LocalRemoteImages provides false) {
                    Box(Modifier.fillMaxWidth().padding(horizontal = Space.gutter)) {
                        PhotoGridView(
                            PhotosState(
                                tiles = listOf(
                                    PhotoTile.Uploaded(OwnPhoto("p1", 0, PhotoStatus.Review), null),
                                    PhotoTile.Uploaded(OwnPhoto("p2", 1, PhotoStatus.Rejected), null),
                                    PhotoTile.Uploaded(OwnPhoto("p3", 2, PhotoStatus.Approved), null),
                                ),
                            ),
                            onAdd = {}, onRetry = {}, onMove = { _, _ -> }, onRemove = {},
                        )
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    /** The text's bounds (px) after checking it is whole on one line. */
    private fun whole(text: String): Rect {
        val node = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode()
        val layout = mutableListOf<TextLayoutResult>()
        node.config[SemanticsActions.GetTextLayoutResult].action?.invoke(layout)
        assertEquals("$text on one line", 1, layout.single().lineCount)
        assertFalse("$text whole", layout.single().isLineEllipsized(0))
        return node.boundsInRoot
    }

    private fun tile(description: String): Rect =
        compose.onNode(hasContentDescription(description, substring = true), useUnmergedTree = true).fetchSemanticsNode().boundsInRoot

    /** A pill around its text: 10 dp each side, 2 dp above and below. */
    private fun pill(text: Rect): Rect {
        val d = compose.density.density
        return Rect(text.left - 10 * d, text.top - 2 * d, text.right + 10 * d, text.bottom + 2 * d)
    }

    private fun pillsApartAndInside(expectTileDp: Float?) {
        show()
        val d = compose.density.density
        val main = context.getString(R.string.photo_main)
        val review = context.getString(R.string.photo_status_review)
        val rejected = context.getString(R.string.photo_status_rejected)
        val first = tile(", $main")
        expectTileDp?.let { assertEquals("the first tile's width", it * d, first.width, 1f) }
        val mainPill = pill(whole(main))
        val reviewPill = pill(whole(review))
        assertFalse("the review pill ($reviewPill) covers the main tag ($mainPill)", mainPill.overlaps(reviewPill))
        assertTrue("the review pill is above the main tag", reviewPill.bottom <= mainPill.top + 0.5f)
        val inside = Rect(first.left + 8 * d - 1, first.top + 8 * d - 1, first.right - 8 * d + 1, first.bottom - 8 * d + 1)
        for ((name, p) in listOf("main" to mainPill, "review" to reviewPill)) {
            assertTrue("$name pill $p inside $inside", p.left >= inside.left && p.right <= inside.right && p.bottom <= inside.bottom)
        }
        // A tile with only a status keeps it centred.
        val second = tile(rejected)
        val declined = whole(rejected)
        assertEquals("the status of the second tile is centred", second.center.x, declined.center.x, 1f)
    }

    @Test
    @Config(qualifiers = "fa-w360dp-h780dp-xhdpi", fontScale = 1.3f)
    fun persianLargeTextNarrowTileShowsBothPillsWhole() = pillsApartAndInside(expectTileDp = 100f)

    @Test
    @Config(qualifiers = "en-w360dp-h780dp-xhdpi", fontScale = 1.3f)
    fun englishLargeTextNarrowTileShowsBothPillsWhole() = pillsApartAndInside(expectTileDp = 100f)

    @Test
    @Config(qualifiers = "tr-w360dp-h780dp-xhdpi", fontScale = 1.3f)
    fun turkishLargeTextNarrowTileShowsBothPillsWhole() = pillsApartAndInside(expectTileDp = 100f)

    @Test
    @Config(qualifiers = "fa-w411dp-h891dp-xhdpi")
    fun persianDefaultSizeKeepsPillsApart() = pillsApartAndInside(expectTileDp = null)
}
