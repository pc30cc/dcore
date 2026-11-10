package app.core.feature.chat

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.performTextInput
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
import app.core.ui.theme.Templates
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
            AppTheme(template = Templates.of(if (dark) Templates.NEON else Templates.WHITE)) {
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
        // Nothing received: requests sent from a profile can still be seen and pulled back.
        compose.onNodeWithContentDescription("Requests").performClick()
        assertEquals(listOf("browse", "requests"), actions.calls)
    }

    @Test
    fun newMatchesAreARowOfFacesAndOpenTheirThread() {
        show(ready(newMatch))
        compose.onNodeWithText("New matches").assertIsDisplayed()
        // The faces alone: no advice under them.
        compose.onNodeWithText("Say hello", substring = true).assertDoesNotExist()
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
            AppTheme(template = Templates.of(Templates.WHITE)) {
                shown["declined"] = previewText(call(CallOutcome.Declined, ME, 0), ME)
                shown["noAnswer"] = previewText(call(CallOutcome.Missed, ME, 0, CallKind.Video), ME)
                shown["failed"] = previewText(call(CallOutcome.Failed, NEGAR, 0), ME)
                shown["long"] = previewText(call(CallOutcome.Completed, ME, 754, CallKind.Video), ME)
                shown["longSpoken"] = previewText(call(CallOutcome.Completed, ME, 754, CallKind.Video), ME, spoken = true)
                shown["declinedSpoken"] = previewText(call(CallOutcome.Declined, ME, 0), ME, spoken = true)
            }
        }
        compose.waitForIdle()
        assertEquals("Voice call, Declined", shown["declined"])
        assertEquals("Video call, No answer", shown["noAnswer"])
        assertEquals("Voice call, Failed", shown["failed"])
        assertEquals("Video call, 12 min, 34 sec", shown["long"])
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
            AppTheme(template = Templates.of(Templates.WHITE)) {
                shown = previewText(declined, ME)
                spoken = previewText(declined, ME, spoken = true)
            }
        }
        compose.waitForIdle()
        assertEquals("تماس صوتی، رد شد", shown)
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
    fun requestsAreOneRowAboveTheConversations() {
        show(ready(talking, requests = 2))
        // One place says how many are waiting: the row (the header's requests button carries no count).
        val row = compose.onAllNodesWithContentDescription("Requests: 2")
        assertEquals(1, row.fetchSemanticsNodes().size)
        row[0].performClick()
        assertEquals("requests", actions.calls.last())
        compose.onNodeWithContentDescription("Search").assertIsDisplayed()
    }

    @Test
    fun withoutRequestsThereIsNoRowButTheHeaderStillOpensThem() {
        show(ready(talking, requests = 0))
        compose.onNode(hasContentDescription("Requests:", substring = true)).assertDoesNotExist()
        compose.onNodeWithContentDescription("Requests").performClick()
        assertEquals(listOf("requests"), actions.calls.filter { it == "requests" })
    }

    @Test
    fun searchKeepsOnlyTheNamesThatMatch() {
        show(ready(talking, mineLast))
        compose.onNodeWithContentDescription("Search").performClick()
        compose.onNode(hasSetTextAction()).performTextInput("sar")
        compose.onNode(hasContentDescription("Sara, ", substring = true)).assertIsDisplayed()
        compose.onNode(hasContentDescription("Negar, ", substring = true)).assertDoesNotExist()
    }

    @Test
    fun backClosesTheSearchFirstAndANameNobodyHasSaysSo() {
        var dispatcher: androidx.activity.OnBackPressedDispatcher? = null
        compose.setContent {
            dispatcher = androidx.activity.compose.LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
            AppTheme(template = Templates.of(Templates.WHITE)) {
                CompositionLocalProvider(LocalRemoteImages provides false) {
                    ConversationsScreen(ready(talking, mineLast), actions, today = LocalDate.now(ChatTestData.zone))
                }
            }
        }
        assertEquals("nothing to close: Back is the tabs'", false, dispatcher!!.hasEnabledCallbacks())
        compose.onNodeWithContentDescription("Search").performClick()
        compose.onNode(hasSetTextAction()).performTextInput("zzz")
        compose.onNodeWithText("No one by that name").assertIsDisplayed()
        compose.runOnUiThread { dispatcher!!.onBackPressed() }
        compose.waitForIdle()
        compose.onNode(hasSetTextAction()).assertDoesNotExist()
        compose.onNode(hasContentDescription("Negar, ", substring = true)).assertIsDisplayed()
        assertEquals(false, dispatcher!!.hasEnabledCallbacks())
    }

    @Test
    fun aNameNotReadYetKeepsThePagesComing() {
        show(ready(talking, mineLast))
        compose.onNodeWithContentDescription("Search").performClick()
        compose.waitForIdle()
        actions.calls.clear()
        // Nobody loaded by that name: the next page is asked for, not only "No one by that name".
        compose.onNode(hasSetTextAction()).performTextInput("zeynep")
        compose.waitForIdle()
        compose.onNodeWithText("No one by that name").assertIsDisplayed()
        assertTrue("the next page is read: ${actions.calls}", "end" in actions.calls)
    }

    @Test
    fun aTurkishNameIsFoundWhicheverIItIsTypedWith() {
        fun named(name: String) = conversation(id = "3001", peer = peer(id = "eturk00000001", name = name), lastMessage = wire(5100, NEGAR, "Merhaba"))
        assertTrue(matchesSearch(named("İrem"), "irem"))
        assertTrue(matchesSearch(named("İrem"), "İrem"))
        assertTrue(matchesSearch(named("İrem"), "İR"))
        assertTrue(matchesSearch(named("Işıl"), "ışıl"))
        assertTrue(matchesSearch(named("Işıl"), "Işıl"))
        assertTrue(matchesSearch(named("Işıl"), "isil"))
        assertTrue(matchesSearch(named("José"), "jose"))
        assertTrue(matchesSearch(named("Negar"), "neg"))
        assertTrue(!matchesSearch(named("Irem"), "arem"))
    }

    @Test
    fun theRequestsCountStopsAtNinetyNinePlus() {
        val ascii: (Int) -> String = { it.toString() }
        assertEquals("3", requestsBadgeText(3, ascii))
        assertEquals("12", requestsBadgeText(12, ascii))
        assertEquals("99", requestsBadgeText(99, ascii))
        assertEquals("99+", requestsBadgeText(250, ascii))
    }

    @Test
    fun offlineAndReconnectingAreAQuietLineOverWhatThePhoneHas() {
        show(ready(talking).copy(offline = true, connection = RealtimeHealth.DEGRADED))
        compose.onNodeWithText("You’re offline.").assertIsDisplayed()
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
        compose.onNodeWithText("Notifications can’t reach this phone").assertIsDisplayed()
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
        compose.onNode(hasContentDescription("Negar، تأییدشده، ۳ پیام نخونده", substring = true)).assertIsDisplayed()
    }
}
