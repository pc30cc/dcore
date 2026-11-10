package app.core.feature.auth

import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A sign-in page with the keyboard up: what is under the field (the code
 * page's error line and its action, Play's Google button) can be scrolled
 * into sight above the keyboard, docked actions or not.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w360dp-h640dp-xhdpi")
class AuthPageInsetsTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private var view: View? = null

    private fun show(docked: Boolean) {
        compose.runOnUiThread { WindowCompat.setDecorFitsSystemWindows(compose.activity.window, false) }
        compose.setContent {
            view = LocalView.current
            AppTheme {
                AuthPage(
                    title = "Title",
                    onBack = {},
                    actions = if (docked) ({ Text("Docked") }) else null,
                ) {
                    Spacer(Modifier.height(360.dp))
                    Text("Under the field")
                }
            }
        }
        compose.waitForIdle()
    }

    /** The keyboard, as the window reports it, [height] tall. */
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

    private fun keyboardTop(height: Int): Float =
        compose.onNode(isRoot()).fetchSemanticsNode().boundsInRoot.bottom - height

    @Test
    fun withoutADockTheContentEndsAboveTheKeyboard() {
        show(docked = false)
        val height = (300 * compose.density.density).toInt()
        keyboard(height)
        compose.onNodeWithText("Under the field").performScrollTo()
        val line = compose.onNodeWithText("Under the field").fetchSemanticsNode().boundsInRoot
        assertTrue("$line is under the keyboard (top ${keyboardTop(height)})", line.bottom <= keyboardTop(height) + 0.5f)
    }

    @Test
    fun aDockedActionSitsAboveTheKeyboardOnce() {
        show(docked = true)
        val height = (300 * compose.density.density).toInt()
        keyboard(height)
        val dock = compose.onNodeWithText("Docked").fetchSemanticsNode().boundsInRoot
        val top = keyboardTop(height)
        assertTrue("the dock is under the keyboard: $dock, keyboard top $top", dock.bottom <= top)
        // 18 dp above the keyboard, not twice the keyboard's height.
        assertTrue("the dock is lifted twice: $dock, keyboard top $top", top - dock.bottom < 40 * compose.density.density)
        compose.onNodeWithText("Under the field").performScrollTo()
        val line = compose.onNodeWithText("Under the field").fetchSemanticsNode().boundsInRoot
        assertTrue("$line is under the dock $dock", line.bottom <= dock.top + 0.5f)
    }
}
