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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.assertIsNotEnabled
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
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
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
import app.core.brand.AppBrand
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.Numerals
import app.core.i18n.JalaliDate
import app.core.i18n.JalaliDates
import app.core.i18n.LocalAppName
import app.core.media.LocalRemoteImages
import app.core.model.AccountStatus
import app.core.model.CallKind
import app.core.model.SettingsPatch
import app.core.model.WalletItem
import app.core.feature.paywall.PaywallEntry
import app.core.feature.paywall.PaywallRequest
import app.core.store.BillingUnavailableReason
import app.core.store.SampleBilling
import app.core.store.Store
import app.core.model.Id
import app.core.feature.call.CallTags
import app.core.net.Backend
import app.core.net.SampleApi
import app.core.net.SampleData
import app.core.ui.nav.AppNavHost
import app.core.ui.LocalIoDispatcher
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import app.core.push.CallNotifications
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
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
import androidx.compose.runtime.getValue

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
 * `SCREENS_TEMPLATE` (`neon`, `white`) runs every tour in that template,
 * `SCREENS_FONT_SCALE` at that font scale, and `GALLERY_PHOTOS` draws real
 * photos ([TourPhotos]).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xhdpi")
class ScreenTourTest {

    @get:Rule(order = 0) val fontScale = TourFontScale()
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()

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
        SampleData.welcomeImages = emptyList()
        SampleData.photosHeldInReview = emptySet()
        SampleData.privateTextField = false
        SampleData.offer = SampleData.Offer.THREE
        TourPhotos.photoAliases = emptyMap()
    }

    // MARK: - Sign-in and sign-up

    @Test @Config(qualifiers = "+en") fun signInAndSignUpEnglishLight() = signInAndSignUp()
    @Test @Config(qualifiers = "+en-night") fun signInAndSignUpEnglishDark() = signInAndSignUp()
    @Test @Config(qualifiers = "+fa") fun signInAndSignUpPersianLight() = signInAndSignUp()
    @Test @Config(qualifiers = "+fa-night") fun signInAndSignUpPersianDark() = signInAndSignUp()
    @Test @Config(qualifiers = "+fa", fontScale = 1.5f) fun signInAndSignUpPersianLargeText() = signInAndSignUp()

    private fun signInAndSignUp() {
        flow = "a"
        // The catalogue gets a private short-text field, so the about-you step shows its text row as drawn.
        SampleData.privateTextField = true
        start(signedIn = false)

        waitFor(hasText(str(R.string.welcome_sign_up)))
        capture("welcome")
        compose.onNodeWithText(str(R.string.welcome_sign_up)).performClick()

        waitFor(hasText(str(R.string.privacy_title)))
        capture("privacy")
        compose.onNodeWithText(str(R.string.privacy_accept)).performClick()

        waitFor(hasText(str(R.string.auth_phone_title)))
        // The bazaar build's default dial code is +98; the play build follows the SIM (GB here, in English).
        val national = if (BuildConfig.STORE == "play" && language == "en") "7700900123" else "9127654321"
        compose.onNode(hasSetTextAction() and hasContentDescription(str(R.string.auth_phone_label))).performTextInput(national)
        waitFor(hasText(str(R.string.auth_send_code)) and isEnabled())
        capture("phone")
        compose.onNodeWithText(str(R.string.auth_send_code)).performClick()

        waitFor(hasText(str(R.string.auth_code_title)))
        val codeField = compose.onNodeWithContentDescription(str(R.string.auth_code_label, 6))
        codeField.performTextInput("123")
        compose.waitForIdle()
        capture("otp")
        codeField.performTextInput("456")

        // Sign-up, step by step, with the design's own person (his name, his answers, his photos when
        // GALLERY_PHOTOS is set): each step captured as its mockup shows it (`o01`…`o14`).
        val persian = language == "fa"
        waitFor(hasText(str(R.string.onboarding_name_title)), timeoutMs = 20_000)
        // Back from the first step asks before leaving sign-up; «نه، بمونم» stays.
        compose.onNode(hasContentDescription(str(R.string.ui_back)) and hasClickAction()).performClick()
        waitFor(hasText(str(R.string.dialog_sign_out_title)))
        captureWithDialog("o01-name-leave")
        compose.onNode(hasText(str(R.string.dialog_sign_out_stay)) and hasAnyAncestor(isDialog())).performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }
        compose.onNode(hasSetTextAction() and hasContentDescription(str(R.string.onboarding_name_title))).performTextInput(if (persian) "آرش" else "Arash")
        waitForNext()
        capture("o01-name")
        next()

        waitFor(hasText(str(R.string.onboarding_birthday_title)))
        compose.waitForIdle()
        // Nothing is chosen until a wheel moves: no age, «ادامه» off.
        compose.onNode(hasText(str(R.string.onboarding_continue)) and hasClickAction()).assertIsNotEnabled()
        capture("o02-birthday-untouched")
        // On the wheels, in the calendar shown (Solar Hijri in Persian; the longest month name in English), 25 years back.
        val ui = if (persian) AppLanguage.FA else AppLanguage.EN
        wheel(str(R.string.onboarding_birthday_day), 13)
        wheel(str(R.string.onboarding_birthday_month), if (persian) 1 else 8)
        wheel(str(R.string.onboarding_birthday_year), 75)
        waitForNext()
        val born = if (persian) {
            JalaliDates.toGregorian(JalaliDate(JalaliDates.toJalali(LocalDate.now()).year - 25, 2, 14))
        } else {
            LocalDate.of(LocalDate.now().year - 25, 9, 14)
        }
        val age = str(R.string.onboarding_birthday_age, Numerals.format(java.time.Period.between(born, LocalDate.now()).years, ui))
        waitFor(hasText(age, substring = true))
        capture("o02-birthday")
        next()
        // The date is asked about once more (the age and the date) before it is kept.
        val bornAge = Numerals.format(java.time.Period.between(born, LocalDate.now()).years, ui)
        waitFor(hasText(str(R.string.onboarding_birthday_confirm_title, bornAge)))
        captureWithDialog("o02-birthday-confirm")
        compose.onNode(hasText(str(R.string.onboarding_birthday_confirm_yes)) and hasAnyAncestor(isDialog())).performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }

        waitFor(hasText(str(R.string.onboarding_gender_title)), timeoutMs = 20_000)
        compose.onNodeWithText(str(R.string.gender_man)).performClick()
        waitForNext()
        capture("o03-gender")
        // Birth date and gender go to the server together.
        next()

        waitFor(hasText(str(R.string.onboarding_interest_title)), timeoutMs = 20_000)
        compose.onNodeWithText(str(R.string.interest_women)).performClick()
        waitForNext()
        capture("o04-interested-in")
        next()

        val catalog = checkNotNull(app.graph.config.config.value?.catalog) { "no catalogue" }
        waitFor(hasText(str(R.string.onboarding_goal_title)), timeoutMs = 20_000)
        val serious = catalog.intentions.firstOrNull { it.key == "serious" }?.label?.takeIf { it.isNotBlank() } ?: str(R.string.intention_serious)
        compose.onNodeWithText(serious).performClick()
        waitForNext()
        capture("o05-intention")
        next()

        // Photos: three pictures from the system picker, each framed and uploaded; the sample keeps the
        // third in review («در حال بررسی») and approves the others.
        waitFor(hasText(str(R.string.onboarding_photos_title)), timeoutMs = 20_000)
        capture("o06-photos-empty")
        val pictures = TourPhotos.files("people/arash-1.jpg", "people/arash-2.jpg", "people/arash-3.jpg")
            ?: listOf(
                Portrait(sky = 0xFF8EC5FC.toInt(), ground = 0xFFE0C3FC.toInt(), shirt = 0xFF2E7D6B.toInt(), hair = 0xFF3B2416.toInt()),
                Portrait(sky = 0xFFFFD3A5.toInt(), ground = 0xFFFD6585.toInt(), shirt = 0xFF283593.toInt(), hair = 0xFF1B1B1B.toInt()),
                Portrait(sky = 0xFFA8E6CF.toInt(), ground = 0xFF3D84A8.toInt(), shirt = 0xFFF9A825.toInt(), hair = 0xFF5D4037.toInt()),
            ).map { it.jpeg() }
        SampleData.photosHeldInReview = setOf(2)
        pickPhotos(pictures)
        val probes = pictures.map(::probe)
        val use = hasText(str(R.string.onboarding_crop_use)) and hasAnyAncestor(isDialog())
        val area = hasContentDescription(str(R.string.onboarding_crop_area)) and hasAnyAncestor(isDialog())
        repeat(pictures.size) { index ->
            waitFor(use, timeoutMs = 20_000)
            compose.waitForIdle()
            // The frame shows this turn's own picture as soon as it is up, never the one before it.
            val image = compose.onNode(area, useUnmergedTree = true).captureToImage().asAndroidBitmap()
            assertEquals("crop ${index + 1} shows another picture", index, closest(probes, probe(image)))
            if (index == 0) {
                // Zoomed a third of the way in, as the design draws the crop: the slider's fill shows.
                compose.onNode(hasContentDescription(str(R.string.onboarding_crop_zoom)) and hasAnyAncestor(isDialog()))
                    .performSemanticsAction(SemanticsActions.SetProgress) { it(CROP_ZOOM) }
                compose.waitForIdle()
                capture("o08-photo-crop", compose.onNode(isDialog()))
            }
            compose.onNode(use).performClick()
            compose.waitForIdle()
        }
        compose.waitUntil(20_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }
        val approved = hasLabel(str(R.string.photo_status_approved), substring = true)
        val review = hasText(str(R.string.photo_status_review))
        pump(30_000) {
            compose.onAllNodes(approved, useUnmergedTree = true).fetchSemanticsNodes().size == 2 &&
                compose.onAllNodes(review, useUnmergedTree = true).fetchSemanticsNodes().size == 1
        }
        waitForNext()
        capture("o07-photos-filled")
        SampleData.photosHeldInReview = emptySet()
        next()

        // Prompts: two picked from the catalogue's sheet and answered; the sheet captured with one answered.
        waitFor(hasText(str(R.string.onboarding_prompts_title)), timeoutMs = 20_000)
        capture("o09-prompts-empty")
        val prompts = catalog.prompts.filter { it.category != "voice" }
        val answers = if (persian) {
            listOf("یه هفته کوه‌پیمایی دور ماسوله، با یه کوله و یه دفترچه‌ی طراحی", "صبح زود دوچرخه، عصر کتاب‌فروشی، شب شام با دوستام")
        } else {
            listOf("A week of hiking around Masuleh with one backpack and a sketchbook", "An early bike ride, an afternoon in a bookshop, dinner with friends")
        }
        answers.forEachIndexed { index, answer ->
            // Activated as TalkBack would: Robolectric never finishes a touch ripple's exit (no render thread),
            // so a tap would leave it frozen on the row in the capture.
            compose.onNodeWithText(str(R.string.onboarding_prompts_add)).performScrollTo().performSemanticsAction(SemanticsActions.OnClick)
            waitFor(hasText(str(R.string.onboarding_prompts_pick)), timeoutMs = 10_000)
            compose.waitForIdle()
            compose.onNodeWithText(prompts[index].text).performClick()
            compose.waitForIdle()
            if (index == 1) captureWithSheet("o09b-prompts-pick")
            compose.onNode(hasText(str(R.string.onboarding_prompts_choose)) and hasClickAction()).performClick()
            waitFor(hasSetTextAction() and hasContentDescription(str(R.string.onboarding_prompts_answer)), timeoutMs = 10_000)
            compose.onNode(hasSetTextAction() and hasContentDescription(str(R.string.onboarding_prompts_answer))).performTextInput(answer)
        }
        // The touches' ripples fade out before the page is captured.
        compose.mainClock.advanceTimeBy(RIPPLE_MS)
        waitForNext()
        capture("o09-prompts")
        next()

        // The catalogue's fields: height on the slider, education, smoking, languages.
        waitFor(hasText(str(R.string.onboarding_fields_title)), timeoutMs = 20_000)
        capture("o10-fields-empty")
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress))
            .performSemanticsAction(SemanticsActions.SetProgress) { it(178f) }
        fun option(id: Int): String = catalog.fields.flatMap { it.options }.first { it.id == id }.label
        listOf(54, 21, 31, 33).forEach { compose.onNodeWithText(option(it)).performScrollTo().performSemanticsAction(SemanticsActions.OnClick) }
        compose.waitForIdle()
        waitFor(hasText(str(R.string.onboarding_fields_height, Numerals.format(178, ui))))
        scrollToTop()
        capture("o10-fields")
        captureRest("o10-fields-end")
        next()

        // Location: the city list first (looked at, then closed), then the phone's approximate position, which
        // passes the step.
        waitFor(hasText(str(R.string.onboarding_location_title)), timeoutMs = 20_000)
        capture("o11-location")
        compose.onNodeWithText(str(R.string.onboarding_location_by_city)).performClick()
        waitFor(hasText(str(R.string.onboarding_location_city_title)), timeoutMs = 10_000)
        compose.onAllNodes(hasSetTextAction())[0].performTextInput(if (persian) "اصف" else "Lon")
        val city = if (persian) "اصفهان" else "London"
        pump(10_000) { compose.onAllNodes(hasText(city) and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        captureWithSheet("o11-location-city")
        compose.onNode(hasContentDescription(str(R.string.action_close)) and SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss))
            .performSemanticsAction(SemanticsActions.Dismiss)
        compose.waitUntil(10_000) { compose.onAllNodes(hasText(str(R.string.onboarding_location_city_title))).fetchSemanticsNodes().isEmpty() }
        val elsewhere = BuildConfig.STORE == "play" && !persian
        allowCoarseLocation(if (elsewhere) 51.51 to -0.12 else 35.70 to 51.40)
        compose.onNodeWithText(str(R.string.onboarding_location_use)).performClick()

        // Notifications (Android 13+ asks): two switches, then the system's question, answered yes.
        val notifications = hasText(str(R.string.onboarding_notifications_title))
        val guidelines = hasText(str(R.string.onboarding_rules_title))
        waitFor(notifications or guidelines, timeoutMs = 20_000)
        if (compose.onAllNodes(notifications, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()) {
            compose.waitForIdle()
            capture("o12-notifications")
            shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
            compose.onNodeWithText(str(R.string.onboarding_notifications_allow)).performClick()
        }

        waitFor(guidelines, timeoutMs = 20_000)
        compose.waitForIdle()
        capture("o13-guidelines")
        compose.onNodeWithText(str(R.string.onboarding_rules_agree)).performClick()

        // Signed up: the person's own card, then the deck.
        waitFor(hasText(str(R.string.onboarding_done_go)), timeoutMs = 20_000)
        compose.waitForIdle()
        // The card's photo is decoded off the main thread: wait until it is drawn over the placeholder.
        val placeholder = (TourPhotos.template ?: Templates.of(if (dark) Templates.NEON else Templates.WHITE)).colors.photoPlaceholder.toArgb()
        pump(10_000) {
            val screen = compose.onAllNodes(isRoot())[0].captureToImage().asAndroidBitmap()
            screen.getPixel(screen.width / 2, screen.height / 4) != placeholder
        }
        capture("o14-done")
        compose.onNodeWithText(str(R.string.onboarding_done_go)).performClick()
        val like = str(R.string.deck_action_like)
        waitFor(hasContentDescription(like) and isEnabled() and !hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        val details = str(R.string.deck_action_details)
        waitFor(SemanticsMatcher("the top card") { node ->
            node.config.getOrElseNullable(SemanticsActions.CustomActions) { null }?.any { action -> action.label == details } == true
        }, timeoutMs = 20_000)
        compose.waitForIdle()
        capture("signup-done-deck")
    }

    /** The sign-up step's «ادامه», once it can be tapped. */
    private fun waitForNext() = waitFor(hasText(str(R.string.onboarding_continue)) and isEnabled() and hasClickAction(), timeoutMs = 20_000, unmerged = false)

    private fun next() {
        waitForNext()
        compose.onNode(hasText(str(R.string.onboarding_continue)) and isEnabled() and hasClickAction()).performClick()
    }

    /** Turns the birthday wheel labelled [label] to its row [index], as TalkBack would. */
    private fun wheel(label: String, index: Int) {
        compose.onNode(hasContentDescription(label) and SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress))
            .performSemanticsAction(SemanticsActions.SetProgress) { it(index.toFloat()) }
        compose.waitForIdle()
    }

    /** A picture's colour at a point the crop window shows whatever it frames: the middle, a twelfth down. */
    private fun probe(bytes: ByteArray): Int = probe(android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size))

    private fun probe(image: Bitmap): Int = image.getPixel(image.width / 2, image.height / 12)

    /** The index in [probes] nearest to [pixel]. */
    private fun closest(probes: List<Int>, pixel: Int): Int = probes.indices.minBy { i ->
        val dr = android.graphics.Color.red(probes[i]) - android.graphics.Color.red(pixel)
        val dg = android.graphics.Color.green(probes[i]) - android.graphics.Color.green(pixel)
        val db = android.graphics.Color.blue(probes[i]) - android.graphics.Color.blue(pixel)
        dr * dr + dg * dg + db * db
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

    // MARK: - The Profile tab, editing, settings, deleting

    @Test @Config(qualifiers = "+en") fun profileTabEnglishLight() = profileTab()
    @Test @Config(qualifiers = "+en-night") fun profileTabEnglishDark() = profileTab()
    @Test @Config(qualifiers = "+fa") fun profileTabPersianLight() = profileTab()
    @Test @Config(qualifiers = "+fa-night") fun profileTabPersianDark() = profileTab()
    @Test @Config(qualifiers = "+fa", fontScale = 1.5f) fun profileTabPersianLargeText() = profileTab()
    @Test @Config(qualifiers = "+fa") fun restrictedPersian() = restricted()
    @Test @Config(qualifiers = "+en") fun restrictedEnglish() = restricted()
    @Test @Config(qualifiers = "+fa") fun restorePersian() = restore()

    /** The design's own photos for the staged profile ([SampleApi.stageOwnProfile]). */
    private val ownPhotos = mapOf(
        "8101" to "people/p-arash.jpg",
        "8102" to "people/arash-2.jpg",
        "8103" to "people/arash-3.jpg",
        "8104" to "people/arash-4.jpg",
    )

    /**
     * The account's own screens as the design draws them: the Profile tab
     * (m16) and its preview, the editor (m17) with a question's sheet,
     * Settings (m18) with its language, notifications, privacy, account,
     * help and legal sheets and the licences, and deleting the account (m20).
     */
    private fun profileTab() {
        flow = "p"
        TourPhotos.photoAliases = ownPhotos + boardPhotos
        // The likes and chats around the account, so the tab bar carries the Likes count and the Chats dot as m16 does.
        start(signedIn = true, chat = true) { sample ->
            runBlocking {
                sample.stageOwnProfile()
                sample.stageSocialBoards(premium = false)
            }
        }
        // The number this phone signed in with, as an OTP sign-in leaves it (the Account row's value).
        runBlocking { app.graph.preferences.rememberSignIn("+989123456789") }

        val like = str(R.string.deck_action_like)
        waitFor(hasContentDescription(like) and isEnabled() and !hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        // The likes page is read once (its total is the tab's count).
        tab(R.string.tab_likes)
        waitFor(hasText(str(R.string.likes_see_all)), timeoutMs = 20_000)
        tab(R.string.tab_profile)
        waitFor(hasText(str(R.string.me_edit)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("m16-my-profile")
        captureRest("m16-my-profile-end")
        scrollToTop()

        compose.onNodeWithText(str(R.string.me_preview)).performClick()
        waitFor(isDialog(), timeoutMs = 10_000)
        compose.waitForIdle()
        capture("m16-preview", compose.onNode(isDialog()))
        compose.onAllNodes(hasContentDescription(str(R.string.profile_view_close)) and hasAnyAncestor(isDialog()))[0].performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }

        compose.onNodeWithText(str(R.string.me_edit)).performClick()
        waitFor(hasText(str(R.string.edit_photos)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("m17-edit-profile")
        captureRest("m17-edit-profile-end")
        scrollToTop()
        val answer = if (language == "fa") "یه هفته کوه‌پیمایی دور ماسوله، با یه کوله" else "A week hiking around Masuleh with one backpack"
        compose.onNodeWithText(answer).performClick()
        waitFor(hasText(str(R.string.edit_save)), timeoutMs = 10_000)
        captureWithSheet("m17-answer-sheet")
        dismissSheet()
        compose.onNodeWithContentDescription(str(R.string.action_back)).performClick()
        waitFor(hasText(str(R.string.me_edit)), timeoutMs = 20_000)

        compose.onAllNodes(hasContentDescription(str(R.string.settings_title)) and hasClickAction())[0].performClick()
        waitFor(hasText(str(R.string.settings_template)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("m18-settings")
        captureRest("m18-settings-end")
        scrollToTop()
        val list = hasScrollAction() and !hasAnyAncestor(isDialog())
        for ((row, name) in listOf(
            R.string.settings_language to "m18-language",
            R.string.settings_notifications to "m18-notifications",
            R.string.settings_privacy to "m18-privacy",
            R.string.settings_account to "m18-account",
            R.string.settings_help to "m18-help",
        )) {
            openSheet(list, str(row))
            captureWithSheet(name)
            dismissSheet()
        }
        openSheet(list, str(R.string.settings_legal))
        captureWithSheet("m18-legal")
        compose.onNode(hasText(str(R.string.settings_licences)) and hasAnyAncestor(isDialog())).performSemanticsAction(SemanticsActions.OnClick)
        // Read off the main thread when the sheet opens.
        waitFor(hasText("Open Font License", substring = true), timeoutMs = 20_000)
        captureWithSheet("m18-licences")
        dismissSheet()

        compose.onNode(list).performScrollToNode(hasText(str(R.string.action_sign_out)))
        compose.onNode(hasText(str(R.string.action_sign_out)) and !hasAnyAncestor(isDialog())).performClick()
        waitFor(isDialog())
        captureWithDialog("m18-sign-out")
        compose.onNode(hasText(str(R.string.dialog_sign_out_stay)) and hasAnyAncestor(isDialog())).performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }

        // A plan of this store that keeps renewing: the delete screen names it.
        runBlocking { (app.graph.api as SampleApi).stageOwnProfile(subscription = true) }
        compose.onNode(list).performScrollToNode(hasText(str(R.string.settings_delete)))
        compose.onNodeWithText(str(R.string.settings_delete)).performClick()
        waitFor(hasText(str(R.string.delete_title)), timeoutMs = 20_000)
        waitFor(hasText(str(R.string.delete_sub)), timeoutMs = 10_000)
        compose.waitForIdle()
        capture("m20-delete-account")
    }

    /** A suspended account (m19): the reason, until when, the appeal, the renewing plan, sign out and delete. */
    private fun restricted() {
        flow = "r"
        TourPhotos.photoAliases = ownPhotos
        val reason = if (language == "fa") "پیام‌های توهین‌آمیز، طبق گزارش چند نفر" else "Insulting messages, reported by several people"
        start(signedIn = true) { sample ->
            runBlocking {
                sample.stageOwnProfile(subscription = true)
                sample.setAccountStatus(AccountStatus.Suspended, reason = reason)
            }
        }
        waitFor(hasText(str(R.string.restricted_suspended_title)), timeoutMs = 20_000)
        waitFor(hasText(reason), timeoutMs = 20_000)
        waitFor(hasText(str(R.string.restricted_billing)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("m19-restricted")
        compose.onNodeWithText(str(R.string.settings_delete)).performClick()
        waitFor(hasText(str(R.string.delete_title)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("m20-delete-from-restricted")
    }

    /** A deleted account signed in inside its grace period: when it goes for good, and bringing it back. */
    private fun restore() {
        flow = "d"
        start(signedIn = true) { sample -> runBlocking { sample.deleteAccount() } }
        waitFor(hasText(str(R.string.restore_title)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("restore")
        compose.onNodeWithText(str(R.string.restore_action)).performClick()
        waitFor(hasContentDescription(str(R.string.deck_action_like)) and isEnabled(), timeoutMs = 20_000)
    }

    /** Scrolls Settings to the row titled [title] and opens its sheet. */
    private fun openSheet(list: SemanticsMatcher, title: String) {
        compose.onNode(list).performScrollToNode(hasText(title))
        // As TalkBack would (a touch leaves its ripple's last frame in Robolectric's drawing).
        compose.onNode(hasText(title) and !hasAnyAncestor(isDialog())).performSemanticsAction(SemanticsActions.OnClick)
        waitFor(hasText(title) and hasAnyAncestor(isDialog()))
        compose.waitForIdle()
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
        TourPhotos.photoAliases = deckFaces
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
        compose.onNodeWithText(str(R.string.match_later)).performScrollTo().performClick()
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
        compose.onNode(hasScrollAction() and hasAnyAncestor(isDialog())).performScrollToIndex(1)
        compose.waitForIdle()
        capture("profile-2", compose.onNode(isDialog()))
        compose.onNodeWithContentDescription(str(R.string.profile_view_close)).performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }

        compose.onNodeWithText(str(R.string.tab_likes)).performClick()
        waitFor(hasText(str(R.string.likes_see_all)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("likes")
    }

    // MARK: - The deck's screens, as the design draws them

    @Test @Config(qualifiers = "+fa") fun deckScreensPersian() = deckScreens()
    @Test @Config(qualifiers = "+en") fun deckScreensEnglish() = deckScreens()
    @Test @Config(qualifiers = "+fa", fontScale = 1.3f) fun deckScreensPersianLargeText() = deckScreens()

    /**
     * The deck (m01), its filters (m03), a card's full profile (m04) and its
     * details (m05) down to their end, its «بیشتر» sheet, the like on one
     * photo (m06), the match with its openers (m07) and the end of the deck
     * (m02), then the same pane offline, failing and snoozed, with the
     * design's own people where `GALLERY_PHOTOS` has them.
     */
    private fun deckScreens() {
        flow = "e"
        // The sample deck opens on Mahsa (she likes this account, as m01 draws her); Nazanin has answers and facts.
        TourPhotos.photoAliases = deckFaces + mapOf(
            "9112" to "people/p-elnaz.jpg",
            "9121" to "people/p-sara.jpg",
            "9122" to "photos/hd-1623577840329-201565179c92.jpg",
            "9123" to "people/p-nazanin.jpg",
            "8001" to "people/p-arash.jpg",
        )
        start(signedIn = true)
        val like = str(R.string.deck_action_like)
        val details = str(R.string.deck_action_details)
        val onDeck = !hasAnyAncestor(isDialog())
        waitFor(hasContentDescription(like) and isEnabled() and onDeck, timeoutMs = 20_000)
        val card = SemanticsMatcher("the top card") { node ->
            node.config.getOrElseNullable(SemanticsActions.CustomActions) { null }?.any { action -> action.label == details } == true
        }
        waitFor(card)
        // The likes list once, so the Likes tab carries its count as the design draws it.
        compose.onNodeWithText(str(R.string.tab_likes)).performClick()
        waitFor(hasText(str(R.string.likes_see_all)), timeoutMs = 20_000)
        compose.onNodeWithText(str(R.string.tab_discover)).performClick()
        waitFor(hasContentDescription(like) and isEnabled() and onDeck, timeoutMs = 20_000)
        waitFor(card)
        capture("m01-deck")

        // The filters, over the deck.
        compose.onNodeWithContentDescription(str(R.string.deck_filters)).performClick()
        waitFor(hasText(str(R.string.filters_apply)))
        captureWithSheet("m03-filters")
        dismissSheet()

        // The first card already likes this account: liking it is a match.
        compose.onNode(hasContentDescription(like) and onDeck).performClick()
        waitFor(hasText(str(R.string.match_title)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("m07-match", compose.onNode(isDialog()))
        compose.onNodeWithText(str(R.string.match_later)).performScrollTo().performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }

        // A profile with an answer and facts (the sample's Nazanin), passing the cards before it.
        val pass = hasContentDescription(str(R.string.deck_action_pass)) and isEnabled() and onDeck
        val withAnswers = card and hasContentDescription("نازنین", substring = true)
        repeat(MAX_PASSES) {
            if (compose.onAllNodes(withAnswers).fetchSemanticsNodes().isEmpty() && compose.onAllNodes(pass).fetchSemanticsNodes().isNotEmpty()) {
                compose.onNode(pass).performClick()
                compose.waitForIdle()
            }
        }
        waitFor(withAnswers)
        compose.onNode(withAnswers).performCustomAccessibilityActionWithLabel(details)
        waitFor(isDialog())
        capture("m04-profile", compose.onNode(isDialog()))
        val page = hasScrollAction() and hasAnyAncestor(isDialog())
        compose.onNode(page).performScrollToIndex(1)
        compose.waitForIdle()
        capture("m05-details", compose.onNode(isDialog()))
        // Its end: the last photo, then report / block clear of pass and like.
        compose.onNode(page).performScrollToNode(hasText(str(R.string.profile_block)))
        repeat(2) { compose.onNode(page).performTouchInput { swipeUp() } }
        compose.waitForIdle()
        capture("m05-details-end", compose.onNode(isDialog()))
        // «بیشتر»: write to them, report, block.
        compose.onAllNodes(hasContentDescription(str(R.string.profile_view_more)) and hasAnyAncestor(isDialog()))[0].performClick()
        waitFor(hasText(str(R.string.request_write_to)))
        captureWithSheet("m05-more")
        dismissSheet()
        val second = str(R.string.profile_view_photo, Numerals.format(2, ui()), Numerals.format(3, ui()))
        compose.onNode(page).performScrollToNode(hasContentDescription(second))
        compose.onNodeWithContentDescription(second).performClick()
        waitFor(hasText(str(R.string.like_item_send)))
        captureWithSheet("m06-like-photo")
        dismissSheet()
        compose.onAllNodes(hasContentDescription(str(R.string.profile_view_close)) and hasAnyAncestor(isDialog()))[0].performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }

        // Everyone within the filters, passed: the end of the deck.
        val end = hasText(str(R.string.deck_exhausted_title))
        repeat(MAX_PASSES) {
            if (compose.onAllNodes(end).fetchSemanticsNodes().isEmpty() && compose.onAllNodes(pass).fetchSemanticsNodes().isNotEmpty()) {
                compose.onNode(pass).performClick()
                compose.waitForIdle()
            }
        }
        waitFor(end, timeoutMs = 20_000)
        capture("m02-deck-empty")

        // The same pane when the deck cannot be shown: offline, a server failure, snoozed.
        val sample = app.graph.api as SampleApi
        val paneButton = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button) and
            SemanticsMatcher.keyIsDefined(SemanticsProperties.Text) and onDeck
        sample.deckOutage = SampleApi.DeckOutage.Offline
        compose.onAllNodes(paneButton)[0].performClick()
        waitFor(hasText(str(R.string.error_offline)), timeoutMs = 20_000)
        capture("m02-offline")
        sample.deckOutage = SampleApi.DeckOutage.Failed
        compose.onNodeWithText(str(R.string.action_try_again)).performClick()
        waitFor(hasText(str(R.string.deck_failed)), timeoutMs = 20_000)
        capture("m02-failed")
        sample.deckOutage = null
        runBlocking { sample.updateSettings(SettingsPatch(snoozed = true)) }
        compose.onNodeWithText(str(R.string.action_try_again)).performClick()
        waitFor(hasText(str(R.string.deck_snoozed_title)), timeoutMs = 20_000)
        capture("m02-snoozed")
        compose.onNodeWithText(str(R.string.deck_snoozed_action)).performClick()
        compose.waitForIdle()
    }

    /** Closes the bottom sheet in front, as dragging it down would (its grabber's dismiss action). */
    private fun dismissSheet() {
        val grabber = hasContentDescription(str(R.string.action_close)) and SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)
        compose.onAllNodes(grabber)[0].performSemanticsAction(SemanticsActions.Dismiss)
        compose.waitForIdle()
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
        // The deck's first card (the match) wears the same face in the thread as on the deck.
        TourPhotos.photoAliases = deckFaces
        start(signedIn = true, chat = true)

        val like = str(R.string.deck_action_like)
        waitFor(hasContentDescription(like) and isEnabled() and !hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        compose.onNode(hasContentDescription(like) and !hasAnyAncestor(isDialog())).performClick()
        waitFor(hasText(str(R.string.match_title)), timeoutMs = 20_000)

        // The first message goes from the match screen's own composer, then its thread opens.
        val text = if (language == "fa") "سلام! عکس‌های کوهت عالی بود" else "Hi! Your mountain photos are great"
        compose.onNode(hasSetTextAction() and hasAnyAncestor(isDialog())).performScrollTo().performTextInput(text)
        capture("match-typed", compose.onNode(isDialog()))
        compose.onNodeWithContentDescription(str(R.string.match_send)).performScrollTo().performClick()
        waitFor(hasSetTextAction() and !hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        // The bubble reaches the server: "sent" (or further) replaces "sending".
        val sent = listOf(R.string.chat_status_sent, R.string.chat_status_delivered, R.string.chat_status_read).map(::str)
        val onServer = SemanticsMatcher("own bubble on the server") { node ->
            node.config.getOrElseNullable(SemanticsProperties.ContentDescription) { null }
                ?.any { d -> d.contains(text) && sent.any { d.endsWith(it) } } == true
        }
        waitFor(onServer, timeoutMs = 20_000)
        // The thread's top line is there before the picture (the conversation row arrives after the message).
        waitFor(hasText(str(R.string.chat_matched_today)), timeoutMs = 20_000)
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
        // "Write to them" is in the profile's overflow sheet.
        val more = hasContentDescription(str(R.string.profile_view_more)) and hasClickAction() and hasAnyAncestor(isDialog())
        waitFor(more)
        compose.onAllNodes(more)[0].performClick()
        val write = hasLabel(str(R.string.request_write_to)) and hasClickAction()
        waitFor(write, unmerged = false)
        compose.onNode(write).performClick()
        waitFor(hasText(str(R.string.request_send_hint)), timeoutMs = 10_000)
        // The sheet's field: the last one on screen.
        val fields = compose.onAllNodes(hasSetTextAction() and hasAnyAncestor(isDialog()))
        fields[fields.fetchSemanticsNodes().lastIndex].performTextInput(if (language == "fa") "سلام! عکس کوهت عالیه" else "Hi! Love the mountain photo")
        compose.waitForIdle()
        captureWithSheet("request-write")
    }

    // MARK: - The social boards, as the design draws them

    @Test @Config(qualifiers = "+fa") fun socialScreensPersian() = socialScreens()
    @Test @Config(qualifiers = "+en") fun socialScreensEnglish() = socialScreens()
    @Test @Config(qualifiers = "+fa", fontScale = 1.3f) fun socialScreensPersianLargeText() = socialScreens()
    @Test @Config(qualifiers = "+fa") fun lockedLikesPersian() = lockedLikes()
    @Test @Config(qualifiers = "+en") fun lockedLikesEnglish() = lockedLikes()

    /** The board people's photos ([SampleData.boardPeople]): the design's own, where `GALLERY_PHOTOS` has them. */
    /**
     * One face per deck person across the tours: the first card (Mahsa, as m01
     * draws her) and the men, so a likes tile or a thread never shows someone
     * under another's name or a stranger's face.
     */
    private val deckFaces = mapOf(
        "9111" to "people/p-mahsa.jpg",
        "9071" to "faces/m4.jpg",
        "9081" to "faces/m2.jpg",
    )

    private val boardPhotos = listOf("yasaman", "reyhaneh", "parya", "negar", "sara", "elnaz", "hasti", "kiana", "mahsa", "nazanin", "shida", "tarane")
        .mapIndexed { i, name -> (9201 + i).toString() to "people/p-$name.jpg" }.toMap()

    /** m08: the free plan's likes: the day's free look open, the rest blurred, one button to the plans. */
    /**
     * Switches tabs as TalkBack would (the semantics click): a touch would
     * leave its ripple's last fade frame in Robolectric's drawing, a grey
     * cell that a phone redraws away.
     */
    private fun tab(label: Int) {
        compose.onNodeWithText(str(label)).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
    }

    private fun lockedLikes() {
        flow = "s"
        TourPhotos.photoAliases = boardPhotos
        start(signedIn = true) { sample ->
            // The blurred tiles blur the board people's own photos, as the server's blurhash would.
            sample.blurhashOf = { id -> TourPhotos.blurhashFor(id) }
            runBlocking { sample.stageSocialBoards(premium = false) }
        }
        val like = str(R.string.deck_action_like)
        waitFor(hasContentDescription(like) and isEnabled() and !hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        tab(R.string.tab_likes)
        waitFor(hasText(str(R.string.likes_see_all)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("m08-likes-locked")
    }

    /**
     * The staged boards on the premium plan: every like open (m08b), the
     * chats with someone typing (m09), her thread (m10), a voice call and a
     * video call placed from it with the microphone off (m13), her ring
     * (m12) and the requests (m11).
     */
    private fun socialScreens() {
        flow = "s"
        TourPhotos.photoAliases = boardPhotos
        var boards: SampleApi.SocialBoards? = null
        start(signedIn = true, chat = true, calls = true) { sample -> boards = runBlocking { sample.stageSocialBoards(premium = true) } }
        val talking = boards!!.talking
        val graph = app.graph
        val sample = graph.api as SampleApi
        val like = str(R.string.deck_action_like)
        waitFor(hasContentDescription(like) and isEnabled() and !hasAnyAncestor(isDialog()), timeoutMs = 20_000)

        tab(R.string.tab_likes)
        waitFor(hasLabel("یاسمن", substring = true), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("m08b-likes-open")

        tab(R.string.tab_chats)
        val mahsa = hasLabel("مهسا", substring = true) and hasClickAction()
        waitFor(mahsa, timeoutMs = 20_000, unmerged = false)
        runBlocking { sample.peerTyping(talking) }
        waitFor(hasLabel(str(R.string.chat_typing), substring = true), timeoutMs = 10_000, unmerged = false)
        capture("m09-chats")

        compose.onAllNodes(mahsa)[0].performClick()
        waitFor(hasSetTextAction(), timeoutMs = 20_000)
        waitFor(hasLabel("صدات خیلی آرومه", substring = true), timeoutMs = 20_000, unmerged = false)
        runBlocking { sample.peerTyping(talking) }
        waitFor(hasLabel(str(R.string.chat_typing_a11y, "مهسا"), substring = true), timeoutMs = 10_000, unmerged = false)
        capture("m10-chat")

        // A voice call from the header, live; then a video call with the microphone off.
        val voice = hasLabel(str(R.string.call_header_audio, "مهسا"))
        val video = hasLabel(str(R.string.call_header_video, "مهسا"))
        waitFor(voice and hasClickAction(), timeoutMs = 20_000, unmerged = false)
        compose.onNode(voice and hasClickAction()).performClick()
        waitForLive()
        capture("m13b-voice-call")
        hangUp()
        compose.onNode(video and hasClickAction()).performClick()
        waitForLive()
        compose.onNodeWithTag(CallTags.MUTE).performClick()
        compose.waitForIdle()
        capture("m13-video-call")
        hangUp()

        // Her ring, opened from its notification.
        val ring = runBlocking { sample.ringFrom(talking, CallKind.Video) }
        openRing(ring.id)
        waitFor(hasText(str(R.string.call_status_incoming_video)), timeoutMs = 10_000)
        compose.waitForIdle()
        capture("m12-incoming-call")
        compose.onNodeWithTag(CallTags.DECLINE).performClick()
        pump(10_000) { graph.calls.controller.session.value == null }

        compose.onNodeWithContentDescription(str(R.string.action_back)).performClick()
        val requests = hasContentDescription(str(R.string.chat_requests), substring = true) and hasClickAction()
        waitFor(requests, timeoutMs = 20_000)
        compose.onAllNodes(requests)[0].performClick()
        waitFor(hasText(str(R.string.requests_accept)), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("m11-requests")
    }

    // MARK: - Paywall, packs and purchases

    @Test @Config(qualifiers = "+en") fun paywallEnglishLight() = paywall()
    @Test @Config(qualifiers = "+en-night") fun paywallEnglishDark() = paywall()
    @Test @Config(qualifiers = "+fa") fun paywallPersianLight() = paywall()
    @Test @Config(qualifiers = "+fa-night") fun paywallPersianDark() = paywall()
    @Test @Config(qualifiers = "+fa") fun paywallBoardsPersian() = paywallBoards()
    @Test @Config(qualifiers = "+en") fun paywallBoardsEnglish() = paywallBoards()
    @Test @Config(qualifiers = "+fa", fontScale = 1.3f) fun paywallBoardsPersianLargeText() = paywallBoards()
    @Test @Config(qualifiers = "fa-w360dp-h780dp-xhdpi", fontScale = 1.3f) fun paywallBoardsNarrowPersianLargeText() = paywallBoards(flow = "n")
    @Test @Config(qualifiers = "en-w360dp-h780dp-xhdpi", fontScale = 1.5f) fun paywallBoardsNarrowEnglishLargeText() = paywallBoards(flow = "n")
    @Test @Config(qualifiers = "+tr", fontScale = 1.5f) fun paywallBoardsTurkishLargeText() = paywallBoards()

    /** The paywall's purchase button, whatever price it carries («ادامه با …», "Continue for …"). */
    private val payButton: SemanticsMatcher get() = hasText(str(R.string.paywall_cta, "").trim(), substring = true) and hasAnyAncestor(isDialog())

    /** The packs sheet's button, whichever form its price takes (toman, or a store currency). */
    private val buyPackButton: SemanticsMatcher
        get() = (hasText(str(R.string.packs_buy, "").trim(), substring = true) or hasText(str(R.string.packs_buy_store_price, "").trim(), substring = true)) and hasClickAction()

    /** The paywall's button for a subscriber: the purchase, or the store's page while the plan cannot be changed here. */
    private val payOrManage: SemanticsMatcher
        get() = (hasText(str(R.string.paywall_cta, "").trim(), substring = true) or hasText(str(R.string.manage_subscription))) and hasClickAction() and hasAnyAncestor(isDialog())

    /**
     * From the likes list's one button to the paywall, then every step of a
     * purchase on the sample store and server: pending, another account's,
     * paid but the server unreachable (queued), confirmed; the plan held, its
     * period marked and its store page; restore; held on another store
     * account; the super likes' packs, bought; the store app missing.
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
        waitFor(hasText(str(R.string.likes_see_all)), timeoutMs = 20_000)
        // The lock's one button goes straight to the plans (no sheet between).
        compose.onNode(hasText(str(R.string.likes_see_all))).performScrollTo().performClick()

        waitFor(payButton, timeoutMs = 20_000, unmerged = false)
        compose.waitForIdle()
        capture("paywall", compose.onNode(isDialog()))

        // Paid in cash later: pending.
        billing.next = SampleBilling.Outcome.PENDING
        buy(payButton)
        waitFor(hasText(str(R.string.paywall_step_pending)) and hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        capture("paywall-pending", compose.onNode(isDialog()))
        compose.runOnUiThread { graph.purchases.acknowledge() }

        // Another account's purchase.
        billing.next = SampleBilling.Outcome.OTHER_ACCOUNT
        buy(payButton)
        waitFor(hasText(str(R.string.paywall_fail_other_account)) and hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        capture("paywall-failed", compose.onNode(isDialog()))
        compose.runOnUiThread { graph.purchases.acknowledge() }

        // Paid, and the network gone before the server answered: kept, sent again, confirmed once.
        billing.next = SampleBilling.Outcome.PURCHASED
        sample.purchasesUnreachable = true
        buy(payButton)
        waitFor(hasText(str(R.string.paywall_step_queued)) and hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        capture("paywall-queued", compose.onNode(isDialog()))
        sample.purchasesUnreachable = false
        runBlocking { graph.purchases.flushNow() }
        waitFor(hasText(str(R.string.paywall_done_action)) and hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("paywall-done", compose.onNode(isDialog()))
        compose.onNode(hasText(str(R.string.paywall_done_action)) and hasAnyAncestor(isDialog())).performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }

        // The plan held: the paywall opens on the plan above it (on Cafe Bazaar, not sold until the plan ends: the store's page).
        val held = graph.entitlements.entitlements.value?.plan ?: "premium"
        compose.runOnUiThread { graph.paywall.plans(PaywallEntry.GENERAL) }
        waitFor(payOrManage, timeoutMs = 20_000, unmerged = false)
        compose.waitForIdle()
        capture("paywall-subscribed", compose.onNode(isDialog()))

        // The held plan's own tab: the period bought is marked; chosen, its button is the store's page.
        val heldName = SampleData.plan(held)?.names?.let { if (language == "fa") it.first else it.second } ?: held
        compose.onNode(hasText(heldName) and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        val marked = hasText(str(R.string.paywall_option_current), substring = true) and hasClickAction() and hasAnyAncestor(isDialog())
        waitFor(marked, timeoutMs = 10_000, unmerged = false)
        compose.waitForIdle()
        capture("paywall-current-marked", compose.onNode(isDialog()))
        compose.onNode(marked).performClick()
        waitFor(hasText(str(R.string.manage_subscription)) and hasAnyAncestor(isDialog()), timeoutMs = 10_000)
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
            hasText(str(R.string.paywall_locked))
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
        val buyPack = buyPackButton
        waitFor(buyPack, timeoutMs = 20_000, unmerged = false)
        compose.waitForIdle()
        captureWithSheet("packs")
        val five = app.resources.getQuantityString(R.plurals.packs_quantity_superlike, 5, Digits.localize("5", ui()))
        compose.onAllNodes(hasContentDescription(five, substring = true) and hasClickAction())[0].performClick()
        sample.purchaseDelayMs = 2_500
        compose.onNode(buyPack).performClick()
        waitFor(hasText(str(R.string.paywall_step_verifying, str(R.string.store_name))), timeoutMs = 10_000)
        compose.waitForIdle()
        captureWithSheet("packs-verifying")
        sample.purchaseDelayMs = 0
        waitFor(hasText(str(R.string.packs_done, five)), timeoutMs = 20_000)
        compose.waitForIdle()
        captureWithSheet("packs-done")
        compose.runOnUiThread { graph.paywall.close() }

        // The store app missing.
        billing.unavailable = BillingUnavailableReason.STORE_NOT_INSTALLED
        compose.runOnUiThread { graph.paywall.plans(PaywallEntry.BOOSTS) }
        waitFor(hasText(str(R.string.paywall_fail_store_missing, str(R.string.store_name))) and hasAnyAncestor(isDialog()), timeoutMs = 20_000)
        compose.waitForIdle()
        capture("paywall-store-missing", compose.onNode(isDialog()))
        compose.runOnUiThread { graph.paywall.close() }
        billing.unavailable = null
        runBlocking { forgetPurchases() }
    }

    /**
     * The design's boards (m14, h06, h06-two, h06-many, m15) on the sample
     * store, nothing bought: three plans from the profile's row (m14), the
     * same from the likes list with its count and the year chosen (h06), two
     * plans with the month chosen (h06-two), five plans out of likes (the
     * rail, h06-many), and the super likes' packs over the deck with one held
     * (m15), then the boosts.
     */
    private fun paywallBoards(flow: String = "w") {
        this.flow = flow
        start(signedIn = true)
        val graph = app.graph
        val sample = graph.api as SampleApi
        runBlocking { forgetPurchases() }
        val like = str(R.string.deck_action_like)
        waitFor(hasContentDescription(like) and isEnabled() and !hasAnyAncestor(isDialog()), timeoutMs = 20_000)

        fun open(request: PaywallRequest, name: String, then: () -> Unit = {}) {
            compose.runOnUiThread { graph.paywall.open(request) }
            waitFor(payButton, timeoutMs = 20_000, unmerged = false)
            then()
            compose.waitForIdle()
            capture(name, compose.onNode(isDialog()))
            compose.runOnUiThread { graph.paywall.close() }
            compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }
        }
        fun choose(period: String) {
            compose.onNode(hasText(period) and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
            compose.waitForIdle()
        }
        fun months(n: Int) = app.resources.getQuantityString(R.plurals.paywall_months, n, Digits.localize("$n", ui()))

        SampleData.offer = SampleData.Offer.THREE
        open(PaywallRequest.Plans(PaywallEntry.GENERAL), "m14-paywall")
        open(PaywallRequest.Plans(PaywallEntry.SEE_LIKES, likes = 12), "h06-paywall") { choose(months(12)) }
        SampleData.offer = SampleData.Offer.TWO
        open(PaywallRequest.Plans(PaywallEntry.GENERAL), "h06-paywall-two") { choose(months(1)) }
        SampleData.offer = SampleData.Offer.MANY
        open(PaywallRequest.Plans(PaywallEntry.OUT_OF_LIKES), "h06-paywall-many")
        SampleData.offer = SampleData.Offer.THREE

        runBlocking { sample.stageWallet(superlikes = 1) }
        compose.runOnUiThread { graph.paywall.packs(WalletItem.Superlike, PaywallEntry.OUT_OF_SUPERLIKES) }
        val buyPack = buyPackButton
        waitFor(buyPack, timeoutMs = 20_000, unmerged = false)
        compose.waitForIdle()
        captureWithSheet("m15-packs-sheet")
        compose.onNode(hasText(str(R.string.packs_tab_boost)) and hasClickAction()).performClick()
        waitFor(hasText(str(R.string.packs_title_boost)), timeoutMs = 10_000)
        compose.waitForIdle()
        captureWithSheet("m15-packs-boosts")
        compose.runOnUiThread { graph.paywall.close() }
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

    private fun start(signedIn: Boolean, chat: Boolean = false, calls: Boolean = false, stage: (SampleApi) -> Unit = {}) {
        System.setProperty(Backend.SAMPLE_PROPERTY, "true")
        // The app's own language setting (Cafe Bazaar's build would otherwise stay Persian).
        app.getSystemService(LocaleManager::class.java).applicationLocales = LocaleList.forLanguageTags(language)
        if (BuildConfig.STORE == "play" && language == "en") {
            shadowOf(app.getSystemService(TelephonyManager::class.java)).setSimCountryIso("gb")
        }
        val graph = app.graph
        check(graph.api is SampleApi) { "the tour runs on the sample backend" }
        // What the tour stages on the sample server, before the app reads anything.
        stage(graph.api as SampleApi)
        runBlocking {
            // The preferences store outlives a test in this JVM: start each tour before the privacy notice.
            graph.secureStore.remove("legal.accepted")
            graph.preferences.rememberSignIn(null)
            if (!signedIn) graph.api.logout(false)
        }
        // The welcome's pictures (the sample config hands them out, one list for every template).
        SampleData.welcomeImages = TourPhotos.welcomeImages()
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
        TourPhotos.install(app)
        compose.setContent {
            val config by graph.config.config.collectAsStateWithLifecycle()
            val template = TourPhotos.template ?: Templates.of(if (isSystemInDarkTheme()) Templates.NEON else Templates.WHITE)
            AppTheme(template = template) {
                CompositionLocalProvider(
                    LocalAppGraph provides graph,
                    LocalAppName provides AppBrand.appName,
                    LocalRemoteImages provides TourPhotos.enabled,
                    // Robolectric's resources are only safe to read on the main thread (a raw file read on the IO
                    // pool sometimes never returns there).
                    LocalIoDispatcher provides Dispatchers.Main,
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
        val theme = (TourPhotos.template?.let { it.id + if (dark) "-night" else "" } ?: if (dark) "dark" else "light") +
            (if (scale > 1f) String.format(Locale.ROOT, "-text%.1f", scale) else "")
        val file = File(dir, String.format(Locale.ROOT, "%s-%s-%s-%s%02d-%s.png", BuildConfig.STORE, language, theme, flow, ++shot, name))
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private companion object {
        val DEBUG_DUMP = System.getenv("SCREENS_DEBUG") == "1"
        const val STEP_MS = 50L
        const val RIPPLE_MS = 2_000L
        const val MAX_PASSES = 40
    }
}

/** The crop's zoom in the tour: a third of the way along the slider (1 to 4). */
private const val CROP_ZOOM = 2f
