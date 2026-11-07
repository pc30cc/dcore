package app.core.feature.call

import app.core.common.Clock
import app.core.model.CallAcceptance
import app.core.model.CallKind
import app.core.model.CallOutcome
import app.core.model.CallRole
import app.core.model.CallState
import app.core.model.Id
import app.core.push.RingStopReason
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The call's state machine on a JVM, with a scripted server and a room with
 * no media: placed, ringing, answered, active, ended, and every way out
 * (declined, missed, busy, timeouts, refusals, drops), the races between a
 * hang-up and an answer, and the rule that nothing is polled while the
 * realtime socket is up.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MatchCallSessionTest {

    private class Rig(scope: TestScope, connected: Boolean = true) {
        val api = ScriptedCallApi()
        val room = FakeCallRoom()
        val signals = CallSignals().apply { setRealtimeConnected(connected) }
        val ringback = RecordingRingback()
        val foreground = RecordingForeground()
        val rang = mutableListOf<Id>()
        val clock = Clock { T0 + scope.testScheduler.currentTime }
        val session = MatchCallSession(
            api = api,
            room = room,
            signals = signals,
            ringback = ringback,
            foreground = foreground,
            rang = { rang += it },
            clock = clock,
            dispatcher = StandardTestDispatcher(scope.testScheduler),
        )
        val phase get() = session.phase.value

        fun update(state: CallState, role: CallRole = CallRole.Caller, outcome: CallOutcome? = null, rangAt: Long? = null, id: Id = "9001") =
            signals.onRealtimeCall(testCall(id = id, role = role, state = state, outcome = outcome, rangAt = rangAt?.let(::at)))
    }

    private val peer = CallPeer(conversationId = "500", name = "Negar", photoUrl = "https://cdn.example.test/p/1/1/320.webp")

    // MARK: - Outgoing

    @Test
    fun outgoingCallGoesPlacedRingingAnsweredActiveEnded() = runTest {
        val r = Rig(this)
        r.session.place(peer, CallKind.Audio)
        assertEquals(CallPhase.Placing, r.phase)
        runCurrent()
        assertEquals(listOf("place"), r.api.log)
        // Ringing on the server: the ringback plays, the service holds the call, still "Calling…".
        assertTrue(r.ringback.playing)
        assertEquals(1, r.foreground.shown.size)
        assertEquals(CallPhase.Placing, r.phase)

        r.update(CallState.Ringing, rangAt = 800)
        runCurrent()
        assertEquals(CallPhase.Ringing, r.phase)

        r.update(CallState.Connecting)
        runCurrent()
        assertFalse("the ringback stops at the answer", r.ringback.playing)
        assertEquals(listOf("place", "token"), r.api.log)
        assertEquals("room-token", r.room.joined?.token)
        assertEquals("connecting until the other person is in the room", CallPhase.Connecting, r.phase)

        r.room.emitted.tryEmit(CallRoom.Event.PeerPresence(true))
        runCurrent()
        val live = r.phase as CallPhase.Live
        assertEquals(at(0), live.since)
        assertEquals("the ongoing notification gets its timer", live.since, r.foreground.shown.last().since)

        r.session.hangUp()
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.HUNG_UP), r.phase)
        assertEquals(listOf("place", "token", "end"), r.api.log)
        assertTrue(r.room.log.contains("disconnect"))
        assertEquals(1, r.foreground.stopped)
        r.session.close()
        runCurrent()
    }

    @Test
    fun aVoiceCallStartsOnTheEarpieceAndAVideoCallOnTheSpeaker() = runTest {
        val voice = Rig(this)
        voice.session.place(peer, CallKind.Audio)
        runCurrent()
        voice.update(CallState.Active)
        runCurrent()
        assertEquals(false, voice.room.speaker)
        assertEquals(false, voice.room.wantedVideo)
        voice.session.close()

        val video = Rig(this)
        video.session.place(peer, CallKind.Video)
        runCurrent()
        video.update(CallState.Active)
        runCurrent()
        assertEquals(true, video.room.speaker)
        assertEquals(true, video.room.wantedVideo)
        video.session.close()
        runCurrent()
    }

    @Test
    fun aRingingCallMakesNoPollWhileTheSocketIsUp() = runTest {
        val r = Rig(this, connected = true)
        r.session.place(peer, CallKind.Audio)
        runCurrent()
        advanceTimeBy(40_000)
        runCurrent()
        assertEquals("only the create", listOf("place"), r.api.log)
        r.update(CallState.Active)
        runCurrent()
        r.room.emitted.tryEmit(CallRoom.Event.PeerPresence(true))
        runCurrent()
        advanceTimeBy(10 * 60_000)
        runCurrent()
        assertEquals("and nothing on a timer once live", listOf("place", "token"), r.api.log)
        r.session.close()
        runCurrent()
    }

    @Test
    fun withTheSocketDownTheCallIsReadEvery3sRingingAndEvery15sAnswered() = runTest {
        val r = Rig(this, connected = false)
        r.session.place(peer, CallKind.Audio)
        runCurrent()
        advanceTimeBy(9_100)
        runCurrent()
        assertEquals(3, r.api.count("get"))
        // The read finds it answered.
        r.api.get = { id -> testCall(id = id, state = CallState.Active) }
        advanceTimeBy(3_000)
        runCurrent()
        assertEquals(4, r.api.count("get"))
        assertTrue(r.phase is CallPhase.Live)
        advanceTimeBy(30_100)
        runCurrent()
        assertEquals("every 15 s once answered", 6, r.api.count("get"))
        r.session.close()
        runCurrent()
    }

    @Test
    fun theSocketComingBackIsReadOnceThenNothing() = runTest {
        val r = Rig(this, connected = false)
        r.session.place(peer, CallKind.Audio)
        runCurrent()
        advanceTimeBy(1_000)
        r.signals.setRealtimeConnected(true)
        runCurrent()
        assertEquals("one read for what the socket missed", 1, r.api.count("get"))
        advanceTimeBy(30_000)
        runCurrent()
        assertEquals(1, r.api.count("get"))
        r.session.close()
        runCurrent()
    }

    @Test
    fun declinedAndUnansweredCallsEndWithoutTellingTheServerAgain() = runTest {
        val declined = Rig(this)
        declined.session.place(peer, CallKind.Audio)
        runCurrent()
        declined.update(CallState.Ended, outcome = CallOutcome.Declined)
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.DECLINED), declined.phase)
        assertEquals(listOf("place"), declined.api.log)
        assertFalse(declined.ringback.playing)
        declined.session.close()

        val missed = Rig(this)
        missed.session.place(peer, CallKind.Audio)
        runCurrent()
        missed.update(CallState.Missed, outcome = CallOutcome.Missed)
        runCurrent()
        assertEquals("a busy callee looks exactly like this", CallPhase.Ended(CallEnd.NO_ANSWER), missed.phase)
        missed.session.close()
        runCurrent()
    }

    @Test
    fun aRingTheServerNeverEndsTimesOutOnThePhoneAndIsCancelled() = runTest {
        val r = Rig(this, connected = true)
        r.session.place(peer, CallKind.Audio)
        runCurrent()
        advanceTimeBy(59_000)
        runCurrent()
        assertEquals(CallPhase.Placing, r.phase)
        advanceTimeBy(1_500)
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.NO_ANSWER), r.phase)
        assertEquals("the phone withdraws it", listOf("place", "end"), r.api.log)
        r.session.close()
        runCurrent()
    }

    @Test
    fun refusalsSayWhyAndSendNothingMore() = runTest {
        val cases = listOf(
            http(403, "calls_not_allowed", "reason" to "consent") to CallEnd.NOT_ALLOWED,
            http(403, "calls_not_allowed", "reason" to "disabled") to CallEnd.CALLS_OFF,
            http(403, "calls_not_allowed", "reason" to "plan") to CallEnd.NEEDS_PLAN,
            http(409, "caller_busy") to CallEnd.CALLER_BUSY,
            http(404, "not_found") to CallEnd.UNAVAILABLE,
            http(422, "limit_reached") to CallEnd.LIMIT_REACHED,
            http(429, "rate_limited") to CallEnd.RATE_LIMITED,
            offline() to CallEnd.OFFLINE,
            http(500, "internal") to CallEnd.FAILED,
        )
        for ((error, end) in cases) {
            val r = Rig(this)
            r.api.place = { _, _ -> throw error }
            r.session.place(peer, CallKind.Audio)
            runCurrent()
            assertEquals(end, (r.phase as CallPhase.Ended).end)
            assertEquals(listOf("place"), r.api.log)
            assertFalse(r.ringback.playing)
            assertTrue("no service for a call that never rang", r.foreground.shown.isEmpty())
            r.session.close()
            runCurrent()
        }
    }

    @Test
    fun aHangUpWhileTheCreateIsOnItsWayWithdrawsTheCallWhenItLands() = runTest {
        val r = Rig(this)
        val gate = CompletableDeferred<Unit>()
        r.api.place = { conversation, kind ->
            gate.await()
            testCall(conversationId = conversation, kind = kind)
        }
        r.session.place(peer, CallKind.Audio)
        runCurrent()
        r.session.hangUp()
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.HUNG_UP), r.phase)
        gate.complete(Unit)
        runCurrent()
        assertEquals("nobody is left ringing", listOf("place", "end"), r.api.log)
        assertFalse(r.ringback.playing)
        r.session.close()
        runCurrent()
    }

    @Test
    fun anAnswerThatBeatsTheCreatesOwnReplyIsNotLost() = runTest {
        val r = Rig(this)
        val gate = CompletableDeferred<Unit>()
        r.api.place = { conversation, kind ->
            gate.await()
            testCall(conversationId = conversation, kind = kind)
        }
        r.session.place(peer, CallKind.Audio)
        runCurrent()
        r.update(CallState.Connecting)
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("place", "token"), r.api.log)
        assertEquals(CallPhase.Connecting, r.phase)
        r.session.close()
        runCurrent()
    }

    @Test
    fun aLateRingingNeverTakesAnAnsweredCallBack() = runTest {
        val r = Rig(this)
        r.session.place(peer, CallKind.Audio)
        runCurrent()
        r.update(CallState.Active)
        r.room.peerHere = true
        runCurrent()
        assertTrue(r.phase is CallPhase.Live)
        r.update(CallState.Ringing, rangAt = 500)
        runCurrent()
        assertTrue(r.phase is CallPhase.Live)
        r.session.close()
        runCurrent()
    }

    @Test
    fun theRelayAndItsPolicyComeFromTheTokenAndAMissingRelayIsSaid() = runTest {
        val r = Rig(this)
        r.api.token = { testToken(turn = true, warnings = listOf("turn_missing")) }
        r.session.place(peer, CallKind.Audio)
        runCurrent()
        r.update(CallState.Connecting)
        runCurrent()
        val joined = r.room.joined!!
        assertEquals("wss://rtc.example.test", joined.wsUrl)
        assertEquals(listOf("turns:relay.example.test:443"), joined.turn?.urls)
        assertEquals(app.core.model.IcePolicy.Relay, joined.icePolicy)
        assertTrue(r.session.relayWarning.value)
        r.session.close()
        runCurrent()
    }

    @Test
    fun answeredButNeverTogetherFailsAfter30s() = runTest {
        val r = Rig(this)
        r.session.place(peer, CallKind.Audio)
        runCurrent()
        r.update(CallState.Connecting)
        runCurrent()
        advanceTimeBy(30_500)
        runCurrent()
        assertEquals(CallEnd.FAILED, (r.phase as CallPhase.Ended).end)
        assertEquals("end", r.api.log.last())
        r.session.close()
        runCurrent()
    }

    // MARK: - Incoming

    @Test
    fun incomingRingReportsRangThenTheAcceptsTokenJoinsTheRoom() = runTest {
        val r = Rig(this)
        r.session.ring("9001", peer, CallKind.Video, expiresAt = at(45_000))
        runCurrent()
        assertEquals(CallPhase.Ringing, r.phase)
        assertEquals(listOf("9001"), r.rang)
        assertTrue("nothing sent until Answer or Decline", r.api.log.isEmpty())
        assertTrue("the ring is the notification's, not the service's", r.foreground.shown.isEmpty())

        r.room.peerHere = true
        r.session.answer()
        runCurrent()
        assertEquals("the accept carries the token: no second request", listOf("accept"), r.api.log)
        assertTrue(r.phase is CallPhase.Live)
        assertEquals(true, r.room.wantedVideo)
        r.session.close()
        runCurrent()
    }

    @Test
    fun answeringAVideoCallWithVoiceOnlyKeepsTheCameraOff() = runTest {
        val r = Rig(this)
        r.session.ring("9001", peer, CallKind.Video, expiresAt = at(45_000))
        runCurrent()
        r.session.answer(withVideo = false)
        runCurrent()
        assertEquals(false, r.room.wantedVideo)
        assertFalse(r.session.cameraOn.value)
        r.session.close()
        runCurrent()
    }

    @Test
    fun aRingAnsweredOnAnotherPhoneEndsHereWithoutARequest() = runTest {
        val r = Rig(this)
        r.session.ring("9001", peer, CallKind.Audio, expiresAt = at(45_000))
        runCurrent()
        r.update(CallState.Connecting, role = CallRole.Callee)
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.ANSWERED_ELSEWHERE), r.phase)
        assertTrue(r.api.log.isEmpty())
        r.session.close()
        runCurrent()
    }

    @Test
    fun theSocketsConnectingForThisPhonesOwnAcceptIsNotAnswerElsewhere() = runTest {
        val r = Rig(this)
        val gate = CompletableDeferred<Unit>()
        r.api.accept = { id ->
            gate.await()
            CallAcceptance(testCall(id = id, role = CallRole.Callee, state = CallState.Connecting), testToken())
        }
        r.session.ring("9001", peer, CallKind.Audio, expiresAt = at(45_000))
        runCurrent()
        r.session.answer()
        runCurrent()
        r.update(CallState.Connecting, role = CallRole.Callee)
        runCurrent()
        assertEquals(CallPhase.Connecting, r.phase)
        gate.complete(Unit)
        runCurrent()
        assertEquals("joined", "connect", r.room.log.first())
        r.session.close()
        runCurrent()
    }

    @Test
    fun ringStopsFromPushEndTheRingScreen() = runTest {
        for ((reason, end) in listOf(
            RingStopReason.CANCELLED to CallEnd.CANCELLED,
            RingStopReason.MISSED to CallEnd.MISSED,
            RingStopReason.ANSWERED_ELSEWHERE to CallEnd.ANSWERED_ELSEWHERE,
            RingStopReason.DECLINED to CallEnd.DECLINED_ELSEWHERE,
        )) {
            val r = Rig(this)
            r.session.ring("9001", peer, CallKind.Audio, expiresAt = at(45_000))
            runCurrent()
            r.signals.ringStopped("9001", reason)
            runCurrent()
            assertEquals(CallPhase.Ended(end), r.phase)
            assertTrue(r.api.log.isEmpty())
            r.session.close()
            runCurrent()
        }
    }

    @Test
    fun aStopForAnotherCallChangesNothing() = runTest {
        val r = Rig(this)
        r.session.ring("9001", peer, CallKind.Audio, expiresAt = at(45_000))
        runCurrent()
        r.signals.ringStopped("9999", RingStopReason.CANCELLED)
        r.update(CallState.Ended, role = CallRole.Callee, outcome = CallOutcome.Cancelled, id = "9999")
        runCurrent()
        assertEquals(CallPhase.Ringing, r.phase)
        r.session.close()
        runCurrent()
    }

    @Test
    fun anUnansweredRingMissesOnThePhonesOwnDeadlineWithNoRequest() = runTest {
        val r = Rig(this)
        r.session.ring("9001", peer, CallKind.Audio, expiresAt = at(45_000))
        runCurrent()
        advanceTimeBy(60_500)
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.MISSED), r.phase)
        assertTrue(r.api.log.isEmpty())
        r.session.close()
        runCurrent()
    }

    @Test
    fun theAcceptLosingToAnotherPhoneSaysSo() = runTest {
        val r = Rig(this)
        r.api.accept = { throw http(409, "answered_elsewhere") }
        r.session.ring("9001", peer, CallKind.Audio, expiresAt = at(45_000))
        runCurrent()
        r.session.answer()
        runCurrent()
        assertEquals(CallEnd.ANSWERED_ELSEWHERE, (r.phase as CallPhase.Ended).end)
        assertEquals(listOf("accept"), r.api.log)
        r.session.close()
        runCurrent()
    }

    @Test
    fun anAcceptTooLateForACancelledCallSaysItWasCancelled() = runTest {
        val r = Rig(this)
        r.api.accept = { throw http(409, "not_ringing") }
        r.api.get = { id -> testCall(id = id, role = CallRole.Callee, state = CallState.Cancelled, outcome = CallOutcome.Cancelled) }
        r.session.ring("9001", peer, CallKind.Audio, expiresAt = at(45_000))
        runCurrent()
        r.session.answer()
        runCurrent()
        assertEquals(CallEnd.CANCELLED, (r.phase as CallPhase.Ended).end)
        assertEquals(listOf("accept", "get"), r.api.log)
        r.session.close()
        runCurrent()
    }

    @Test
    fun declineIsSentForARingNeverAnsweredHere() = runTest {
        val r = Rig(this)
        r.session.ring("9001", peer, CallKind.Audio, expiresAt = at(45_000))
        runCurrent()
        r.session.hangUp()
        runCurrent()
        assertEquals("a decline, never an end (which would end a call another phone answered)", listOf("decline"), r.api.log)
        r.session.close()
        runCurrent()
    }

    @Test
    fun aHangUpWhileTheAcceptIsInFlightWaitsForItAndEndsTheCallItMade() = runTest {
        val r = Rig(this)
        val gate = CompletableDeferred<Unit>()
        r.api.accept = { id ->
            gate.await()
            CallAcceptance(testCall(id = id, role = CallRole.Callee, state = CallState.Connecting), testToken())
        }
        r.session.ring("9001", peer, CallKind.Audio, expiresAt = at(45_000))
        runCurrent()
        r.session.answer()
        runCurrent()
        r.session.hangUp()
        runCurrent()
        assertEquals(listOf("accept"), r.api.log)
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("accept", "end"), r.api.log)
        assertTrue("never joined after the hang-up", r.room.joined == null)
        r.session.close()
        runCurrent()
    }

    // MARK: - In the room

    private fun TestScope.liveRig(): Rig {
        val r = Rig(this)
        r.session.place(peer, CallKind.Audio)
        runCurrent()
        r.update(CallState.Active)
        r.room.peerHere = true
        runCurrent()
        assertTrue(r.phase is CallPhase.Live)
        return r
    }

    @Test
    fun reconnectingIsShownAndReconnectedCarriesOn() = runTest {
        val r = liveRig()
        r.room.emitted.tryEmit(CallRoom.Event.Reconnecting)
        runCurrent()
        assertTrue((r.phase as CallPhase.Live).reconnecting)
        r.room.emitted.tryEmit(CallRoom.Event.Reconnected)
        runCurrent()
        assertFalse((r.phase as CallPhase.Live).reconnecting)
        assertFalse(r.api.log.contains("end"))
        r.session.close()
        runCurrent()
    }

    @Test
    fun aRoomLostForGoodIsACallDroppedAndTheServerIsTold() = runTest {
        val r = liveRig()
        r.room.emitted.tryEmit(CallRoom.Event.Reconnecting)
        runCurrent()
        r.room.emitted.tryEmit(CallRoom.Event.Disconnected(byServer = false))
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.CONNECTION_LOST), r.phase)
        assertEquals("end", r.api.log.last())
        r.session.close()
        runCurrent()
    }

    @Test
    fun reconnectingForTooLongDropsTheCall() = runTest {
        val r = liveRig()
        r.room.emitted.tryEmit(CallRoom.Event.Reconnecting)
        runCurrent()
        advanceTimeBy(45_500)
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.CONNECTION_LOST), r.phase)
        r.session.close()
        runCurrent()
    }

    @Test
    fun theOtherPersonDroppingOutWaitsForThemThenEnds() = runTest {
        val r = liveRig()
        r.room.emitted.tryEmit(CallRoom.Event.PeerPresence(false))
        runCurrent()
        assertTrue((r.phase as CallPhase.Live).peerAway)
        assertEquals("the socket is up: no read", 0, r.api.count("get"))
        r.room.emitted.tryEmit(CallRoom.Event.PeerPresence(true))
        runCurrent()
        assertFalse((r.phase as CallPhase.Live).peerAway)
        r.room.emitted.tryEmit(CallRoom.Event.PeerPresence(false))
        runCurrent()
        advanceTimeBy(30_500)
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.PEER_ENDED), r.phase)
        r.session.close()
        runCurrent()
    }

    @Test
    fun theServerSayingTheyHungUpEndsAtOnce() = runTest {
        val r = liveRig()
        r.update(CallState.Ended, outcome = CallOutcome.Completed)
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.PEER_ENDED), r.phase)
        assertFalse(r.api.log.contains("end"))
        r.session.close()
        runCurrent()
    }

    @Test
    fun aMicrophoneThatWillNotStartShowsMutedAndSaysWhy() = runTest {
        val r = Rig(this)
        r.room.joinResult = CallRoom.Result.Joined(microphone = false, camera = false)
        r.session.place(peer, CallKind.Audio)
        runCurrent()
        r.update(CallState.Active)
        runCurrent()
        assertTrue(r.session.muted.value)
        assertEquals(CallDegradation.NO_MICROPHONE, r.session.degraded.value)
        r.session.close()
        runCurrent()
    }

    @Test
    fun aCellularCallTakingTheAudioHoldsTheMicrophoneUntilItEnds() = runTest {
        val r = liveRig()
        r.room.emitted.tryEmit(CallRoom.Event.AudioFocus(held = false))
        runCurrent()
        assertTrue(r.session.onHold.value)
        assertEquals(false, r.room.microphone)
        r.room.emitted.tryEmit(CallRoom.Event.AudioFocus(held = true))
        runCurrent()
        assertFalse(r.session.onHold.value)
        assertEquals(true, r.room.microphone)
        r.session.close()
        runCurrent()
    }

    @Test
    fun mutedBeforeTheAnswerJoinsMuted() = runTest {
        val r = Rig(this)
        r.session.place(peer, CallKind.Audio)
        runCurrent()
        r.session.toggleMute()
        r.update(CallState.Active)
        runCurrent()
        assertEquals(false, r.room.microphone)
        assertTrue(r.session.muted.value)
        r.session.close()
        runCurrent()
    }

    @Test
    fun withoutTheMicrophoneNobodyIsRung() = runTest {
        val r = Rig(this)
        r.session.refuseWithoutMicrophone(peer, CallKind.Audio)
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.NO_MICROPHONE), r.phase)
        assertTrue(r.api.log.isEmpty())
        r.session.close()
        runCurrent()
    }

    @Test
    fun closingALiveCallHangsItUpAndReleasesTheRoom() = runTest {
        val r = liveRig()
        r.session.close()
        runCurrent()
        assertEquals("end", r.api.log.last())
        assertTrue(r.room.released)
        assertNull(r.foreground.shown.lastOrNull()?.takeIf { r.foreground.stopped == 0 })
    }
}
