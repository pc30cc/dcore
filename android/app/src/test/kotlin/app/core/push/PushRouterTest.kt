package app.core.push

import app.core.common.Diag
import app.core.model.Id
import app.core.model.PublicUid
import app.core.model.PushData
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** One push, whatever it is: where it goes, and what is shown. */
class PushRouterTest {

    private class Shade : NotificationSink {
        val shown = mutableListOf<Triple<PushData, String?, String?>>()
        override fun show(push: PushData, title: String?, body: String?) { shown += Triple(push, title, body) }
        override fun clearConversation(conversationId: String) = Unit
        override fun clearLikes() = Unit
    }

    private class Chat(var account: PublicUid? = "aaaaaaaaaaaaa", var viewing: Id? = null) : PushChatHooks {
        val arrived = mutableListOf<Id>()
        var listReads = 0
        var inboxReads = 0
        override suspend fun signedInAccount(): PublicUid? = account
        override fun isViewing(conversationId: Id): Boolean = viewing == conversationId
        override suspend fun messageArrived(conversationId: Id) { arrived += conversationId }
        override suspend fun listChanged() { listReads++ }
        override suspend fun requestArrived() { inboxReads++ }
    }

    private val shade = Shade()
    private val chat = Chat()
    private val router = PushRouter(shade, chat, Diag.Silent)

    private val message = mapOf("type" to "message", "conversationId" to "1287390234923400001", "messageId" to "1287390234923417600")

    @Test
    fun aMessageIsShownWithTheServersTextAndItsThreadMarkedToRead() = runTest {
        assertEquals(PushHandled.Shown, router.onMessage(message, "Negar", "Hello!", 0))
        assertEquals(PushData.NewMessage("1287390234923400001", "1287390234923417600"), shade.shown.single().first)
        assertEquals("Negar", shade.shown.single().second)
        assertEquals(listOf("1287390234923400001"), chat.arrived)
    }

    @Test
    fun aMessageForTheConversationOnScreenIsNotShown() = runTest {
        chat.viewing = "1287390234923400001"
        assertEquals(PushHandled.OnScreen, router.onMessage(message, "Negar", "Hello!", 0))
        assertTrue(shade.shown.isEmpty())
        assertEquals("still read on the screen's next step", 1, chat.arrived.size)
    }

    @Test
    fun ringsGoToTheCallsAndNeverToTheShade() = runTest {
        val ring = mapOf(
            "type" to "call_incoming", "callId" to "1287390234923430001", "conversationId" to "1287390234923400001",
            "kind" to "video", "peerName" to "Negar", "expiresAt" to "2026-11-06T09:15:45.000Z",
        )
        assertEquals("no call layer: dropped", PushHandled.Ignored, router.onMessage(ring, null, null, 0))
        val taken = mutableListOf<PushData>()
        router.calls = CallPushHandler { push, _, _ -> taken += push; true }
        assertEquals(PushHandled.ToCalls, router.onMessage(ring, null, null, 0))
        assertEquals(PushHandled.ToCalls, router.onMessage(mapOf("type" to "call_cancel", "callId" to "1287390234923430001", "reason" to "cancelled"), null, null, 0))
        assertEquals(2, taken.size)
        assertTrue(shade.shown.isEmpty())
    }

    @Test
    fun aMissedCallIsTheCallLayersFirstAndOursOtherwise() = runTest {
        val missed = mapOf("type" to "call_missed", "callId" to "1287390234923430001", "conversationId" to "1287390234923400001")
        router.calls = CallPushHandler { _, _, _ -> false }
        assertEquals(PushHandled.Shown, router.onMessage(missed, "Missed call", "Negar", 0))
        assertTrue(shade.shown.single().first is PushData.CallMissed)
    }

    @Test
    fun aPushForNobodySignedInIsDropped() = runTest {
        chat.account = null
        assertEquals(PushHandled.Ignored, router.onMessage(message, "Negar", "Hello!", 0))
        assertTrue(shade.shown.isEmpty())
        assertTrue(chat.arrived.isEmpty())
    }

    @Test
    fun aMatchReadsTheListAndARequestTheInboxAndBothShow() = runTest {
        router.onMessage(mapOf("type" to "match", "conversationId" to "1287390234923400001"), null, null, 0)
        assertEquals(1, chat.listReads)
        assertEquals(0, chat.inboxReads)
        router.onMessage(mapOf("type" to "request", "requestId" to "1287390234923440001"), null, null, 0)
        assertEquals("a request is not a conversation: the list stays", 1, chat.listReads)
        assertEquals(1, chat.inboxReads)
        assertEquals(listOf("m:1287390234923400001", "r:1287390234923440001"), shade.shown.map { NotificationTags.of(it.first) })
    }

    @Test
    fun unknownAndMalformedPushesAreIgnored() = runTest {
        assertEquals(PushHandled.Ignored, router.onMessage(mapOf("type" to "sparkle"), "x", "y", 0))
        assertEquals(PushHandled.Ignored, router.onMessage(mapOf("type" to "message", "conversationId" to "x"), "x", "y", 0))
        assertEquals(PushHandled.Ignored, router.onMessage(emptyMap(), null, null, 0))
        assertTrue(shade.shown.isEmpty())
    }

    @Test
    fun eachPushOpensItsPlaceAndTagsItsNotificationAsTheServerDoes() {
        assertEquals(OpenTarget.Thread("12"), OpenTargets.of(PushData.NewMessage("12", "13")))
        assertEquals(OpenTarget.Thread("12"), OpenTargets.of(PushData.NewMatch("12")))
        assertEquals(OpenTarget.Thread("12"), OpenTargets.of(PushData.CallMissed("9", "12")))
        assertEquals(OpenTarget.Requests, OpenTargets.of(PushData.NewRequest("5")))
        assertEquals(OpenTarget.Likes, OpenTargets.of(PushData.NewLike(3)))
        assertEquals(null, OpenTargets.of(PushData.CallCancel("9", "ended")))
        assertEquals("c:12", NotificationTags.of(PushData.NewMessage("12", "13")))
        assertEquals("m:12", NotificationTags.of(PushData.NewMatch("12")))
        assertEquals("likes", NotificationTags.of(PushData.NewLike(3)))
        assertEquals("r:5", NotificationTags.of(PushData.NewRequest("5")))
        assertEquals("call:9", NotificationTags.of(PushData.CallMissed("9", "12")))
        assertEquals(PushChannels.MESSAGES, NotificationTags.channel(PushData.CallMissed("9", "12")))
        assertEquals(PushChannels.MATCHES, NotificationTags.channel(PushData.NewMatch("12")))
        // The app's own notification carries the same keys a system-drawn one does.
        assertEquals(mapOf("type" to "message", "conversationId" to "12", "messageId" to "13"), OpenTargets.extras(PushData.NewMessage("12", "13")))
    }
}
