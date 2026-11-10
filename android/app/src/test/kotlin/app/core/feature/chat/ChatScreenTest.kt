package app.core.feature.chat

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.cache.SendState
import app.core.feature.card.ScreenTestData
import app.core.feature.chat.ChatTestData.ME
import app.core.feature.chat.ChatTestData.NEGAR
import app.core.feature.chat.ChatTestData.callLine
import app.core.feature.chat.ChatTestData.conversation
import app.core.feature.chat.ChatTestData.minutesAgo
import app.core.feature.chat.ChatTestData.peer
import app.core.feature.chat.ChatTestData.row
import app.core.media.LocalRemoteImages
import app.core.model.CallKind
import app.core.model.CallOutcome
import app.core.model.CallsAllowed
import app.core.model.Conversation
import app.core.model.ConversationState
import app.core.model.MessageKind
import app.core.model.ReportReason
import app.core.realtime.RealtimeHealth
import app.core.sync.ChatMessage
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs
import java.time.LocalDate
import java.util.Locale
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue

/** Every state of a thread: loading, failed, gone, ended, sending, failed sends, marks, typing, actions, safety. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class ChatScreenTest {

    @get:Rule val compose = createComposeRule()

    private class Recorder : ChatActions {
        val calls = mutableListOf<String>()
        override fun back() { calls += "back" }
        override fun send(text: String): Boolean { calls += "send:$text"; return true }
        override fun typed() { if (calls.lastOrNull() != "typed") calls += "typed" }
        override fun retry(message: ChatMessage) { calls += "retry:${message.localId}" }
        override fun delete(message: ChatMessage) { calls += "delete:${message.localId}" }
        override fun sendAnyway(message: ChatMessage) { calls += "sendAnyway:${message.localId}" }
        override fun react(message: ChatMessage, emoji: String, current: String?) { calls += "react:${message.serverId}:$emoji:$current" }
        override fun unsend(message: ChatMessage) { calls += "unsend:${message.serverId}" }
        override fun copied() { calls += "copied" }
        override fun nearTop(shownRows: Int) {}
        override fun retryOlder() { calls += "retryOlder" }
        override fun reload() { calls += "reload" }
        override fun openProfile() { calls += "profile" }
        override fun closeProfile() { calls += "closeProfile" }
        override fun setMuted(muted: Boolean) { calls += "muted:$muted" }
        override fun unmatch() { calls += "unmatch" }
        override fun block() { calls += "block" }
        override fun report(reason: ReportReason, details: String?, block: Boolean, message: ChatMessage?) {
            calls += "report:${reason.wire}:$block:${message?.serverId}"
        }
        override fun noticeShown(id: Long) {}
    }

    private val actions = Recorder()

    private val INTRO_HINT = "Say something about their profile. It's the easiest way to start."

    private fun show(state: ChatUiState, dark: Boolean = false) {
        compose.setContent {
            AppTheme(dark = dark) {
                CompositionLocalProvider(LocalRemoteImages provides false) {
                    ChatScreen(state, actions, messageMax = 2_000, catalog = ScreenTestData.catalog)
                }
            }
        }
    }

    private fun thread(
        rows: List<ChatMessage>,
        marks: List<ChatMessage> = emptyList(),
        conversation: Conversation = conversation(peerReadId = "101", peerDeliveredId = "102"),
        readReceipts: Boolean = true,
        atTop: Boolean = true,
    ) = ChatUiState(
        me = ME,
        conversation = conversation,
        items = buildTranscript(rows, marks, conversation, readReceipts, atTop, ME, ChatTestData.zone),
        loading = false,
        moreOlder = !atTop,
        connection = RealtimeHealth.CONNECTED,
        ended = conversation.state == ConversationState.Ended,
    )

    /** A bubble TalkBack reads as [start] … [end]: who and what first, its state last. */
    private fun bubble(start: String, end: String = "") = SemanticsMatcher("bubble \"$start…$end\"") { node ->
        node.config.getOrNull(SemanticsProperties.ContentDescription)?.any { it.startsWith(start) && it.endsWith(end) } == true
    }

    @Test
    fun theFirstReadIsASkeletonWithALabel() {
        show(ChatUiState(me = ME, conversation = conversation(), loading = true))
        compose.onNodeWithContentDescription("Loading messages").assertIsDisplayed()
        compose.onNodeWithText("Negar").assertIsDisplayed()
    }

    @Test
    fun aFailedFirstReadOfflineSaysSoAndTriesAgain() {
        show(ChatUiState(me = ME, conversation = conversation(), loading = false, loadFailed = true, offline = true))
        compose.onNodeWithText("Couldn't load messages").assertIsDisplayed()
        compose.onNodeWithText("You're offline. Messages will load when you're back online.").assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("reload"), actions.calls)
    }

    @Test
    fun aGoneConversationHasNoComposerAndLeadsBack() {
        show(ChatUiState(me = ME, loading = false, gone = true))
        compose.onNodeWithText("This conversation isn't available").assertIsDisplayed()
        compose.onNode(hasSetTextAction()).assertDoesNotExist()
        compose.onNodeWithText("Back").performClick()
        assertEquals(listOf("back"), actions.calls)
    }

    @Test
    fun anEndedConversationIsReadOnly() {
        show(thread(listOf(row(1, mine = false, body = "Bye")), conversation = conversation(state = ConversationState.Ended)))
        compose.onNodeWithText("Bye").assertIsDisplayed()
        compose.onNodeWithText("This conversation has ended").assertIsDisplayed()
        compose.onNode(hasSetTextAction()).assertDoesNotExist()
        compose.onNodeWithContentDescription("More options").assertDoesNotExist()
    }

    @Test
    fun theThreadOpensWithItsIntroductionAndDaySeparators() {
        show(
            thread(
                listOf(
                    row(3, mine = false, body = "Good morning", at = minutesAgo(5)),
                    row(2, mine = true, body = "Hi Negar", at = minutesAgo(60 * 24)),
                ),
            ),
        )
        compose.onNodeWithText("You and ⁨Negar⁩ matched").assertIsDisplayed()
        compose.onNodeWithText("Yesterday").assertIsDisplayed()
        compose.onNodeWithText("Today").assertIsDisplayed()
        compose.onNodeWithText("Good morning").assertIsDisplayed()
    }

    @Test
    fun theFirstLineOfANewDayComesIntoViewWhenTheReaderWasAtTheNewest() {
        // A long yesterday, read down to its newest line.
        val yesterday = (40 downTo 1).map { n ->
            row(n.toLong(), mine = n % 2 == 0, body = "Yesterday $n", at = minutesAgo(60L * 24 + 41 - n))
        }
        var state by mutableStateOf(thread(yesterday))
        compose.setContent {
            AppTheme(dark = false) {
                CompositionLocalProvider(LocalRemoteImages provides false) {
                    ChatScreen(state, actions, messageMax = 2_000, catalog = ScreenTestData.catalog)
                }
            }
        }
        compose.onNodeWithText("Yesterday 40").assertIsDisplayed()

        // Today's first line from the other person: it brings its own "Today" separator,
        // so the line that was newest is two rows up. The thread still follows it.
        state = thread(listOf(row(41, mine = false, body = "Good morning", at = minutesAgo(1))) + yesterday)
        compose.waitForIdle()
        compose.onNodeWithText("Good morning").assertIsDisplayed()
        compose.onNodeWithText("Today").assertIsDisplayed()
        compose.onNodeWithContentDescription("Go to the newest message").assertDoesNotExist()
    }

    @Test
    fun ownMessagesSaySendingSentDeliveredAndReadToTalkBack() {
        show(
            thread(
                listOf(
                    row(104, mine = true, body = "Fourth", state = SendState.PENDING, at = minutesAgo(1)),
                    row(103, mine = true, body = "Third", at = minutesAgo(2)),
                    row(102, mine = true, body = "Second", at = minutesAgo(3)),
                    row(101, mine = true, body = "First", at = minutesAgo(4)),
                ),
            ),
        )
        compose.onNode(bubble("You, Fourth", ", Sending")).assertIsDisplayed()
        compose.onNode(bubble("You, Third", ", Sent")).assertIsDisplayed()
        compose.onNode(bubble("You, Second", ", Delivered")).assertIsDisplayed()
        compose.onNode(bubble("You, First", ", Read")).assertIsDisplayed()
    }

    /** How many of the node [tag]'s pixels are within a few levels of [color]. */
    private fun pixelsNear(tag: String, color: androidx.compose.ui.graphics.Color): Int {
        val image = compose.onNodeWithTag(tag, useUnmergedTree = true).captureToImage().asAndroidBitmap()
        val (r, g, b) = Triple((color.red * 255).toInt(), (color.green * 255).toInt(), (color.blue * 255).toInt())
        var count = 0
        for (y in 0 until image.height) for (x in 0 until image.width) {
            val p = image.getPixel(x, y)
            if (abs(android.graphics.Color.red(p) - r) + abs(android.graphics.Color.green(p) - g) + abs(android.graphics.Color.blue(p) - b) < 24) count++
        }
        return count
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun readIsToldFromDeliveredByItsShapeNotAShade() {
        show(thread(listOf(row(102, mine = true, body = "Second", at = minutesAgo(3)), row(101, mine = true, body = "First", at = minutesAgo(4))),
            conversation = conversation(peerReadId = "101", peerDeliveredId = "102")))
        val ink = app.core.ui.theme.Templates.White.colors.onBubbleOut
        // Delivered: the double tick's thin strokes on the bubble. Read: a disc of the same ink with
        // the tick cut out of it, so several times as much of it is ink.
        val delivered = pixelsNear(deliveryTag(Delivery.Delivered), ink)
        val read = pixelsNear(deliveryTag(Delivery.Read), ink)
        assertTrue("delivered $delivered px of ink, read $read", delivered > 0 && read > 2 * delivered)
    }

    @Test
    fun withoutReadReceiptsNothingReadsAsRead() {
        show(thread(listOf(row(102, mine = true, body = "Second"), row(101, mine = true, body = "First")), readReceipts = false))
        compose.onNode(bubble("You, First", ", Delivered")).assertIsDisplayed()
        compose.onNode(bubble("You, First", ", Read")).assertDoesNotExist()
    }

    @Test
    fun aFailedSendIsMarkedAndOffersRetryEditAndDelete() {
        show(thread(listOf(row(7, mine = true, body = "Lost one", state = SendState.FAILED, errorCode = "network"))))
        compose.onNodeWithText("Not sent. Tap for options.").assertIsDisplayed().performClick()
        compose.onNodeWithText("Try again").assertIsDisplayed()
        compose.onNodeWithText("Edit").assertIsDisplayed()
        compose.onNodeWithText("Delete").assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("retry:local-7"), actions.calls)
    }

    @Test
    fun aRefusedMessageCannotBeRetriedOnlyEditedOrDeleted() {
        show(thread(listOf(row(8, mine = true, body = "Not allowed", state = SendState.FAILED, errorCode = "message_refused"))))
        compose.onNodeWithText("Not sent: this message goes against the community guidelines.").performClick()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.onNodeWithText("Delete").performClick()
        assertEquals(listOf("delete:local-8"), actions.calls)
    }

    @Test
    fun theServersAreYouSureAsksBeforeSending() {
        val waiting = row(9, mine = true, body = "Send me the money", state = SendState.CONFIRM, errorCode = "money")
        show(thread(listOf(waiting)).copy(confirm = waiting))
        compose.onNodeWithText("Before you send").assertIsDisplayed()
        compose.onNodeWithText("Messages about money are a common way people get scammed. Never send money to someone you haven't met.").assertIsDisplayed()
        compose.onNodeWithText("Send anyway").performClick()
        assertEquals(listOf("sendAnyway:local-9"), actions.calls)
    }

    @Test
    fun aLongPressOnTheirMessageReactsCopiesOrReports() {
        show(thread(listOf(row(50, mine = false, body = "Look at this view"))))
        compose.onNode(bubble("Look at this view")).performTouchInput { longClick() }
        compose.onNodeWithContentDescription("React with ❤️").assertIsDisplayed()
        compose.onNodeWithText("Copy").assertIsDisplayed()
        compose.onNodeWithText("Unsend").assertDoesNotExist()
        compose.onNodeWithContentDescription("React with ❤️").performClick()
        assertEquals(listOf("react:50:❤️:null"), actions.calls)

        compose.onNode(bubble("Look at this view")).performTouchInput { longClick() }
        compose.onNodeWithText("Report message").performClick()
        compose.onNodeWithText("Report ⁨Negar⁩").assertIsDisplayed()
        compose.onNodeWithText("The message you picked goes with the report.").assertIsDisplayed()
        compose.onNodeWithText("Send report").assertIsNotEnabled()
        compose.onNodeWithText("Harassment or bullying").performClick()
        compose.onNodeWithText("Send report").assertIsEnabled().performClick()
        assertEquals("report:harassment:true:50", actions.calls.last())
    }

    @Test
    fun ownMessagesCanBeUnsentAfterAConfirmation() {
        show(thread(listOf(row(60, mine = true, body = "Oops"))))
        compose.onNode(bubble("You, Oops")).performTouchInput { longClick() }
        compose.onNodeWithText("Report message").assertDoesNotExist()
        compose.onNodeWithText("Unsend").performClick()
        compose.onNodeWithText("Unsend this message?").assertIsDisplayed()
        compose.onNodeWithText("Unsend").performClick()
        assertEquals(listOf("unsend:60"), actions.calls)
    }

    @Test
    fun unsentAndRemovedMessagesKeepNoText() {
        show(
            thread(
                rows = listOf(row(71, mine = false, body = "Something rude"), row(70, mine = true, body = "Never mind"), row(69, mine = false, body = "Taken back")),
                marks = listOf(
                    row(72, mine = true, kind = MessageKind.Unsend, body = null, refId = 70),
                    row(73, mine = false, kind = MessageKind.Unsend, body = null, refId = 69),
                    row(74, mine = false, kind = MessageKind.Unsend, body = null, refId = 71, sender = "zmoderation00"),
                ),
            ),
        )
        compose.onNodeWithText("You unsent this message").assertIsDisplayed()
        compose.onNodeWithText("This message was unsent").assertIsDisplayed()
        compose.onNodeWithText("This message was removed").assertIsDisplayed()
        compose.onNodeWithText("Never mind").assertDoesNotExist()
        compose.onNodeWithText("Something rude").assertDoesNotExist()
    }

    @Test
    fun reactionsShowUnderTheBubbleAndAreRead() {
        show(
            thread(
                rows = listOf(row(80, mine = false, body = "A photo from the trip")),
                marks = listOf(row(81, mine = true, kind = MessageKind.Reaction, body = "🔥", refId = 80)),
            ),
        )
        compose.onNodeWithText("🔥").assertIsDisplayed()
        compose.onNode(bubble("A photo from the trip", ", Reactions: 🔥")).assertIsDisplayed()
    }

    @Test
    fun typingShowsInTheHeaderAndAsABubble() {
        show(thread(listOf(row(1, mine = false, body = "Hey"))).copy(typing = true))
        compose.onNodeWithText("typing…").assertIsDisplayed()
        compose.onNodeWithContentDescription("⁨Negar⁩ is typing").assertIsDisplayed()
    }

    @Test
    fun presenceIsShownOnlyWhenTheServerSentIt() {
        show(thread(listOf(row(1, mine = false, body = "Hey")), conversation = conversation(peer = peer(online = true))))
        compose.onNodeWithText("Online").assertIsDisplayed()
    }

    @Test
    fun noPresenceNoLine() {
        show(thread(listOf(row(1, mine = false, body = "Hey")), conversation = conversation(peer = peer(online = false))))
        compose.onNodeWithText("Online").assertDoesNotExist()
        compose.onNodeWithText("Active recently").assertDoesNotExist()
    }

    @Test
    fun theComposerSendsWhatWasTypedAndStartsAgainEmpty() {
        show(thread(listOf(row(1, mine = false, body = "Hey"))))
        compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
        compose.onNode(hasSetTextAction()).performTextInput("Coffee on Friday?")
        compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
        assertEquals(listOf("typed", "send:Coffee on Friday?"), actions.calls)
        compose.onNodeWithText("Coffee on Friday?").assertDoesNotExist()
    }

    @Test
    fun blockAndUnmatchAskFirstFromTheMenu() {
        show(thread(listOf(row(1, mine = false, body = "Hey"))))
        compose.onNodeWithContentDescription("More options").performClick()
        compose.onNodeWithText("Block").performClick()
        compose.onNodeWithText("Block ⁨Negar⁩?").assertIsDisplayed()
        compose.onNodeWithText("Block").performClick()
        assertEquals(listOf("block"), actions.calls)

        compose.onNodeWithContentDescription("More options").performClick()
        compose.onNodeWithText("Unmatch").performClick()
        compose.onNodeWithText("Unmatch ⁨Negar⁩?").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(listOf("block"), actions.calls)
    }

    @Test
    fun reportFromTheMenuSendsTheRecentMessagesAndBlocksByDefault() {
        show(thread(listOf(row(1, mine = false, body = "Hey"))))
        compose.onNodeWithContentDescription("More options").performClick()
        compose.onNodeWithText("Report").performClick()
        compose.onNodeWithText("Their recent messages go with the report, so the team can check.").assertIsDisplayed()
        compose.onNodeWithText("Fake profile").performClick()
        compose.onNodeWithText("Also block them").performClick()
        compose.onNodeWithText("Send report").performClick()
        assertEquals(listOf("report:fake:false:null"), actions.calls)
    }

    @Test
    fun aCallLineSaysWhatHappenedFromThisSide() {
        show(
            thread(
                listOf(
                    row(92, mine = true, kind = MessageKind.Call, body = null, call = callLine(92, ME, CallOutcome.Declined, kind = CallKind.Video)),
                    row(91, mine = false, kind = MessageKind.Call, body = null, sender = NEGAR, call = callLine(91, NEGAR, CallOutcome.Missed)),
                    row(90, mine = true, kind = MessageKind.Call, body = null, call = callLine(90, ME, CallOutcome.Completed, seconds = 125)),
                ),
            ),
        )
        // One sentence each, from this side; the length in units, not "2:05".
        compose.onNode(hasContentDescription("Missed voice call, Incoming, ", substring = true)).assertIsDisplayed()
        compose.onNode(hasContentDescription("Voice call, 2 minutes, 5 seconds, Outgoing, ", substring = true)).assertIsDisplayed()
        // A declined call says it was a call, and which kind: the icon is not read.
        val declined = compose.onNodeWithTag("call.line.92").fetchSemanticsNode().config[SemanticsProperties.ContentDescription].single()
        assertTrue(declined, declined.startsWith("Video call, Declined, Outgoing, "))
        compose.onNode(hasContentDescription("2:05", substring = true)).assertDoesNotExist()
        compose.onNodeWithTag("call.line.90").assert(hasClickAction().not())
    }

    @Test
    fun aCallLineCallsBackWithItsKindWhileBothAllowCalls() {
        val back = mutableListOf<String>()
        val rows = listOf(row(92, mine = false, kind = MessageKind.Call, body = null, sender = NEGAR, call = callLine(92, NEGAR, CallOutcome.Missed, kind = CallKind.Video)))
        var state by mutableStateOf(thread(rows, conversation = conversation(callsAllowed = CallsAllowed(me = true, peer = true))))
        compose.setContent {
            AppTheme(dark = false) {
                CompositionLocalProvider(
                    LocalRemoteImages provides false,
                    LocalChatCallBack provides { conversation, kind -> back += "${conversation.id}:${kind.wire}" },
                ) {
                    ChatScreen(state, actions, messageMax = 2_000, catalog = ScreenTestData.catalog)
                }
            }
        }
        compose.onNodeWithTag("call.line.92").assert(hasClickAction()).performClick()
        assertEquals(listOf("${ChatTestData.CONVERSATION}:video"), back)

        // Calls switched off by one of them: the line is only a record.
        state = thread(rows, conversation = conversation(callsAllowed = CallsAllowed(me = true, peer = false)))
        compose.onNodeWithTag("call.line.92").assert(hasClickAction().not())
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun theCallBackButtonShowsOnlyWhileBothAllowCalls() {
        // An answered call of one's own: nothing else on the line is drawn in the accent.
        val rows = listOf(row(93, mine = true, kind = MessageKind.Call, body = null, call = callLine(93, ME, CallOutcome.Completed, seconds = 65)))
        var state by mutableStateOf(thread(rows, conversation = conversation(callsAllowed = CallsAllowed(me = true, peer = true))))
        compose.setContent {
            AppTheme(dark = false) {
                CompositionLocalProvider(LocalRemoteImages provides false, LocalChatCallBack provides { _, _ -> }) {
                    ChatScreen(state, actions, messageMax = 2_000, catalog = ScreenTestData.catalog)
                }
            }
        }
        val accent = app.core.ui.theme.Templates.White.colors.primary
        val withButton = pixelsNear("call.line.93", accent)
        state = thread(rows, conversation = conversation(callsAllowed = CallsAllowed(me = true, peer = false)))
        compose.waitForIdle()
        val record = pixelsNear("call.line.93", accent)
        assertTrue("the call-back button's phone in the accent: $withButton px", withButton > 40)
        assertEquals("a record has no button", 0, record)
    }

    @Test
    fun theIntroDoesNotSayTheDayOfTheSeparatorUnderItAgain() {
        val matched = conversation(peerReadId = "101", peerDeliveredId = "102") // three days ago
        val day = matched.createdAt.atZone(ChatTestData.zone).toLocalDate()
        val clock = ChatClockText(Locale.US)
        val weekday = clock.weekday(day)
        show(thread(listOf(row(1, mine = false, body = "Hey", at = matched.createdAt.plusSeconds(600))), conversation = matched))
        compose.onNodeWithText("You and ⁨Negar⁩ matched").assertIsDisplayed()
        // Something has been said: no more advice on how to start.
        compose.onNodeWithText(INTRO_HINT).assertDoesNotExist()
        // One name for that day: the separator's; not the date over it as well.
        compose.onAllNodesWithText(weekday).assertCountEquals(1)
        compose.onNodeWithText(clock.day(day, LocalDate.now(ChatTestData.zone))).assertDoesNotExist()
    }

    @Test
    fun anEmptyThreadSuggestsHowToStart() {
        show(thread(emptyList()))
        compose.onNodeWithText("You and ⁨Negar⁩ matched").assertIsDisplayed()
        compose.onNodeWithText(INTRO_HINT).assertIsDisplayed()
    }

    @Test
    fun theIntroSaysWhenTheyMatchedTheWayTheSeparatorsDo() {
        val matched = conversation(peerReadId = "101", peerDeliveredId = "102")
        val weekday = ChatClockText(Locale.US).weekday(matched.createdAt.atZone(ChatTestData.zone).toLocalDate())
        show(thread(listOf(row(1, mine = false, body = "Hey", at = minutesAgo(1))), conversation = matched))
        compose.onNodeWithText("Today").assertIsDisplayed()
        compose.onNodeWithText(weekday).assertIsDisplayed()
    }

    @Test
    fun earlierMessagesThatFailedToLoadOfferAnotherTry() {
        show(thread(listOf(row(1, mine = false, body = "Hey")), atTop = false).copy(olderFailed = true))
        compose.onNodeWithText("Couldn't load earlier messages").assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("retryOlder"), actions.calls)
    }

    @Test
    fun reconnectingIsAQuietLineOverTheThread() {
        show(thread(listOf(row(1, mine = false, body = "Hey"))).copy(connection = RealtimeHealth.DEGRADED))
        compose.onNodeWithText("Reconnecting…").assertIsDisplayed()
        compose.onNodeWithText("Hey").assertIsDisplayed()
    }

    @Test
    fun darkThemeDrawsTheSameThread() {
        show(thread(listOf(row(2, mine = true, body = "Mine"), row(1, mine = false, body = "Theirs"))), dark = true)
        compose.onNodeWithText("Mine").assertIsDisplayed()
        compose.onNodeWithText("Theirs").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "fa-w411dp-h891dp")
    fun persianUsesPersianWordsAndDigits() {
        show(
            thread(
                listOf(
                    row(2, mine = false, kind = MessageKind.Call, body = null, call = callLine(2, NEGAR, CallOutcome.Completed, seconds = 125)),
                    row(1, mine = true, body = "سلام", at = minutesAgo(3)),
                ),
            ),
        )
        compose.onNodeWithText("امروز").assertIsDisplayed()
        compose.onNodeWithText("سلام").assertIsDisplayed()
        // Times and lengths in Persian digits: no ASCII digit is left in what TalkBack reads.
        val mine = compose.onNode(bubble("شما، سلام")).fetchSemanticsNode()
        val description = mine.config[SemanticsProperties.ContentDescription].single()
        assertTrue(description, description.none { it in '0'..'9' })
        assertTrue(description, description.any { it in '۰'..'۹' })
        compose.onNode(hasContentDescription("۲ دقیقه و ۵ ثانیه", substring = true)).assertIsDisplayed()
        compose.onNode(hasContentDescription("۲:۰۵", substring = true)).assertDoesNotExist()
    }

    @Test
    fun aDeliveredMessageWithoutReadReceiptsOffersThePlans() {
        val opened = mutableListOf<app.core.feature.paywall.PaywallRequest>()
        compose.setContent {
            AppTheme(dark = false) {
                CompositionLocalProvider(
                    LocalRemoteImages provides false,
                    app.core.feature.paywall.LocalPaywall provides app.core.feature.paywall.PaywallLauncher { opened += it },
                ) {
                    ChatScreen(ChatUiState(me = ME, conversation = conversation(), loading = false, readReceiptsLocked = true), actions, messageMax = 2_000, catalog = ScreenTestData.catalog)
                }
            }
        }
        compose.onNodeWithText("See when it's read").performClick()
        assertEquals(listOf(app.core.feature.paywall.PaywallRequest.Plans(app.core.feature.paywall.PaywallEntry.READ_RECEIPTS)), opened)
    }
}
