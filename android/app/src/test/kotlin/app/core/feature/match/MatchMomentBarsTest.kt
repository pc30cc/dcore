package app.core.feature.match

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.WindowCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.R
import app.core.feature.card.ScreenTestData
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.shadows.ShadowDialog

/**
 * The match moment's own window shows the bars with the icons its template
 * needs, whatever the activity's theme gave it: light over neon's photos and
 * dark page, dark on white's page (two portrait cards on white).
 */
@RunWith(AndroidJUnit4::class)
class MatchMomentBarsTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun icons(launch: Int, template: app.core.ui.theme.AppTemplate): Pair<Boolean, Boolean> {
        // The activity as a launch in the other template themes it, which a dialog's window starts with.
        compose.runOnUiThread { compose.activity.setTheme(launch) }
        compose.setContent {
            AppTheme(template = template) {
                MatchMomentDialog(ScreenTestData.negar, myPhoto = null, onSendMessage = {}, onDismiss = {})
            }
        }
        compose.waitForIdle()
        val dialog = ShadowDialog.getLatestDialog()
        assertNotNull("the match moment is shown", dialog)
        val window = dialog.window!!
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        return controller.isAppearanceLightStatusBars to controller.isAppearanceLightNavigationBars
    }

    @Test
    fun `the match moment's window has dark bar icons in white after a neon launch`() {
        assertEquals("dark status and navigation icons", true to true, icons(R.style.Theme_App, Templates.White))
    }

    @Test
    fun `the match moment's window has light bar icons in neon after a white launch`() {
        assertEquals("light status and navigation icons", false to false, icons(R.style.Theme_App_Light, Templates.Neon))
    }
}
