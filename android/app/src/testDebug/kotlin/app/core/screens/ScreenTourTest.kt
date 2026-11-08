package app.core.screens

import android.Manifest
import android.app.LocaleManager
import android.app.NotificationManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.LocaleList
import android.os.Looper
import android.telephony.TelephonyManager
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.view.Window
import androidx.activity.ComponentActivity
import androidx.annotation.StringRes
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performCustomAccessibilityActionWithLabel
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.window.DialogWindowProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.BuildConfig
import app.core.CoreApp
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.call.CallActivityHooks
import app.core.feature.call.CallHost
import app.core.feature.call.CallPhase
import app.core.feature.call.ProvideCallsToChat
import app.core.feature.auth.welcome.Headline
import app.core.brand.AppBrand
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.JalaliDates
import app.core.i18n.LocalAppName
import app.core.media.LocalRemoteImages
import app.core.model.CallKind
import app.core.model.Id
import app.core.net.Backend
import app.core.net.SampleApi
import app.core.ui.nav.AppNavHost
import app.core.ui.theme.AppTheme
import app.core.push.CallNotifications
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.LocalDate
import java.util.Locale
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowWindowManagerImpl

/**
 * The whole app on the sample backend, driven as a person would, in Persian
 * (right to left) and English, light and dark, and with large text, on a
 * phone-sized screen:
 * sign-in (the phone number and its code), the first sign-up steps, the
 * deck, a card's full profile, the match moment and the likes list; the
 * chats, a thread with every kind of line, a voice and a video call placed
 * from it, a ring, and message requests from both sides.
 *
 * Each step waits for its screen, so a screen that no longer appears, or a
 * flow the sample backend no longer carries, fails here. With the
 * environment variable `SCREENS_DIR` set, every screen is also written there
 * as a PNG (`<store>-<language>-<theme>-<flow><nn>-<screen>.png`); without it
 * nothing is written. The images are for looking at, never committed.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xhdpi")
class ScreenTourTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val app: CoreApp get() = ApplicationProvider.getApplicationContext()

    private fun str(@StringRes id: Int, vararg args: Any): String =
        (if (args.isEmpty()) app.resources.getString(id) else app.resources.getString(id, *args)).replace("{appName}", AppBrand.appName)

    private val language: String get() = app.resources.configuration.locales[0].language
    private val dark: Boolean
        get() = (app.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES

    private val outDir: File? = System.getenv("SCREENS_DIR")?.takeIf { it.isNotBlank() }?.let(::File)
    private var flow = ""
    private var shot = 0

    @After
    fun tearDown() {
        hooks?.let { compose.runOnUiThread { app.graph.calls.controller.dismiss(); it.onDestroy() } }
        // The process lifecycle is one per JVM: back to the background for whatever runs next.
        if (foreground) compose.runOnUiThread { (ProcessLifecycleOwner.get().lifecycle as LifecycleRegistry).currentState = Lifecycle.State.CREATED }
        System.clearProperty(Backend.SAMPLE_PROPERTY)
    }

    // MARK: - Sign-in and sign-up

    @Test @Config(qualifiers = "+en") fun signInAndSignUpEnglishLight() = signInAndSignUp()
    @Test @Config(qualifiers = "+en-night") fun signInAndSignUpEnglishDark() = signInAndSignUp()
    @Test @Config(qualifiers = "+fa") fun signInAndSignUpPersianLight() = signInAndSignUp()
    @Test @Config(qualifiers = "+fa-night") fun signInAndSignUpPersianDark() = signInAndSignUp()
    @Test @Config(qualifiers = "+fa", fontScale = 1.5f) fun signInAndSignUpPersianLargeText() = signInAndSignUp()

    private fun signInAndSignUp() {
        flow = "a"
        start(signedIn = false)

        waitFor(hasText(str(R.string.welcome_sign_up)))
        capture("welcome")
        compose.onNodeWithText(str(R.string.welcome_sign_up)).performClick()

        waitFor(hasText(Headline.plain(str(R.string.auth_sheet_privacy_title))))
        capture("privacy")
        compose.onNodeWithText(str(R.string.privacy_accept)).performClick()

        waitFor(hasText(Headline.plain(str(R.string.auth_sheet_signup_title))))
        // The bazaar build's default dial code is +98; the play build follows the SIM (GB here, in English).
        val national = if (BuildConfig.STORE == "play" && language == "en") "7700900123" else "9127654321"
        compose.onNode(hasSetTextAction() and hasContentDescription(str(R.string.auth_phone_label))).performTextInput(national)
        waitFor(hasText(str(R.string.auth_sheet_continue)) and isEnabled())
        capture("phone")
        compose.onNodeWithText(str(R.string.auth_sheet_continue)).performClick()

        waitFor(hasText(str(R.string.auth_code_title)))
        val codeField = compose.onNodeWithContentDescription(str(R.string.auth_code_label, 6))
        codeField.performTextInput("123")
        compose.waitForIdle()
        capture("otp")
        codeField.performTextInput("456")

        waitFor(hasText(str(R.string.onboarding_name_title)), timeoutMs = 20_000)
        compose.onNodeWithText(str(R.string.onboarding_name_label)).performTextInput(if (language == "fa") "سارا" else "Sara")
        waitFor(hasText(str(R.string.action_next)) and isEnabled())
        capture("signup-name")
        compose.onNodeWithText(str(R.string.action_next)).performClick()

        waitFor(hasText(str(R.string.onboarding_birthday_title)))
        capture("signup-birthday")
        // Filled in, in the calendar shown (Solar Hijri in Persian), with the longest month name.
        val persian = language == "fa"
        val ui = if (persian) AppLanguage.FA else AppLanguage.EN
        val year = if (persian) JalaliDates.toJalali(LocalDate.now()).year - 25 else LocalDate.now().year - 25
        pick(str(R.string.onboarding_birthday_day), Digits.localize("14", ui))
        pick(str(R.string.onboarding_birthday_month), if (persian) "اردیبهشت" else "September")
        pick(str(R.string.onboarding_birthday_year), Digits.localize(year.toString(), ui))
        waitFor(hasText(str(R.string.action_next)) and isEnabled())
        capture("signup-birthday-filled")
    }

    // MARK: - Deck, profile, match, likes

    @Test @Config(qualifiers = "+en") fun deckToLikesEnglishLight() = deckToLikes()
    @Test @Config(qualifiers = "+en-night") fun deckToLikesEnglishDark() = deckToLikes()
    @Test @Config(qualifiers = "+fa") fun deckToLikesPersianLight() = deckToLikes()
    @Test @Config(qualifiers = "+fa-night") fun deckToLikesPersianDark() = deckToLikes()
    @Test @Config(qualifiers = "+en", fontScale = 1.5f) fun deckToLikesEnglishLargeText() = deckToLikes()

    private fun deckToLikes() {
        flow = "b"
        start(signedIn = true)

        val like = str(R.string.deck_action_like)
        val details = str(R.string.deck_action_details)
        waitFor(hasContentDescription(like) and isEnabled() and !hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        val card = SemanticsMatcher("the top card") { node ->
            node.config.getOrElseNullable(SemanticsActions.CustomActions) { null }?.any { action -> action.label == details } == true
        }
        waitFor(card)
        capture("deck")

        // The sample deck starts with people who already like this account: liking the first is a match.
        compose.onNode(hasContentDescription(like) and !hasAnyAncestor(isDialog())).performClick()
        waitFor(hasText(str(R.string.match_title)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("match", compose.onNode(isDialog()))
        compose.onNodeWithText(str(R.string.match_keep_swiping)).performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }

        // A profile with an answer and details (the sample's Nazanin), passing the cards before it.
        val pass = str(R.string.deck_action_pass)
        val withAnswers = card and hasContentDescription("نازنین", substring = true)
        repeat(5) {
            waitFor(card)
            if (compose.onAllNodes(withAnswers).fetchSemanticsNodes().isEmpty()) {
                compose.onNode(hasContentDescription(pass) and !hasAnyAncestor(isDialog())).performClick()
                compose.waitForIdle()
            }
        }
        waitFor(withAnswers)
        capture("deck-next")
        compose.onNode(withAnswers).performCustomAccessibilityActionWithLabel(details)
        waitFor(isDialog())
        capture("profile-1", compose.onNode(isDialog()))
        compose.onNode(hasScrollAction() and hasAnyAncestor(isDialog())).performTouchInput { swipeUp() }
        compose.waitForIdle()
        capture("profile-2", compose.onNode(isDialog()))
        compose.onNodeWithContentDescription(str(R.string.profile_view_close)).performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }

        compose.onNodeWithText(str(R.string.tab_likes)).performClick()
        waitFor(hasText(str(R.string.likes_banner_title)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("likes")
    }

    // MARK: - Match, thread, chats, requests

    @Test @Config(qualifiers = "+en") fun matchToChatEnglishLight() = matchToChat()
    @Test @Config(qualifiers = "+en-night") fun matchToChatEnglishDark() = matchToChat()
    @Test @Config(qualifiers = "+fa") fun matchToChatPersianLight() = matchToChat()
    @Test @Config(qualifiers = "+fa-night") fun matchToChatPersianDark() = matchToChat()
    @Test @Config(qualifiers = "+fa", fontScale = 1.5f) fun matchToChatPersianLargeText() = matchToChat()

    /** "Send a message" on the match opens its thread; a message goes out, and the chat list and the requests show it all. */
    private fun matchToChat() {
        flow = "c"
        start(signedIn = true, chat = true)

        val like = str(R.string.deck_action_like)
        waitFor(hasContentDescription(like) and isEnabled() and !hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        compose.onNode(hasContentDescription(like) and !hasAnyAncestor(isDialog())).performClick()
        waitFor(hasText(str(R.string.match_send_message)), timeoutMs = 20_000)
        compose.onNodeWithText(str(R.string.match_send_message)).performClick()

        // The new match's thread, with nothing in it yet.
        waitFor(hasText(str(R.string.chat_intro_hint)), timeoutMs = 20_000)
        waitFor(hasSetTextAction())
        capture("thread-new")

        val text = if (language == "fa") "سلام! عکس‌های کوهت عالی بود" else "Hi! Your mountain photos are great"
        compose.onNode(hasSetTextAction()).performTextInput(text)
        compose.onNodeWithContentDescription(str(R.string.chat_send)).performClick()
        // The bubble reaches the server: "sent" (or further) replaces "sending".
        val sent = listOf(R.string.chat_status_sent, R.string.chat_status_delivered, R.string.chat_status_read).map(::str)
        val onServer = SemanticsMatcher("own bubble on the server") { node ->
            node.config.getOrElseNullable(SemanticsProperties.ContentDescription) { null }
                ?.any { d -> d.contains(text) && sent.any { d.endsWith(it) } } == true
        }
        waitFor(onServer, timeoutMs = 20_000)
        capture("thread-sent")

        compose.onNodeWithContentDescription(str(R.string.action_back)).performClick()
        compose.onNodeWithText(str(R.string.tab_chats)).performClick()
        waitFor(hasContentDescription(text, substring = true), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("chats")

        // The sample has a request waiting in the inbox.
        val requests = hasContentDescription(str(R.string.chat_requests), substring = true) and hasClickAction()
        waitFor(requests, timeoutMs = 20_000)
        compose.onAllNodes(requests)[0].performClick()
        waitFor(hasText(str(R.string.requests_accept)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("requests")
    }

    // MARK: - Chats, a thread's lines, calls and requests

    @Test @Config(qualifiers = "+en") fun chatsAndCallsEnglishLight() = chatsAndCalls()
    @Test @Config(qualifiers = "+en-night") fun chatsAndCallsEnglishDark() = chatsAndCalls()
    @Test @Config(qualifiers = "+fa") fun chatsAndCallsPersianLight() = chatsAndCalls()
    @Test @Config(qualifiers = "+fa-night") fun chatsAndCallsPersianDark() = chatsAndCalls()
    @Test @Config(qualifiers = "+fa", fontScale = 1.5f) fun chatsAndCallsPersianLargeText() = chatsAndCalls()

    /**
     * The chat list; a thread with received, sent and refused messages and
     * the line a call leaves; a voice call and a video call placed from its
     * header, live; a video ring opened from its notification; a message
     * request received, and one being written from a profile.
     */
    private fun chatsAndCalls() {
        flow = "d"
        start(signedIn = true, chat = true, calls = true)
        val graph = app.graph
        val sample = graph.api as SampleApi
        val peer = "نگار"

        val like = str(R.string.deck_action_like)
        waitFor(hasContentDescription(like) and isEnabled() and !hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        compose.onNodeWithText(str(R.string.tab_chats)).performClick()
        val row = hasLabel(peer, substring = true) and hasClickAction()
        waitFor(row, timeoutMs = 20_000)
        compose.waitForIdle()
        capture("chats")

        compose.onAllNodes(row)[0].performClick()
        waitFor(hasSetTextAction(), timeoutMs = 20_000)
        val voice = hasLabel(str(R.string.call_header_audio, peer))
        val video = hasLabel(str(R.string.call_header_video, peer))
        waitFor(voice and hasClickAction(), timeoutMs = 20_000, unmerged = false)
        val conversationId = runBlocking { sample.conversations().value.items.first { it.peer.name == peer }.id }

        // A voice call: ringing, then live once the sample answers (after 4 s).
        compose.onNode(voice and hasClickAction()).performClick()
        waitFor(hasText(str(R.string.call_status_calling)) or hasText(str(R.string.call_status_ringing)), timeoutMs = 10_000)
        capture("call-voice-ringing")
        waitForLive()
        capture("call-voice-live")
        hangUp()

        // The thread: what was there, the call's line, a message sent and one the server refused.
        // The hang-up reaches the server from the call's own (main thread) timers: the looper's clock moves too.
        val calledLine = hasLabel(str(R.string.chat_line_call_audio_length, ""), substring = true)
        pump(20_000) { compose.onAllNodes(calledLine, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        val sentText = if (language == "fa") "فردا عصر کافه؟" else "Coffee tomorrow evening?"
        send(sentText)
        waitFor(ownBubble(sentText, listOf(R.string.chat_status_sent, R.string.chat_status_delivered, R.string.chat_status_read)), timeoutMs = 20_000)
        val refusedText = if (language == "fa") "این یکی refusedword دارد" else "This one has a refusedword in it"
        send(refusedText)
        waitFor(ownBubble(refusedText, listOf(R.string.chat_not_sent)), timeoutMs = 20_000)
        waitFor(hasText(str(R.string.chat_not_sent_refused)))
        compose.waitForIdle()
        capture("thread-lines")

        // A video call from the same header.
        compose.onNode(video and hasClickAction()).performClick()
        waitForLive()
        capture("call-video-live")
        hangUp()

        // A ring: the sample's other phone calls, and its notification is opened.
        val ring = runBlocking { sample.ringFrom(conversationId, CallKind.Video) }
        openRing(ring.id)
        waitFor(hasText(str(R.string.call_status_incoming_video)), timeoutMs = 10_000)
        compose.waitForIdle()
        capture("call-incoming")
        waitFor(hasLabel(str(R.string.call_action_decline)) and hasClickAction(), unmerged = false)
        compose.onAllNodes(hasLabel(str(R.string.call_action_decline)) and hasClickAction())[0].performClick()
        pump(10_000) { graph.calls.controller.session.value == null }

        // A message request in the inbox.
        compose.onNodeWithContentDescription(str(R.string.action_back)).performClick()
        val requests = hasContentDescription(str(R.string.chat_requests), substring = true) and hasClickAction()
        waitFor(requests, timeoutMs = 20_000)
        compose.onAllNodes(requests)[0].performClick()
        waitFor(hasText(str(R.string.requests_accept)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("requests")
        compose.onNodeWithContentDescription(str(R.string.action_back)).performClick()

        // A thread written in another script than the app's (the other person's call, a note on a like),
        // with a draft in the app's own script in the composer.
        val elif = hasLabel("Elif", substring = true) and hasClickAction()
        waitFor(elif, timeoutMs = 20_000, unmerged = false)
        compose.onAllNodes(elif)[0].performClick()
        waitFor(hasText("Konuşmak güzeldi 😊"), timeoutMs = 20_000)
        compose.onNode(hasSetTextAction() and !hasAnyAncestor(isDialog()))
            .performTextInput(if (language == "fa") "See you at 8!" else "ساعت ۸ می‌بینمت!")
        compose.waitForIdle()
        capture("thread-mixed")
        compose.onNodeWithContentDescription(str(R.string.action_back)).performClick()

        // Writing to someone before a match: a profile's "Write to them".
        compose.onNodeWithText(str(R.string.tab_discover)).performClick()
        val details = str(R.string.deck_action_details)
        val card = SemanticsMatcher("the top card") { node ->
            node.config.getOrElseNullable(SemanticsActions.CustomActions) { null }?.any { action -> action.label == details } == true
        }
        waitFor(card, timeoutMs = 20_000)
        compose.onAllNodes(card)[0].performCustomAccessibilityActionWithLabel(details)
        waitFor(isDialog())
        val write = hasLabel(str(R.string.request_write_to)) and hasClickAction() and hasAnyAncestor(isDialog())
        waitFor(write, unmerged = false)
        compose.onNode(write).performClick()
        waitFor(hasText(str(R.string.request_send_hint)), timeoutMs = 10_000)
        // The sheet's field: the last one on screen.
        val fields = compose.onAllNodes(hasSetTextAction() and hasAnyAncestor(isDialog()))
        fields[fields.fetchSemanticsNodes().lastIndex].performTextInput(if (language == "fa") "سلام! عکس کوهت عالیه" else "Hi! Love the mountain photo")
        compose.waitForIdle()
        captureWithSheet("request-write")
    }

    private fun send(text: String) {
        val composer = hasSetTextAction() and !hasAnyAncestor(isDialog())
        compose.onNode(composer).performTextInput(text)
        compose.onNodeWithContentDescription(str(R.string.chat_send)).performClick()
        compose.waitForIdle()
    }

    /** The phone's own bubble with [text], whose TalkBack sentence ends with one of [states]. */
    private fun ownBubble(text: String, states: List<Int>): SemanticsMatcher {
        val endings = states.map(::str)
        return SemanticsMatcher("own bubble \"$text\"") { node ->
            node.config.getOrElseNullable(SemanticsProperties.ContentDescription) { null }
                ?.map(::plain)?.any { d -> d.contains(text) && endings.any { d.endsWith(it) } } == true
        }
    }

    private fun waitForLive() {
        val session = app.graph.calls.controller.session
        runCatching { pump(20_000) { session.value?.phase?.value is CallPhase.Live } }.onFailure {
            throw AssertionError("the call never went live: ${session.value?.phase?.value}", it)
        }
        // The timer past its first seconds (the wall clock, and the screen's own clock that ticks it).
        pump(2_100) { false }
        compose.mainClock.advanceTimeBy(2_100)
        compose.waitForIdle()
    }

    private fun hangUp() {
        val controller = app.graph.calls.controller
        controller.session.value?.hangUp()
        pump(10_000) { controller.session.value?.phase?.value?.isOver != false }
        compose.runOnUiThread { controller.dismiss() }
        pump(10_000) { controller.session.value == null }
    }

    /**
     * Waits for [done] (or [timeoutMs], when [done] never holds) on the wall
     * clock, moving the main looper's clock along with it: the call's timers
     * run on the main thread, whose clock the test drives.
     */
    private fun pump(timeoutMs: Long, done: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        val looper = shadowOf(Looper.getMainLooper())
        while (true) {
            compose.waitForIdle()
            if (done()) return
            if (System.currentTimeMillis() >= end) {
                if (timeoutMs >= 5_000) throw AssertionError("still waiting after $timeoutMs ms")
                return
            }
            Thread.sleep(STEP_MS)
            looper.idleFor(java.time.Duration.ofMillis(STEP_MS))
        }
    }

    /** The ring's notification, tapped: its intent reaches the activity as a ring's would. */
    private fun openRing(callId: Id) {
        val manager = app.getSystemService(NotificationManager::class.java)
        pump(10_000) { CallNotifications.isRinging(app, callId) }
        val posted = shadowOf(manager).allNotifications.last { it.extras.getString(CallNotifications.EXTRA_CALL) == callId }
        val intent = shadowOf(posted.contentIntent).savedIntent
        compose.runOnUiThread { check(hooks?.onNewIntent(intent) == true) { "the ring's tap was not taken" } }
    }

    /** A node whose text or TalkBack label is [text], ignoring the direction marks around names. */
    private fun hasLabel(text: String, substring: Boolean = false): SemanticsMatcher {
        val wanted = plain(text)
        return SemanticsMatcher("label \"$wanted\"") { node ->
            val labels = node.config.getOrElseNullable(SemanticsProperties.ContentDescription) { null }.orEmpty() +
                node.config.getOrElseNullable(SemanticsProperties.Text) { null }.orEmpty().map { it.text }
            labels.map(::plain).any { if (substring) it.contains(wanted) else it == wanted }
        }
    }

    private fun plain(text: String): String = text.filterNot { it in "\u2066\u2067\u2068\u2069\u200e\u200f\u202a\u202b\u202c" }

    // MARK: - Helpers

    /** The app as [app.core.MainActivity] draws it, on the sample backend, in the configuration's language. */
    private var hooks: CallActivityHooks? = null
    private var foreground = false

    private fun start(signedIn: Boolean, chat: Boolean = false, calls: Boolean = false) {
        System.setProperty(Backend.SAMPLE_PROPERTY, "true")
        // The app's own language setting (Cafe Bazaar's build would otherwise stay Persian).
        app.getSystemService(LocaleManager::class.java).applicationLocales = LocaleList.forLanguageTags(language)
        if (BuildConfig.STORE == "play" && language == "en") {
            shadowOf(app.getSystemService(TelephonyManager::class.java)).setSimCountryIso("gb")
        }
        val graph = app.graph
        check(graph.api is SampleApi) { "the tour runs on the sample backend" }
        runBlocking {
            // The preferences store outlives a test in this JVM: start each tour before the privacy notice.
            graph.secureStore.remove("legal.accepted")
            if (!signedIn) graph.api.logout(false)
        }
        graph.config.start()
        // The chat and its realtime socket follow the account, as MainActivity starts them.
        if (chat) {
            graph.chat.start()
            // The app in front, as a phone's process lifecycle reports it (the
            // test's activity does not drive it here): the realtime socket connects.
            compose.runOnUiThread { (ProcessLifecycleOwner.get().lifecycle as LifecycleRegistry).currentState = Lifecycle.State.RESUMED }
            foreground = true
        }
        if (calls) {
            // What a call asks for, already allowed; the ring may post and go full screen.
            shadowOf(app).grantPermissions(
                Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA,
                Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.POST_NOTIFICATIONS,
            )
            compose.runOnUiThread { hooks = CallActivityHooks(compose.activity, graph.calls) { graph.realtime }.also { it.onCreate(null) } }
        }
        compose.setContent {
            val config by graph.config.config.collectAsStateWithLifecycle()
            AppTheme(dark = isSystemInDarkTheme()) {
                CompositionLocalProvider(
                    LocalAppGraph provides graph,
                    LocalAppName provides AppBrand.appName,
                    LocalRemoteImages provides false,
                ) {
                    if (calls) {
                        // As MainActivity draws it: the call over everything.
                        Box(Modifier.fillMaxSize()) {
                            Surface(Modifier.fillMaxSize()) { ProvideCallsToChat { AppNavHost(config = config) } }
                            CallHost(hooks)
                        }
                    } else {
                        Surface(Modifier.fillMaxSize()) { AppNavHost(config = config) }
                    }
                }
            }
        }
    }

    /** Opens the menu labelled [label] and picks [item] from it. */
    private fun pick(label: String, item: String) {
        compose.onNodeWithText(label).performClick()
        waitFor(hasText(item) and hasAnyAncestor(isPopup()))
        compose.onNode(hasText(item) and hasAnyAncestor(isPopup())).performScrollTo().performClick()
        compose.waitForIdle()
    }

    private fun waitFor(matcher: SemanticsMatcher, timeoutMs: Long = 10_000, unmerged: Boolean = true) {
        runCatching {
            compose.waitUntil(timeoutMs) { compose.onAllNodes(matcher, useUnmergedTree = unmerged).fetchSemanticsNodes().isNotEmpty() }
        }.onFailure {
            if (DEBUG_DUMP) {
                capture("debug")
                println(compose.onAllNodes(isRoot())[0].printToString(Int.MAX_VALUE))
            }
            throw it
        }
    }

    private fun capture(name: String, node: SemanticsNodeInteraction = compose.onAllNodes(isRoot())[0]) {
        if (outDir == null) return
        compose.waitForIdle()
        write(name, node.captureToImage().asAndroidBitmap())
    }

    /**
     * Every window on screen, stacked in order: the activity, then each dialog
     * or sheet over it. A bottom sheet is a window of its own that does not say
     * it is a dialog, so [captureToImage] would copy the activity's window instead.
     */
    private fun captureWithSheet(name: String) {
        if (outDir == null) return
        compose.waitForIdle()
        val views = Shadow.extract<ShadowWindowManagerImpl>(compose.activity.windowManager).views
        val windows = views.mapNotNull { windowProvider(it)?.window }.distinct()
        check(windows.isNotEmpty()) { "no sheet window" }
        val screen = copy(compose.activity.window)
        val canvas = Canvas(screen)
        windows.forEach { canvas.drawBitmap(copy(it), 0f, 0f, null) }
        write(name, screen)
    }

    private fun windowProvider(view: View): DialogWindowProvider? = when (view) {
        is DialogWindowProvider -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { windowProvider(view.getChildAt(it)) }
        else -> null
    }

    private fun copy(window: Window): Bitmap {
        val decor = window.decorView
        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        var result = -1
        PixelCopy.request(window, bitmap, { result = it }, Handler(Looper.getMainLooper()))
        shadowOf(Looper.getMainLooper()).idle()
        check(result == PixelCopy.SUCCESS) { "copying a window failed: $result" }
        return bitmap
    }

    private fun write(name: String, bitmap: Bitmap) {
        val dir = outDir ?: return
        dir.mkdirs()
        val scale = app.resources.configuration.fontScale
        val theme = (if (dark) "dark" else "light") + (if (scale > 1f) String.format(Locale.ROOT, "-text%.1f", scale) else "")
        val file = File(dir, String.format(Locale.ROOT, "%s-%s-%s-%s%02d-%s.png", BuildConfig.STORE, language, theme, flow, ++shot, name))
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private companion object {
        val DEBUG_DUMP = System.getenv("SCREENS_DEBUG") == "1"
        const val STEP_MS = 50L
    }
}
