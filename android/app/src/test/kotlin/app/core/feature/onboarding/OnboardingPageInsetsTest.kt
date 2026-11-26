package app.core.feature.onboarding

import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.ui.components.AppTextField
import app.core.ui.components.PrimaryButton
import app.core.ui.theme.AppTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * A sign-up step with the keyboard up: the docked actions sit just above the
 * keyboard and the field being typed in stays in view above them (the
 * content's viewport ends where the actions begin); without the keyboard the
 * content still ends 70 dp above the button, as the design draws it. On a
 * phone on its side, where lifting the actions would leave the field no room,
 * they stay whole at the bottom under the keyboard and the field is shown
 * above the keyboard instead.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h914dp")
class OnboardingPageInsetsTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private var view: View? = null
    private val scroll = ScrollState(0)

    private fun show() {
        compose.runOnUiThread { WindowCompat.setDecorFitsSystemWindows(compose.activity.window, false) }
        compose.setContent {
            view = LocalView.current
            var text by remember { mutableStateOf("") }
            AppTheme {
                OnboardingPage(StepChrome(1, 10) {}, "Title", scroll = scroll, actions = { PrimaryButton("Continue", {}) }) {
                    Spacer(Modifier.height(480.dp))
                    AppTextField(text, { text = it })
                    Spacer(Modifier.height(200.dp))
                    Text("End")
                }
            }
        }
        compose.waitForIdle()
    }

    private fun px(dp: Int): Float = dp * compose.density.density

    /** The keyboard, as the window reports it, [height] px tall. */
    private fun keyboard(height: Int) {
        compose.runOnUiThread {
            val insets = WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, height))
                .setVisible(WindowInsetsCompat.Type.ime(), height > 0)
                .build()
            ViewCompat.dispatchApplyWindowInsets(view!!, insets)
        }
        compose.waitForIdle()
    }

    private fun root(): Rect = compose.onNode(isRoot()).fetchSemanticsNode().boundsInRoot
    private fun button(): Rect = compose.onNodeWithText("Continue").fetchSemanticsNode().boundsInRoot
    private fun field(): Rect = compose.onNode(hasSetTextAction()).fetchSemanticsNode().boundsInRoot
    private fun header(): Rect = compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo)).fetchSemanticsNode().boundsInRoot

    private fun onItsSideTheFieldStaysAboveTheKeyboard(keyboardDp: Int) {
        show()
        compose.onNode(hasSetTextAction()).performScrollTo().performClick()
        compose.waitForIdle()
        val resting = button()
        val height = px(keyboardDp).roundToInt()
        keyboard(height)
        val top = root().bottom - height
        val field = field()
        assertTrue("the field $field is under the keyboard (top $top)", field.bottom <= top + 0.5f)
        assertTrue("the field $field runs under the header ${header()}", field.top >= header().bottom - 0.5f)
        assertEquals("the actions stay whole where they were", resting, button())
        // The keyboard goes: everything is back where it was.
        keyboard(0)
        assertEquals(resting, button())
    }

    private fun typingKeepsTheFieldAboveTheActions() {
        show()
        compose.onNode(hasSetTextAction()).performScrollTo().performClick()
        compose.waitForIdle()
        val height = px(335).roundToInt()
        keyboard(height)
        val top = root().bottom - height
        val button = button()
        assertTrue("the button $button is under the keyboard (top $top)", button.bottom <= top + 0.5f)
        assertTrue("the button $button is lifted twice (keyboard top $top)", top - button.bottom < px(40))
        val field = field()
        assertTrue("the field $field is under the actions $button", field.bottom <= button.top + 0.5f)
        assertTrue("the field $field is off the top", field.top >= 0f)
    }

    @Test
    fun theFieldBeingTypedInStaysAboveTheDockedActions() = typingKeepsTheFieldAboveTheActions()

    @Test
    @Config(qualifiers = "w360dp-h640dp")
    fun onAShortPhoneTooTheFieldStaysAboveTheDockedActions() = typingKeepsTheFieldAboveTheActions()

    @Test
    @Config(qualifiers = "w640dp-h360dp")
    fun onASmallPhoneOnItsSideTheFieldStaysAboveTheKeyboard() = onItsSideTheFieldStaysAboveTheKeyboard(keyboardDp = 200)

    @Test
    @Config(qualifiers = "w891dp-h411dp")
    fun onAPhoneOnItsSideTheFieldStaysAboveTheKeyboard() = onItsSideTheFieldStaysAboveTheKeyboard(keyboardDp = 190)

    @Test
    @Config(qualifiers = "w891dp-h411dp", fontScale = 1.3f)
    fun onAPhoneOnItsSideWithLargeTextTheFieldStaysAboveTheKeyboard() = onItsSideTheFieldStaysAboveTheKeyboard(keyboardDp = 190)

    @Test
    fun withoutTheKeyboardTheContentEnds70dpAboveTheButton() {
        show()
        compose.runOnIdle { runBlocking { scroll.scrollTo(scroll.maxValue) } }
        compose.waitForIdle()
        val end = compose.onNodeWithText("End").fetchSemanticsNode().boundsInRoot
        val gap = button().top - end.bottom
        assertTrue("the end is $gap px above the button, ${px(70)} expected", abs(gap - px(70)) <= px(1))
    }
}
