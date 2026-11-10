package app.core.feature.chat

import app.core.cache.SendState
import app.core.feature.chat.ChatTestData.ME
import app.core.feature.chat.ChatTestData.NEGAR
import app.core.feature.chat.ChatTestData.callLine
import app.core.feature.chat.ChatTestData.conversation
import app.core.feature.chat.ChatTestData.minutesAgo
import app.core.feature.chat.ChatTestData.row
import app.core.feature.chat.ChatTestData.zone
import app.core.model.CallOutcome
import app.core.model.MessageKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/** What a thread shows from its rows: marks, separators, runs, reactions and unsends. */
class TranscriptRulesTest {

    private fun bubbles(items: List<ChatItem>) = items.filterIsInstance<ChatItem.Bubble>()

    @Test
    fun theReadMarkNeedsThePlansReadReceipts() {
        // Newest first: 103 (not yet delivered), 102 (delivered), 101 (read).
        val rows = listOf(row(103, mine = true), row(102, mine = true), row(101, mine = true))
        val c = conversation(peerReadId = "101", peerDeliveredId = "102")

        val paid = bubbles(buildTranscript(rows, emptyList(), c, readReceipts = true, atTop = false, me = ME, zone = zone))
        assertEquals(listOf(Delivery.Sent, Delivery.Delivered, Delivery.Read), paid.map { it.delivery })

        // Without the feature a read message reads "delivered" at most, whatever pointer the phone holds.
        val free = bubbles(buildTranscript(rows, emptyList(), c, readReceipts = false, atTop = false, me = ME, zone = zone))
        assertEquals(listOf(Delivery.Sent, Delivery.Delivered, Delivery.Delivered), free.map { it.delivery })

        // No delivered pointer either (the reader hides when they are online): plain "sent".
        val hidden = bubbles(buildTranscript(rows, emptyList(), conversation(), readReceipts = false, atTop = false, me = ME, zone = zone))
        assertEquals(List(3) { Delivery.Sent }, hidden.map { it.delivery })
    }

    @Test
    fun theReadReceiptsLinkGoesWithTheNewestOwnMessageOnceItWentOut() {
        val c = conversation(peerReadId = "101", peerDeliveredId = "102")
        fun offered(rows: List<app.core.sync.ChatMessage>) = offersReadReceipts(buildTranscript(rows, emptyList(), c, readReceipts = false, atTop = false, me = ME, zone = zone))
        // 102 delivered, then 103 sent while the other phone is off: the newest one carries the link.
        assertTrue(offered(listOf(row(103, mine = true), row(102, mine = true))))
        assertTrue(offered(listOf(row(102, mine = true))))
        // The newest own one failed or is still on its way: no line carries the link, so none is offered.
        assertFalse(offered(listOf(row(104, mine = true, state = SendState.FAILED), row(102, mine = true))))
        assertFalse(offered(listOf(row(104, mine = true, state = SendState.PENDING), row(102, mine = true))))
        // Only their messages: nothing of the account's to read.
        assertFalse(offered(listOf(row(105, mine = false))))
    }

    @Test
    fun theOutboxStatesShowAsTheyAreAndTheirMessagesHaveNoMark() {
        val rows = listOf(
            row(4, mine = true, state = SendState.CONFIRM, errorCode = "money"),
            row(3, mine = true, state = SendState.FAILED, errorCode = "network"),
            row(2, mine = true, state = SendState.PENDING),
            row(1, mine = false),
        )
        val items = bubbles(buildTranscript(rows, emptyList(), conversation(), readReceipts = true, atTop = false, me = ME, zone = zone))
        assertEquals(listOf(Delivery.Confirm, Delivery.Failed, Delivery.Pending, null), items.map { it.delivery })
    }

    @Test
    fun eachDayStartsWithItsSeparatorAndTheIntroClosesTheTopOnlyAtTheStart() {
        val yesterday = minutesAgo(24 * 60)
        val rows = listOf(row(3, mine = false, at = minutesAgo(1)), row(2, mine = true, at = minutesAgo(2)), row(1, mine = false, at = yesterday))
        val items = buildTranscript(rows, emptyList(), conversation(), readReceipts = false, atTop = true, me = ME, zone = zone)
        val today = LocalDate.now(zone)
        assertEquals(
            listOf("local-3", "local-2", "day:$today", "local-1", "day:${today.minusDays(1)}", "intro"),
            items.map { it.key },
        )
        val more = buildTranscript(rows, emptyList(), conversation(), readReceipts = false, atTop = false, me = ME, zone = zone)
        assertFalse(more.any { it is ChatItem.Intro })
    }

    @Test
    fun theMatchDaysSeparatorIsLeftToTheIntro() {
        val matched = conversation() // matched three days before today, at noon
        fun items(rows: List<app.core.sync.ChatMessage>) =
            buildTranscript(rows, emptyList(), matched, readReceipts = false, atTop = true, me = ME, zone = zone)
        val matchDay = matched.createdAt.atZone(zone).toLocalDate()

        // The first message the same day as the match: «۳ روز پیش مچ شدین» places it; no separator under the intro.
        val sameDay = items(listOf(row(1, mine = true, at = matched.createdAt.plusSeconds(600))))
        assertEquals(listOf("local-1", "intro"), sameDay.map { it.key })
        // A first message on a later day keeps its separator.
        val later = items(listOf(row(1, mine = true, at = minutesAgo(1))))
        assertEquals(listOf("local-1", "day:${LocalDate.now(zone)}", "intro"), later.map { it.key })
        assertFalse(later.any { it is ChatItem.Day && it.date == matchDay })
        // Nothing written yet: the intro alone.
        assertEquals(listOf("intro"), items(emptyList()).map { it.key })
        // Not at the top of the history: no intro, and the separator stays.
        val notTop = buildTranscript(listOf(row(1, mine = true, at = matched.createdAt.plusSeconds(600))), emptyList(), matched, readReceipts = false, atTop = false, me = ME, zone = zone)
        assertEquals(listOf("local-1", "day:$matchDay"), notTop.map { it.key })
    }

