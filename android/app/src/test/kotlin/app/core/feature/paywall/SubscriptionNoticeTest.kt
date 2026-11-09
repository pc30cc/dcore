package app.core.feature.paywall

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.R
import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.model.Plan
import app.core.store.Store
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant

/** A restricted account's purchases card: Restore always, the plan and its store page only for a plan from this store. */
@RunWith(AndroidJUnit4::class)
class SubscriptionNoticeTest {

    @get:Rule val compose = createComposeRule()

    private val store = Store.fromId(app.core.BuildConfig.STORE)
    private val storeSource = if (store == Store.PLAY) EntitlementSource.Play else EntitlementSource.Bazaar
    private val storeName: String get() = ApplicationProvider.getApplicationContext<android.content.Context>().getString(R.string.store_name)
    private val calls = mutableListOf<String>()
    private var shown by mutableStateOf<Entitlements?>(null)
    private var notice by mutableStateOf<RestoreNotice?>(null)

    private fun show(e: Entitlements?) {
        shown = e
        compose.setContent {
            AppTheme(dark = false) {
                SubscriptionNoticeContent(
                    entitlements = shown,
                    store = store,
                    planNames = mapOf("plus" to "Plus", "premium" to "Premium"),
                    restoring = false,
                    notice = notice,
                    onManage = { calls += "manage:$it" },
                    onRestore = { calls += "restore" },
                )
            }
        }
        compose.waitForIdle()
    }

    private fun absent(text: String) = assertTrue("$text is shown", compose.onAllNodesWithText(text).fetchSemanticsNodes().isEmpty())

    @Test
    fun withoutAPlanFromThisStoreRestoreIsStillThere() {
        show(Entitlements())
        compose.onNodeWithText("Purchases").assertIsDisplayed()
        compose.onNodeWithText("Restore purchases").performClick()
        absent("Manage subscription")
        assertEquals(listOf("restore"), calls)
    }

    @Test
    fun entitlementsThatCouldNotBeReadStillOfferRestore() {
        show(null)
        compose.onNodeWithText("Restore purchases").assertIsDisplayed()
    }

    @Test
    fun aGrantIsNotAStoreSubscription() {
        show(Entitlements(plan = Plan.Plus, source = EntitlementSource.Grant))
        compose.onNodeWithText("Restore purchases").assertIsDisplayed()
        absent("Manage subscription")
    }

    @Test
    fun aRenewingPlanSaysItRenewsAndWhereToCancel() {
        show(Entitlements(plan = Plan.Plus, source = storeSource, autoRenew = true, manageUrl = "https://example.com/m"))
        compose.onNodeWithText("Your subscription").assertIsDisplayed()
        compose.onNodeWithText("Your Plus subscription keeps renewing while your account is restricted. You can cancel it in $storeName.").assertIsDisplayed()
        compose.onNodeWithText("Manage subscription").performClick()
        assertEquals(listOf("manage:https://example.com/m"), calls)
    }

    @Test
    fun aCancelledPlanSaysWhenItEndsNotThatItRenews() {
        show(Entitlements(plan = Plan.Premium, source = storeSource, autoRenew = false, planExpiresAt = Instant.parse("2026-12-09T12:00:00Z")))
        compose.onNodeWithText("Your Premium subscription doesn't renew. It ends on", substring = true).assertIsDisplayed()
        absent("Your Premium subscription keeps renewing while your account is restricted. You can cancel it in $storeName.")
        compose.onNodeWithText("Manage subscription").assertIsDisplayed()
    }

    @Test
    fun theRestoreAnswerNamesAnotherAccountsPurchase() {
        notice = RestoreNotice.OTHER_ACCOUNT
        show(Entitlements())
        compose.onNodeWithText("This purchase belongs to another account. Sign in with that account to use it.").assertIsDisplayed()
    }
}
