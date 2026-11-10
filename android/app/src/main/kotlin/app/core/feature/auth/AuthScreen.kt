package app.core.feature.auth

import android.content.Context
import android.os.Build
import android.telephony.TelephonyManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
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
import app.core.feature.auth.welcome.WelcomeContent
import app.core.feature.auth.welcome.WelcomeFaces
import app.core.feature.auth.welcome.WelcomeScreen
import app.core.feature.legal.PrivacyNoticeScreen
import app.core.i18n.AppLanguage
import app.core.i18n.AppLocales
import app.core.i18n.LocalAppName
import app.core.i18n.brandString
import app.core.i18n.brandText
import app.core.model.DeviceInfo
import app.core.store.IntegrityResult
import app.core.store.Store
import app.core.ui.components.AppDialog
import app.core.ui.components.AppSnackbar
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Motion
import app.core.ui.theme.Space
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Sign-in: the welcome (one title, Sign up and Sign in), then the in-app
 * privacy summary (before anything is asked, once per install), the phone
 * number and its code, with Google beside the number in the Play build, each
 * a page of its own in the template. Both welcome buttons lead into the same
 * pages: the server decides whether the number is new. Where the account
 * goes afterwards is [AuthGate]'s to decide.
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
                    rememberSignIn = graph.preferences::rememberSignIn,
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

    val brand = remember { BrandWelcome.load(context.applicationContext) }
    val pictures = remember(brand, config?.welcome) { WelcomeContent.pictures(brand, config?.welcome) }
    // Signed in (or gone for another reason): the welcome's decoded pictures are not kept. An activity being made
    // again (rotation, dark mode, font size, split screen) keeps them, so they do not decode and fade in again.
    DisposableEffect(activity) { onDispose { if (activity?.isChangingConfigurations != true) WelcomeFaces.release() } }
    val reduced = LocalReducedMotion.current
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl

    Box(Modifier.fillMaxSize()) {
        AnimatedContent(
            targetState = state.stage,
            transitionSpec = {
                if (reduced) {
                    fadeIn(tween(Motion.REDUCED_MS)) togetherWith fadeOut(tween(Motion.REDUCED_MS))
                } else {
                    // Forward pages come in from the end side, as a pushed screen does.
                    val forward = targetState.ordinal > initialState.ordinal
                    val sign = (if (rtl) -1 else 1) * (if (forward) 1 else -1)
                    (slideInHorizontally(Motion.screen) { it * sign / 4 } + fadeIn(tween(Motion.MEDIUM_MS))) togetherWith
                        (slideOutHorizontally(Motion.screen) { -it * sign / 4 } + fadeOut(tween(Motion.SHORT_MS)))
                }
            },
            label = "authStage",
        ) { stage ->
            when (stage) {
                AuthStage.Welcome -> WelcomeScreen(
                    pictures = pictures,
                    onSignUp = model::continueWithPhone,
                    onSignIn = model::continueWithPhone,
                    enabled = !state.googleBusy,
                ) {
                    LegalLine()
                }
                AuthStage.Privacy -> PrivacyNoticeScreen(onBack = { model.back() }, onAccept = model::acceptPrivacy)
                AuthStage.Phone -> PhoneStep(state, model, language)
                AuthStage.Code -> CodeStep(state, model, language)
            }
        }
        Notices()
    }
}

private const val INTEGRITY_WAIT_MS = 3_000L

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

/** The session-ended note and the closed-account notice, wherever sign-in was reached from. */
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
        SnackbarHost(snackbar, Modifier.align(Alignment.TopCenter).safeDrawingPadding().padding(top = Notes.snackbarTop, start = Space.gutter, end = Space.gutter)) { data ->
            AppSnackbar(data.visuals.message)
        }
    }
    if (notice == GateNotice.AccountClosed) {
        AppDialog(
            title = brandString(R.string.auth_closed_title),
            body = brandString(R.string.auth_closed_body),
            confirm = brandString(R.string.action_ok),
            onConfirm = { graph.auth.clearNotice() },
            dismiss = null,
            onDismiss = { graph.auth.clearNotice() },
            destructive = false,
        )
    }
}

private const val NO_BREAK_SPACE = '\u00A0'

/** «با ادامه، قوانین و حریم خصوصی رو قبول می‌کنی.», both as links (`--text-2`, underlined) in `--type-legal`, `--text-3`. */
@Composable
private fun LegalLine() {
    val t = AppTheme.template
    val config by LocalAppGraph.current.config.config.collectAsStateWithLifecycle()
    val legal = config?.legal
    val termsUrl = legal?.termsUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.termsUrl
    val privacyUrl = legal?.privacyUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.privacyUrl
    // A link's words stay on one line (no-break spaces): a link split over two lines reads as two.
    val terms = brandString(R.string.legal_terms).replace(' ', NO_BREAK_SPACE)
    val privacy = brandString(R.string.legal_privacy).replace(' ', NO_BREAK_SPACE)
    // The raw template, unformatted: its %1$s and %2$s become links below.
    val template = brandText(stringResource(R.string.auth_legal_notice_links), LocalAppName.current)
    val linkStyle = TextLinkStyles(SpanStyle(color = t.colors.text2, textDecoration = TextDecoration.Underline))
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
        style = t.type.legal.copy(lineBreak = LineBreak.Heading),
        color = t.colors.text3,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().widthIn(max = Notes.legalMaxWidth),
    )
}

/** The route's own sizes. */
private object Notes {
    /** The terms line wraps at this width on a wide screen, so it stays two short lines at most. */
    val legalMaxWidth = 360.dp
    val snackbarTop = 8.dp
}
