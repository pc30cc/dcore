package app.core.feature.call

import app.core.common.Clock
import app.core.model.CallKind
import app.core.model.MessageKind
import app.core.net.SampleApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A whole call against the sample backend, with a room that has no media
 * (the sample has no media server): what the phone asks the server, counted
 * by route. While the realtime socket is up a ringing call asks nothing;
 * while it is down the call is read every 3 s, and the server's answer brings
 * the call to the room. Every ended call leaves its line in the chat.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CallSampleTest {

    private class Phone(scope: TestScope, answerAfterMs: Long?, connected: Boolean) {
        val clock = Clock { T0 + scope.testScheduler.currentTime }
        val api = SampleApi(clock = clock, answerAfterMs = answerAfterMs)
        val room = FakeCallRoom()
        val signals = CallSignals().apply { setRealtimeConnected(connected) }
        val session = MatchCallSession(
            api = CallApi.of(api),
            room = room,
            signals = signals,
            ringback = SilentRingback,
            foreground = NoCallForeground,
            clock = clock,
            dispatcher = StandardTestDispatcher(scope.testScheduler),
        )

        fun gets() = api.requestLog.count { it == "calls.get" }
    }

    private suspend fun Phone.callable(): CallPeer {
        val conversation = api.conversations().value.items.first { it.callsAllowed.both }
        return CallPeer(conversation.id, conversation.peer.name)
    }

    @Test
    fun aRingingCallMakesNoPollWhileTheSocketIsUp() = runTest {
        val phone = Phone(this, answerAfterMs = null, connected = true)
        phone.session.place(phone.callable(), CallKind.Audio)
        runCurrent()
        advanceTimeBy(44_000)
        runCurrent()
        assertEquals(0, phone.gets())
        assertEquals(listOf("calls.place"), phone.api.requestLog.filter { it.startsWith("calls.") })
        phone.session.close()
        runCurrent()
    }

    @Test
    fun withTheSocketDownTheSampleAnswersAndTheCallGoesLive() = runTest {
        val phone = Phone(this, answerAfterMs = 4_000, connected = false)
        phone.room.peerHere = true
        phone.session.place(phone.callable(), CallKind.Video)
        runCurrent()
        advanceTimeBy(3_100)
        runCurrent()
        assertEquals("the other phone rings", CallPhase.Ringing, phone.session.phase.value)
        advanceTimeBy(3_000)
        runCurrent()
        assertTrue(phone.session.phase.value is CallPhase.Live)
        assertEquals("one read per 3 s while it rang", 2, phone.gets())
        assertEquals("sample.room.", phone.room.joined?.token?.take(12))
        phone.session.hangUp()
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.HUNG_UP), phone.session.phase.value)
        val line = phone.api.messagesBefore(phone.callable().conversationId, before = null).items.last()
        assertEquals(MessageKind.Call, line.kind)
        assertEquals(phone.session.callId, line.call?.callId)
        phone.session.close()
        runCurrent()
    }

    @Test
    fun anUnansweredCallIsMissedByTheServerAndSaysNoAnswer() = runTest {
        val phone = Phone(this, answerAfterMs = null, connected = false)
        phone.session.place(phone.callable(), CallKind.Audio)
        runCurrent()
        advanceTimeBy(46_000)
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.NO_ANSWER), phone.session.phase.value)
        phone.session.close()
        runCurrent()
    }

    @Test
    fun aRingFromTheSampleIsAnsweredWithTheAcceptsToken() = runTest {
        val phone = Phone(this, answerAfterMs = null, connected = true)
        val peer = phone.callable()
        val ring = phone.api.ringFrom(peer.conversationId, CallKind.Audio)
        phone.room.peerHere = true
        phone.session.ring(ring.id, peer, CallKind.Audio, ring.ringExpiresAt)
        runCurrent()
        phone.session.answer()
        runCurrent()
        assertTrue(phone.session.phase.value is CallPhase.Live)
        assertEquals(listOf("calls.accept"), phone.api.requestLog.filter { it.startsWith("calls.") })
        phone.session.close()
        runCurrent()
    }
}
