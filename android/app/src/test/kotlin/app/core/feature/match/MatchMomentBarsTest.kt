package app.core.feature.match

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.WindowCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.R
import app.core.feature.card.ScreenTestData
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.shadows.ShadowDialog

/** The match moment is dark in every template: its own window shows light bar icons, in white too. */
@RunWith(AndroidJUnit4::class)
class MatchMomentBarsTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun `the match moment's window has light bar icons in white`() {
        // The activity as a white launch themes it: dark bar icons, which a dialog's window starts with.
        compose.runOnUiThread { compose.activity.setTheme(R.style.Theme_App_Light) }
        compose.setContent {
            AppTheme(template = Templates.White) {
                MatchMomentDialog(ScreenTestData.negar, myPhoto = null, onSendMessage = {}, onDismiss = {})
            }
        }
        compose.waitForIdle()
        val dialog = ShadowDialog.getLatestDialog()
        assertNotNull("the match moment is shown", dialog)
        val window = dialog.window!!
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        assertFalse("status bar icons are light", controller.isAppearanceLightStatusBars)
        assertFalse("navigation bar icons are light", controller.isAppearanceLightNavigationBars)
    }
}
