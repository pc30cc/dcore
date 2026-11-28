package app.core.feature.auth

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.brand.AppBrand
import app.core.model.Config
import app.core.model.LegalLinks
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config as RobolectricConfig

/**
 * Maintenance never stands between a person and deleting their account:
 * «حذف حساب» opens the web deletion page (the panel's link, else the
 * brand's), next to «دوباره امتحان کن»; without any link it is not drawn.
 */
@RunWith(AndroidJUnit4::class)
@RobolectricConfig(qualifiers = "w411dp-h891dp")
class MaintenancePageTest {

    @get:Rule val compose = createComposeRule()

    private val calls = mutableListOf<String>()

    private fun show(message: String?, deletion: Boolean) {
        compose.setContent {
            AppTheme(template = Templates.White) {
                MaintenancePage(
                    message = message,
                    checking = false,
                    onRetry = { calls += "retry" },
                    onDelete = if (deletion) ({ calls += "delete" }) else null,
                )
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun deleteAccountIsThereBesideTryAgain() {
        show("Back in a few minutes.", deletion = true)
        compose.onNodeWithText("Back soon").assertIsDisplayed()
        compose.onNodeWithText("Back in a few minutes.").assertIsDisplayed()
        compose.onNodeWithText("Delete account").performClick()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("delete", "retry"), calls)
    }

    @Test
    fun withoutALinkThereIsNoDeleteAndTheBuildsLineStandsIn() {
        show(message = " ", deletion = false)
        compose.onNodeWithText("We’re down for a few minutes. Try again shortly.").assertIsDisplayed()
        assertTrue(compose.onAllNodesWithText("Delete account").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun thePanelsDeletionLinkWinsOverTheBrands() {
        val panel = "https://example.com/account/delete"
        assertEquals(panel, deletionUrl(Config(legal = LegalLinks(deleteAccountUrl = panel))))
        val brand = AppBrand.Legal.deleteAccountUrl.takeIf { it.isNotBlank() }
        assertEquals(brand, deletionUrl(Config(legal = LegalLinks(deleteAccountUrl = ""))))
        assertEquals("no config yet: the brand's", brand, deletionUrl(null))
    }
}
