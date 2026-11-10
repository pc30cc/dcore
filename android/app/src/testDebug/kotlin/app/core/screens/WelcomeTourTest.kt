package app.core.screens

import android.app.LocaleManager
import android.graphics.Bitmap
import android.os.LocaleList
import android.telephony.TelephonyManager
import android.view.View
import androidx.activity.ComponentActivity
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.text.TextLayoutResult
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.BuildConfig
import app.core.CoreApp
import app.core.LocalAppGraph
import app.core.R
import app.core.brand.AppBrand
import app.core.feature.auth.AuthRoute
import app.core.feature.auth.welcome.WelcomeFaces
import app.core.i18n.LocalAppName
import app.core.media.LocalRemoteImages
import app.core.net.Backend
import app.core.net.SampleApi
import app.core.net.SampleData
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
 * The welcome and the sign-in pages on a phone-sized screen, in English and
 * Persian, in the template `SCREENS_TEMPLATE` names (white otherwise): the
 * welcome (also with large text, everything on one screen; in landscape and
 * on a small phone with large text, everything within reach), then Sign up
 * (the privacy summary, the number), Sign in (the number filled), a send
 * refused with a wait, the code with three digits, the wait over, a code sent
 * again (a call offered), a wrong code, and the keyboard over the code page.
 *
 * With `SCREENS_DIR` set the screens are written there as PNGs
 * (`<store>-<language>-<theme>-w<nn>-<name>.png`); without it nothing is.
 * With `GALLERY_PHOTOS` the welcome shows the design's pictures, with
 * `SCREENS_FONT_SCALE` every case runs at that font scale ([TourPhotos]).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xhdpi")
class WelcomeTourTest {

    @get:Rule(order = 0) val fontScale = TourFontScale()
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()

    private val app: CoreApp get() = ApplicationProvider.getApplicationContext()
    private val language: String get() = app.resources.configuration.locales[0].language
    private val outDir: File? = System.getenv("SCREENS_DIR")?.takeIf { it.isNotBlank() }?.let(::File)
    private var shot = 0

    private fun str(@StringRes id: Int, vararg args: Any): String =
        (if (args.isEmpty()) app.resources.getString(id) else app.resources.getString(id, *args)).replace("{appName}", AppBrand.appName)

    @After
    fun tearDown() {
        System.clearProperty(Backend.SAMPLE_PROPERTY)
        SampleData.welcomeImages = emptyList()
    }

    // MARK: - The welcome

    @Test @Config(qualifiers = "+en") fun welcomeEnglish() = welcome()
    @Test @Config(qualifiers = "+fa") fun welcomePersian() = welcome()
    @Test @Config(qualifiers = "+en", fontScale = 1.5f) fun welcomeEnglishLargeText() = welcome()
    @Test @Config(qualifiers = "+fa", fontScale = 1.5f) fun welcomePersianLargeText() = welcome()

    /** The config names only the orbit's small face crops: white's frame has no photo large enough. */
    @Test @Config(qualifiers = "+fa") fun welcomePersianFacesOnly() = welcome(pictures = TourPhotos.welcomeFacesOnly(), name = "welcome-faces-only")

    @Test @Config(qualifiers = "fa-w891dp-h411dp-land-xhdpi") fun welcomePersianLandscape() = welcomeWithinReach("welcome-land")
    @Test @Config(qualifiers = "fa-w360dp-h640dp-xhdpi", fontScale = 1.5f) fun welcomePersianSmallPhoneLargeText() = welcomeWithinReach("welcome-small")
    @Test @Config(qualifiers = "en-w360dp-h640dp-xhdpi", fontScale = 1.5f) fun welcomeEnglishSmallPhoneLargeText() = welcomeWithinReach("welcome-small")

