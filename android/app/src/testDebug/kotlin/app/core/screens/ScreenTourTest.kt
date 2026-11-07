package app.core.screens

import android.app.LocaleManager
import android.graphics.Bitmap
import android.os.LocaleList
import android.telephony.TelephonyManager
import androidx.annotation.StringRes
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
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
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performCustomAccessibilityActionWithLabel
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.BuildConfig
import app.core.CoreApp
import app.core.LocalAppGraph
import app.core.R
import app.core.brand.AppBrand
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.JalaliDates
import app.core.i18n.LocalAppName
import app.core.media.LocalRemoteImages
import app.core.net.Backend
import app.core.net.SampleApi
import app.core.ui.nav.AppNavHost
import app.core.ui.theme.AppTheme
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

/**
 * The whole app on the sample backend, driven as a person would, in Persian
 * (right to left) and English, light and dark, and with large text, on a
 * phone-sized screen:
 * sign-in (the phone number and its code), the first sign-up steps, the
 * deck, a card's full profile, the match moment and the likes list.
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

    @get:Rule val compose = createComposeRule()

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

        waitFor(hasText(str(R.string.auth_continue_phone)))
        capture("welcome")
        compose.onNodeWithText(str(R.string.auth_continue_phone)).performClick()

        waitFor(hasText(str(R.string.privacy_title)))
        capture("privacy")
        compose.onNodeWithText(str(R.string.privacy_accept)).performClick()

        waitFor(hasText(str(R.string.auth_phone_title)))
        // The bazaar build's default dial code is +98; the play build follows the SIM (GB here, in English).
        val national = if (BuildConfig.STORE == "play" && language == "en") "7700900123" else "9127654321"
        compose.onNodeWithText(str(R.string.auth_phone_label)).performTextInput(national)
        waitFor(hasText(str(R.string.auth_send_code)) and isEnabled())
        capture("phone")
        compose.onNodeWithText(str(R.string.auth_send_code)).performClick()

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

    // MARK: - Helpers

    /** The app as [app.core.MainActivity] draws it, on the sample backend, in the configuration's language. */
    private fun start(signedIn: Boolean) {
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
        compose.setContent {
            val config by graph.config.config.collectAsStateWithLifecycle()
            AppTheme(dark = isSystemInDarkTheme()) {
                CompositionLocalProvider(
                    LocalAppGraph provides graph,
                    LocalAppName provides AppBrand.appName,
                    LocalRemoteImages provides false,
                ) {
                    Surface(Modifier.fillMaxSize()) { AppNavHost(config = config) }
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

    private fun waitFor(matcher: SemanticsMatcher, timeoutMs: Long = 10_000) {
        compose.waitUntil(timeoutMs) { compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun capture(name: String, node: SemanticsNodeInteraction = compose.onAllNodes(isRoot())[0]) {
        val dir = outDir ?: return
        compose.waitForIdle()
        val bitmap = node.captureToImage().asAndroidBitmap()
        dir.mkdirs()
        val scale = app.resources.configuration.fontScale
        val theme = (if (dark) "dark" else "light") + (if (scale > 1f) String.format(Locale.ROOT, "-text%.1f", scale) else "")
        val file = File(dir, String.format(Locale.ROOT, "%s-%s-%s-%s%02d-%s.png", BuildConfig.STORE, language, theme, flow, ++shot, name))
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
