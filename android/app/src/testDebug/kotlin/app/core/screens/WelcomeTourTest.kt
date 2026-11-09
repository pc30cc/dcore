package app.core.screens

import android.app.LocaleManager
import android.graphics.Bitmap
import android.os.LocaleList
import android.provider.Settings
import android.telephony.TelephonyManager
import androidx.activity.ComponentActivity
import androidx.annotation.StringRes
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.BuildConfig
import app.core.CoreApp
import app.core.LocalAppGraph
import app.core.R
import app.core.brand.AppBrand
import app.core.feature.auth.AuthRoute
import app.core.feature.auth.welcome.BrandWelcome
import app.core.feature.auth.welcome.Headline
import app.core.i18n.brandText
import app.core.i18n.LocalAppName
import app.core.media.LocalRemoteImages
import app.core.net.Backend
import app.core.net.SampleApi
import app.core.ui.theme.AppTheme
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.Locale

/**
 * The welcome and the sign-in sheet on a phone-sized screen, in English and
 * Persian (light system theme; the scene has its own colours), with the
 * Compose clock driven by hand: the opening at 0.2, 0.8, 2 and 5 seconds,
 * then the sheet for Sign up (privacy notice, phone number), for Sign in,
 * and the code step. Large text (1.5x) keeps the welcome on one screen.
 *
 * With `SCREENS_DIR` set the screens are written there as PNGs
 * (`<store>-<language>-<theme>-w<nn>-<name>.png`); without it nothing is.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xhdpi")
class WelcomeTourTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val app: CoreApp get() = ApplicationProvider.getApplicationContext()
    private val language: String get() = app.resources.configuration.locales[0].language
    private val outDir: File? = System.getenv("SCREENS_DIR")?.takeIf { it.isNotBlank() }?.let(::File)
    private var shot = 0

    private fun str(@StringRes id: Int, vararg args: Any): String =
        (if (args.isEmpty()) app.resources.getString(id) else app.resources.getString(id, *args)).replace("{appName}", AppBrand.appName)

    @After
    fun tearDown() {
        System.clearProperty(Backend.SAMPLE_PROPERTY)
    }

    // MARK: - The opening

    @Test @Config(qualifiers = "+en") fun openingEnglish() = opening()
    @Test @Config(qualifiers = "+fa") fun openingPersian() = opening()
    @Test @Config(qualifiers = "+en", fontScale = 1.5f) fun openingEnglishLargeText() = opening(large = true)
    @Test @Config(qualifiers = "+fa", fontScale = 1.5f) fun openingPersianLargeText() = opening(large = true)

    /** With animations removed (the system's setting): no blur, no burst, the bubbles still where they rest. */
    @Test @Config(qualifiers = "+en") fun openingReducedMotionEnglish() {
        Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        try {
            compose.mainClock.autoAdvance = false
            start()
            val signUp = str(R.string.welcome_sign_up)
            frames { compose.onAllNodes(hasText(signUp)).fetchSemanticsNodes().isNotEmpty() }
            compose.mainClock.advanceTimeBy(200)
            capture("welcome-reduced-0.2s")
            compose.mainClock.advanceTimeBy(1_800)
            capture("welcome-reduced-2.0s")
        } finally {
            Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        }
    }

    private fun opening(large: Boolean = false) {
        compose.mainClock.autoAdvance = false
        start()
        val signUp = str(R.string.welcome_sign_up)
        frames { compose.onAllNodes(hasText(signUp)).fetchSemanticsNodes().isNotEmpty() }
        val start = compose.mainClock.currentTime
        val moments = if (large) listOf(5_000L) else listOf(200L, 800L, 2_000L, 5_000L)
        for (at in moments) {
            compose.mainClock.advanceTimeBy(at - (compose.mainClock.currentTime - start))
            capture(String.format(Locale.ROOT, "welcome-%.1fs", at / 1000f))
        }
        // Everything on one screen, also with large text: both buttons and the terms within the window.
        val root = compose.onAllNodes(isRoot())[0].fetchSemanticsNode().boundsInRoot
        for (label in listOf(str(R.string.welcome_sign_in), signUp)) {
            val bounds = compose.onNodeWithText(label).fetchSemanticsNode().boundsInRoot
            assertTrue("$label is off screen: $bounds in $root", bounds.top >= root.top && bounds.bottom <= root.bottom)
        }
        val terms = compose.onAllNodes(hasText(str(R.string.legal_terms), substring = true)).fetchSemanticsNodes().single().boundsInRoot
        assertTrue("the terms line is off screen: $terms in $root", terms.bottom <= root.bottom)
        // The bubbles are decoration: nothing in the tree but the texts and buttons.
        // The brand's own eyebrow when it has one for this language, else the app's.
        val eyebrow = BrandWelcome.load(app).eyebrow[language]?.let { brandText(it) } ?: str(R.string.welcome_eyebrow)
        val headline = Headline.plain(eyebrow)
        assertTrue(compose.onAllNodes(hasText(headline, substring = true, ignoreCase = true)).fetchSemanticsNodes().isNotEmpty())
        assertEquals(0, compose.onAllNodes(hasContentDescription("bubble", substring = true, ignoreCase = true)).fetchSemanticsNodes().size)
    }

    // MARK: - The sheet

    @Test @Config(qualifiers = "+en") fun sheetEnglish() = sheet()
    @Test @Config(qualifiers = "+fa") fun sheetPersian() = sheet()

    private fun sheet() {
        start()
        val signUp = str(R.string.welcome_sign_up)
        waitFor(hasText(signUp))
        compose.onNodeWithText(signUp).performClick()

        // A new install: the privacy notice comes first, in the sheet.
        waitFor(hasText(Headline.plain(str(R.string.auth_sheet_privacy_title))))
        capture("signup-privacy")
        compose.onNodeWithText(str(R.string.privacy_accept)).performClick()

        val signUpTitle = Headline.plain(str(R.string.auth_sheet_signup_title))
        waitFor(hasText(signUpTitle))
        capture("signup-phone")
        // The play build offers Google here; the bazaar build never does.
        val google = compose.onAllNodes(hasText(str(R.string.auth_continue_google))).fetchSemanticsNodes().size
        if (BuildConfig.STORE == "bazaar") assertEquals(0, google)

        // Back to the welcome, then Sign in: the notice is behind us, the greeting differs.
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        waitFor(hasText(signUp))
        compose.onNodeWithText(str(R.string.welcome_sign_in)).performClick()
        waitFor(hasText(Headline.plain(str(R.string.auth_sheet_signin_title))))
        val national = if (BuildConfig.STORE == "play" && language == "en") "7700900123" else "9127654321"
        compose.onNode(hasSetTextAction() and hasContentDescription(str(R.string.auth_phone_label))).performTextInput(national)
        waitFor(hasText(str(R.string.auth_sheet_continue)) and isEnabled())
        capture("signin-phone")
        compose.onNodeWithText(str(R.string.auth_sheet_continue)).performClick()

        waitFor(hasText(str(R.string.auth_code_title)))
        compose.onNode(hasSetTextAction() and hasContentDescription(str(R.string.auth_code_label, 6))).performTextInput("123")
        compose.waitForIdle()
        capture("code")
    }

    // MARK: - Helpers

    private fun start() {
        System.setProperty(Backend.SAMPLE_PROPERTY, "true")
        app.getSystemService(LocaleManager::class.java).applicationLocales = LocaleList.forLanguageTags(language)
        if (BuildConfig.STORE == "play" && language == "en") {
            shadowOf(app.getSystemService(TelephonyManager::class.java)).setSimCountryIso("gb")
        }
        val graph = app.graph
        check(graph.api is SampleApi) { "the tour runs on the sample backend" }
        runBlocking {
            graph.secureStore.remove("legal.accepted")
            graph.api.logout(false)
        }
        graph.config.start()
        compose.setContent {
            AppTheme(dark = false) {
                CompositionLocalProvider(
                    LocalAppGraph provides graph,
                    LocalAppName provides AppBrand.appName,
                    LocalRemoteImages provides false,
                ) {
                    Surface(Modifier.fillMaxSize()) { AuthRoute() }
                }
            }
        }
    }

    /** With the clock held: frame by frame until [done]. */
    private fun frames(limit: Int = 600, done: () -> Boolean) {
        repeat(limit) {
            compose.mainClock.advanceTimeByFrame()
            shadowOf(android.os.Looper.getMainLooper()).idle()
            if (done()) return
        }
        throw AssertionError("not there after $limit frames")
    }

    private fun waitFor(matcher: SemanticsMatcher, timeoutMs: Long = 10_000) {
        compose.waitUntil(timeoutMs) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun capture(name: String) {
        val dir = outDir ?: return
        if (compose.mainClock.autoAdvance) compose.waitForIdle()
        val bitmap = compose.onAllNodes(isRoot())[0].captureToImage().asAndroidBitmap()
        dir.mkdirs()
        val scale = app.resources.configuration.fontScale
        val theme = "light" + (if (scale > 1f) String.format(Locale.ROOT, "-text%.1f", scale) else "")
        val file = File(dir, String.format(Locale.ROOT, "%s-%s-%s-w%02d-%s.png", BuildConfig.STORE, language, theme, ++shot, name))
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
