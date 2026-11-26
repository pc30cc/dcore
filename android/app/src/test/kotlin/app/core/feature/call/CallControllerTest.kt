package app.core.feature.call

import app.core.common.Clock
import app.core.model.ConversationPeer
import app.core.model.CallKind
import app.core.model.CallRole
import app.core.model.CallState
import app.core.model.Id
import app.core.model.Photo
import app.core.push.IncomingCallLink
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one call on the phone: asked for, placed after the permissions, rung,
 * answered before any permission dialog, minimised, and closed by itself.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CallControllerTest {

    private class App(scope: TestScope, cachedFace: suspend (Id) -> ConversationPeer? = { null }) {
        val api = ScriptedCallApi()
        val signals = CallSignals().apply { setRealtimeConnected(true) }
        val ringsEnded = mutableListOf<Pair<Id, CallEnd>>()
        /** The runtime permissions this phone holds. */
        val granted = mutableSetOf<String>()
        val rooms = mutableListOf<FakeCallRoom>()
        val dispatcher = StandardTestDispatcher(scope.testScheduler)
        val controller = CallController(
            newSession = { kind ->
                MatchCallSession(
                    api = api,
                    room = FakeCallRoom().also { rooms += it },
                    signals = signals,
                    ringback = SilentRingback,
                    foreground = NoCallForeground,
                    clock = Clock { T0 + scope.testScheduler.currentTime },
                    dispatcher = dispatcher,
                )
            },
            scope = scope.backgroundScope,
            onRingEnded = { id, end -> ringsEnded += id to end },
            cachedFace = cachedFace,
            hasPermission = { it in granted },
        )
    }

    private val peer = CallPeer("500", "Negar")
    private fun link(answer: Boolean = false, callId: String = "9001", kind: CallKind = CallKind.Audio) =
        IncomingCallLink(callId, "500", kind, "Negar", null, answer, at(45_000))

    @Test
    fun theCallButtonWaitsForThePermissionsThenPlaces() = runTest {
        val app = App(this)
        assertTrue(app.controller.requestCall(peer, CallKind.Video))
        assertEquals(CallRequest.Place(peer, CallKind.Video), app.controller.pending.value)
        assertNull("nothing rings before the permissions are answered", app.controller.session.value)
        app.controller.place(peer, CallKind.Video, microphone = true, camera = false)
        runCurrent()
        assertNull(app.controller.pending.value)
        val session = app.controller.session.value!!
        assertFalse("a refused camera places the video call with it off", session.cameraOn.value)
        assertEquals(listOf("place"), app.api.log)
        app.controller.dismiss()
        runCurrent()
    }

    @Test
    fun withoutTheMicrophoneTheScreenSaysWhyAndNothingIsPlaced() = runTest {
        val app = App(this)
        app.controller.requestCall(peer, CallKind.Audio)
        app.controller.place(peer, CallKind.Audio, microphone = false, camera = false)
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.NO_MICROPHONE), app.controller.session.value!!.phase.value)
        assertTrue(app.api.log.isEmpty())
        advanceTimeBy(10_000)
        runCurrent()
        assertTrue("it stays until closed: the person has something to do", app.controller.session.value != null)
        app.controller.dismiss()
        runCurrent()
    }

    @Test
    fun aSecondCallWhileOneIsOnBringsTheFirstBack() = runTest {
        val app = App(this)
        app.controller.place(peer, CallKind.Audio, microphone = true, camera = false)
        runCurrent()
        app.controller.minimise()
        assertTrue(app.controller.minimised.value)
        assertFalse(app.controller.requestCall(CallPeer("501", "Elif"), CallKind.Audio))
        assertFalse(app.controller.minimised.value)
        assertNull(app.controller.pending.value)
        assertFalse("and a ring for another call is not opened over it", app.controller.openRing(link(callId = "9002")))
        app.controller.dismiss()
        runCurrent()
    }

    @Test
    fun theRingsTapOpensOneRingScreenAndItsEndTakesTheRingDown() = runTest {
        val app = App(this)
        assertTrue(app.controller.openRing(link()))
        runCurrent()
        val session = app.controller.session.value!!
        assertTrue(app.controller.openRing(link()))
        assertSame("the same call: the same screen", session, app.controller.session.value)
        app.signals.onRealtimeCall(testCall(role = CallRole.Callee, state = CallState.Missed))
        runCurrent()
        assertEquals(listOf("9001" to CallEnd.MISSED), app.ringsEnded)
        advanceTimeBy(CallController.END_LINGER_MS + 100)
        runCurrent()
        assertNull("a missed call closes by itself", app.controller.session.value)
    }

    @Test
    fun aRingTakesTheFaceTheChatStoredForItsConversation() = runTest {
        val stored = Photo(id = "1", w = 640, h = 800, blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj", url = "https://cdn.example.test/p/1/1/320.webp?sig=a")
        val asked = mutableListOf<Id>()
        val app = App(this, cachedFace = { id -> asked += id; ConversationPeer("bnegar2kq7xm4", "Negar", stored, verified = true).takeIf { id == "500" } })
        // The ring brought a name and no photo.
        assertTrue(app.controller.openRing(link()))
        runCurrent()
        val peer = app.controller.session.value!!.peer.value
        assertEquals(listOf("500"), asked)
        assertEquals(stored.url, peer.photoUrl)
        assertEquals("the blurhash, drawn while the photo loads", stored.blurhash, peer.blurhash)
        assertEquals("Negar", peer.name)
        assertTrue("the verified mark the chat stored", peer.verified)
        app.controller.dismiss()
        runCurrent()
    }

    @Test
    fun aRingWhoseConversationIsNotStoredKeepsWhatItBrought() = runTest {
        val app = App(this, cachedFace = { error("the cache is closed") })
        val withPhoto = IncomingCallLink("9001", "500", CallKind.Audio, "Negar", "https://cdn.example.test/p/2/1/320.webp?sig=b", false, at(45_000))
        assertTrue(app.controller.openRing(withPhoto))
        runCurrent()
        val peer = app.controller.session.value!!.peer.value
        assertEquals(withPhoto.peerPhotoUrl, peer.photoUrl)
        assertNull(peer.blurhash)
        assertEquals("the ring still rings", CallPhase.Ringing, app.controller.session.value!!.phase.value)
        app.controller.dismiss()
        runCurrent()
    }

    @Test
    fun aRingCannotBeMinimisedButAnAnsweredCallCan() = runTest {
        val app = App(this)
        app.controller.openRing(link())
        runCurrent()
        app.controller.minimise()
        assertFalse(app.controller.minimised.value)
        app.controller.requestAnswer(withVideo = true)
        runCurrent()
        app.controller.minimise()
        assertTrue(app.controller.minimised.value)
        app.controller.dismiss()
        runCurrent()
    }

    @Test
    fun endOnTheNotificationHangsUpTheCallOnScreen() = runTest {
        val app = App(this)
        app.controller.place(peer, CallKind.Audio, microphone = true, camera = false)
        runCurrent()
        assertFalse(app.controller.hangUpFromNotification("1234"))
        assertTrue(app.controller.hangUpFromNotification("9001"))
        runCurrent()
        assertEquals(CallPhase.Ended(CallEnd.HUNG_UP), app.controller.session.value?.phase?.value)
        assertEquals(listOf("place", "end"), app.api.log)
        app.controller.dismiss()
        runCurrent()
    }

    @Test
    fun callAgainAfterNoAnswerAsksAfresh() = runTest {
        val app = App(this)
        app.controller.place(peer, CallKind.Audio, microphone = true, camera = false)
        runCurrent()
        app.signals.onRealtimeCall(testCall(state = CallState.Missed))
        runCurrent()
        assertEquals(CallEnd.NO_ANSWER, (app.controller.session.value!!.phase.value as CallPhase.Ended).end)
        app.controller.retry()
        assertNull(app.controller.session.value)
        assertEquals(CallRequest.Place(peer, CallKind.Audio), app.controller.pending.value)
    }

    // MARK: - Answering before the permissions

    @Test
    fun answerSendsTheAcceptAtOnceThenAsksForTheMicrophone() = runTest {
        val app = App(this)
        app.controller.openRing(link())
        runCurrent()
        val grant = app.controller.requestAnswer(withVideo = false)
        runCurrent()
        assertEquals("the accept goes before any dialog", listOf("accept"), app.api.log)
        assertEquals(CallRequest.Grant("9001", listOf(CallPermissions.MICROPHONE)), grant)
        assertEquals(grant, app.controller.pending.value)
        val session = app.controller.session.value!!
        assertTrue("joined muted until the microphone is allowed", session.muted.value)
        assertEquals(MicrophoneAccess.ASKING, session.microphone.value)
        assertEquals("nothing is published that may not record", false, app.rooms.last().wantedMicrophone)
        app.controller.dismiss()
        runCurrent()
    }

    @Test
    fun aDialogLeftOpenPastTheRingsEndDoesNotMissAnAnsweredCall() = runTest {
        val app = App(this)
        app.controller.openRing(link())
        runCurrent()
        advanceTimeBy(40_000)
        runCurrent()
        val grant = app.controller.requestAnswer(withVideo = false)!!
        runCurrent()
        app.signals.onRealtimeCall(testCall(role = CallRole.Callee, state = CallState.Active))
        runCurrent()
        // Past the ring's own end and the server's expiry, with the dialog still up.
        advanceTimeBy(30_000)
        runCurrent()
        val session = app.controller.session.value!!
        assertTrue("${session.phase.value}", session.phase.value is CallPhase.Live)
        assertTrue(app.ringsEnded.none { it.second == CallEnd.MISSED })

        app.controller.permissionsAnswered(grant, mapOf(CallPermissions.MICROPHONE to true))
        runCurrent()
        assertNull(app.controller.pending.value)
        assertFalse("allowed: the call unmutes", session.muted.value)
        assertEquals(MicrophoneAccess.GRANTED, session.microphone.value)
        assertEquals(true, app.rooms.last().microphone)
        app.controller.dismiss()
        runCurrent()
    }

    @Test
    fun everythingAllowedAsksNothing() = runTest {
        val app = App(this)
        app.granted += CallPermissions.MICROPHONE
        app.controller.openRing(link())
        runCurrent()
        assertNull(app.controller.requestAnswer(withVideo = false))
        runCurrent()
        assertNull(app.controller.pending.value)
        assertEquals(listOf("accept"), app.api.log)
        assertFalse(app.controller.session.value!!.muted.value)
        assertEquals(true, app.rooms.last().wantedMicrophone)
        app.controller.dismiss()
        runCurrent()
    }

    @Test
    fun voiceOnlyOnAVideoCallNeverAsksForTheCamera() = runTest {
        val nothing = App(this)
        nothing.controller.openRing(link(kind = CallKind.Video))
        runCurrent()
        assertEquals(CallRequest.Grant("9001", listOf(CallPermissions.MICROPHONE)), nothing.controller.requestAnswer(withVideo = false))
        runCurrent()
        nothing.controller.dismiss()
        runCurrent()

        val microphone = App(this)
        microphone.granted += CallPermissions.MICROPHONE
        microphone.controller.openRing(link(kind = CallKind.Video))
        runCurrent()
        assertNull(microphone.controller.requestAnswer(withVideo = false))
        runCurrent()
        assertEquals(false, microphone.rooms.last().wantedVideo)
        microphone.controller.dismiss()
        runCurrent()
    }

    @Test
    fun aVideoAnswerAsksForTheCameraWhileItConnects() = runTest {
        val app = App(this)
        app.granted += CallPermissions.MICROPHONE
        app.controller.openRing(link(kind = CallKind.Video))
        runCurrent()
        val grant = app.controller.requestAnswer(withVideo = true)!!
        runCurrent()
        assertEquals(CallRequest.Grant("9001", listOf(CallPermissions.CAMERA)), grant)
        assertEquals(listOf("accept"), app.api.log)
        val session = app.controller.session.value!!
        assertFalse("the camera waits for its permission", session.cameraOn.value)
        assertEquals(false, app.rooms.last().wantedVideo)

        app.controller.permissionsAnswered(grant, mapOf(CallPermissions.CAMERA to true))
        runCurrent()
        assertTrue(session.cameraOn.value)
        assertTrue(app.rooms.last().log.contains("camera:true"))
        app.controller.dismiss()
        runCurrent()
    }

    @Test
    fun aRefusedMicrophoneKeepsTheCallUpAndSaysSo() = runTest {
        val app = App(this)
        app.controller.openRing(link())
        runCurrent()
        val grant = app.controller.requestAnswer(withVideo = false)!!
        runCurrent()
        app.controller.permissionsAnswered(grant, mapOf(CallPermissions.MICROPHONE to false))
        runCurrent()
        val session = app.controller.session.value!!
        assertFalse(session.phase.value.isOver)
        assertEquals(CallDegradation.MICROPHONE_REFUSED, session.degraded.value)
        assertEquals(MicrophoneAccess.REFUSED, session.microphone.value)
        // The picture-in-picture window's mute cannot ask: it changes nothing rather than show a silent live microphone.
        session.toggleMute()
        runCurrent()
        assertTrue(session.muted.value)
        assertFalse(app.rooms.last().log.contains("mic:true"))
        app.controller.dismiss()
        runCurrent()
    }
}
