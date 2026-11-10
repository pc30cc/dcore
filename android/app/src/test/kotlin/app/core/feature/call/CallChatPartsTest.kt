package app.core.feature.call

import androidx.compose.runtime.Composable
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.feature.chat.ChatClockText
import app.core.model.CallKind
import app.core.model.CallLine
import app.core.model.CallOutcome
import app.core.model.CallSwitches
import app.core.ui.theme.AppTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs
import java.util.Locale
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue

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

    /** The one TalkBack sentence of the call line [line]. */
    private fun label(line: CallLine): String =
        compose.onNodeWithTag(callLineTag(line)).fetchSemanticsNode().config[SemanticsProperties.ContentDescription].single()

    @Test
    fun aCompletedCallLineReadsAsOneSentenceAndCallsBack() {
        val line = line(CallOutcome.Completed, caller = "me")
        show { CallLineRow(line, me = "me", at = at(0), onCallBack = { calls += "back" }) }
        compose.onNodeWithTag("call.line.77").assertIsDisplayed()
        compose.onNodeWithText("Voice call", substring = false).assertDoesNotExist() // merged into one node
        val time = ChatClockText(Locale.US).time(at(0))
        // The length as a length, every word spelt out; the time last, apart from it.
        assertEquals("Voice call, 4 minutes, 5 seconds, Outgoing, $time", label(line))
        compose.onNodeWithTag("call.line.77").assert(hasClickAction()).performClick()
        assertEquals(listOf("back"), calls)
    }

    @Test
    fun withoutCallBackTheLineIsNotAButton() {
        show { CallLineRow(line(CallOutcome.Completed, caller = "me"), me = "me", at = at(0), onCallBack = null) }
        compose.onNodeWithTag("call.line.77").assert(hasClickAction().not())
    }

    @Test
    fun theCalleeSeesAMissedCallTheCallerSeesNoAnswer() {
        show { CallLineRow(line(CallOutcome.Missed, caller = "them", kind = CallKind.Video), me = "me", at = at(0), onCallBack = null) }
        compose.onNodeWithContentDescription("Missed video call, Incoming", substring = true).assertIsDisplayed()
    }

    @Test
    fun theCallerSeesNoAnswer() {
        val line = line(CallOutcome.Missed, caller = "me")
        show(dark = true) { CallLineRow(line, me = "me", at = at(0), onCallBack = null) }
        // TalkBack has no icon to go by: the kind is said first.
        assertTrue(label(line), label(line).startsWith("Voice call, No answer, Outgoing, "))
    }

    @Test
    fun declinedAndCancelledSayWhatHappened() {
        val line = line(CallOutcome.Declined, caller = "me", kind = CallKind.Video)
        show { CallLineRow(line, me = "me", at = at(0), onCallBack = null) }
        assertTrue(label(line), label(line).startsWith("Video call, Declined, Outgoing, "))
    }

    @Test
    fun theCallerSeesTheirCancelledCall() {
        val line = line(CallOutcome.Cancelled, caller = "me", kind = CallKind.Video)
        show { CallLineRow(line, me = "me", at = at(0), onCallBack = null) }
        assertTrue(label(line), label(line).startsWith("Video call, Cancelled, Outgoing, "))
    }

    @Test
    fun aFailedCallSaysItsKindOnce() {
        val line = line(CallOutcome.Failed, caller = "them")
        show { CallLineRow(line, me = "me", at = at(0), onCallBack = null) }
        assertTrue(label(line), label(line).startsWith("Voice call, Failed, Incoming, "))
    }

    /** How many of [line]'s pixels are drawn in the template's accent (the call-back button's phone or camera). */
    private fun accentPixels(line: CallLine, dark: Boolean): Int {
        val image = compose.onNodeWithTag(callLineTag(line)).captureToImage().asAndroidBitmap()
        val accent = app.core.ui.theme.Templates.of(if (dark) app.core.ui.theme.Templates.NEON else app.core.ui.theme.Templates.WHITE).colors.primary
        val (r, g, b) = Triple((accent.red * 255).toInt(), (accent.green * 255).toInt(), (accent.blue * 255).toInt())
        var count = 0
        for (y in 0 until image.height) for (x in 0 until image.width) {
            val p = image.getPixel(x, y)
            val d = abs(android.graphics.Color.red(p) - r) + abs(android.graphics.Color.green(p) - g) + abs(android.graphics.Color.blue(p) - b)
            if (d < 24) count++
        }
        return count
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun aLineThatCallsBackShowsItsButtonAndARecordShowsNone() {
        val line = line(CallOutcome.Completed, caller = "me", kind = CallKind.Video)
        var dark by mutableStateOf(false)
        var back: (() -> Unit)? by mutableStateOf(null)
        compose.setContent { AppTheme(dark = dark) { CallLineRow(line, me = "me", at = at(0), onCallBack = back) } }
        for (theme in listOf(false, true)) {
            dark = theme
            back = { calls += "back" }
            compose.waitForIdle()
            val withButton = accentPixels(line, dark)
            val wide = compose.onNodeWithTag(callLineTag(line)).fetchSemanticsNode().boundsInRoot.width
            back = null
            compose.waitForIdle()
            val record = accentPixels(line, dark)
            val narrow = compose.onNodeWithTag(callLineTag(line)).fetchSemanticsNode().boundsInRoot.width
            assertTrue("dark=$dark: the button's camera in the accent ($withButton px)", withButton > 40)
            assertEquals("dark=$dark: no accent on a record", 0, record)
            // The button's 48 dp touch target ends the line.
            assertTrue("dark=$dark: $wide vs $narrow", wide - narrow >= 40f * compose.density.density)
        }
    }

    @Test
    @Config(qualifiers = "fa-w411dp-h891dp")
    fun persianDeclinedLineSaysTheKind() {
        val line = line(CallOutcome.Declined, caller = "me")
        show { CallLineRow(line, me = "me", at = at(0), onCallBack = null) }
        assertTrue(label(line), label(line).startsWith("تماس صوتی، رد شد، خروجی، "))
    }

    @Test
    @Config(qualifiers = "fa-w411dp-h891dp")
    fun persianCallLine() {
        val line = line(CallOutcome.Completed, caller = "me")
        show { CallLineRow(line, me = "me", at = at(0), onCallBack = null) }
        val label = label(line)
        assertTrue(label, label.startsWith("تماس صوتی، ۴ دقیقه و ۵ ثانیه، خروجی، "))
        assertTrue("Persian digits only: $label", label.none { it in '0'..'9' })
    }

    @Test
    @Config(qualifiers = "tr-w411dp-h891dp")
    fun turkishCallLine() {
        val line = line(CallOutcome.Completed, caller = "them")
        show { CallLineRow(line, me = "me", at = at(0), onCallBack = null) }
        assertTrue(label(line), label(line).startsWith("Sesli arama, 4 dakika 5 saniye, Gelen, "))
    }

    @Test
    @Config(qualifiers = "fa-w411dp-h891dp", fontScale = 1.5f)
    fun persianLargeTextKeepsTheLineWhole() {
        val line = line(CallOutcome.Missed, caller = "them", kind = CallKind.Video)
        show(dark = true) { CallLineRow(line, me = "me", at = at(0), onCallBack = { calls += "back" }) }
        compose.onNodeWithTag(callLineTag(line)).assertIsDisplayed()
        assertTrue(label(line), label(line).startsWith("تماس تصویری بی‌پاسخ، ورودی، "))
    }
}
