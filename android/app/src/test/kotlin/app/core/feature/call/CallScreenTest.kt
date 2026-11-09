package app.core.feature.call

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.media.LocalRemoteImages
import app.core.model.CallKind
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Every state of the call screen, drawn from a state alone (no room, no server), on a phone-sized screen. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class CallScreenTest {

    @get:Rule val compose = createComposeRule()

    private class Recorder : CallScreenActions {
        val calls = mutableListOf<String>()
        override fun answer() { calls += "answer" }
        override fun answerVoiceOnly() { calls += "answerVoiceOnly" }
        override fun decline() { calls += "decline" }
        override fun hangUp() { calls += "hangUp" }
        override fun toggleMute() { calls += "mute" }
        override fun toggleCamera() { calls += "camera" }
        override fun switchCamera() { calls += "flip" }
        override fun toggleSpeaker() { calls += "speaker" }
        override fun selectRoute(route: AudioRoute) { calls += "route:$route" }
        override fun minimise() { calls += "minimise" }
        override fun done() { calls += "done" }
        override fun retry() { calls += "retry" }
        override fun openSettings() { calls += "settings" }
    }

    private val actions = Recorder()
    private val negar = CallPeer("500", "Negar", photoUrl = "https://cdn.example.test/p/1/1/320.webp")

    private fun state(phase: CallPhase, incoming: Boolean = false, kind: CallKind = CallKind.Audio) =
        CallScreenState(phase = phase, incoming = incoming, kind = kind, peer = negar, cameraOn = kind == CallKind.Video, speakerOn = kind == CallKind.Video)

    private fun show(state: CallScreenState) {
        compose.setContent { Screen(state) }
    }

    @Composable
    private fun Screen(state: CallScreenState) {
        AppTheme(dark = false) {
            CompositionLocalProvider(LocalRemoteImages provides false) {
                CallScreen(state, actions, now = { at(65_000) })
            }
        }
    }

    private fun status() = compose.onNodeWithTag(CallTags.STATUS, useUnmergedTree = true)

    @Test
    fun theRingDrawsTheBlurhashOnceItIsKnownAndTheSilhouetteOnlyBefore() {
        var peer by mutableStateOf(CallPeer("500", "Negar"))
        compose.setContent { Screen(state(CallPhase.Ringing, incoming = true).copy(peer = peer)) }
        // Nothing known of the face yet: the silhouette (never a letter).
        compose.onNodeWithTag(CallTags.FACE_SILHOUETTE, useUnmergedTree = true).assertExists()
        compose.onNodeWithTag(CallTags.FACE_BLURHASH, useUnmergedTree = true).assertDoesNotExist()
        // The stored conversation's photo arrives: its blurhash at once, no silhouette.
        peer = peer.withCachedFace("https://cdn.example.test/p/1/1/320.webp?sig=a", "LEHV6nWB2yk8pyo0adR*.7kCMdnj")
        compose.onNodeWithTag(CallTags.FACE_BLURHASH, useUnmergedTree = true).assertExists()
        compose.onNodeWithTag(CallTags.FACE_SILHOUETTE, useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    fun withRemoteImagesThePhotoIsDrawnOverItsBlurhash() {
        val face = negar.copy(blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj")
        compose.setContent {
            AppTheme(dark = true) {
                CallScreen(state(CallPhase.Ringing, incoming = true).copy(peer = face), actions, now = { at(65_000) })
            }
        }
        compose.onNodeWithTag(CallTags.FACE_BLURHASH, useUnmergedTree = true).assertExists()
        compose.onNodeWithTag(CallTags.FACE_PHOTO, useUnmergedTree = true).assertExists()
        compose.onNodeWithTag(CallTags.FACE_SILHOUETTE, useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    fun anIncomingVoiceCallShowsWhoAndAnswerAndDecline() {
        show(state(CallPhase.Ringing, incoming = true))
        compose.onNodeWithText("Negar").assertIsDisplayed()
        status().assertTextEquals("Incoming voice call")
        compose.onNodeWithContentDescription("Answer").performClick()
        compose.onNodeWithContentDescription("Decline").performClick()
        assertEquals(listOf("answer", "decline"), actions.calls)
        // Ringing here: nothing to minimise, no in-call controls yet.
        compose.onAllNodesWithTag(CallTags.MINIMISE).assertCountEquals(0)
        compose.onAllNodesWithTag(CallTags.MUTE).assertCountEquals(0)
    }

    @Test
    fun anIncomingVideoCallCanBeAnsweredWithVoiceOnly() {
        show(state(CallPhase.Ringing, incoming = true, kind = CallKind.Video))
        status().assertTextEquals("Incoming video call")
        compose.onNodeWithContentDescription("Answer with voice only").performClick()
        compose.onNodeWithContentDescription("Answer with video").performClick()
        assertEquals(listOf("answerVoiceOnly", "answer"), actions.calls)
    }

    @Test
    fun anOutgoingCallSaysCallingThenRinging() {
        show(state(CallPhase.Placing))
        status().assertTextEquals("Calling…")
        compose.onNodeWithContentDescription("End call").performClick()
        assertEquals(listOf("hangUp"), actions.calls)
        compose.onNodeWithTag(CallTags.MINIMISE).performClick()
        assertEquals("minimise", actions.calls.last())
    }

    @Test
    fun ringingOutAndConnecting() {
        show(state(CallPhase.Ringing))
        status().assertTextEquals("Ringing…")
    }

    @Test
    fun connectingSaysSo() {
        show(state(CallPhase.Connecting))
        status().assertTextEquals("Connecting…")
    }

    @Test
    fun aLiveCallShowsItsTimerAndTheControls() {
        show(state(CallPhase.Live(since = at(0))))
        status().assertTextEquals("1:05")
        compose.onNodeWithContentDescription("Mute").performClick()
        compose.onNodeWithContentDescription("Speaker").performClick()
        assertEquals(listOf("mute", "speaker"), actions.calls)
    }

    @Test
    fun mutedAndSpeakerAreSaidAsToggles() {
        show(state(CallPhase.Live(since = at(0))).copy(muted = true, speakerOn = true))
        compose.onNodeWithContentDescription("Unmute").assertIsSelected()
        compose.onNodeWithContentDescription("Speaker").assertIsSelected()
    }

    @Test
    fun aVideoCallHasCameraAndFlipButNoSpeakerSwitch() {
        show(state(CallPhase.Live(since = at(0)), kind = CallKind.Video))
        compose.onNodeWithContentDescription("Turn camera off").performClick()
        compose.onNodeWithContentDescription("Switch camera").performClick()
        compose.onAllNodesWithTag(CallTags.SPEAKER).assertCountEquals(0)
        assertEquals(listOf("camera", "flip"), actions.calls)
    }

    @Test
    fun cameraControlsWaitForTheAnswer() {
        show(state(CallPhase.Placing, kind = CallKind.Video))
        compose.onNodeWithContentDescription("Turn camera off").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Switch camera").assertIsNotEnabled()
    }

    @Test
    fun reconnectingAndAWeakLinkAreShown() {
        show(state(CallPhase.Live(since = at(0), reconnecting = true)))
        status().assertTextEquals("Reconnecting…")
    }

    @Test
    fun theOtherPersonDroppingOutIsShown() {
        show(state(CallPhase.Live(since = at(0), peerAway = true)))
        status().assertTextEquals("Waiting for ⁨Negar⁩ to reconnect…")
    }

    @Test
    fun noticesForAWeakLinkHoldRelayAndDegradation() {
        show(
            state(CallPhase.Live(since = at(0))).copy(
                weakNetwork = true,
                onHold = true,
                relayWarning = true,
                degraded = CallDegradation.NO_CAMERA,
            ),
        )
        compose.onNodeWithText("Weak connection").assertIsDisplayed()
        compose.onNodeWithText("On hold while another call uses the audio").assertIsDisplayed()
        compose.onNodeWithText("Your camera couldn't start. The call goes on as voice.").assertExists()
        compose.onNodeWithText("Your network may block calls. If it doesn't connect, try another network.").assertExists()
        compose.onNodeWithContentDescription("Mute").assertIsNotEnabled()
    }

    @Test
    fun aHeadsetTurnsTheSpeakerSwitchIntoARouteChoice() {
        show(state(CallPhase.Live(since = at(0))).copy(routes = AudioRoutes(listOf(AudioRoute.Earpiece, AudioRoute.Speaker, AudioRoute.Bluetooth("Car kit")), AudioRoute.Bluetooth("Car kit"))))
        compose.onAllNodesWithTag(CallTags.SPEAKER).assertCountEquals(0)
        compose.onNodeWithTag(CallTags.AUDIO).performClick()
        compose.onNodeWithTag(CallTags.ROUTES).assertIsDisplayed()
        compose.onNodeWithText("Car kit").assertIsDisplayed()
        compose.onNodeWithText("Speaker").performClick()
        assertEquals(listOf("route:Speaker"), actions.calls)
    }

    @Test
    fun endsSayHowItEndedAndOfferWhatCanBeDone() {
        show(state(CallPhase.Ended(CallEnd.NO_ANSWER)))
        status().assertTextEquals("No answer")
        compose.onNodeWithContentDescription("Call again").performClick()
        compose.onNodeWithContentDescription("Close").performClick()
        assertEquals(listOf("retry", "done"), actions.calls)
    }

    @Test
    fun withoutTheMicrophoneTheScreenPointsToTheSettings() {
        show(state(CallPhase.Ended(CallEnd.NO_MICROPHONE)))
        status().assertTextEquals("Calls need the microphone")
        compose.onNodeWithTag(CallTags.DETAIL, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithContentDescription("Open settings").performClick()
        assertEquals(listOf("settings"), actions.calls)
    }

    @Test
    fun aMissedVideoCallSaysSoAndOffersNoRetryToTheCallee() {
        show(state(CallPhase.Ended(CallEnd.MISSED), incoming = true, kind = CallKind.Video))
        status().assertTextEquals("Missed video call")
        compose.onAllNodesWithTag(CallTags.RETRY).assertCountEquals(0)
    }

    @Test
    fun refusalsHaveTheirOwnWords() {
        val words = mapOf(
            CallEnd.NOT_ALLOWED to "You both need to allow calls first",
            CallEnd.CALLER_BUSY to "You're already on a call",
            CallEnd.OFFLINE to "You're offline",
            CallEnd.ANSWERED_ELSEWHERE to "Answered on another device",
            CallEnd.CONNECTION_LOST to "Call dropped",
        )
        var current = words.keys.first()
        compose.setContent {
            AppTheme(dark = false) {
                CompositionLocalProvider(LocalRemoteImages provides false) {
                    CallScreen(state(CallPhase.Ended(current)), actions)
                }
            }
        }
        status().assertTextEquals(words.getValue(current))
    }

    @Test
    fun theStatusLineIsALiveRegionButTheTimerIsNot() {
        show(state(CallPhase.Placing))
        status().assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.LiveRegion))
    }

    @Test
    fun aLiveTimerIsNotReadEverySecond() {
        show(state(CallPhase.Live(since = at(0))))
        status().assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.LiveRegion))
    }

    @Test
    @Config(qualifiers = "fa-w411dp-h891dp")
    fun persianIsRightToLeftWithPersianDigits() {
        show(state(CallPhase.Live(since = at(0))))
        status().assertTextEquals("۱:۰۵")
        compose.onNodeWithContentDescription("بی‌صدا").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "fa-w411dp-h891dp")
    fun persianRing() {
        show(state(CallPhase.Ringing, incoming = true, kind = CallKind.Video))
        status().assertTextEquals("تماس تصویری ورودی")
        compose.onNodeWithContentDescription("رد").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "tr-w411dp-h891dp")
    fun turkish() {
        show(state(CallPhase.Placing))
        status().assertTextEquals("Aranıyor…")
    }

    @Test
    @Config(qualifiers = "w411dp-h360dp-land")
    fun aPhoneOnItsSideKeepsTheEndButtonOnScreen() {
        show(state(CallPhase.Live(since = at(0))))
        compose.onNodeWithContentDescription("End call").assertIsDisplayed()
    }
}
