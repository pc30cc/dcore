package app.core.feature.auth

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.model.EntitlementSource
import app.core.model.Entitlements
import app.core.store.Store
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The restricted screen (m19): the reason and until when, the appeal while
 * one can be sent, the renewal line only for a plan of this store that keeps
 * renewing (with its store page), and signing out or deleting at the bottom.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class RestrictedPageTest {

    @get:Rule val compose = createComposeRule()

    private val store = Store.fromId(app.core.BuildConfig.STORE)
    private val storeSource = if (store == Store.PLAY) EntitlementSource.Play else EntitlementSource.Bazaar
    private val calls = mutableListOf<String>()
    private var text by mutableStateOf("")

    private fun show(
        banned: Boolean = false,
        reason: String? = "Repeated reports of harassment.",
        until: String? = "November 17, 2026, 6:00 PM",
        appeal: AppealState = AppealState.Open,
        renewing: Boolean = false,
        error: String? = null,
    ) {
        compose.setContent {
            AppTheme(template = Templates.White) {
                RestrictedPage(
                    banned = banned,
                    reason = reason,
                    until = until,
                    loading = false,
                    appeal = appeal,
                    appealText = text,
                    onAppealText = { text = it },
                    onSend = { calls += "send:$text" },
                    busy = false,
                    error = error,
                    onRetry = { calls += "retry" },
                    renewing = renewing,
                    onManage = { calls += "manage" },
                    onSignOut = { calls += "signOut" },
                    onDelete = { calls += "delete" },
                )
            }
        }
        compose.waitForIdle()
    }

    private fun absent(text: String) = assertTrue("$text is shown", compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isEmpty())

    @Test
    fun aSuspensionShowsItsReasonAndUntilWhenWithoutADateInTheTitle() {
        show()
        compose.onNodeWithText("Your account is suspended").assertIsDisplayed()
        compose.onNodeWithText("No one can see your profile until then.").assertIsDisplayed()
        compose.onNodeWithText("Reason").assertIsDisplayed()
        compose.onNodeWithText("Repeated reports of harassment.").assertIsDisplayed()
        compose.onNodeWithText("Until").assertIsDisplayed()
        compose.onNodeWithText("November 17, 2026, 6:00 PM").assertIsDisplayed()
    }

    @Test
    fun aBanHasNoEndAndItsOwnTitle() {
        show(banned = true, until = null)
        compose.onNodeWithText("Your account is closed").assertIsDisplayed()
        compose.onNodeWithText("No one can see your profile.").assertIsDisplayed()
        absent("Until")
    }

    @Test
    fun theAppealIsSentWithWhatWasWritten() {
        show()
        // Nothing written yet: the button takes the person to the field and sends nothing.
        compose.onNodeWithText("Send appeal").performClick()
        compose.onNode(hasSetTextAction()).assertIsFocused()
        assertEquals(emptyList<String>(), calls)
        text = "It was a misunderstanding."
        compose.waitForIdle()
        compose.onNodeWithText("Send appeal").performClick()
        assertEquals(listOf("send:It was a misunderstanding."), calls)
        compose.onNodeWithText("26 / 2000", substring = true).assertIsDisplayed()
    }

    @Test
    fun aLongAppealPastedInIsKeptWhole() {
        show()
        // Written elsewhere and pasted: the server takes up to 2000, so 700 go as they are.
        val pasted = "It was a misunderstanding. ".repeat(26).take(700)
        compose.onNode(hasSetTextAction()).performTextInput(pasted)
        compose.waitForIdle()
        assertEquals(700, text.length)
        compose.onNodeWithText("Send appeal").performClick()
        assertEquals(listOf("send:$pasted"), calls)
    }

    @Test
    fun aReadThatFailedCanBeTriedAgainFromTheScreen() {
        // Nothing read (offline at launch): no reason yet, the error line and a way to ask again.
        show(reason = null, until = null, appeal = AppealState.None, error = "You’re offline.")
        compose.onNodeWithText("You’re offline.").assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("retry"), calls)
    }

    @Test
    fun nothingReadYetOffersToTryAgain() {
        show(reason = null, until = null, appeal = AppealState.None)
        compose.onNodeWithText("Try again").assertIsDisplayed()
    }

    @Test
    fun aReadReasonNeedsNoTryAgain() {
        show()
        absent("Try again")
    }

    @Test
    fun aSentAppealSaysSoInsteadOfTheField() {
        show(appeal = AppealState.Sent)
        compose.onNodeWithText("Appeal sent. The answer will come here.").assertIsDisplayed()
        absent("Send appeal")
    }

    @Test
    fun anUpheldAppealShowsTheDecision() {
        show(appeal = AppealState.Upheld("We checked the messages again."))
        compose.onNodeWithText("Your appeal was reviewed. The decision stands.").assertIsDisplayed()
        compose.onNodeWithText("We checked the messages again.").assertIsDisplayed()
    }

    @Test
    fun aRenewingPlanSaysItRenewsAndOpensItsStorePage() {
        show(renewing = true)
        compose.onNodeWithText("Your subscription still renews during this time.").assertIsDisplayed()
        compose.onNodeWithText("Manage subscription").performClick()
        assertEquals(listOf("manage"), calls)
    }

    @Test
    fun withoutARenewingPlanThereIsNoBillingLine() {
        show(renewing = false)
        absent("Your subscription still renews")
        absent("Manage subscription")
        absent("Restore")
    }

    @Test
    fun signingOutAndDeletingAreAtTheBottom() {
        show()
        compose.onNodeWithText("Sign out").performClick()
        compose.onNodeWithText("Delete account").performClick()
        assertEquals(listOf("signOut", "delete"), calls)
    }

    @Test
    fun onlyARenewingPlanOfThisStoreCounts() {
        assertNotNull(renewingStorePlan(Entitlements(plan = "plus", source = storeSource, autoRenew = true), store))
        // The store has not said: it may renew.
        assertNotNull(renewingStorePlan(Entitlements(plan = "premium", source = storeSource, autoRenew = null), store))
        assertNull(renewingStorePlan(Entitlements(plan = "premium", source = storeSource, autoRenew = false), store))
        assertNull(renewingStorePlan(Entitlements(plan = "plus", source = EntitlementSource.Grant, autoRenew = true), store))
        assertNull(renewingStorePlan(Entitlements(), store))
        assertNull(renewingStorePlan(null, store))
        val other = if (store == Store.PLAY) EntitlementSource.Bazaar else EntitlementSource.Play
        assertNull(renewingStorePlan(Entitlements(plan = "plus", source = other, autoRenew = true), store))
    }
}
