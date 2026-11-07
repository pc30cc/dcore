package app.core.feature.chat

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
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
import app.core.realtime.RealtimeHealth
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
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
