package app.core.push

import app.core.model.CallKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/** The server's own ring and stop (`fixtures/push`) read into this build's ring, and the phone-clock rule. */
class CallRingTest {

    private fun push(name: String): Map<String, String> {
        val file = File("../../server/packages/shared/fixtures/push/$name.json")
        assumeTrue("no server fixture $name", file.isFile)
        val json = Json.parseToJsonElement(file.readText()) as JsonObject
        return json.mapValues { it.value.jsonPrimitive.content }
    }

    @Test
    fun theServersRingAndStopDecode() {
        val ring = CallRing.from(push("call_incoming"))!!
        assertEquals("1287390234923430001", ring.callId)
        assertEquals("1287390234923400001", ring.conversationId)
        assertEquals(CallKind.Video, ring.kind)
        assertEquals("Negar", ring.peerName)
        assertEquals(Instant.parse("2026-11-06T09:15:45.000Z"), ring.expiresAt)
        assertEquals(true, ring.peerPhotoUrl?.startsWith("https://"))

        val stop = CallRingStop.from(push("call_cancel"))!!
        assertEquals("1287390234923430001", stop.callId)
        assertEquals(RingStopReason.ANSWERED_ELSEWHERE, stop.reason)
    }

    @Test
    fun onlyHttpsPhotosAreFetched() {
        assertNull(CallRing.photoUrl("http://cdn.example.test/p.webp"))
        assertNull(CallRing.photoUrl("file:///sdcard/x.jpg"))
        assertEquals("https://cdn.example.test/p.webp", CallRing.photoUrl(" https://cdn.example.test/p.webp "))
    }

    @Test
    fun anUnknownStopReasonIsAnEndNotAMissedCall() {
        assertEquals(RingStopReason.ENDED, RingStopReason.of("teleported"))
        assertEquals(false, RingStopReason.ENDED.missed)
    }

    @Test
    fun expiryOnThePhonesClock() {
        val sent = Instant.parse("2026-11-06T09:15:00Z")
        val expires = sent.plusSeconds(45)
        // The clocks agree: unchanged.
        assertEquals(expires, expiryOnPhoneClock(expires, sent.plusSeconds(2), sent))
        // The phone is an hour slow: the ring still lasts 45 s, from now.
        val slow = sent.minusSeconds(3600)
        assertEquals(slow.plusSeconds(45), expiryOnPhoneClock(expires, slow, sent))
        // No send time: nothing to correct with.
        assertEquals(expires, expiryOnPhoneClock(expires, slow, null))
    }
}
