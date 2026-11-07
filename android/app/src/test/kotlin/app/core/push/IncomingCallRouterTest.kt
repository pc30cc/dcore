package app.core.push

import app.core.common.FakeClock
import app.core.feature.call.T0
import app.core.feature.call.at
import app.core.feature.call.testCall
import app.core.model.CallKind
import app.core.model.CallOutcome
import app.core.model.CallRole
import app.core.model.CallState
import app.core.model.Id
import app.core.model.InstantSerializer
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ring from push and from the realtime socket: one ring for both, a stop
 * that beats its ring (FCM keeps no order) wins, nothing rings past its expiry
 * or with nobody signed in, and a missed call is left only for a ring nobody
 * dealt with here.
 */
class IncomingCallRouterTest {

    private class Phone(signedIn: Boolean = true) {
        val clock = FakeClock(T0)
        var signedIn = signedIn
        var canPost = true
        val rings = mutableListOf<CallRing>()
        val stops = mutableListOf<Triple<Id, Boolean, RingStopReason>>()
        val rang = mutableListOf<Id>()
        val peers = mutableMapOf("500" to IncomingCallRouter.RingPeer("Negar", "https://cdn.example.test/p/1/1/320.webp"))
        val router = IncomingCallRouter(
            signedIn = { this.signedIn },
            ring = { ring -> if (canPost) rings += ring; canPost },
            stop = { id, missed, reason -> stops += Triple(id, missed, reason) },
            peerOf = { peers[it] },
            rang = { rang += it },
            clock = clock,
        )
    }

    private fun ringData(callId: Id = "9001", expiresInMs: Long = 45_000, kind: String = "video") = mapOf(
        "type" to "call_incoming",
        "callId" to callId,
        "conversationId" to "500",
        "kind" to kind,
        "peerName" to "Negar",
        "peerPhotoUrl" to "https://cdn.example.test/p/1/1/320.webp",
        "expiresAt" to InstantSerializer.format(at(expiresInMs)),
    )

    private fun stopData(callId: Id = "9001", reason: String = "cancelled") = mapOf("type" to "call_cancel", "callId" to callId, "reason" to reason)

    @Test
    fun aPushRingRingsAndReportsRang() = runTest {
        val phone = Phone()
        assertTrue(phone.router.onMessage(ringData(), sentAtMillis = T0))
        assertEquals(1, phone.rings.size)
        assertEquals("Negar", phone.rings.single().peerName)
        assertEquals(CallKind.Video, phone.rings.single().kind)
        assertEquals(listOf("9001"), phone.rang)
        assertTrue(phone.router.isRinging("9001"))
    }

    @Test
    fun otherPushesAreNotACallsToHandle() = runTest {
        val phone = Phone()
        assertFalse(phone.router.onMessage(mapOf("type" to "message", "conversationId" to "500", "messageId" to "1")))
        assertTrue(phone.rings.isEmpty())
    }

    @Test
    fun theSameRingFromPushAndRealtimeRingsOnce() = runTest {
        val phone = Phone()
        phone.router.onMessage(ringData(), sentAtMillis = T0)
        phone.router.onRealtimeCall(testCall(role = CallRole.Callee, kind = CallKind.Video))
        assertEquals(1, phone.rings.size)
        assertEquals(1, phone.rang.size)

        val other = Phone()
        other.router.onRealtimeCall(testCall(role = CallRole.Callee, kind = CallKind.Video))
        other.router.onMessage(ringData(), sentAtMillis = T0)
        assertEquals("realtime first, then push", 1, other.rings.size)
        assertEquals("the realtime ring names the match from what the phone knows", "Negar", other.rings.single().peerName)
    }

    @Test
    fun aStopThatArrivesBeforeItsRingKeepsTheRingOff() = runTest {
        val phone = Phone()
        phone.router.onMessage(stopData(), sentAtMillis = T0)
        phone.router.onMessage(ringData(), sentAtMillis = T0)
        assertTrue("FCM keeps no order: the late ring is dropped", phone.rings.isEmpty())
        assertEquals("nothing rang here, so nothing was missed here", false, phone.stops.single().second)
    }

