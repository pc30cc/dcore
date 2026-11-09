package app.core.feature.auth

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.telephony.TelephonyManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import app.core.BuildConfig
import app.core.LocalAppGraph
import app.core.R
import app.core.brand.AppBrand
import app.core.feature.auth.welcome.BrandWelcome
import app.core.feature.auth.welcome.BubbleField
import app.core.feature.auth.welcome.WelcomeContent
import app.core.feature.auth.welcome.WelcomeLayout
import app.core.feature.auth.welcome.WelcomePalette
import app.core.feature.auth.welcome.WelcomeTexts
import app.core.feature.auth.welcome.rememberBubbleArt
import app.core.i18n.APP_NAME_PLACEHOLDER
import app.core.i18n.AppLanguage
import app.core.i18n.AppLocales
import app.core.i18n.LocalAppName
import app.core.i18n.brandString
import app.core.i18n.brandText
import app.core.model.DeviceInfo
import app.core.store.IntegrityResult
import app.core.store.Store
import app.core.ui.theme.DarkSemantic
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.LocalSemanticColors
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Sign-in: the welcome (the brand's scene with its floating bubbles, Sign in
 * and Sign up), then a sheet over it with the in-app privacy notice (before
 * anything is asked, once per install), the phone number and its code, or
 * Google in the Play build. Both buttons lead into the same steps: the server
 * decides whether the number is new. Where the account goes afterwards is
 * [AuthGate]'s to decide.
 */
@Composable
fun AuthRoute() {
    val graph = LocalAppGraph.current
    val context = LocalContext.current
    // The language the server is asked in is the funnel's; what is drawn follows the screen's configuration.
    val requestLanguage = AppLocales.current(context)
    val language = screenLanguage()
    val model: AuthViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                val app = context.applicationContext
                AuthViewModel(
                    api = graph.api,
                    gate = graph.auth,
                    legal = graph.legal,
                    clock = graph.clock,
                    saved = createSavedStateHandle(),
                    config = { graph.config.config.value },
                    device = { deviceInfo(requestLanguage.tag) },
                    locale = { requestLanguage.tag },
                    appHash = { graph.auth.smsCodes.appHash(app) },
                    integrity = { hash ->
                        withTimeoutOrNull(INTEGRITY_WAIT_MS) { (graph.store.integrity.token(hash) as? IntegrityResult.Token)?.value }
                    },
                    defaultCountry = defaultCountry(app, requestLanguage),
                    googleBuild = AppBrand.supportsGoogleSignIn,
                )
            }
        },
    )
    val state by model.state.collectAsStateWithLifecycle()
    val config by graph.config.config.collectAsStateWithLifecycle()
    LaunchedEffect(config) { model.refreshOptions() }

    val activity = LocalActivity.current
    LaunchedEffect(state.launchGoogle) {
        if (state.launchGoogle && activity != null) model.signInWithGoogle(activity)
    }

    BackHandler(enabled = state.stage != AuthStage.Welcome) { model.back() }

    var intent by rememberSaveable { mutableStateOf(SheetIntent.SignUp) }
    // The opening plays once per visit, not again after a rotation.
    var introPlayed by rememberSaveable { mutableStateOf(false) }
    val intro = remember { !introPlayed }
    LaunchedEffect(Unit) { introPlayed = true }

    val reduced = LocalReducedMotion.current
    val persian = language == AppLanguage.FA
    val appName = LocalAppName.current
    val brand = remember { BrandWelcome.load(context.applicationContext) }
    val fallbackEyebrow = brandString(R.string.welcome_eyebrow)
    val fallbackSubtitle = brandString(R.string.auth_subtitle)
    val content = remember(brand, config?.welcome, language) {
        WelcomeContent.resolve(
            brand = brand,
            config = config?.welcome,
            language = language.tag,
            fallbackEyebrow = fallbackEyebrow,
            // The name alone, emphasised.
            fallbackHeadline = "*$APP_NAME_PLACEHOLDER*",
            fallbackSubtitle = fallbackSubtitle,
        )
    }
    val labels = listOf(
        brandString(R.string.welcome_bubble_like),
        brandString(R.string.welcome_bubble_match),
        brandString(R.string.welcome_bubble_chat),
    ).map { if (persian) it else it.uppercase(java.util.Locale.forLanguageTag(language.tag)) }
    val art = rememberBubbleArt(content.pictures, labels, persian)
    val density = LocalDensity.current.density
    val field = remember(density, labels.size) { BubbleField(density, words = labels.size) }
    // The word bubble's word is never under 13 sp at the phone's text size: the bubble grows instead.
    val wordText = with(LocalDensity.current) { WORD_TEXT_MIN.toPx() }
    SideEffect { field.wordMinRadius = art.wordRadiusFor(wordText) }
    val sheetOpen = state.stage != AuthStage.Welcome

    SceneSystemBars(lightIcons = sheetOpen)

    Box(Modifier.fillMaxSize()) {
        WelcomeLayout(
            colors = content.colors,
            texts = WelcomeTexts(
                eyebrow = brandText(content.eyebrow, appName),
                headline = brandText(content.headline, appName),
                subtitle = brandText(content.subtitle, appName),
                signIn = brandString(R.string.welcome_sign_in),
                signUp = brandString(R.string.welcome_sign_up),
            ),
            persian = persian,
            language = language.tag,
            field = field,
            art = art,
            sceneRunning = !sheetOpen,
            intro = intro,
            reduced = reduced,
            onSignIn = {
                intent = SheetIntent.SignIn
                model.continueWithPhone()
            },
            onSignUp = {
                intent = SheetIntent.SignUp
                model.continueWithPhone()
            },
            enabled = !state.googleBusy,
        ) {
            WelcomeFooter(state)
        }
        AuthSheet(state = state, model = model, intent = intent, language = language, art = art, reduced = reduced)
        Notices()
    }
}

