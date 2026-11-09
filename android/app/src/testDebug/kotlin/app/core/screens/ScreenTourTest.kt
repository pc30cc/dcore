package app.core.screens

import android.Manifest
import android.app.Activity
import android.app.LocaleManager
import android.app.NotificationManager
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Handler
import android.os.LocaleList
import android.os.Looper
import android.telephony.TelephonyManager
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
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
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performCustomAccessibilityActionWithLabel
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.swipeDown
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
import app.core.model.WalletItem
import app.core.feature.paywall.PaywallEntry
import app.core.store.BillingUnavailableReason
import app.core.store.SampleBilling
import app.core.store.Store
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
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.LocalDate
import java.util.Locale
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowWindowManagerImpl

/**
 * The whole app on the sample backend, driven as a person would, in Persian
 * (right to left) and English, light and dark, and with large text, on a
 * phone-sized screen:
 * sign-in (the phone number and its code), every sign-up step to the
 * deck, a card's full profile, the match moment and the likes list; the
 * chats, a thread with every kind of line, a voice and a video call placed
 * from it, a ring, and message requests from both sides; the Profile tab
 * and its dialogs.
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

        // The age, read back once before it is kept.
        next()
        confirmDialog("signup-birthday-confirm")

        waitFor(hasText(str(R.string.onboarding_gender_title)), timeoutMs = 20_000)
        capture("signup-gender")
        compose.onNodeWithText(str(R.string.gender_woman)).performClick()
        waitForNext()
        capture("signup-gender-filled")
        // Birth date and gender go to the server together, after one more read-back.
        next()
        confirmDialog("signup-basics-confirm")

        waitFor(hasText(str(R.string.onboarding_interest_title)), timeoutMs = 20_000)
        capture("signup-interested")
        compose.onNodeWithText(str(R.string.interest_men)).performClick()
        waitForNext()
        capture("signup-interested-filled")
        next()

        val catalog = checkNotNull(app.graph.config.config.value?.catalog) { "no catalogue" }
        waitFor(hasText(str(R.string.onboarding_goal_title)), timeoutMs = 20_000)
        capture("signup-intention")
        val serious = catalog.intentions.firstOrNull { it.key == "serious" }?.label?.takeIf { it.isNotBlank() } ?: str(R.string.intention_serious)
        compose.onNodeWithText(serious).performClick()
        waitForNext()
        capture("signup-intention-filled")
        next()

        // Photos: three pictures from the system picker, each framed, uploaded and approved by the sample.
        waitFor(hasText(str(R.string.onboarding_photos_title)), timeoutMs = 20_000)
        capture("signup-photos-empty")
        val looks = listOf(
            Portrait(sky = 0xFF8EC5FC.toInt(), ground = 0xFFE0C3FC.toInt(), shirt = 0xFF2E7D6B.toInt(), hair = 0xFF3B2416.toInt()),
            Portrait(sky = 0xFFFFD3A5.toInt(), ground = 0xFFFD6585.toInt(), shirt = 0xFF283593.toInt(), hair = 0xFF1B1B1B.toInt()),
            Portrait(sky = 0xFFA8E6CF.toInt(), ground = 0xFF3D84A8.toInt(), shirt = 0xFFF9A825.toInt(), hair = 0xFF5D4037.toInt()),
        )
        pickPhotos(looks.map { it.jpeg() })
        val use = hasText(str(R.string.onboarding_crop_use)) and hasAnyAncestor(isDialog())
        val area = hasContentDescription(str(R.string.onboarding_crop_area)) and hasAnyAncestor(isDialog())
        repeat(looks.size) { index ->
            waitFor(use, timeoutMs = 20_000)
            // The frame keeps the previous picture until the next one is decoded: wait for this turn's own.
            pump(10_000) {
                val image = compose.onNode(area, useUnmergedTree = true).captureToImage().asAndroidBitmap()
                Portrait.closest(looks, image.getPixel(image.width / 2, image.height / 12)) == index
            }
            if (index == 0) capture("signup-photos-crop", compose.onNode(isDialog()))
            compose.onNode(use).performClick()
            compose.waitForIdle()
        }
        compose.waitUntil(20_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }
        if (compose.onAllNodes(hasLabel(str(R.string.photo_uploading)), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()) {
            capture("signup-photos-uploading")
        }
        val approved = hasLabel(str(R.string.photo_status_approved), substring = true)
        pump(30_000) { compose.onAllNodes(approved, useUnmergedTree = true).fetchSemanticsNodes().size == 3 }
        waitForNext()
        capture("signup-photos-filled")
        next()

        // Prompts: two picked from the catalogue's sheet and answered.
        waitFor(hasText(str(R.string.onboarding_prompts_title)), timeoutMs = 20_000)
        capture("signup-prompts")
        val prompts = catalog.prompts.filter { it.category != "voice" }
        val answers = if (persian) {
            listOf("یه هفته کوه‌پیمایی دور ماسوله، با یه کوله و یه دفترچهٔ طراحی", "صبح زود دوچرخه، عصر کتاب‌فروشی، شب شام با دوستام")
        } else {
            listOf("A week of hiking around Masuleh with one backpack and a sketchbook", "An early bike ride, an afternoon in a bookshop, dinner with friends")
        }
        answers.forEachIndexed { index, answer ->
            compose.onNodeWithText(str(R.string.onboarding_prompts_add)).performScrollTo().performClick()
            waitFor(hasText(str(R.string.onboarding_prompts_pick)), timeoutMs = 10_000)
            compose.waitForIdle()
            if (index == 0) captureWithSheet("signup-prompts-pick")
            compose.onNodeWithText(prompts[index].text).performClick()
            waitFor(hasSetTextAction(), timeoutMs = 10_000)
            val fields = compose.onAllNodes(hasSetTextAction())
            fields[fields.fetchSemanticsNodes().lastIndex].performTextInput(answer)
        }
        waitForNext()
        capture("signup-prompts-filled")
        captureRest("signup-prompts-filled-end")
        next()

        // The catalogue's fields: height on the slider, smoking, languages.
        waitFor(hasText(str(R.string.onboarding_fields_title)), timeoutMs = 20_000)
        capture("signup-fields")
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress))
            .performSemanticsAction(SemanticsActions.SetProgress) { it(168f) }
        fun option(id: Int): String = catalog.fields.flatMap { it.options }.first { it.id == id }.label
        listOf(21, 31, 33).forEach { compose.onNodeWithText(option(it)).performScrollTo().performClick() }
        compose.waitForIdle()
        scrollToTop()
        capture("signup-fields-filled")
        captureRest("signup-fields-filled-end")
        next()

        // Location: the phone's approximate position (allowed), then the city list a person may pick from instead.
        waitFor(hasText(str(R.string.onboarding_location_title)), timeoutMs = 20_000)
        capture("signup-location")
        val elsewhere = BuildConfig.STORE == "play" && !persian
        allowCoarseLocation(if (elsewhere) 51.51 to -0.12 else 35.70 to 51.40)
        compose.onNodeWithText(str(R.string.onboarding_location_use)).performClick()
        waitFor(hasText(str(R.string.onboarding_location_shown)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("signup-location-set")
        compose.onNodeWithText(str(R.string.action_change)).performClick()
        waitFor(hasSetTextAction(), timeoutMs = 10_000)
        val query = if (persian) "اصف" else "Lon"
        compose.onNode(hasSetTextAction()).performTextInput(query)
        val city = if (persian) "اصفهان" else "London"
        pump(10_000) { compose.onAllNodes(hasText(city) and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        capture("signup-location-city")
        captureRest("signup-location-city-end")
        next()

        // Notifications (Android 13+ asks): the reasons, then the system's question, answered yes.
        val notifications = hasText(str(R.string.onboarding_notifications_title))
        val guidelines = hasText(str(R.string.onboarding_rules_title))
        waitFor(notifications or guidelines, timeoutMs = 20_000)
        if (compose.onAllNodes(notifications, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()) {
            compose.waitForIdle()
            capture("signup-notifications")
            shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
            compose.onNodeWithText(str(R.string.onboarding_notifications_allow)).performClick()
        }

        waitFor(guidelines, timeoutMs = 20_000)
        compose.waitForIdle()
        capture("signup-guidelines")
        captureRest("signup-guidelines-end")
        compose.onNodeWithText(str(R.string.onboarding_rules_agree)).performClick()

        // Signed up: the deck.
        val like = str(R.string.deck_action_like)
        waitFor(hasContentDescription(like) and isEnabled() and !hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        val details = str(R.string.deck_action_details)
        waitFor(SemanticsMatcher("the top card") { node ->
            node.config.getOrElseNullable(SemanticsActions.CustomActions) { null }?.any { action -> action.label == details } == true
        }, timeoutMs = 20_000)
        compose.waitForIdle()
        capture("signup-done-deck")
    }

    /** The sign-up step's "Next", once it can be tapped. */
    private fun waitForNext() = waitFor(hasText(str(R.string.action_next)) and isEnabled() and hasClickAction(), timeoutMs = 20_000, unmerged = false)

    private fun next() {
        waitForNext()
        compose.onNode(hasText(str(R.string.action_next)) and isEnabled() and hasClickAction()).performClick()
    }

    /** A read-back dialog over the step, captured as [name], then confirmed. */
    private fun confirmDialog(name: String) {
        waitFor(isDialog())
        compose.waitForIdle()
        captureWithDialog(name)
        compose.onNode(hasText(str(R.string.action_confirm)) and hasAnyAncestor(isDialog())).performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }
    }

    /**
     * The system photo picker, answered: [pictures] are written as files and
     * handed back as its result (the sandbox's media provider serves no
     * picker URIs).
     */
    private fun pickPhotos(pictures: List<ByteArray>) {
        val dir = File(app.cacheDir, "picked").apply { mkdirs() }
        val uris = pictures.mapIndexed { index, bytes -> Uri.fromFile(File(dir, "IMG_${1000 + index}.jpg").apply { writeBytes(bytes) }) }
        compose.onAllNodes(hasContentDescription(str(R.string.onboarding_photos_add)) and hasClickAction())[0].performClick()
        compose.waitForIdle()
        val activity = shadowOf(compose.activity)
        val request = checkNotNull(activity.nextStartedActivityForResult) { "the photo picker was not opened" }
        val result = Intent().apply {
            clipData = ClipData.newRawUri(null, uris.first()).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
        }
        compose.runOnUiThread { activity.receiveResult(request.intent, Activity.RESULT_OK, result) }
        compose.waitForIdle()
    }

    /** A made-up portrait (a figure against a sky), 4:5 and larger than the upload size. */
    private class Portrait(val sky: Int, val ground: Int, val shirt: Int, val hair: Int) {

        /** As the JPEG a gallery would hold. */
        fun jpeg(): ByteArray {
            val w = 1440f
            val h = 1800f
            val bitmap = Bitmap.createBitmap(w.toInt(), h.toInt(), Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            paint.shader = LinearGradient(0f, 0f, 0f, h, sky, ground, Shader.TileMode.CLAMP)
            canvas.drawRect(0f, 0f, w, h, paint)
            paint.shader = null
            paint.color = shirt
            canvas.drawOval(RectF(w * 0.14f, h * 0.66f, w * 0.86f, h * 1.25f), paint)
            paint.color = 0xFFE8B996.toInt()
            canvas.drawRect(w * 0.44f, h * 0.5f, w * 0.56f, h * 0.7f, paint)
            canvas.drawOval(RectF(w * 0.35f, h * 0.24f, w * 0.65f, h * 0.56f), paint)
            paint.color = hair
            canvas.drawArc(RectF(w * 0.33f, h * 0.2f, w * 0.67f, h * 0.5f), 180f, 180f, true, paint)
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
            return out.toByteArray()
        }

        companion object {
            /** The index of the portrait in [looks] whose sky is nearest to [pixel]. */
            fun closest(looks: List<Portrait>, pixel: Int): Int = looks.indices.minBy { i ->
                val sky = looks[i].sky
                val dr = android.graphics.Color.red(sky) - android.graphics.Color.red(pixel)
                val dg = android.graphics.Color.green(sky) - android.graphics.Color.green(pixel)
                val db = android.graphics.Color.blue(sky) - android.graphics.Color.blue(pixel)
                dr * dr + dg * dg + db * db
            }
        }
    }

    /** The coarse permission granted and the network provider holding a fresh fix at [at] (lat, lng). */
    private fun allowCoarseLocation(at: Pair<Double, Double>) {
        shadowOf(app).grantPermissions(Manifest.permission.ACCESS_COARSE_LOCATION)
        val manager = shadowOf(app.getSystemService(LocationManager::class.java))
        manager.setProviderEnabled(LocationManager.NETWORK_PROVIDER, true)
        manager.setLastKnownLocation(
            LocationManager.NETWORK_PROVIDER,
            Location(LocationManager.NETWORK_PROVIDER).apply {
                latitude = at.first
                longitude = at.second
                accuracy = 2_000f
                time = System.currentTimeMillis()
            },
        )
    }

    // MARK: - The Profile tab

    @Test @Config(qualifiers = "+en") fun profileTabEnglishLight() = profileTab()
    @Test @Config(qualifiers = "+en-night") fun profileTabEnglishDark() = profileTab()
    @Test @Config(qualifiers = "+fa") fun profileTabPersianLight() = profileTab()
    @Test @Config(qualifiers = "+fa-night") fun profileTabPersianDark() = profileTab()
    @Test @Config(qualifiers = "+fa", fontScale = 1.5f) fun profileTabPersianLargeText() = profileTab()

    /** The signed-in account's own tab, a screen at a time, and the dialogs its rows open. */
    private fun profileTab() {
        flow = "p"
        start(signedIn = true)

        val like = str(R.string.deck_action_like)
        waitFor(hasContentDescription(like) and isEnabled() and !hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        compose.onNodeWithText(str(R.string.tab_profile)).performClick()
        waitFor(hasText(str(R.string.profile_empty_title)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("profile")
        val list = hasScrollAction() and !hasAnyAncestor(isDialog())
        var page = 1
        while (canScrollFurther(list) && page < 6) {
            compose.onNode(list).performTouchInput { swipeUp() }
            compose.waitForIdle()
            capture("profile-${++page}")
        }

        openRow(list, str(R.string.settings_language))
        captureWithDialog("profile-language")
        closeDialog(str(R.string.action_close))

        // The licence texts are read from the app's resources off the main thread; in this sandbox the
        // first read after another tour sometimes never lands, so the dialog is opened again.
        val licence = hasText("Open Font License", substring = true) and hasAnyAncestor(isDialog())
        fun licenceShown() = compose.onAllNodes(licence, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        for (attempt in 1..3) {
            if (attempt > 1) closeDialog(str(R.string.action_close))
            openRow(list, str(R.string.settings_licences))
            pump(4_000) { licenceShown() }
            if (licenceShown()) break
        }
        check(licenceShown()) { "the licence texts never showed" }
        captureWithDialog("profile-licences")
        closeDialog(str(R.string.action_close))

        openRow(list, str(R.string.action_sign_out))
        captureWithDialog("profile-sign-out")
        closeDialog(str(R.string.action_cancel))
    }

    /** Scrolls the tab's list to the row titled [title] and opens its dialog. */
    private fun openRow(list: SemanticsMatcher, title: String) {
        compose.onNode(list).performScrollToNode(hasText(title))
        compose.onNode(hasText(title) and !hasAnyAncestor(isDialog())).performClick()
        waitFor(isDialog())
        compose.waitForIdle()
    }

    private fun closeDialog(button: String) {
        compose.onNode(hasText(button) and hasAnyAncestor(isDialog())).performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }
    }

    /** The screen's scrollable content has more below what is shown. */
    private fun canScrollFurther(matcher: SemanticsMatcher): Boolean {
        val node = compose.onAllNodes(matcher).fetchSemanticsNodes().firstOrNull() ?: return false
        val range = node.config.getOrElseNullable(SemanticsProperties.VerticalScrollAxisRange) { null } ?: return false
        return range.value() < range.maxValue()
    }

    /** What a step holds below the screen, scrolled to its end and captured as [name]; nothing when it fits. */
    private fun captureRest(name: String) {
        val content = hasScrollAction() and !hasAnyAncestor(isDialog())
        if (!canScrollFurther(content)) return
        compose.onNode(content).performTouchInput { swipeUp() }
        compose.waitForIdle()
        capture(name)
    }

    private fun scrollToTop() {
        val content = hasScrollAction() and !hasAnyAncestor(isDialog())
        if (compose.onAllNodes(content).fetchSemanticsNodes().isEmpty()) return
        compose.onNode(content).performTouchInput { swipeDown() }
        compose.waitForIdle()
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
        // The call's line (its tag; "Voice call" alone would also find the header's button).
        val calledLine = SemanticsMatcher("a call line") { node -> node.config.getOrElseNullable(SemanticsProperties.TestTag) { null }?.startsWith("call.line.") == true }
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

    // MARK: - Paywall, packs and purchases

    @Test @Config(qualifiers = "+en") fun paywallEnglishLight() = paywall()
    @Test @Config(qualifiers = "+en-night") fun paywallEnglishDark() = paywall()
    @Test @Config(qualifiers = "+fa") fun paywallPersianLight() = paywall()
    @Test @Config(qualifiers = "+fa-night") fun paywallPersianDark() = paywall()

    /**
     * From the likes list's lock to the paywall, then every step of a
     * purchase on the sample store and server: pending, paid but the server
     * unreachable (queued), another account's, confirming, confirmed; the
     * store app missing; and the super likes' packs, bought.
     */
    private fun paywall() {
        flow = "e"
        start(signedIn = true)
        val graph = app.graph
        val billing = graph.billing as SampleBilling
        val sample = graph.api as SampleApi
        runBlocking { forgetPurchases() }

        val like = str(R.string.deck_action_like)
        waitFor(hasContentDescription(like) and isEnabled() and !hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        compose.onNodeWithText(str(R.string.tab_likes)).performClick()
        waitFor(hasText(str(R.string.likes_banner_title)), timeoutMs = 20_000)
        compose.onAllNodes(hasText(str(R.string.likes_banner_title)))[0].performClick()
        waitFor(hasText(str(R.string.upsell_see_plans)), timeoutMs = 10_000)
        compose.waitForIdle()
        captureWithSheet("upsell")
        compose.onNodeWithText(str(R.string.upsell_see_plans)).performClick()

        val subscribe = hasText(str(R.string.paywall_subscribe)) and hasAnyAncestor(isDialog())
        waitFor(subscribe, timeoutMs = 20_000)
        compose.waitForIdle()
        capture("paywall", compose.onNode(isDialog()))
        compose.onNode(hasScrollAction() and hasAnyAncestor(isDialog())).performTouchInput { swipeUp() }
        compose.waitForIdle()
        capture("paywall-periods", compose.onNode(isDialog()))

        // Paid in cash later: pending.
        billing.next = SampleBilling.Outcome.PENDING
        buy(subscribe)
        waitFor(hasText(str(R.string.paywall_step_pending_title)) and hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        scrollToEnd()
        capture("paywall-pending", compose.onNode(isDialog()))
        compose.runOnUiThread { graph.purchases.acknowledge() }

        // Another account's purchase.
        billing.next = SampleBilling.Outcome.OTHER_ACCOUNT
        buy(subscribe)
        waitFor(hasText(str(R.string.paywall_fail_other_account)) and hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        scrollToEnd()
        capture("paywall-failed", compose.onNode(isDialog()))
        compose.runOnUiThread { graph.purchases.acknowledge() }

        // Paid, and the network gone before the server answered: kept, sent again, confirmed once.
        billing.next = SampleBilling.Outcome.PURCHASED
        sample.purchasesUnreachable = true
        buy(subscribe)
        waitFor(hasText(str(R.string.paywall_step_queued_title)) and hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        scrollToEnd()
        capture("paywall-queued", compose.onNode(isDialog()))
        sample.purchasesUnreachable = false
        runBlocking { graph.purchases.flushNow() }
        waitFor(hasText(str(R.string.paywall_done_action)) and hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("paywall-done", compose.onNode(isDialog()))
        compose.onNode(hasText(str(R.string.paywall_done_action)) and hasAnyAncestor(isDialog())).performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }

        // The plan is shown with its renewal date and the store's page.
        compose.runOnUiThread { graph.paywall.plans(PaywallEntry.GENERAL) }
        waitFor(hasText(str(R.string.paywall_plan_current)) and hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("paywall-subscribed", compose.onNode(isDialog()))

        // The plan's own tab: the period bought is marked, and another is chosen.
        val plusName = graph.config.config.value?.planNames?.get("plus") ?: "Plus"
        compose.onNode(hasText(plusName) and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        val held = hasContentDescription(str(R.string.paywall_option_current), substring = true) and hasAnyAncestor(isDialog())
        waitFor(held, timeoutMs = 10_000, unmerged = false)
        compose.onNode(held).performScrollTo()
        compose.waitForIdle()
        capture("paywall-current-marked", compose.onNode(isDialog()))
        // Chosen, it is not sold again: a line in place of the button.
        compose.onNode(held).performClick()
        waitFor(hasText(str(R.string.paywall_current_option)) and hasAnyAncestor(isDialog()), timeoutMs = 10_000)
        compose.waitForIdle()
        capture("paywall-current-chosen", compose.onNode(isDialog()))

        // Restore with nothing new: the account had it all already (the other account's purchase is gone from the store).
        billing.removeOwned("foreign")
        compose.onNode(hasText(str(R.string.paywall_restore)) and hasAnyAncestor(isDialog())).performClick()
        waitFor(hasText(str(R.string.paywall_restore_up_to_date)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("paywall-restore-up-to-date", compose.onNode(isDialog()))
        compose.runOnUiThread { graph.paywall.close() }
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }

        // Another store account on this phone, holding another account's subscription of the same plan:
        // the plan is held elsewhere; no second one is sold.
        billing.switchStoreAccount(holdingAnotherAccountsPlan = true)
        compose.runOnUiThread { graph.paywall.plans(PaywallEntry.GENERAL) }
        waitFor(hasText(str(R.string.paywall_held_elsewhere, str(R.string.store_name))) and hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        waitFor(hasText(str(R.string.paywall_check_again)) and hasAnyAncestor(isDialog()), timeoutMs = 10_000)
        compose.waitForIdle()
        capture("paywall-elsewhere", compose.onNode(isDialog()))
        compose.runOnUiThread { graph.paywall.close() }
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }

        // A store account that lists nothing of the plan: Play says so (its list is the only word);
        // Cafe Bazaar's list can be empty for the holder itself, so its usual lock stays.
        billing.switchStoreAccount()
        compose.runOnUiThread { graph.paywall.plans(PaywallEntry.GENERAL) }
        val unlisted = if (AppBrand.store == Store.BAZAAR) {
            hasText(str(R.string.paywall_fail_change, str(R.string.store_name))) or hasText(str(R.string.paywall_current_option))
        } else {
            hasText(str(R.string.paywall_held_elsewhere, str(R.string.store_name)))
        }
        waitFor(unlisted and hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("paywall-unlisted", compose.onNode(isDialog()))
        compose.runOnUiThread { graph.paywall.close() }
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }

        // Super likes: the packs (sold whichever store account holds the plan), one bought, slowly enough to see it confirmed.
        compose.runOnUiThread { graph.paywall.packs(WalletItem.Superlike, PaywallEntry.OUT_OF_SUPERLIKES) }
        waitFor(hasText(str(R.string.packs_body_superlike)), timeoutMs = 20_000)
        compose.waitForIdle()
        captureWithSheet("packs")
        val five = app.resources.getQuantityString(R.plurals.packs_quantity_superlike, 5, Digits.localize("5", ui()))
        sample.purchaseDelayMs = 2_500
        compose.onAllNodes(hasContentDescription(five, substring = true) and hasClickAction())[0].performClick()
        waitFor(hasText(str(R.string.paywall_step_verifying, str(R.string.store_name))), timeoutMs = 10_000)
        compose.waitForIdle()
        captureWithSheet("packs-verifying")
        sample.purchaseDelayMs = 0
        waitFor(hasText(str(R.string.paywall_done_pack_title)), timeoutMs = 20_000)
        compose.waitForIdle()
        captureWithSheet("packs-done")
        compose.runOnUiThread { graph.paywall.close() }

        // The store app missing.
        billing.unavailable = BillingUnavailableReason.STORE_NOT_INSTALLED
        compose.runOnUiThread { graph.paywall.plans(PaywallEntry.BOOSTS) }
        waitFor(hasText(str(R.string.paywall_store_missing_title, str(R.string.store_name))) and hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("paywall-store-missing", compose.onNode(isDialog()))
        compose.runOnUiThread { graph.paywall.close() }
        billing.unavailable = null
        runBlocking { forgetPurchases() }
    }

    private fun ui(): AppLanguage = if (language == "fa") AppLanguage.FA else AppLanguage.EN

    /** Taps the paywall's button once the last step is cleared and it can be tapped again. */
    private fun buy(button: SemanticsMatcher) {
        waitFor(button and isEnabled(), timeoutMs = 10_000, unmerged = false)
        compose.onNode(button).performClick()
        compose.waitForIdle()
    }

    /** The paywall's steps sit under the periods: scrolled into view for the picture. */
    private fun scrollToEnd() {
        compose.onNode(hasScrollAction() and hasAnyAncestor(isDialog())).performTouchInput { swipeUp() }
        compose.waitForIdle()
    }

    /** Purchases this JVM's earlier tours left on the phone's storage (the outbox outlives a test). */
    private suspend fun forgetPurchases() {
        app.graph.secureStore.remove("billing.outbox")
        app.graph.secureStore.remove("billing.known")
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
                if (timeoutMs >= 5_000) {
                    if (DEBUG_DUMP) {
                        capture("debug")
                        println(compose.onAllNodes(isRoot())[0].printToString(Int.MAX_VALUE))
                    }
                    throw AssertionError("still waiting after $timeoutMs ms")
                }
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

    /**
     * The activity with each dialog window over it where the platform puts
     * it: centred, behind it the dim its window asks for (the compositor's
     * part, which no window's own pixels carry).
     */
    private fun captureWithDialog(name: String) {
        if (outDir == null) return
        compose.waitForIdle()
        val views = Shadow.extract<ShadowWindowManagerImpl>(compose.activity.windowManager).views
        val windows = views.mapNotNull { windowProvider(it)?.window }.distinct()
        check(windows.isNotEmpty()) { "no dialog window" }
        val screen = copy(compose.activity.window)
        val canvas = Canvas(screen)
        windows.forEach { window ->
            val attributes = window.attributes
            if (attributes.flags and WindowManager.LayoutParams.FLAG_DIM_BEHIND != 0) {
                canvas.drawColor(android.graphics.Color.argb((attributes.dimAmount * 255).toInt(), 0, 0, 0))
            }
            val layer = copy(window)
            canvas.drawBitmap(layer, (screen.width - layer.width) / 2f, (screen.height - layer.height) / 2f, null)
        }
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