    private fun welcome(pictures: List<String>? = null, name: String = "welcome") {
        start(pictures)
        val signUp = str(R.string.welcome_sign_up)
        waitFor(hasText(signUp))
        waitForPictures()
        capture(name)
        // Everything on one screen, also with large text: the title, both buttons and the terms within the window.
        val root = compose.onAllNodes(isRoot())[0].fetchSemanticsNode().boundsInRoot
        for (label in listOf(str(R.string.welcome_title), str(R.string.welcome_sign_in), signUp)) {
            val bounds = compose.onNodeWithText(label).fetchSemanticsNode().boundsInRoot
            assertTrue("$label is off screen: $bounds in $root", bounds.top >= root.top && bounds.bottom <= root.bottom)
        }
        val terms = compose.onAllNodes(hasText(str(R.string.legal_terms), substring = true)).fetchSemanticsNodes().single().boundsInRoot
        assertTrue("the terms line is off screen: $terms in $root", terms.bottom <= root.bottom)
        // One title, two buttons, the terms and the mark (read as the app's name): the pictures say nothing to a screen reader.
        assertEquals(1, compose.onAllNodes(hasContentDescription(AppBrand.appName)).fetchSemanticsNodes().size)
        val texts = compose.onAllNodes(SemanticsMatcher("has text") { it.config.contains(androidx.compose.ui.semantics.SemanticsProperties.Text) })
            .fetchSemanticsNodes().size
        assertEquals("title, two buttons, terms line", 4, texts)
    }

    /**
     * A short window: the hero gives way and the page scrolls before anything
     * is cut. Each of the title, both buttons and the terms line can be
     * brought fully into the window, the buttons at their full height.
     */
    private fun welcomeWithinReach(name: String) {
        start()
        val signUp = str(R.string.welcome_sign_up)
        waitFor(hasText(signUp))
        waitForPictures()
        capture(name)
        val root = compose.onAllNodes(isRoot())[0].fetchSemanticsNode().boundsInRoot
        val minButton = 48 * compose.density.density - 0.5f
        for (label in listOf(str(R.string.welcome_title), signUp, str(R.string.welcome_sign_in))) {
            compose.onNodeWithText(label).performScrollTo()
            val bounds = compose.onNodeWithText(label).fetchSemanticsNode().boundsInRoot
            assertTrue("$label is cut: $bounds in $root", bounds.top >= root.top && bounds.bottom <= root.bottom)
        }
        for (label in listOf(signUp, str(R.string.welcome_sign_in))) {
            val button = compose.onNode(hasClickAction() and hasText(label)).fetchSemanticsNode().boundsInRoot
            assertTrue("$label is squeezed: $button", button.height >= minButton)
        }
        val terms = hasText(str(R.string.legal_terms), substring = true)
        compose.onNode(terms).performScrollTo()
        val line = compose.onNode(terms).fetchSemanticsNode().boundsInRoot
        assertTrue("the terms line is cut: $line in $root", line.top >= root.top && line.bottom <= root.bottom)
    }

    // MARK: - The privacy summary's links

    /** The narrowest phone, the largest text and the longest words: both footer links stay whole (the second wraps below). */
    @Test @Config(qualifiers = "tr-w360dp-h640dp-xhdpi", fontScale = 1.5f) fun privacyLinksTurkishSmallLargeText() {
        start()
        val signUp = str(R.string.welcome_sign_up)
        waitFor(hasText(signUp))
        compose.onNodeWithText(signUp).performScrollTo().performClick()
        waitFor(hasText(str(R.string.privacy_title)))
        capture("privacy-links")
        val root = compose.onAllNodes(isRoot())[0].fetchSemanticsNode().boundsInRoot
        for (label in listOf(str(R.string.privacy_full), str(R.string.legal_terms))) {
            val node = compose.onNode(hasText(label), useUnmergedTree = true).fetchSemanticsNode()
            val layouts = mutableListOf<TextLayoutResult>()
            node.config[SemanticsActions.GetTextLayoutResult].action!!.invoke(layouts)
            // Whole: on one line, as wide as the words need (not squeezed into what a row left).
            val text = layouts.single()
            val needed = kotlin.math.ceil(text.multiParagraph.intrinsics.maxIntrinsicWidth)
            assertTrue("$label is cut: ${text.size.width} px of $needed", text.lineCount == 1 && text.size.width + 1 >= needed)
            val bounds = node.boundsInRoot
            assertTrue("$label is outside the window: $bounds in $root", bounds.left >= root.left && bounds.right <= root.right && bounds.bottom <= root.bottom)
        }
    }

    // MARK: - The pages

    @Test @Config(qualifiers = "+en") fun pagesEnglish() = pages()
    @Test @Config(qualifiers = "+fa") fun pagesPersian() = pages()

