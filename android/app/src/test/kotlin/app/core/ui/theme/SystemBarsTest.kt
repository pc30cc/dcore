package app.core.ui.theme

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.WindowCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The window's bar icons have one owner: the template, unless a screen over
 * it asks for its own; when that screen goes, the template's icons as the
 * template is then come back, whatever changed underneath.
 */
@RunWith(AndroidJUnit4::class)
class SystemBarsTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private var template by mutableStateOf(Templates.Neon)
    private var welcome by mutableStateOf(false)
    private var sheetOpen by mutableStateOf(false)
    private var call by mutableStateOf(false)

    /** Whether the status and navigation bars draw dark icons (a light appearance), as the window has them now. */
    private fun darkIcons(): Pair<Boolean, Boolean> {
        compose.waitForIdle()
        val window = compose.activity.window
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        return controller.isAppearanceLightStatusBars to controller.isAppearanceLightNavigationBars
    }

    private fun show() {
        compose.setContent {
            val bars = remember { SystemBarRequests() }
            ApplySystemBars(compose.activity, template, bars)
            CompositionLocalProvider(LocalSystemBars provides bars) {
                // A full-screen scene's own request, and CallHost's.
                if (welcome) SystemBarsOverride(BarIcons(lightStatus = sheetOpen, lightNavigation = true))
                if (call) SystemBarsOverride(BarIcons(lightStatus = true, lightNavigation = true))
            }
        }
    }

    @Test
    fun `with no request the bars follow every template change`() {
        show()
        assertEquals("neon: light icons", false to false, darkIcons())
        template = Templates.White
        assertEquals("white: dark icons", true to true, darkIcons())
        template = Templates.Neon
        assertEquals(false to false, darkIcons())
    }

    @Test
    fun `leaving sign-in after the default changed to white under it shows white's icons`() {
        welcome = true
        show()
        assertEquals("dark status icons over the welcome's sky, a light handle on its dark bottom", true to false, darkIcons())
        // config.ui arrives: the admin's default is white.
        template = Templates.White
        assertEquals("the welcome keeps its own icons", true to false, darkIcons())
        sheetOpen = true
        assertEquals("light icons over the dimmed scene and the sheet", false to false, darkIcons())
        // Signed in: the welcome is gone.
        welcome = false
        assertEquals("white's dark icons on the white app", true to true, darkIcons())
    }

    @Test
    fun `leaving sign-in after the default changed to neon under it shows neon's icons`() {
        template = Templates.White
        welcome = true
        sheetOpen = true
        show()
        assertEquals(false to false, darkIcons())
        template = Templates.Neon
        sheetOpen = false
        welcome = false
        assertEquals("neon's light icons on the dark app", false to false, darkIcons())
    }

    @Test
    fun `a call in white has light icons and gives white's back when it ends`() {
        template = Templates.White
        show()
        assertEquals(true to true, darkIcons())
        call = true
        assertEquals("light icons on the dark call", false to false, darkIcons())
        call = false
        assertEquals(true to true, darkIcons())
    }

    @Test
    fun `the latest request wins and a change to an earlier one keeps it under the later`() {
        template = Templates.White
        welcome = true
        sheetOpen = true
        show()
        call = true
        assertEquals(false to false, darkIcons())
        // The welcome's own request changes under the call: the call still decides.
        sheetOpen = false
        assertEquals(false to false, darkIcons())
        call = false
        assertEquals("the welcome's request again", true to false, darkIcons())
    }
}