private const val INTEGRITY_WAIT_MS = 3_000L

/** The smallest the word bubble's word may be: readable text. */
private val WORD_TEXT_MIN = 13.sp

/** The phone, as sign-in names it: model, Android version, app version and language. Nothing about its holder. */
internal fun deviceInfo(language: String) = DeviceInfo(
    model = listOf(Build.MANUFACTURER, Build.MODEL).filter { it.isNotBlank() }.joinToString(" ").take(64),
    osVersion = Build.VERSION.RELEASE.orEmpty(),
    appVersion = BuildConfig.VERSION_NAME,
    locale = language,
)

private fun defaultCountry(context: Context, language: AppLanguage): DialCountry {
    val telephony = context.getSystemService(TelephonyManager::class.java)
    return PhoneNumbers.defaultCountry(
        storeDefault = if (AppBrand.store == Store.BAZAAR) "IR" else null,
        simIso = runCatching { telephony?.simCountryIso }.getOrNull(),
        networkIso = runCatching { telephony?.networkCountryIso }.getOrNull(),
        language = language.tag,
    )
}

/** Under the buttons: a Google message when the sheet is closed, and the terms line. */
@Composable
private fun WelcomeFooter(state: AuthUiState) {
    val config by LocalAppGraph.current.config.config.collectAsStateWithLifecycle()
    val legal = config?.legal
    val termsUrl = legal?.termsUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.termsUrl
    val privacyUrl = legal?.privacyUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.privacyUrl
    CompositionLocalProvider(LocalSemanticColors provides DarkSemantic) {
        InlineMessage(state.googleError?.takeIf { state.stage == AuthStage.Welcome }?.let { googleErrorText(it) })
    }
    LegalLine(termsUrl = termsUrl, privacyUrl = privacyUrl)
}

/** The session-ended note and the closed-account dialog, wherever sign-in was reached from. */
@Composable
private fun Notices() {
    val graph = LocalAppGraph.current
    val notice by graph.auth.notice.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val sessionEnded = brandString(R.string.auth_session_ended)
    LaunchedEffect(notice) {
        if (notice == GateNotice.SessionEnded) {
            graph.auth.clearNotice()
            snackbar.showSnackbar(sessionEnded)
        }
    }
    Box(Modifier.fillMaxSize()) {
        SnackbarHost(snackbar, Modifier.align(Alignment.TopCenter).safeDrawingPadding().padding(top = 8.dp))
    }
    if (notice == GateNotice.AccountClosed) {
        AlertDialog(
            onDismissRequest = { graph.auth.clearNotice() },
            title = { Text(brandString(R.string.auth_closed_title)) },
            text = { Text(brandString(R.string.auth_closed_body)) },
            confirmButton = { TextButton(onClick = { graph.auth.clearNotice() }) { Text(brandString(R.string.action_ok)) } },
        )
    }
}

/** "By continuing you agree to the Terms and the Privacy Policy", both as links, in white on the scene. */
@Composable
private fun LegalLine(termsUrl: String, privacyUrl: String) {
    // A link's words stay on one line (no-break spaces): a link split over two lines reads as two.
    val terms = brandString(R.string.legal_terms).replace(' ', '\u00A0')
    val privacy = brandString(R.string.legal_privacy).replace(' ', '\u00A0')
    // The raw template, unformatted: its %1$s and %2$s become links below. Formatting it
    // with no arguments (brandString) throws MissingFormatArgumentException.
    val template = brandText(stringResource(R.string.auth_legal_notice_links), LocalAppName.current)
    val linkStyle = TextLinkStyles(SpanStyle(color = WelcomePalette.Headline, fontWeight = FontWeight.Medium, textDecoration = TextDecoration.Underline))
    val text = buildAnnotatedString {
        val parts = template.split("%1\$s", "%2\$s")
        val order = Regex("%([12])\\\$s").findAll(template).map { it.groupValues[1] }.toList()
        parts.forEachIndexed { index, part ->
            append(part)
            val which = order.getOrNull(index) ?: return@forEachIndexed
            val (label, url) = if (which == "1") terms to termsUrl else privacy to privacyUrl
            if (url.isNotBlank()) withLink(LinkAnnotation.Url(url, linkStyle)) { append(label) } else append(label)
        }
    }
    Text(
        text,
        style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 1.45.em, lineBreak = LineBreak.Heading),
        color = WelcomePalette.Terms,
        textAlign = TextAlign.Center,
        modifier = Modifier.widthIn(max = 320.dp).padding(top = 4.dp, start = 8.dp, end = 8.dp),
    )
}

/**
 * The bar icons over the scene: dark on its light sky while the welcome
 * shows, light over the dimmed scene and the dark sheet; the navigation bar
 * sits on the scene's dark bottom either way. The theme's own setting comes
 * back when sign-in is left.
 */
@Composable
private fun SceneSystemBars(lightIcons: Boolean) {
    val view = LocalView.current
    if (view.isInEditMode) return
    DisposableEffect(lightIcons) {
        val window = view.context.findActivity()?.window ?: return@DisposableEffect onDispose {}
        val controller = WindowCompat.getInsetsController(window, view)
        val status = controller.isAppearanceLightStatusBars
        val navigation = controller.isAppearanceLightNavigationBars
        controller.isAppearanceLightStatusBars = !lightIcons
        controller.isAppearanceLightNavigationBars = false
        onDispose {
            controller.isAppearanceLightStatusBars = status
            controller.isAppearanceLightNavigationBars = navigation
        }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
