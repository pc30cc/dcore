package app.core.feature.auth

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.model.ProfileReview
import app.core.model.ReviewState
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * The review screen in each of its states: waiting (one line, «دوباره ببین»),
 * changes asked for (the team's message, «ویرایش پروفایل», «برای بررسی
 * بفرست»), not accepted (the reason, nothing to send), and before the first
 * answer (no line, no button yet); signing out and deleting the account at
 * the bottom of every one.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class ReviewPageTest {

    @get:Rule val compose = createComposeRule()

    private val calls = mutableListOf<String>()
    private val message = "Add a photo where your face is clearly visible."

    private fun show(review: ProfileReview?, loading: Boolean = false, busy: Boolean = false, error: String? = null) {
        compose.setContent {
            AppTheme(template = Templates.White) {
                ReviewPage(
                    review = review,
                    loading = loading,
                    busy = busy,
                    error = error,
                    onCheck = { calls += "check" },
                    onEdit = { calls += "edit" },
                    onResubmit = { calls += "resubmit" },
                    onSignOut = { calls += "signOut" },
                    onDelete = { calls += "delete" },
                )
            }
        }
        compose.waitForIdle()
    }

    private fun absent(text: String) = assertTrue("$text is shown", compose.onAllNodesWithText(text).fetchSemanticsNodes().isEmpty())

    private fun footerWorks() {
        compose.onNodeWithText("Sign out").performClick()
        compose.onNodeWithText("Delete account").performClick()
        assertEquals(listOf("signOut", "delete"), calls.takeLast(2))
    }

    @Test
    fun theTitleIsAPoliteLiveRegionSoADecisionThatArrivesIsAnnounced() {
        var review by mutableStateOf(ProfileReview(ReviewState.Waiting))
        compose.setContent {
            AppTheme(template = Templates.White) {
                ReviewPage(review, loading = false, busy = false, error = null, onCheck = {}, onEdit = {}, onResubmit = {}, onSignOut = {}, onDelete = {})
            }
        }
        compose.onNodeWithText("Your profile is in review").assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
        // The team's decision over the socket: the new title, still a live region, is what is announced.
        review = ProfileReview(ReviewState.NeedsChanges, message, Instant.parse("2026-11-27T09:30:00Z"))
        compose.waitForIdle()
        compose.onNodeWithText("Your profile needs a few changes").assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
    }

    @Test
    fun waitingSaysSoAndChecksAgain() {
        show(ProfileReview(ReviewState.Waiting))
        compose.onNodeWithText("Your profile is in review").assertIsDisplayed()
        compose.onNodeWithText("New profiles are reviewed before they’re shown.").assertIsDisplayed()
        compose.onNodeWithText("Check again").performClick()
        assertEquals(listOf("check"), calls)
        absent("Edit profile")
        absent("Send for review")
        footerWorks()
    }

    @Test
    fun changesAskedForShowTheMessageTheEditorAndTheSend() {
        show(ProfileReview(ReviewState.NeedsChanges, message, Instant.parse("2026-11-27T09:30:00Z")))
        compose.onNodeWithText("Your profile needs a few changes").assertIsDisplayed()
        compose.onNodeWithText("Make the changes below, then send it for review again.").assertIsDisplayed()
        compose.onNodeWithText("What to change").assertIsDisplayed()
        compose.onNodeWithText(message).assertIsDisplayed()
        compose.onNodeWithText("Edit profile").performClick()
        compose.onNodeWithText("Send for review").performClick()
        assertEquals(listOf("edit", "resubmit"), calls)
        absent("Check again")
        footerWorks()
    }

    @Test
    fun notAcceptedShowsWhyAndOffersNothingToSend() {
        show(ProfileReview(ReviewState.Rejected, "Profiles must show the person's own face."))
        compose.onNodeWithText("Your profile wasn’t approved").assertIsDisplayed()
        compose.onNodeWithText("It won’t be shown to anyone.").assertIsDisplayed()
        compose.onNodeWithText("Reason").assertIsDisplayed()
        compose.onNodeWithText("Profiles must show the person's own face.").assertIsDisplayed()
        absent("Send for review")
        absent("Edit profile")
        absent("Check again")
        footerWorks()
    }

    @Test
    fun beforeTheFirstAnswerItShowsNeitherLineNorButton() {
        show(review = null, loading = true)
        compose.onNodeWithText("Your profile is in review").assertIsDisplayed()
        absent("New profiles are reviewed before they’re shown.")
        absent("Check again")
        footerWorks()
    }

    @Test
    fun anAnswerWithoutAReviewReadsAsWaitingAndAFailedReadSaysSo() {
        show(review = null, loading = false, error = "You’re offline.")
        compose.onNodeWithText("New profiles are reviewed before they’re shown.").assertIsDisplayed()
        compose.onNodeWithText("You’re offline.").assertIsDisplayed()
        compose.onNodeWithText("Check again").assertIsDisplayed()
    }

    @Test
    fun aBlankMessageShowsNoCard() {
        show(ProfileReview(ReviewState.NeedsChanges, "  "))
        absent("What to change")
        compose.onNodeWithText("Edit profile").assertIsDisplayed()
    }
}
