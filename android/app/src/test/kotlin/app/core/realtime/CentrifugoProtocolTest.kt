package app.core.realtime

import app.core.realtime.CentrifugoProtocol.StreamPosition
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every frame the app sends, and every shape it can receive, pinned without a socket. */
class CentrifugoProtocolTest {

    private fun obj(text: String) = Json.parseToJsonElement(text).jsonObject

    @Test
    fun connectCarriesTheTokenAndNoSubscriptionsWithoutAPosition() {
        val frame = obj(CentrifugoProtocol.connect(1, "tok", "app-android", "1.0"))
        assertEquals(1, frame["id"]!!.jsonPrimitive.content.toInt())
        val connect = frame["connect"]!!.jsonObject
        assertEquals("tok", connect["token"]!!.jsonPrimitive.content)
        assertEquals("app-android", connect["name"]!!.jsonPrimitive.content)
        assertNull(connect["subs"])
    }

    @Test
    fun connectAsksToRecoverAServerSideChannelFromItsPosition() {
        val frame = obj(CentrifugoProtocol.connect(3, "tok", "n", "v", mapOf("u:#me" to StreamPosition(41, "e9"))))
        val sub = frame["connect"]!!.jsonObject["subs"]!!.jsonObject["u:#me"]!!.jsonObject
        assertEquals("true", sub["recover"]!!.jsonPrimitive.content)
        assertEquals("41", sub["offset"]!!.jsonPrimitive.content)
        assertEquals("e9", sub["epoch"]!!.jsonPrimitive.content)
    }

    @Test
    fun subscribeHasNoTokenAndRecoversOnlyFromAKnownPosition() {
        val plain = obj(CentrifugoProtocol.subscribe(2, "u:#me", null))["subscribe"]!!.jsonObject
        assertEquals("u:#me", plain["channel"]!!.jsonPrimitive.content)
        assertNull(plain["token"])
        assertNull(plain["recover"])
        val resumed = obj(CentrifugoProtocol.subscribe(2, "u:#me", StreamPosition(7, "e1")))["subscribe"]!!.jsonObject
        assertEquals("true", resumed["recover"]!!.jsonPrimitive.content)
        assertEquals("7", resumed["offset"]!!.jsonPrimitive.content)
    }

    @Test
    fun refreshSendsTheNewToken() {
        val frame = obj(CentrifugoProtocol.refresh(9, "fresh"))
        assertEquals("fresh", frame["refresh"]!!.jsonObject["token"]!!.jsonPrimitive.content)
    }

    @Test
    fun anEmptyObjectIsAPingAndThePongIsOne() {
        assertEquals(listOf(Inbound.Ping), CentrifugoProtocol.parse("{}"))
        assertEquals("{}", CentrifugoProtocol.PONG)
    }

    @Test
    fun severalFramesInOneMessage() {
        val frames = CentrifugoProtocol.parse("{}\n{\"push\":{\"channel\":\"u:#me\",\"pub\":{\"data\":{\"a\":1},\"offset\":5}}}\n\n")
        assertEquals(2, frames.size)
        val pub = frames[1] as Inbound.Publication
        assertEquals("u:#me", pub.channel)
        assertEquals(5L, pub.offset)
    }

    @Test
    fun connectReplyWithServerSideSubscriptions() {
        val reply = CentrifugoProtocol.parse(
            """{"id":1,"connect":{"client":"c","version":"6","expires":true,"ttl":3599,"subs":{"u:#me":{"recoverable":true,"epoch":"e2","offset":12,"recovered":true,"was_recovering":true,"publications":[{"data":{"x":1},"offset":12}]}}}}""",
        ).single() as Inbound.Reply
        val connect = reply.connect!!
        assertTrue(connect.expiry.expires)
        assertEquals(3599L, connect.expiry.ttlSeconds)
        val sub = connect.subs.getValue("u:#me")
        assertTrue(sub.recovered)
        assertEquals("e2", sub.epoch)
        assertEquals(12L, sub.offset)
        assertEquals(1, sub.publications.size)
    }

    @Test
    fun subscribeAndRefreshRepliesAndErrors() {
        val sub = CentrifugoProtocol.parse("""{"id":2,"subscribe":{"recovered":false,"was_recovering":true,"epoch":"e","offset":3}}""").single() as Inbound.Reply
        assertFalse(sub.subscribe!!.recovered)
        assertTrue(sub.subscribe!!.wasRecovering)
        val refresh = CentrifugoProtocol.parse("""{"id":5,"refresh":{"expires":true,"ttl":3600}}""").single() as Inbound.Reply
        assertEquals(3600L, refresh.refresh!!.ttlSeconds)
        val error = CentrifugoProtocol.parse("""{"id":2,"error":{"code":112,"message":"unrecoverable position","temporary":false}}""").single() as Inbound.Reply
        assertEquals(CentrifugoProtocol.ERROR_UNRECOVERABLE_POSITION, error.error!!.code)
        assertFalse(error.error!!.temporary)
    }

    @Test
    fun disconnectsUnsubscribesAndServerSubscribes() {
        assertEquals(Inbound.Disconnect(3501, "bad"), CentrifugoProtocol.parse("""{"push":{"disconnect":{"code":3501,"reason":"bad"}}}""").single())
        assertEquals(Inbound.Unsubscribed("u:#me", 2000), CentrifugoProtocol.parse("""{"push":{"channel":"u:#me","unsubscribe":{"code":2000}}}""").single())
        val added = CentrifugoProtocol.parse("""{"push":{"channel":"u:#me","subscribe":{"epoch":"e","offset":1}}}""").single()
        assertTrue(added is Inbound.ServerSubscribed)
    }

    @Test
    fun junkIsUnknownNeverACrash() {
        assertEquals(listOf(Inbound.Unknown, Inbound.Unknown, Inbound.Unknown), CentrifugoProtocol.parse("not json\n[1,2]\n{\"push\":{}}"))
    }

    @Test
    fun terminalCodes() {
        assertTrue(CentrifugoProtocol.isTerminal(3500))
        assertTrue(CentrifugoProtocol.isTerminal(4501))
        assertFalse(CentrifugoProtocol.isTerminal(3005))
        assertFalse(CentrifugoProtocol.isTerminal(3000))
    }
}
