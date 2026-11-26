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
import app.core.model.ModerationAction
import app.core.model.ModerationHistory
import app.core.model.ModerationKind
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
import java.time.Instant

/**
 * The restricted screen (m19): the reason and until when, the appeal while
 * one can be sent, the renewal line only for a plan of this store that keeps
 * renewing (with its store page), signing out or deleting at the bottom; and
 * for a lifted action none of the restriction, only its own lines and a way
 * to read again.
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
        lifted: Boolean = false,
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
                    lifted = lifted,
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
    fun aLiftedActionDrawsNoneOfTheRestrictionAndOffersToReadAgain() {
        // Whatever else is passed, a lift the account has not caught up with reads as one.
        show(lifted = true, appeal = AppealState.Open, renewing = true)
        compose.onNodeWithText("The restriction was lifted").assertIsDisplayed()
        compose.onNodeWithText("There’s nothing to appeal. Your account opens again in a moment.").assertIsDisplayed()
        absent("Your account is suspended")
        absent("until then")
        absent("Reason")
        absent("Repeated reports of harassment.")
        absent("Until")
        absent("November 17")
        absent("Send appeal")
        absent("Appeal")
        absent("Your subscription still renews")
        absent("Manage subscription")
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("retry"), calls)
        compose.onNodeWithText("Sign out").assertIsDisplayed()
        compose.onNodeWithText("Delete account").assertIsDisplayed()
    }

    @Test
    fun aLiftedBanHasNeitherTheBanTitleNorItsLine() {
        show(banned = true, lifted = true, until = null, appeal = AppealState.None)
        compose.onNodeWithText("The restriction was lifted").assertIsDisplayed()
        absent("Your account is closed")
        absent("No one can see your profile")
        compose.onNodeWithText("Try again").assertIsDisplayed()
    }

    @Test
    fun aLiftedActionWhoseReadFailedShowsTheErrorAndOneTryAgain() {
        show(lifted = true, appeal = AppealState.None, error = "You’re offline.")
        compose.onNodeWithText("You’re offline.").assertIsDisplayed()
        assertEquals(1, compose.onAllNodesWithText("Try again").fetchSemanticsNodes().size)
    }

    private fun action(id: String, kind: ModerationKind, startsAt: String, endsAt: String? = null, revokedAt: String? = null) =
        ModerationAction(id, kind, "Reason $id", Instant.parse(startsAt), endsAt?.let(Instant::parse), revokedAt?.let(Instant::parse))

    @Test
    fun theScreenShowsTheActionInForceElseTheNewestOneIfLifted() {
        val standing = action("3", ModerationKind.Suspension, "2026-11-20T10:00:00Z", endsAt = "2026-11-27T10:00:00Z")
        val lifted = action("2", ModerationKind.Suspension, "2026-11-10T10:00:00Z", endsAt = "2026-11-17T10:00:00Z", revokedAt = "2026-11-11T10:00:00Z")
        val ended = action("4", ModerationKind.Suspension, "2026-11-12T10:00:00Z", endsAt = "2026-11-13T10:00:00Z")
        val liftedWarning = action("5", ModerationKind.Warning, "2026-11-21T10:00:00Z", revokedAt = "2026-11-21T11:00:00Z")
        assertEquals(standing, restrictingAction(ModerationHistory(active = listOf(standing), history = listOf(liftedWarning, lifted))))
        // Just lifted, while the account still reads restricted: that one, so the screen says so.
        assertEquals(lifted, restrictingAction(ModerationHistory(history = listOf(liftedWarning, lifted))))
        // The newest one ended on its own: an older lifted one is not shown in its place.
        assertNull(restrictingAction(ModerationHistory(history = listOf(ended, lifted))))
        assertNull("a warning never stands for the restriction", restrictingAction(ModerationHistory(history = listOf(liftedWarning))))
        assertNull(restrictingAction(ModerationHistory()))
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