    private fun pages() {
        start()
        (app.graph.api as SampleApi).otpResendAfterMs = RESEND_WAIT_MS
        val signUp = str(R.string.welcome_sign_up)
        waitFor(hasText(signUp))
        compose.onNodeWithText(signUp).performClick()

        // A new install: the privacy summary comes first.
        waitFor(hasText(str(R.string.privacy_title)))
        capture("privacy")
        compose.onNodeWithText(str(R.string.privacy_accept)).performClick()

        waitFor(hasText(str(R.string.auth_phone_title)))
        capture("phone-empty")
        // The play build offers Google here; the bazaar build never does.
        val google = compose.onAllNodes(hasText(str(R.string.auth_continue_google))).fetchSemanticsNodes().size
        assertEquals(if (BuildConfig.STORE == "bazaar") 0 else 1, google)

        // Back to the welcome, then Sign in: the summary is behind us.
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        waitFor(hasText(signUp))
        compose.onNodeWithText(str(R.string.welcome_sign_in)).performClick()
        waitFor(hasText(str(R.string.auth_phone_title)))
        val national = if (BuildConfig.STORE == "play" && language == "en") "7700900123" else "9123456789"
        val number = hasSetTextAction() and hasContentDescription(str(R.string.auth_phone_label))
        compose.onNode(number).performTextInput(national)
        waitFor(hasText(str(R.string.auth_send_code)) and isEnabled())
        capture("phone")
        compose.onNodeWithText(str(R.string.auth_send_code)).performClick()

        waitFor(hasText(str(R.string.auth_code_title)))
        val code = hasSetTextAction() and hasContentDescription(str(R.string.auth_code_label, 6))
        compose.onNode(code).performTextInput("482")
        compose.waitForIdle()
        capture("code")
        // The countdown changes every second: it is not a live region (an error line is).
        val countdown = compose.onNode(hasText(str(R.string.auth_resend_in, "").trim(), substring = true)).fetchSemanticsNode()
        assertNull(countdown.config.getOrNull(SemanticsProperties.LiveRegion))
        // «ویرایش» is a 48 dp target; the line keeps its own height.
        val edit = compose.onNode(hasText(str(R.string.auth_code_edit)) and hasClickAction()).fetchSemanticsNode().boundsInRoot
        assertTrue("«ویرایش» is $edit", edit.height >= 48 * compose.density.density - 0.5f)

        // «ویرایش», then the same number at once: the server asks for a wait, which the button counts down, alone.
        compose.onNodeWithText(str(R.string.auth_code_edit)).performClick()
        waitFor(hasText(str(R.string.auth_phone_title)))
        waitFor(hasText(str(R.string.auth_send_code)) and isEnabled())
        compose.onNodeWithText(str(R.string.auth_send_code)).performClick()
        waitFor(hasText(str(R.string.auth_resend_in, "").trim(), substring = true))
        capture("phone-wait")
        assertEquals("no second clock under the field", 0, compose.onAllNodes(hasText(str(R.string.auth_error_rate_limited))).fetchSemanticsNodes().size)
        waitOut()
        waitFor(hasText(str(R.string.auth_send_code)) and isEnabled())
        compose.onNodeWithText(str(R.string.auth_send_code)).performClick()
        waitFor(hasText(str(R.string.auth_code_title)))

        // The wait over, nothing wrong: one action, a new code by text.
        waitOut()
        waitFor(hasText(str(R.string.auth_new_code)))
        capture("code-resend")
        assertEquals(0, compose.onAllNodes(hasText(str(R.string.auth_call_me))).fetchSemanticsNodes().size)
        // Sent again and waited out once more: now a call, alone, in the same place.
        compose.onNodeWithText(str(R.string.auth_new_code)).performClick()
        waitFor(hasText(str(R.string.auth_resend_in, "").trim(), substring = true))
        waitOut()
        waitFor(hasText(str(R.string.auth_call_me)))
        capture("code-call")
        assertEquals(0, compose.onAllNodes(hasText(str(R.string.auth_new_code))).fetchSemanticsNodes().size)

        // Wrong codes: every cell in the error colour, one line, one action; the third leaves two tries.
        compose.onNode(code).performTextInput("482710")
        waitFor(hasText(str(R.string.auth_code_wrong)))
        for (wrong in listOf("482711", "482712")) {
            compose.onNode(code).performTextClearance()
            compose.onNode(code).performTextInput(wrong)
            compose.waitForIdle()
        }
        val left = app.resources.getQuantityString(R.plurals.auth_code_wrong_left, 2, 2)
        waitFor(hasText(left))
        waitFor(hasText(str(R.string.auth_new_code)))
        capture("code-error")
        assertEquals(LiveRegionMode.Polite, compose.onNodeWithText(left).fetchSemanticsNode().config.getOrNull(SemanticsProperties.LiveRegion))

        // The keyboard up, leaving 300 dp: the error line and its action scroll into sight above it.
        val root = compose.onAllNodes(isRoot())[0].fetchSemanticsNode().boundsInRoot
        val keyboard = (root.height - 300 * compose.density.density).toInt()
        keyboard(keyboard)
        for (label in listOf(left, str(R.string.auth_new_code))) {
            compose.onNodeWithText(label).performScrollTo()
            val bounds = compose.onNodeWithText(label).fetchSemanticsNode().boundsInRoot
            assertTrue("$label is under the keyboard: $bounds, keyboard from ${root.bottom - keyboard}", bounds.bottom <= root.bottom - keyboard + 0.5f)
        }
        keyboard(0)

        // «ویرایش» in the line under the title goes back to the number.
        compose.onNodeWithText(str(R.string.auth_code_edit)).performClick()
        waitFor(hasText(str(R.string.auth_phone_title)))
    }

