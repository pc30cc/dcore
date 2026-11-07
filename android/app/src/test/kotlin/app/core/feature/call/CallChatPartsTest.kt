package app.core.feature.call

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.model.CallKind
import app.core.model.CallLine
import app.core.model.CallOutcome
import app.core.model.CallSwitches
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The call's parts in a conversation: the header's buttons, the match's call settings, and the call line. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class CallChatPartsTest {

    @get:Rule val compose = createComposeRule()

    private val calls = mutableListOf<String>()

    private fun show(dark: Boolean = false, content: @Composable () -> Unit) {
        compose.setContent { AppTheme(dark = dark) { content() } }
    }

    private val on = CallSwitches(audio = true, video = true)

    @Test
    fun bothAllowingCallsGivesVoiceAndVideo() {
        show { CallHeaderButtons(CallHeaderState("Negar", both = true, switches = on, active = true), onCall = { calls += it.wire }, onOpenSettings = { calls += "settings" }) }
        compose.onNodeWithContentDescription("Voice call with ⁨Negar⁩").performClick()
        compose.onNodeWithContentDescription("Video call with ⁨Negar⁩").performClick()
        assertEquals(listOf("audio", "video"), calls)
    }

    @Test
    fun videoSwitchedOffByThePanelLeavesVoiceOnly() {
        show { CallHeaderButtons(CallHeaderState("Negar", both = true, switches = CallSwitches(audio = true, video = false), active = true), onCall = { calls += it.wire }, onOpenSettings = {}) }
        compose.onNodeWithTag(CallTags.HEADER_AUDIO).assertIsDisplayed()
        compose.onNodeWithTag(CallTags.HEADER_VIDEO).assertDoesNotExist()
    }

    @Test
    fun withoutBothConsentsTheHeaderOpensTheSettings() {
        show { CallHeaderButtons(CallHeaderState("Negar", both = false, switches = on, active = true), onCall = { calls += it.wire }, onOpenSettings = { calls += "settings" }) }
        compose.onNodeWithContentDescription("Calls are off with ⁨Negar⁩. Tap to change.").performClick()
        assertEquals(listOf("settings"), calls)
    }

    @Test
    fun anEndedConversationHasNoCallButtons() {
        show { CallHeaderButtons(CallHeaderState("Negar", both = true, switches = on, active = false), onCall = {}, onOpenSettings = {}) }
        compose.onNodeWithTag(CallTags.HEADER_AUDIO).assertDoesNotExist()
        compose.onNodeWithTag(CallTags.HEADER_SETTINGS).assertDoesNotExist()
    }

    private fun settings(allowMe: Boolean, allowPeer: Boolean, saving: Boolean = false, failed: Boolean = false, readiness: CallReadiness = CallReadiness(true, true)) =
        CallSettingsState("Negar", allowMe, allowPeer, saving, failed, on, active = true, readiness = readiness)

    @Test
    fun theSwitchSaysWhereItStandsForBoth() {
        show { CallSettingsContent(settings(allowMe = true, allowPeer = false), onToggle = { calls += "toggle:$it" }, onCall = {}, onEnableNotifications = {}, onAllowFullScreen = {}, onDismiss = {}) }
        compose.onNodeWithTag(CallTags.CONSENT).assertIsOn()
        compose.onNodeWithText("⁨Negar⁩ hasn't allowed calls yet.").assertIsDisplayed()
        compose.onNodeWithTag(CallTags.CONSENT).performClick()
        assertEquals(listOf("toggle:false"), calls)
    }

    @Test
    fun turnedOffItAsksToTurnItOn() {
        show { CallSettingsContent(settings(allowMe = false, allowPeer = true), onToggle = { calls += "toggle:$it" }, onCall = {}, onEnableNotifications = {}, onAllowFullScreen = {}, onDismiss = {}) }
        compose.onNodeWithTag(CallTags.CONSENT).assertIsOff()
        compose.onNodeWithText("Turn this on so you can call each other.").assertIsDisplayed()
    }

    @Test
    fun bothOnOffersTheCallsThemselves() {
        show { CallSettingsContent(settings(allowMe = true, allowPeer = true), onToggle = {}, onCall = { calls += it.wire }, onEnableNotifications = {}, onAllowFullScreen = {}, onDismiss = {}) }
        compose.onNodeWithText("You can call each other.").assertIsDisplayed()
        compose.onNodeWithText("Video call").performClick()
        assertEquals(listOf("video"), calls)
    }

    @Test
    fun savingAndAFailedSaveAreShown() {
        show { CallSettingsContent(settings(allowMe = true, allowPeer = true, saving = true), onToggle = {}, onCall = {}, onEnableNotifications = {}, onAllowFullScreen = {}, onDismiss = {}) }
        compose.onNodeWithText("Saving…").assertIsDisplayed()
        compose.onNodeWithTag(CallTags.CONSENT).assertIsNotEnabled()
    }

    @Test
    fun aFailedSaveSaysSo() {
        show { CallSettingsContent(settings(allowMe = false, allowPeer = true, failed = true), onToggle = {}, onCall = {}, onEnableNotifications = {}, onAllowFullScreen = {}, onDismiss = {}) }
        compose.onNodeWithText("Couldn't save that. Check your connection and try again.").assertIsDisplayed()
    }

    @Test
    fun whatAPhoneStillNeedsForARingIsOffered() {
        show { CallSettingsContent(settings(allowMe = true, allowPeer = true, readiness = CallReadiness(notifications = false, fullScreen = false)), onToggle = {}, onCall = {}, onEnableNotifications = { calls += "notifications" }, onAllowFullScreen = {}, onDismiss = {}) }
        compose.onNodeWithText("Turn on notifications so calls can ring.").assertIsDisplayed()
        compose.onNodeWithText("Turn on").performClick()
        assertEquals(listOf("notifications"), calls)
    }

    @Test
    fun fullScreenRingsAreOfferedOnceNotificationsAreOn() {
        show { CallSettingsContent(settings(allowMe = true, allowPeer = true, readiness = CallReadiness(notifications = true, fullScreen = false)), onToggle = {}, onCall = {}, onEnableNotifications = {}, onAllowFullScreen = { calls += "fullScreen" }, onDismiss = {}) }
        compose.onNodeWithText("Allow").performClick()
        assertEquals(listOf("fullScreen"), calls)
    }

    private fun line(outcome: CallOutcome, caller: String, kind: CallKind = CallKind.Audio) =
        CallLine(callId = "77", kind = kind, outcome = outcome, placedAt = at(0), durationSeconds = 245, caller = caller)

    @Test
    fun aCompletedCallLineReadsAsOneSentenceAndCallsBack() {
        show { CallLineRow(line(CallOutcome.Completed, caller = "me"), me = "me", at = at(0), onCallBack = { calls += "back" }) }
        compose.onNodeWithTag("call.line.77").assertIsDisplayed()
        compose.onNodeWithText("Voice call", substring = false).assertDoesNotExist() // merged into one node
        compose.onNodeWithContentDescription("Voice call, 4:05, Outgoing", substring = true).performClick()
        assertEquals(listOf("back"), calls)
    }

    @Test
    fun theCalleeSeesAMissedCallTheCallerSeesNoAnswer() {
        show { CallLineRow(line(CallOutcome.Missed, caller = "them", kind = CallKind.Video), me = "me", at = at(0), onCallBack = null) }
        compose.onNodeWithContentDescription("Missed video call, Incoming", substring = true).assertIsDisplayed()
    }

    @Test
    fun theCallerSeesNoAnswer() {
        show(dark = true) { CallLineRow(line(CallOutcome.Missed, caller = "me"), me = "me", at = at(0), onCallBack = null) }
        compose.onNodeWithContentDescription("No answer, Outgoing", substring = true).assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "fa-w411dp-h891dp")
    fun persianCallLine() {
        show { CallLineRow(line(CallOutcome.Completed, caller = "me"), me = "me", at = at(0), onCallBack = null) }
        compose.onNodeWithContentDescription("تماس صوتی، ۴:۰۵، خروجی", substring = true).assertIsDisplayed()
    }
}
