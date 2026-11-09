package app.core.feature.chat

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.feature.chat.ChatTestData.ELIF
import app.core.feature.chat.ChatTestData.ME
import app.core.feature.chat.ChatTestData.NEGAR
import app.core.feature.chat.ChatTestData.conversation
import app.core.feature.chat.ChatTestData.minutesAgo
import app.core.feature.chat.ChatTestData.peer
import app.core.feature.chat.ChatTestData.wire
import app.core.media.LocalRemoteImages
import app.core.model.CallKind
import app.core.model.CallOutcome
import app.core.model.MessageKind
import app.core.realtime.RealtimeHealth
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.LocalDate

/** Every state of the chat list: loading, empty, new matches, conversations, offline, no push. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class ConversationsScreenTest {

    @get:Rule val compose = createComposeRule()

    private class Recorder : ConversationsActions {
        val calls = mutableListOf<String>()
        override fun open(conversationId: String) { calls += "open:$conversationId" }
        override fun openRequests() { calls += "requests" }
        override fun browse() { calls += "browse" }
        override fun refresh() { calls += "refresh" }
        override fun nearEnd() { calls += "end" }
        override fun dismissPushNotice() { calls += "dismissPush" }
    }

    private val actions = Recorder()

    private fun show(state: ConversationsUiState, dark: Boolean = false) {
        compose.setContent {
            AppTheme(dark = dark) {
                CompositionLocalProvider(LocalRemoteImages provides false) {
                    ConversationsScreen(state, actions, today = LocalDate.now(ChatTestData.zone))
                }
            }
        }
    }

    private val newMatch = conversation(id = "2001", peer = peer(id = ELIF, name = "Elif", online = true))
    private val talking = conversation(
        id = "2002",
        peer = peer(),
        lastMessage = wire(5001, NEGAR, "Are you free on Friday?", at = minutesAgo(3)),
        unread = 3,
    )
    private val mineLast = conversation(
        id = "2003",
        peer = peer(id = "dsara77mq2kx9", name = "Sara", verified = false),
        lastMessage = wire(5002, ME, "See you there", at = minutesAgo(60 * 24)),
        muted = true,
    )

    private fun ready(vararg list: app.core.model.Conversation, typing: Set<String> = emptySet(), requests: Int = 0) =
        ConversationsUiState(
            me = ME,
            newMatches = list.filter { it.lastMessage == null },
            conversations = list.filter { it.lastMessage != null },
            typing = typing,
            requests = requests,
            loading = false,
            connection = RealtimeHealth.CONNECTED,
        )

    @Test
    fun theFirstReadIsASkeletonWithALabel() {
        show(ConversationsUiState(loading = true))
        compose.onNodeWithContentDescription("Loading conversations").assertIsDisplayed()
    }

    @Test
    fun nothingYetSendsThePersonToDiscover() {
        show(ConversationsUiState(loading = false, me = ME))
        compose.onNodeWithText("No conversations yet").assertIsDisplayed()
        compose.onNodeWithText("Discover people").performClick()
        assertEquals(listOf("browse"), actions.calls)
    }

    @Test
    fun newMatchesAreARowOfFacesAndOpenTheirThread() {
        show(ready(newMatch))
        compose.onNodeWithText("New matches").assertIsDisplayed()
        compose.onNodeWithText("Say hello to one of your new matches. The first message is the hardest one.").assertIsDisplayed()
        compose.onNodeWithContentDescription("⁨Elif⁩, new match. Open the conversation.").performClick()
        assertEquals("open:2001", actions.calls.last())
    }

    @Test
    fun aConversationReadsItsNameUnreadCountPreviewAndTimeAsOneSentence() {
        show(ready(newMatch, talking, mineLast))
        compose.onNodeWithText("Messages").assertIsDisplayed()
        compose.onNode(
            hasContentDescription("Negar, Verified, 3 unread, ⁨Are you free on Friday?⁩", substring = true),
        ).assertIsDisplayed().performClick()
        assertEquals("open:2002", actions.calls.last())
        // The account's own last message, muted, read yesterday.
        compose.onNode(hasContentDescription("Sara, You: ⁨See you there⁩, Yesterday, Muted")).assertIsDisplayed()
    }

    @Test
    fun aCallAsTheLastLineReadsLikeTheThreadsCallLine() {
        fun call(id: String, caller: String, outcome: CallOutcome, seconds: Long) = app.core.model.Message(
            id = id, conversationId = id, senderId = caller, kind = MessageKind.Call, body = null, at = minutesAgo(5),
            call = ChatTestData.callLine(id.toLong(), caller, outcome, seconds),
        )
        show(
            ready(
                conversation(id = "2005", peer = peer(), lastMessage = call("2005", ME, CallOutcome.Completed, 125)),
                conversation(id = "2006", peer = peer(id = ELIF, name = "Elif"), lastMessage = call("2006", ELIF, CallOutcome.Missed, 0)),
                conversation(id = "2007", peer = peer(id = "emaximil7a2pq", name = "Maximilian"), lastMessage = call("2007", ME, CallOutcome.Declined, 0)),
            ),
        )
        // The same titles as the line in the thread, the length's units spelt out for TalkBack
        // (not "2 min, 5 sec" with a middle dot read out); no "You:" before a call.
        compose.onNode(hasContentDescription("Negar, Verified, Voice call, 2 minutes, 5 seconds, ", substring = true)).assertIsDisplayed()
        compose.onNode(hasContentDescription("Elif, Verified, Missed voice call, ", substring = true)).assertIsDisplayed()
        // "Declined" alone would not say a call happened.
        compose.onNode(hasContentDescription("Maximilian, Verified, Voice call, Declined, ", substring = true)).assertIsDisplayed()
        compose.onNode(hasContentDescription(" · ", substring = true)).assertDoesNotExist()
    }

    @Test
    fun aCallsPreviewNamesItsKindAndItsLengthInShortUnits() {
        fun call(outcome: CallOutcome, caller: String, seconds: Long, kind: CallKind = CallKind.Audio) = app.core.model.Message(
            id = "1", conversationId = "1", senderId = caller, kind = MessageKind.Call, body = null, at = minutesAgo(5),
            call = ChatTestData.callLine(1, caller, outcome, seconds, kind),
        )
        val shown = mutableMapOf<String, String?>()
        compose.setContent {
            AppTheme(dark = false) {
                shown["declined"] = previewText(call(CallOutcome.Declined, ME, 0), ME)
                shown["noAnswer"] = previewText(call(CallOutcome.Missed, ME, 0, CallKind.Video), ME)
                shown["failed"] = previewText(call(CallOutcome.Failed, NEGAR, 0), ME)
                shown["long"] = previewText(call(CallOutcome.Completed, ME, 754, CallKind.Video), ME)
                shown["longSpoken"] = previewText(call(CallOutcome.Completed, ME, 754, CallKind.Video), ME, spoken = true)
                shown["declinedSpoken"] = previewText(call(CallOutcome.Declined, ME, 0), ME, spoken = true)
            }
        }
        compose.waitForIdle()
        assertEquals("Voice call · Declined", shown["declined"])
        assertEquals("Video call · No answer", shown["noAnswer"])
        assertEquals("Voice call · Failed", shown["failed"])
        assertEquals("Video call · 12 min, 34 sec", shown["long"])
        assertEquals("Video call, 12 minutes, 34 seconds", shown["longSpoken"])
        assertEquals("Voice call, Declined", shown["declinedSpoken"])
    }

    @Test
    @Config(qualifiers = "fa-w411dp-h891dp")
    fun aPersianCallsPreviewNamesItsKindToo() {
        val declined = app.core.model.Message(
            id = "1", conversationId = "1", senderId = ME, kind = MessageKind.Call, body = null, at = minutesAgo(5),
            call = ChatTestData.callLine(1, ME, CallOutcome.Declined, 0),
        )
        var shown: String? = null
        var spoken: String? = null
        compose.setContent {
            AppTheme(dark = false) {
                shown = previewText(declined, ME)
                spoken = previewText(declined, ME, spoken = true)
            }
        }
        compose.waitForIdle()
        assertEquals("تماس صوتی · رد شد", shown)
        assertEquals("تماس صوتی، رد شد", spoken)
    }

    @Test
    fun presenceShowsOnlyWhenTheServerSentIt() {
        // Elif shows she is online; Negar does not (the server leaves it out).
        show(ready(talking, conversation(id = "2004", peer = peer(id = ELIF, name = "Elif", online = true), lastMessage = wire(5003, ELIF, "Hi", at = minutesAgo(1)))))
        compose.onNode(hasContentDescription("Elif, Verified, Online", substring = true)).assertIsDisplayed()
        compose.onNode(hasContentDescription("Negar, Verified, 3 unread", substring = true)).assertIsDisplayed()
        compose.onNode(hasContentDescription("Negar, Verified, Online", substring = true)).assertDoesNotExist()
    }

    @Test
    fun typingReplacesThePreview() {
        show(ready(talking, typing = setOf("2002")))
        compose.onNode(hasContentDescription("Negar, Verified, 3 unread, typing…", substring = true)).assertIsDisplayed()
    }

    @Test
    fun requestsHaveTheirRowAndTheHeaderCount() {
        show(ready(talking, requests = 2))
        // The header button and the row above the conversations say the same.
        val both = compose.onAllNodesWithContentDescription("Message requests: 2")
        assertEquals(2, both.fetchSemanticsNodes().size)
        both[0].performClick()
        both[1].performClick()
        assertEquals(listOf("requests", "requests"), actions.calls.takeLast(2))
    }

    /** The requests badge's and its button's bounds on screen (the button by its TalkBack label). */
    private fun badgeAndButton(buttonLabel: String): Pair<androidx.compose.ui.geometry.Rect, androidx.compose.ui.geometry.Rect> {
        val badge = compose.onNodeWithTag(REQUESTS_BADGE_TAG, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val button = compose.onAllNodesWithContentDescription(buttonLabel).fetchSemanticsNodes()
            .map { it.boundsInRoot }.minBy { it.width * it.height }
        return badge to button
    }

    private fun assertOnTheIconsCorner(badge: androidx.compose.ui.geometry.Rect, button: androidx.compose.ui.geometry.Rect, rtl: Boolean) {
        assertTrue("never taller than wide: $badge", badge.width >= badge.height - 1f)
        // Within the button's 48 dp touch target (its drawn circle is 40 dp), so never over the title.
        val target = button.inflate(4f * compose.density.density + 0.5f)
        assertTrue("inside the button: $badge in $target", badge.left >= target.left && badge.top >= target.top && badge.right <= target.right && badge.bottom <= target.bottom)
        assertTrue("over the icon's top half", badge.center.y < button.center.y)
        if (rtl) assertTrue("on the start (left) side in RTL", badge.center.x < button.center.x)
        else assertTrue("on the end (right) side", badge.center.x > button.center.x)
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE) // real text metrics
    fun theRequestsCountIsARoundBadgeOnTheIconsCorner() {
        show(ready(talking, requests = 3))
        val (badge, button) = badgeAndButton("Message requests: 3")
        assertEquals("one figure is round: $badge", badge.width, badge.height, 1f)
        assertOnTheIconsCorner(badge, button, rtl = false)
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(qualifiers = "fa-w411dp-h891dp-xhdpi", fontScale = 1.5f)
    fun inPersianAtLargeTextTheRequestsCountIsOnTheMirroredCorner() {
        show(ready(talking, requests = 12))
        val (badge, button) = badgeAndButton("درخواست‌های پیام: ۱۲")
        assertOnTheIconsCorner(badge, button, rtl = true)
        // It grew with the text: taller than Material's 16 dp, and as tall as wide or wider (never a tall pill).
        val density = compose.density.density
        assertTrue("grew with the text: ${badge.height / density} dp", badge.height / density > 17f)
    }

    @Test
    fun theHeaderAndTheRequestsRowSayTheSameCount() {
        val ascii: (Int) -> String = { it.toString() }
        // One rule for both places (the header used to stop at "9+" over a row saying "12").
        assertEquals("3", requestsBadgeText(3, ascii))
        assertEquals("12", requestsBadgeText(12, ascii))
        assertEquals("99", requestsBadgeText(99, ascii))
        assertEquals("99+", requestsBadgeText(250, ascii))
    }

    @Test
    fun offlineAndReconnectingAreAQuietLineOverWhatThePhoneHas() {
        show(ready(talking).copy(offline = true, connection = RealtimeHealth.DEGRADED))
        compose.onNodeWithText("You're offline. Showing what's on this phone.").assertIsDisplayed()
        compose.onNode(hasContentDescription("Negar, Verified, 3 unread", substring = true)).assertIsDisplayed()
    }

    @Test
    fun connectingIsSaidWhileTheSocketOpens() {
        show(ready(talking).copy(connection = RealtimeHealth.CONNECTING))
        compose.onNodeWithText("Connecting…").assertIsDisplayed()
    }

    @Test
    fun aPhoneWithoutPushIsToldOnceAndCanDismissIt() {
        show(ready(talking).copy(pushUnavailable = true))
        compose.onNodeWithText("Notifications can't reach this phone").assertIsDisplayed()
        compose.onNodeWithContentDescription("Close").performClick()
        assertEquals("dismissPush", actions.calls.last())
    }

    @Test
    fun darkThemeDrawsTheSameList() {
        show(ready(newMatch, talking), dark = true)
        compose.onNode(hasContentDescription("Negar, Verified, 3 unread", substring = true)).assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "fa-w411dp-h891dp")
    fun persianCountsInPersianDigits() {
        show(ready(talking, requests = 2))
        compose.onNodeWithText("گفتگوها").assertExists()
        compose.onNode(hasContentDescription("Negar، تأییدشده، ۳ خوانده‌نشده", substring = true)).assertIsDisplayed()
    }
}
