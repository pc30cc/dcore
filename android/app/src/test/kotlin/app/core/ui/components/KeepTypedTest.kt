package app.core.ui.components

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** A field never cuts what was written under an older, larger limit; it only stops new text past its own. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "en-w411dp-h891dp-xhdpi")
class KeepTypedTest {

    @get:Rule val compose = createComposeRule()

    @Test
    fun newTextStopsAtTheLimitButOlderLongerTextIsKept() {
        // Typing and pasting within or up to the limit.
        assertEquals("abc", keepTyped("abc", "ab", 5))
        assertEquals("abcde", keepTyped("abcdefg", "abc", 5))
        // Already over the limit: a longer edit is refused, a shorter one taken.
        val old = "x".repeat(200)
        assertEquals(old, keepTyped(old + "y", old, 150))
        assertEquals(old.dropLast(1), keepTyped(old.dropLast(1), old, 150))
        // Shortened back under the limit, the limit holds again.
        assertEquals("x".repeat(150), keepTyped("x".repeat(151), "x".repeat(149), 150))
    }

    @Test
    fun anExistingLongAnswerKeepsItsTextWhenACharacterIsTyped() {
        val old = "a".repeat(120) + " " + "b".repeat(79) // 200 characters, written when answers could be 200 long
        var text by mutableStateOf(old)
        compose.setContent { AppTheme { AppTextArea(text, { text = it }, maxLength = 150, placeholder = "Answer") } }
        compose.onNode(hasSetTextAction()).performTextInput("!")
        compose.waitForIdle()
        assertEquals(old, text)
        // Shortening it is taken as written.
        compose.onNode(hasSetTextAction()).performTextReplacement(old.take(160))
        compose.waitForIdle()
        assertEquals(old.take(160), text)
    }

    @Test
    fun aSingleLineFieldKeepsAnOlderLongerValueToo() {
        val old = "Senior industrial designer at a studio in the north of Tehran" // 61, over a 60 limit
        var text by mutableStateOf(old)
        compose.setContent { AppTheme { AppTextField(value = text, onValueChange = { text = it }, maxLength = 60, placeholder = "Work") } }
        compose.onNode(hasSetTextAction()).performTextInput("s")
        compose.waitForIdle()
        assertEquals(old, text)
    }
}
