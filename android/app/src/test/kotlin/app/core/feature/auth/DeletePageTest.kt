package app.core.feature.auth

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.model.StoreName
import app.core.model.StoreSubscriptionNotice
import app.core.store.Store
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The delete screen (m20) with a subscription that keeps renewing: the line
 * always, its store page only when this build's store holds it.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class DeletePageTest {

    @get:Rule val compose = createComposeRule()

    private val calls = mutableListOf<String>()
    private var manage by mutableStateOf(true)

    private fun show() {
        compose.setContent {
            AppTheme(template = Templates.White) {
                DeletePage(
                    restoreDate = "December 10, 2026",
                    subscription = true,
                    manage = manage,
                    onManage = { calls += "manage" },
                    onExport = {},
                    exporting = false,
                    onStay = {},
                    onDelete = {},
                    deleting = false,
                    error = null,
                    onBack = {},
                )
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun onlyASubscriptionOfThisBuildsStoreIsManagedFromHere() {
        val here = if (Store.fromId(app.core.BuildConfig.STORE) == Store.PLAY) StoreName.Play else StoreName.Bazaar
        val other = if (here == StoreName.Play) StoreName.Bazaar else StoreName.Play
        val store = Store.fromId(app.core.BuildConfig.STORE)
        assertTrue(managedHere(StoreSubscriptionNotice(store = here, manageUrl = "https://example.com/manage"), store))
        // Bought in the other store's build: this store's page does not list it.
        assertFalse(managedHere(StoreSubscriptionNotice(store = other, manageUrl = "https://example.com/manage"), store))
        assertFalse(managedHere(StoreSubscriptionNotice(store = StoreName.Unknown), store))
        assertFalse(managedHere(null, store))
    }

    @Test
    fun aSubscriptionInTheOtherStoreIsSaidWithoutAPageThatCannotCancelIt() {
        manage = false
        show()
        compose.onNodeWithText("Your subscription isn’t cancelled automatically.").assertIsDisplayed()
        assertTrue(compose.onAllNodesWithText("Manage subscription").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun aSubscriptionOfThisStoreOpensItsPage() {
        show()
        compose.onNodeWithText("Manage subscription").performClick()
        assertEquals(listOf("manage"), calls)
    }
}
