package app.core.feature.call

import android.content.pm.ServiceInfo
import app.core.model.CallKind
import app.core.model.CallOutcome
import app.core.model.CallRole
import app.core.model.CallState
import app.core.push.RingStopReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** How the server's call states read on each side, the permissions a call asks for, and the service's types. */
class CallRulesTest {

    @Test
    fun theServersStatesReadForEachSide() {
        fun end(state: CallState, role: CallRole, outcome: CallOutcome? = null, answeredHere: Boolean = false) =
            CallEnd.resolve(testCall(role = role, state = state, outcome = outcome), answeredHere)
        assertNull(end(CallState.Ringing, CallRole.Caller))
        assertNull(end(CallState.Active, CallRole.Caller))
        assertNull(end(CallState.Connecting, CallRole.Callee, answeredHere = true))
        assertEquals(CallEnd.ANSWERED_ELSEWHERE, end(CallState.Connecting, CallRole.Callee))
        assertEquals(CallEnd.NO_ANSWER, end(CallState.Missed, CallRole.Caller))
        assertEquals(CallEnd.MISSED, end(CallState.Missed, CallRole.Callee))
        assertEquals(CallEnd.CANCELLED, end(CallState.Cancelled, CallRole.Callee))
        assertEquals(CallEnd.DECLINED, end(CallState.Ended, CallRole.Caller, CallOutcome.Declined))
        assertEquals(CallEnd.DECLINED_ELSEWHERE, end(CallState.Ended, CallRole.Callee, CallOutcome.Declined))
        assertEquals(CallEnd.PEER_ENDED, end(CallState.Ended, CallRole.Callee, CallOutcome.Completed))
        assertEquals(CallEnd.FAILED, end(CallState.Ended, CallRole.Caller, CallOutcome.Failed))
        assertNull("a state this build does not know degrades to 'still on'", end(CallState.Unknown, CallRole.Caller))
    }

    @Test
    fun ringStopsReadAsEnds() {
        assertEquals(CallEnd.CANCELLED, CallEnd.of(RingStopReason.CANCELLED))
        assertEquals(CallEnd.MISSED, CallEnd.of(RingStopReason.MISSED))
        assertEquals(CallEnd.ANSWERED_ELSEWHERE, CallEnd.of(RingStopReason.ANSWERED_ELSEWHERE))
        assertEquals(CallEnd.DECLINED_ELSEWHERE, CallEnd.of(RingStopReason.DECLINED))
        assertEquals(CallEnd.PEER_ENDED, CallEnd.of(RingStopReason.ENDED))
    }

    @Test
    fun aCallAsksForTheMicrophoneTheCameraWhenItWillBeUsedAndBluetoothFromAndroid12() {
        assertEquals(listOf(CallPermissions.MICROPHONE), CallPermissions.needed(CallKind.Audio, withVideo = true, sdk = 30))
        assertEquals(listOf(CallPermissions.MICROPHONE, CallPermissions.BLUETOOTH), CallPermissions.needed(CallKind.Audio, withVideo = true, sdk = 31))
        assertEquals(
            listOf(CallPermissions.MICROPHONE, CallPermissions.CAMERA, CallPermissions.BLUETOOTH),
            CallPermissions.needed(CallKind.Video, withVideo = true, sdk = 34),
        )
        assertEquals("voice only asks for no camera", listOf(CallPermissions.MICROPHONE, CallPermissions.BLUETOOTH), CallPermissions.needed(CallKind.Video, withVideo = false, sdk = 34))
    }

    @Test
    fun whatIsAlreadyGrantedIsNotAskedAndTheDialogsAnswersWin() {
        val granted = setOf(CallPermissions.MICROPHONE)
        val needed = CallPermissions.needed(CallKind.Video, withVideo = true, sdk = 34)
        assertEquals(listOf(CallPermissions.CAMERA, CallPermissions.BLUETOOTH), CallPermissions.missing(needed) { it in granted })
        val got = CallPermissions.outcome(mapOf(CallPermissions.CAMERA to false, CallPermissions.BLUETOOTH to true)) { it in granted }
        assertTrue(got.microphone)
        assertFalse(got.camera)
        assertTrue(got.bluetooth)
    }

    @Test
    fun theServiceIsTypedForWhatIsGranted() {
        val mic = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        val camera = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        assertEquals(0, OngoingCallTypes.of(sdk = 28, video = true, microphoneGranted = true, cameraGranted = true))
        assertEquals(mic, OngoingCallTypes.of(sdk = 34, video = false, microphoneGranted = true, cameraGranted = true))
        assertEquals(mic or camera, OngoingCallTypes.of(sdk = 34, video = true, microphoneGranted = true, cameraGranted = true))
        assertEquals("a refused camera leaves a voice-only service", mic, OngoingCallTypes.of(sdk = 34, video = true, microphoneGranted = true, cameraGranted = false))
        assertEquals(OngoingCallTypes.NONE, OngoingCallTypes.of(sdk = 34, video = false, microphoneGranted = false, cameraGranted = false))
    }

    @Test
    fun durationsAreWrittenInTheReadersDigits() {
        assertEquals("0:05", callDuration(5, app.core.i18n.AppLanguage.EN))
        assertEquals("4:05", callDuration(245, app.core.i18n.AppLanguage.TR))
        assertEquals("1:02:03", callDuration(3723, app.core.i18n.AppLanguage.EN))
        assertEquals("۱۲:۳۴", callDuration(754, app.core.i18n.AppLanguage.FA))
    }

    @Test
    fun theCallLineReadsForEachSide() {
        fun line(outcome: CallOutcome, kind: CallKind = CallKind.Audio) =
            app.core.model.CallLine(callId = "1", kind = kind, outcome = outcome, placedAt = at(0), durationSeconds = 245, caller = "me")
        assertEquals(CallLineTitle.VOICE, line(CallOutcome.Completed).title(viewerIsCaller = true))
        assertEquals(CallLineTitle.VIDEO, line(CallOutcome.Completed, CallKind.Video).title(viewerIsCaller = false))
        assertEquals(CallLineTitle.NO_ANSWER, line(CallOutcome.Missed).title(viewerIsCaller = true))
        assertEquals(CallLineTitle.MISSED_VOICE, line(CallOutcome.Missed).title(viewerIsCaller = false))
        assertEquals(CallLineTitle.CANCELLED, line(CallOutcome.Cancelled).title(viewerIsCaller = true))
        assertEquals(CallLineTitle.MISSED_VIDEO, line(CallOutcome.Cancelled, CallKind.Video).title(viewerIsCaller = false))
        assertTrue(line(CallOutcome.Cancelled).isMissedFor(viewerIsCaller = false))
        assertFalse(line(CallOutcome.Cancelled).isMissedFor(viewerIsCaller = true))
        assertEquals("4:05", line(CallOutcome.Completed).length(app.core.i18n.AppLanguage.EN))
        assertNull(line(CallOutcome.Declined).length(app.core.i18n.AppLanguage.EN))
    }
}