    @Test
    fun aStopAfterTheRingLeavesAMissedCallOnlyWhenTheCallerGaveUpOrNobodyAnswered() = runTest {
        for ((reason, missed) in listOf("cancelled" to true, "missed" to true, "answered_elsewhere" to false, "declined" to false, "ended" to false)) {
            val phone = Phone()
            phone.router.onMessage(ringData(), sentAtMillis = T0)
            phone.router.onMessage(stopData(reason = reason))
            assertEquals(reason, missed, phone.stops.single().second)
            assertEquals(RingStopReason.of(reason), phone.stops.single().third)
            assertFalse(phone.router.isRinging("9001"))
        }
    }

    @Test
    fun aRingDealtWithHereIsNeverMissedNorShownAgain() = runTest {
        val phone = Phone()
        phone.router.onMessage(ringData(), sentAtMillis = T0)
        phone.router.dealtWith("9001")
        phone.router.onMessage(stopData(reason = "cancelled"))
        assertEquals(false, phone.stops.single().second)
        phone.router.onRealtimeCall(testCall(role = CallRole.Callee))
        assertEquals(1, phone.rings.size)
    }

    @Test
    fun aRingAfterItsExpiryOrWithNobodySignedInDoesNotRing() = runTest {
        val late = Phone()
        late.clock.advance(46_000)
        late.router.onMessage(ringData(), sentAtMillis = 0)
        assertTrue(late.rings.isEmpty())

        val nobody = Phone(signedIn = false)
        nobody.router.onMessage(ringData(), sentAtMillis = T0)
        assertTrue(nobody.rings.isEmpty())
        assertTrue(nobody.rang.isEmpty())
    }

    @Test
    fun aPhoneClockThatRunsFastStillRings() = runTest {
        val phone = Phone()
        // The phone's clock is two minutes ahead of the server's.
        phone.clock.advance(120_000)
        phone.router.onMessage(ringData(), sentAtMillis = T0)
        assertEquals(1, phone.rings.size)
        assertEquals("a whole ring from now, on the phone's clock", phone.clock.now().plusSeconds(45), phone.rings.single().expiresAt)
    }

    @Test
    fun aRingThatCouldNotBePostedCanRingAgainFromTheOtherPath() = runTest {
        val phone = Phone()
        phone.canPost = false
        phone.router.onMessage(ringData(), sentAtMillis = T0)
        assertTrue(phone.rang.isEmpty())
        phone.canPost = true
        phone.router.onRealtimeCall(testCall(role = CallRole.Callee))
        assertEquals(1, phone.rings.size)
    }

    @Test
    fun aRealtimeRingReplayedLongAfterItWasPlacedDoesNotRing() = runTest {
        val phone = Phone()
        phone.clock.advance(10 * 60_000)
        phone.router.onRealtimeCall(testCall(role = CallRole.Callee))
        assertTrue(phone.rings.isEmpty())
    }

    @Test
    fun realtimeStopsTheRingAsPushWould() = runTest {
        val phone = Phone()
        phone.router.onRealtimeCall(testCall(role = CallRole.Callee))
        phone.router.onRealtimeCall(testCall(role = CallRole.Callee, state = CallState.Missed, outcome = CallOutcome.Missed))
        assertEquals(Triple("9001", true, RingStopReason.MISSED), phone.stops.single())

        val elsewhere = Phone()
        elsewhere.router.onRealtimeCall(testCall(role = CallRole.Callee))
        elsewhere.router.onRealtimeCall(testCall(role = CallRole.Callee, state = CallState.Connecting))
        assertEquals(Triple("9001", false, RingStopReason.ANSWERED_ELSEWHERE), elsewhere.stops.single())
    }

    @Test
    fun theCallersOwnEventsNeverRing() = runTest {
        val phone = Phone()
        phone.router.onRealtimeCall(testCall(role = CallRole.Caller))
        assertTrue(phone.rings.isEmpty())
    }

    @Test
    fun malformedRingsAreDroppedButStillCountAsCallMessages() = runTest {
        val phone = Phone()
        assertTrue(phone.router.onMessage(ringData() - "conversationId"))
        assertTrue(phone.router.onMessage(ringData() + ("callId" to "../etc")))
        assertTrue(phone.router.onMessage(ringData(kind = "hologram")))
        assertTrue(phone.rings.isEmpty())
    }
}
