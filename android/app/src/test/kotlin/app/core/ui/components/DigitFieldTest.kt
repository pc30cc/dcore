package app.core.ui.components

import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.input.KeyboardType
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Figures typed into a field read left to right inside a Persian page; words keep the page's direction. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "fa-w411dp-h891dp-xhdpi")
class DigitFieldTest {

    @get:Rule val compose = createComposeRule()

    private fun layout(value: String, keyboard: KeyboardType): TextLayoutResult {
        compose.setContent {
            AppTheme {
                AppTextField(value, {}, keyboardOptions = KeyboardOptions(keyboardType = keyboard))
            }
        }
        val results = mutableListOf<TextLayoutResult>()
        compose.onNode(hasSetTextAction()).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!.invoke(results)
        return results.single()
    }

    @Test
    fun aPhoneNumberReadsLeftToRight() {
        val text = layout("۰۹۱۲ ۳۴۵", KeyboardType.Phone)
        val first = text.getBoundingBox(0)
        val last = text.getBoundingBox(7)
        assertTrue("۰۹۱۲ comes before ۳۴۵ from the left: $first, $last", first.left < last.left)
    }

    @Test
    fun aNameKeepsThePagesDirection() {
        val text = layout("آرش و مهسا", KeyboardType.Text)
        val first = text.getBoundingBox(0)
        val last = text.getBoundingBox(9)
        assertTrue("a Persian name runs from the right: $first, $last", first.left > last.left)
    }
}
