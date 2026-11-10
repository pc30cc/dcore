package app.core.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The picker checks what the rule draws for a choice it cannot show, and never cuts a name short. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TemplatePickerTest {

    @get:Rule val compose = createComposeRule()

    private fun picker(choice: String, offered: List<String>, width: Int = 412) {
        compose.setContent {
            AppTheme(template = Templates.Neon) {
                Box(Modifier.width(width.dp).padding(horizontal = 20.dp)) {
                    TemplatePicker(choice = choice, offered = offered, onChoose = {})
                }
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun `the stored choice is checked while it is offered`() {
        picker(choice = "white", offered = listOf("neon", "white"))
        compose.onNodeWithText("White").assertIsSelected()
        compose.onNodeWithText("Default").assertIsNotSelected()
    }

    @Test
    fun `a stored choice the admin stopped offering shows the default checked`() {
        picker(choice = "white", offered = listOf("neon"))
        compose.onNodeWithText("Default").assertIsSelected()
        compose.onNodeWithText("Dark").assertIsNotSelected()
    }

    @Test
    fun `a stored choice a newer build ships shows the default checked`() {
        picker(choice = "sepia", offered = listOf("neon", "sepia", "white"))
        compose.onNodeWithText("Default").assertIsSelected()
    }

    @Test
    @Config(qualifiers = "tr-w360dp-h800dp", fontScale = 1.3f)
    fun `every name is shown whole on a small phone in Turkish at a large font scale`() {
        picker(choice = "default", offered = listOf("neon", "white"), width = 360)
        for (name in listOf("Varsayılan", "Koyu", "Beyaz")) {
            val layout = layoutOf(name)
            for (line in 0 until layout.lineCount) assertFalse("$name is cut short", layout.isLineEllipsized(line))
            assertEquals("$name is not drawn whole", name.length, layout.getLineEnd(layout.lineCount - 1))
            assertEquals("$name is broken inside the word", 1, layout.lineCount)
            assertFalse("$name is clipped", layout.didOverflowHeight)
        }
        // Still one radio group with the default checked.
        compose.onNodeWithText("Varsayılan").assertIsSelected()
    }

    @Test
    @Config(qualifiers = "fa-w412dp-h892dp")
    fun `in Persian at the design's size each name sits on one line`() {
        picker(choice = "default", offered = listOf("neon", "white"))
        for (name in listOf("پیش‌فرض", "تیره", "سفید")) assertTrue(name, layoutOf(name).lineCount == 1)
        // Side by side, as designed: the three names on one baseline.
        val tops = listOf("پیش‌فرض", "تیره", "سفید").map { compose.onNodeWithText(it, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top }
        assertEquals(1, tops.distinct().size)
    }

    @Test
    @Config(qualifiers = "fa-w360dp-h800dp", fontScale = 1.5f)
    fun `at a large font scale every radio keeps its name beside it`() {
        picker(choice = "default", offered = listOf("neon", "white"), width = 360)
        for (name in listOf("پیش‌فرض", "تیره", "سفید")) {
            // The option (its radio and its name) is one line: the name never drops under the radio.
            val option = compose.onNodeWithText(name).fetchSemanticsNode().boundsInRoot
            val text = compose.onNodeWithText(name, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            assertEquals("$name is on one line", 1, layoutOf(name).lineCount)
            // Under the radio would put it below the swatch (58 + 4), the gap (10) and the radio (20).
            val belowRadio = (58 + 4 + 10 + 20) * compose.density.density
            assertTrue("$name sits beside its radio, not under it ($text in $option)", text.top - option.top < belowRadio)
        }
        // Every option the same way: either all in a row or all one a row.
        val tops = listOf("پیش‌فرض", "تیره", "سفید").map { compose.onNodeWithText(it, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top }
        val lefts = listOf("پیش‌فرض", "تیره", "سفید").map { compose.onNodeWithText(it, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.left }
        assertTrue("aligned: tops $tops, lefts $lefts", tops.distinct().size == 1 || lefts.map { it.toInt() / 8 }.distinct().size == 1)
    }

    private fun layoutOf(text: String): TextLayoutResult {
        val node = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode()
        val results = mutableListOf<TextLayoutResult>()
        node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(results)
        return results.single()
    }
}
