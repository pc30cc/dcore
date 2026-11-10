package app.core.feature.requests

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.feature.card.ScreenTestData
import app.core.feature.chat.ChatTestData
import app.core.media.LocalRemoteImages
import app.core.model.MessageRequest
import app.core.model.PeerSummary
import app.core.model.ReportReason
import app.core.model.RequestStatus
import app.core.model.RequestBox
import app.core.sync.RequestsBox
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.time.LocalDate

/** Message requests: loading, empty, failed, received with accept/decline/report, sent with withdraw. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class RequestsScreenTest {

    @get:Rule val compose = createComposeRule()

    private class Recorder : RequestsActions {
        val calls = mutableListOf<String>()
        override fun back() { calls += "back" }
        override fun select(box: RequestBox) { calls += "select:$box" }
        override fun refresh() { calls += "refresh" }
        override fun loadMore() { calls += "more" }
        override fun accept(request: MessageRequest) { calls += "accept:${request.id}" }
        override fun decline(request: MessageRequest) { calls += "decline:${request.id}" }
        override fun withdraw(request: MessageRequest) { calls += "withdraw:${request.id}" }
        override fun report(request: MessageRequest, reason: ReportReason, details: String?, block: Boolean) {
            calls += "report:${request.id}:${reason.wire}:$block"
        }
        override fun noticeShown(id: Long) {}
    }

    private val actions = Recorder()

    private fun show(state: RequestsUiState, dark: Boolean = false) {
        compose.setContent {
            AppTheme(template = Templates.of(if (dark) Templates.NEON else Templates.WHITE)) {
                CompositionLocalProvider(LocalRemoteImages provides false) {
                    RequestsScreen(state, actions, ScreenTestData.catalog, today = LocalDate.now(ChatTestData.zone))
                }
            }
        }
    }

    private val fromNegar = MessageRequest(
        id = "3001",
        peer = PeerSummary(ChatTestData.NEGAR, "Negar", ChatTestData.photo(9001), verified = true),
        body = "Your photos from the north are great.",
        status = RequestStatus.Pending,
        at = ChatTestData.minutesAgo(30),
    )

    private val toElif = fromNegar.copy(id = "3002", peer = PeerSummary(ChatTestData.ELIF, "Elif"), body = "Hello from Tabriz")

    @Test
    fun theFirstReadIsASkeletonWithALabel() {
        show(RequestsUiState(inbox = RequestsBox(loading = true)))
        compose.onNodeWithContentDescription("Loading requests").assertIsDisplayed()
    }

    @Test
    fun anEmptyInboxSaysWhatWouldBeThere() {
        show(RequestsUiState(inbox = RequestsBox(loaded = true)))
        compose.onNodeWithText("No requests").assertIsDisplayed()
    }

    @Test
    fun aFailedReadOfflineSaysSoAndTriesAgain() {
        show(RequestsUiState(inbox = RequestsBox(loaded = true, failed = true, offline = true)))
        compose.onNodeWithText("You’re offline.").assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("refresh"), actions.calls)
    }

    @Test
    fun aReceivedRequestIsAcceptedOrDeclined() {
        show(RequestsUiState(inbox = RequestsBox(items = listOf(fromNegar), loaded = true)))
        compose.onNodeWithText("Received, 1").assertIsDisplayed()
        compose.onNodeWithText("Your photos from the north are great.").assertIsDisplayed()
        compose.onNodeWithText("Decline").performClick()
        compose.onNodeWithText("Accept").performClick()
        assertEquals(listOf("decline:3001", "accept:3001"), actions.calls)
    }

    @Test
    fun anAnswerOnItsWayHoldsTheButtons() {
        show(RequestsUiState(inbox = RequestsBox(items = listOf(fromNegar), loaded = true), working = setOf("3001")))
        compose.onNodeWithText("Decline").assertIsNotEnabled()
        compose.onNodeWithText("Accept").assertIsNotEnabled()
    }

    @Test
    fun aRequestCanBeReportedWithItsMessage() {
        show(RequestsUiState(inbox = RequestsBox(items = listOf(fromNegar), loaded = true)))
        compose.onNodeWithContentDescription("More options").performClick()
        compose.onNodeWithText("Report").performClick()
        compose.onNodeWithText("Report ⁨Negar⁩").assertIsDisplayed()
        compose.onNodeWithText("Their message goes with the report, and the request is declined.").assertIsDisplayed()
        compose.onNodeWithText("Spam").performClick()
        compose.onNodeWithText("Send report").performClick()
        assertEquals(listOf("report:3001:spam:true"), actions.calls)
    }

    @Test
    fun sentRequestsWaitAndCanBeWithdrawn() {
        show(RequestsUiState(box = RequestBox.Sent, sent = RequestsBox(items = listOf(toElif), loaded = true)))
        compose.onNodeWithText("Waiting for an answer").assertIsDisplayed()
        compose.onNodeWithText("Accept").assertDoesNotExist()
        compose.onNodeWithText("Withdraw").performClick()
        compose.onNodeWithText("Received").performClick()
        assertEquals(listOf("withdraw:3002", "select:Inbox"), actions.calls)
    }

    @Test
    fun darkThemeDrawsTheSameList() {
        show(RequestsUiState(inbox = RequestsBox(items = listOf(fromNegar), loaded = true)), dark = true)
        compose.onNodeWithText("Accept").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "fa-w411dp-h891dp")
    fun persianCountsInPersianDigits() {
        show(RequestsUiState(inbox = RequestsBox(items = listOf(fromNegar, fromNegar.copy(id = "3003")), loaded = true)))
        compose.onNodeWithText("درخواست‌ها").assertIsDisplayed()
        compose.onNodeWithText("دریافتی، ۲", substring = true).assertExists()
    }

    @Test
    fun theEndOfABoxWithMoreReadsTheNextPartOnItsOwn() {
        show(RequestsUiState(inbox = RequestsBox(items = listOf(fromNegar), loaded = true, nextCursor = "c1")))
        compose.waitForIdle()
        assertEquals(listOf("more"), actions.calls)
        compose.onNodeWithContentDescription("Loading requests").assertExists()
    }

    @Test
    fun aFailedReadOfMoreOffersToTryAgain() {
        show(RequestsUiState(inbox = RequestsBox(items = listOf(fromNegar), loaded = true, nextCursor = "c1", moreFailed = true)))
        compose.onNodeWithText("More requests didn’t load.").assertExists()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("more"), actions.calls)
    }

    @Test
    fun pagesOfHiddenSendersWaitForTheButtonInsteadOfAnEmptyBox() {
        show(RequestsUiState(inbox = RequestsBox(loaded = true, nextCursor = "c5", moreHidden = true)))
        compose.onNodeWithText("No requests").assertDoesNotExist()
        compose.waitForIdle()
        assertEquals("nothing read unasked", emptyList<String>(), actions.calls)
        compose.onNodeWithText("Show more").performClick()
        assertEquals(listOf("more"), actions.calls)
    }

    @Test
    fun theEndOfTheBoxReadsNothingMore() {
        show(RequestsUiState(inbox = RequestsBox(items = listOf(fromNegar), loaded = true)))
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Loading requests").assertDoesNotExist()
        assertEquals(emptyList<String>(), actions.calls)
    }
}
