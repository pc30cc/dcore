package app.core.realtime

import app.core.model.ConversationChange
import app.core.model.EntitlementSource
import app.core.model.MessageKind
import app.core.model.PushData
import app.core.model.RealtimeEvent
import app.core.model.RealtimeEvents
import app.core.model.StoreName
import app.core.model.Wire
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The server's realtime and push fixtures (`server/packages/shared/fixtures`)
 * read by the app's decoders: every envelope becomes the right event, every
 * push the right type. The server validates the same files against its
 * schemas, so these are shapes both sides agree on.
 */
class RealtimeEventsTest {

    private val root: File = generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "server/packages/shared/fixtures") }
        .firstOrNull { it.isDirectory }
        ?: error("server/packages/shared/fixtures not found")

    private fun files(dir: String): Map<String, String> =
        File(root, dir).listFiles().orEmpty().filter { it.name.endsWith(".json") }.associate { it.name.removeSuffix(".json") to it.readText() }

    @Test
    fun everyRealtimeFixtureDecodesToItsEvent() {
        val expected = mapOf(
            "message" to RealtimeEvent.MessageArrived::class,
            "receipt" to RealtimeEvent.ReceiptMoved::class,
            "typing" to RealtimeEvent.PeerTyping::class,
            "conversation" to RealtimeEvent.ConversationChanged::class,
            "conversation_end" to RealtimeEvent.ConversationEnded::class,
            "like" to RealtimeEvent.LikeReceived::class,
            "request" to RealtimeEvent.RequestReceived::class,
            "call" to RealtimeEvent.CallChanged::class,
            "entitlement" to RealtimeEvent.EntitlementsChanged::class,
            "profile" to RealtimeEvent.ProfileModerated::class,
            "account" to RealtimeEvent.AccountChanged::class,
            "support" to RealtimeEvent.SupportReplied::class,
            "config" to RealtimeEvent.ConfigChanged::class,
        )
        val fixtures = files("realtime")
        assertEquals("a fixture without a decoder, or the reverse", expected.keys.sorted(), fixtures.keys.sorted())
        for ((name, text) in fixtures) {
            val event = RealtimeEvents.decode(Wire.json.parseToJsonElement(text))
            assertTrue("$name decoded as $event", expected.getValue(name).isInstance(event))
        }
    }

    @Test
    fun theChatEventsCarryWhatTheReceiverWrites() {
        val fixtures = files("realtime")
        val message = RealtimeEvents.decode(Wire.json.parseToJsonElement(fixtures.getValue("message"))) as RealtimeEvent.MessageArrived
        assertEquals("1287390234923417600", message.id)
        assertEquals("c-7f3a9e", message.message.clientId)
        assertEquals(MessageKind.Text, message.message.kind)
        val conversation = RealtimeEvents.decode(Wire.json.parseToJsonElement(fixtures.getValue("conversation"))) as RealtimeEvent.ConversationChanged
        assertEquals(ConversationChange.Matched, conversation.change.reason)
        assertTrue(conversation.change.conversation.peer.online)
        val receipt = RealtimeEvents.decode(Wire.json.parseToJsonElement(fixtures.getValue("receipt"))) as RealtimeEvent.ReceiptMoved
        assertEquals("1287390234923417600", receipt.receipt.readUpTo)
        assertNull(receipt.receipt.deliveredUpTo)
    }

    @Test
    fun unknownTypesAndBrokenPayloadsAreDroppedNotThrown() {
        assertNull(RealtimeEvents.decode(Wire.json.parseToJsonElement("""{"t":"sparkle","v":1,"id":"1","d":{}}""")))
        assertNull(RealtimeEvents.decode(Wire.json.parseToJsonElement("""{"t":"message","v":1,"id":"1","d":{"id":"2"}}""")))
        assertNull(RealtimeEvents.decode(Wire.json.parseToJsonElement("""[1]""")))
        // Unknown keys are fine.
        val newer = RealtimeEvents.decode(
            Wire.json.parseToJsonElement("""{"t":"typing","v":2,"id":"9","extra":true,"d":{"conversationId":"5","by":"cn5wy6l3naf5b","mood":"x"}}"""),
        )
        assertTrue(newer is RealtimeEvent.PeerTyping)
    }

    @Test
    fun anEntitlementEventSaysWhoseViewItIs() {
        fun decode(store: String?): RealtimeEvent.EntitlementsChanged {
            val member = store?.let { "\"store\":$it," } ?: ""
            val text = """{"t":"entitlement","v":1,"id":"7","d":{$member"plan":"plus","source":"play","wallet":{"boost":2}}}"""
            return RealtimeEvents.decode(Wire.json.parseToJsonElement(text)) as RealtimeEvent.EntitlementsChanged
        }
        for (event in listOf(decode(null), decode("null"), decode("\"play\""), decode("\"bazaar\""), decode("\"elsewhere\""))) {
            assertEquals("plus", event.entitlements.plan)
            assertEquals(EntitlementSource.Play, event.entitlements.source)
            assertEquals(2, event.entitlements.wallet.boost)
        }
        assertNull("a view of no store", decode(null).store)
        assertNull(decode("null").store)
        assertEquals(StoreName.Play, decode("\"play\"").store)
        assertEquals(StoreName.Bazaar, decode("\"bazaar\"").store)
        assertEquals("a store this build does not know is not its own", StoreName.Unknown, decode("\"elsewhere\"").store)
    }

    @Test
    fun everyPushFixtureParsesToItsType() {
        val strings = MapSerializer(String.serializer(), String.serializer())
        val pushes = files("push").mapValues { (_, text) -> Wire.json.decodeFromString(strings, text) }
        val expected = mapOf(
            "call_incoming" to PushData.CallIncoming::class,
            "call_cancel" to PushData.CallCancel::class,
            "message" to PushData.NewMessage::class,
            "match" to PushData.NewMatch::class,
            "like" to PushData.NewLike::class,
            "request" to PushData.NewRequest::class,
            "call_missed" to PushData.CallMissed::class,
            "account" to PushData.AccountNotice::class,
            "support" to PushData.SupportReply::class,
            "offer" to PushData.Offer::class,
        )
        assertEquals(expected.keys.sorted(), pushes.keys.sorted())
        for ((name, data) in pushes) {
            val push = PushData.parse(data)
            assertTrue("$name parsed as $push", expected.getValue(name).isInstance(push))
        }
        val ring = PushData.parse(pushes.getValue("call_incoming")) as PushData.CallIncoming
        assertEquals("Negar", ring.peerName)
        assertTrue(ring.isRing)
        assertEquals(7, (PushData.parse(pushes.getValue("like")) as PushData.NewLike).total)
    }

    @Test
    fun aPushWithABadIdIsNothingAndAnUnknownTypeIsUnknown() {
        assertNull(PushData.parse(mapOf("type" to "message", "conversationId" to "12", "messageId" to "0abc")))
        assertNull(PushData.parse(mapOf("type" to "message", "conversationId" to "../x", "messageId" to "5")))
        assertNull(PushData.parse(mapOf("conversationId" to "1")))
        assertNull(PushData.parse(mapOf("type" to "offer", "campaignId" to "4", "deeplink" to "https://evil.test")))
        assertEquals(PushData.Unknown("sparkle"), PushData.parse(mapOf("type" to "sparkle")))
        val ring = PushData.parse(mapOf("type" to "call_incoming", "callId" to "1", "conversationId" to "2", "kind" to "video", "peerName" to "N", "peerPhotoUrl" to "http://plain.test/p.jpg")) as PushData.CallIncoming
        assertNull("only https photos", ring.peerPhotoUrl)
    }
}