    /** Lets the sample's short resend wait run out (wall clock and the test's main looper). */
    private fun waitOut() {
        Thread.sleep(RESEND_WAIT_MS)
        shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(RESEND_WAIT_MS))
        compose.waitForIdle()
    }

    /** The keyboard, as the window reports it, [height] px tall (0: gone). */
    private fun keyboard(height: Int) {
        compose.runOnUiThread {
            WindowCompat.setDecorFitsSystemWindows(compose.activity.window, false)
            val insets = WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, height))
                .setVisible(WindowInsetsCompat.Type.ime(), height > 0)
                .build()
            ViewCompat.dispatchApplyWindowInsets(composeView!!, insets)
        }
        compose.waitForIdle()
    }

    private companion object {
        const val RESEND_WAIT_MS = 6_000L
    }

    // MARK: - Helpers

    private var composeView: View? = null

    private fun start(pictures: List<String>? = null) {
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
        val template = TourPhotos.template ?: Templates.White
        TourPhotos.install(app)
        SampleData.welcomeImages = pictures ?: TourPhotos.welcomeImages()
        WelcomeFaces.forgetForTest()
        graph.config.start()
        compose.setContent {
            composeView = LocalView.current
            AppTheme(template = template) {
                CompositionLocalProvider(
                    LocalAppGraph provides graph,
                    LocalAppName provides AppBrand.appName,
                    LocalRemoteImages provides TourPhotos.enabled,
                ) {
                    Surface(Modifier.fillMaxSize()) { AuthRoute() }
                }
            }
        }
    }

    /** Until the welcome has chosen what to draw (its pictures decoded off the main thread), and the fade is over. */
    private fun waitForPictures() {
        runCatching { compose.waitUntil(10_000) { WelcomeFaces.settledCount > 0 } }
        repeat(3) {
            Thread.sleep(100)
            compose.waitForIdle()
        }
    }

    private fun waitFor(matcher: SemanticsMatcher, timeoutMs: Long = 10_000) {
        compose.waitUntil(timeoutMs) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun capture(name: String) {
        val dir = outDir ?: return
        compose.waitForIdle()
        val bitmap = compose.onAllNodes(isRoot())[0].captureToImage().asAndroidBitmap()
        dir.mkdirs()
        val scale = app.resources.configuration.fontScale
        val theme = (TourPhotos.template?.id ?: "white") + (if (scale > 1f) String.format(Locale.ROOT, "-text%.1f", scale) else "")
        val file = File(dir, String.format(Locale.ROOT, "%s-%s-%s-w%02d-%s.png", BuildConfig.STORE, language, theme, ++shot, name))
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