    @Test
    fun aThreadMatchedTodayHasOneSystemLine() {
        // «امروز مچ شدین» and nothing else above today's first message: no «امروز» separator under it.
        val matchedNow = conversation().copy(createdAt = minutesAgo(5))
        val items = buildTranscript(listOf(row(1, mine = true, at = minutesAgo(1))), emptyList(), matchedNow, readReceipts = false, atTop = true, me = ME, zone = zone)
        assertEquals(listOf("local-1", "intro"), items.map { it.key })
        assertEquals(1, items.count { it is ChatItem.Day || it is ChatItem.Intro })
    }

    @Test
    fun aThreadBegunByARequestKeepsItsFirstDate() {
        // «گفتگو با یه درخواست شروع شد» names no day: the separator under it stays.
        val requested = conversation(source = app.core.model.ConversationSource.Request)
        val matchDay = requested.createdAt.atZone(zone).toLocalDate()
        val items = buildTranscript(listOf(row(1, mine = true, at = requested.createdAt.plusSeconds(600))), emptyList(), requested, readReceipts = false, atTop = true, me = ME, zone = zone)
        assertEquals(listOf("local-1", "day:$matchDay", "intro"), items.map { it.key })
    }

    @Test
    fun runsJoinTheSamePersonWithinFiveMinutesAndCallsStandAlone() {
        val rows = listOf(
            row(5, mine = false, at = minutesAgo(0)),
            row(4, mine = false, at = minutesAgo(2)),
            row(3, mine = false, at = minutesAgo(20)),
            row(2, mine = true, at = minutesAgo(21)),
            row(1, mine = true, at = minutesAgo(22), kind = MessageKind.Call, body = null, call = callLine(1, ME, CallOutcome.Completed, 42)),
        )
        val items = buildTranscript(rows, emptyList(), conversation(), readReceipts = false, atTop = false, me = ME, zone = zone)
        val byKey = bubbles(items).associateBy { it.message.serverId }
        assertTrue(byKey.getValue(5).joinsOlder)
        assertTrue(byKey.getValue(4).joinsNewer)
        assertFalse("twenty minutes apart: a new run", byKey.getValue(4).joinsOlder)
        assertFalse("another person: a new run", byKey.getValue(3).joinsOlder)
        assertFalse("a call line breaks a run", byKey.getValue(2).joinsOlder)
        assertEquals(1, items.count { it is ChatItem.Call })
    }

    @Test
    fun theTypingDotsRestAtTheDesignsFadeAndTheDarkestMovesAlong() {
        assertEquals(listOf(1f, 0.7f, 0.45f), (0..2).map { typingAlpha(it, 0f) })
        assertEquals(listOf(0.45f, 1f, 0.7f), (0..2).map { typingAlpha(it, 1f) })
        assertEquals(0.85f, typingAlpha(1, 0.5f), 0.001f)
    }

    @Test
    fun reactionsAreOnePerPersonAndAnEmptyOneTakesItBack() {
        val target = row(10, mine = false)
        val marks = listOf(
            row(11, mine = true, kind = MessageKind.Reaction, body = "❤️", refId = 10),
            row(12, mine = false, kind = MessageKind.Reaction, body = "😂", refId = 10),
            row(13, mine = true, kind = MessageKind.Reaction, body = "🔥", refId = 10),
            row(14, mine = false, kind = MessageKind.Reaction, body = "", refId = 10),
            // A reaction that failed to send is not shown.
            row(15, mine = false, kind = MessageKind.Reaction, body = "😢", refId = 10, state = SendState.FAILED, sender = NEGAR),
        )
        val bubble = bubbles(buildTranscript(listOf(target), marks, conversation(), readReceipts = false, atTop = false, me = ME, zone = zone)).single()
        assertEquals(listOf("🔥"), bubble.reactions)
        assertEquals("🔥", bubble.mine)
    }

    @Test
    fun anUnsendByTheSenderAndAModerationRemovalReadDifferently() {
        val rows = listOf(row(21, mine = false), row(20, mine = true))
        val marks = listOf(
            // The sender took back their own message.
            row(22, mine = true, kind = MessageKind.Unsend, body = null, refId = 20),
            // A kind-8 row from someone other than the sender: moderation.
            row(23, mine = false, kind = MessageKind.Unsend, body = null, refId = 21, sender = "zmoderation00"),
        )
        val items = bubbles(buildTranscript(rows, marks, conversation(), readReceipts = false, atTop = false, me = ME, zone = zone)).associateBy { it.message.serverId }
        assertEquals(Unsent.BySender, items.getValue(20).unsent)
        assertEquals(Unsent.Removed, items.getValue(21).unsent)
        assertNull(items.getValue(21).delivery)
    }
}
