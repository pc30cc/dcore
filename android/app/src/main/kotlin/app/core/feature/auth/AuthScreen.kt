package app.core.feature.auth

import android.content.Context
import android.os.Build
import android.telephony.TelephonyManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextDirection
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
import app.core.feature.legal.PrivacyNoticeScreen
import app.core.i18n.AppLanguage
import app.core.i18n.AppLocales
import app.core.i18n.Digits
import app.core.i18n.LocalAppName
import app.core.i18n.brandString
import app.core.i18n.brandText
import app.core.model.DeviceInfo
import app.core.model.OtpChannel
import app.core.store.IntegrityResult
import app.core.store.Store
import app.core.ui.components.BrandMark
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Motion
import app.core.ui.theme.Radius
import app.core.ui.theme.Space
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Sign-in: the welcome, the in-app privacy notice (the first step, before
 * anything is asked), the phone number and its code, or Google in the Play
 * build. Where the account goes afterwards is [AuthGate]'s to decide.
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

    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val reduced = LocalReducedMotion.current
    AnimatedContent(
        targetState = state.stage,
        transitionSpec = {
            if (reduced) {
                fadeIn(tween(Motion.SHORT_MS)) togetherWith fadeOut(tween(Motion.SHORT_MS))
            } else {
                val forward = targetState.ordinal > initialState.ordinal
                val sign = (if (rtl) -1 else 1) * (if (forward) 1 else -1)
                (slideInHorizontally(Motion.screen) { it * sign / 3 } + fadeIn(tween(Motion.MEDIUM_MS))) togetherWith
                    (slideOutHorizontally(Motion.screen) { -it * sign / 3 } + fadeOut(tween(Motion.SHORT_MS)))
            }
        },
        label = "authStage",
    ) { stage ->
        when (stage) {
            AuthStage.Welcome -> WelcomeScreen(state, model, language)
            AuthStage.Privacy -> PrivacyNoticeScreen(
                versions = state.legalVersions,
                onBack = { model.back() },
                onAccept = model::acceptPrivacy,
            )
            AuthStage.Phone -> PhoneStep(state, model, language)
            AuthStage.Code -> CodeStep(state, model, language)
        }
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

// MARK: - Welcome

@Composable
private fun WelcomeScreen(state: AuthUiState, model: AuthViewModel, language: AppLanguage) {
    val graph = LocalAppGraph.current
    val notice by graph.auth.notice.collectAsStateWithLifecycle()
    val config by graph.config.config.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val sessionEnded = brandString(R.string.auth_session_ended)
    LaunchedEffect(notice) {
        if (notice == GateNotice.SessionEnded) {
            graph.auth.clearNotice()
            snackbar.showSnackbar(sessionEnded)
        }
    }
    val activity = LocalActivity.current
    val legal = config?.legal
    val termsUrl = legal?.termsUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.termsUrl
    val privacyUrl = legal?.privacyUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.privacyUrl

    Box(Modifier.fillMaxSize()) {
        WelcomeBackdrop()
        BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
            val viewport = maxHeight
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = viewport)
                    .padding(horizontal = Space.gutter, vertical = Space.xl),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.SpaceBetween,
            ) {
                Spacer(Modifier.height(Space.xl))
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.md)) {
                    BreathingMark()
                    Spacer(Modifier.height(Space.md))
                    Text(
                        LocalAppName.current,
                        style = MaterialTheme.typography.displayMedium,
                        color = MaterialTheme.colorScheme.onBackground,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.semantics { heading() },
                    )
                    Text(
                        brandString(R.string.auth_subtitle),
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.widthIn(max = 420.dp),
                    )
                }
                Column(
                    Modifier.fillMaxWidth().widthIn(max = 520.dp).padding(top = Space.xxl),
                    verticalArrangement = Arrangement.spacedBy(Space.md),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    PrimaryButton(
                        text = brandString(R.string.auth_continue_phone),
                        onClick = model::continueWithPhone,
                        enabled = !state.googleBusy,
                    )
                    if (state.googleOffered) {
                        OutlinedButton(
                            onClick = {
                                if (state.privacyAccepted && activity != null) model.signInWithGoogle(activity) else model.continueWithGoogle()
                            },
                            enabled = !state.googleBusy,
                            shape = RoundedCornerShape(Radius.pill),
                            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                        ) {
                            if (state.googleBusy) {
                                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                            } else {
                                Icon(painterResource(R.drawable.ic_sign_in_google), contentDescription = null, tint = androidx.compose.ui.graphics.Color.Unspecified, modifier = Modifier.size(20.dp))
                                Spacer(Modifier.size(Space.sm))
                                Text(brandString(R.string.auth_continue_google), style = MaterialTheme.typography.labelLarge)
                            }
                        }
                    }
                    InlineMessage(state.googleError?.let { googleErrorText(it) })
                    LegalLine(termsUrl = termsUrl, privacyUrl = privacyUrl)
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).safeDrawingPadding())
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

@Composable
private fun googleErrorText(error: GoogleError): String = brandString(
    when (error) {
        GoogleError.NoAccount -> R.string.auth_google_no_account
        GoogleError.Unavailable -> R.string.auth_google_unavailable
        GoogleError.Banned -> R.string.auth_error_banned
        GoogleError.Offline -> R.string.error_offline
        GoogleError.Failed -> R.string.auth_google_failed
    },
)

/** The brand colour as a soft wash at the top of the welcome, fading into the background. */
@Composable
private fun WelcomeBackdrop() {
    val colors = MaterialTheme.colorScheme
    Box(
        Modifier
            .fillMaxSize()
            .background(Brush.verticalGradient(0f to colors.primaryContainer, 0.55f to colors.background, 1f to colors.background)),
    )
}

/** The mark, breathing slowly; still with reduced motion. */
@Composable
private fun BreathingMark() {
    val reduced = LocalReducedMotion.current
    val scale = if (reduced) {
        1f
    } else {
        val transition = rememberInfiniteTransition(label = "mark")
        transition.animateFloat(1f, 1.06f, infiniteRepeatable(tween(2400), RepeatMode.Reverse), label = "markScale").value
    }
    Surface(
        shape = RoundedCornerShape(36.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 6.dp,
        modifier = Modifier.size(112.dp).graphicsLayer {
            scaleX = scale
            scaleY = scale
        },
    ) {
        Box(contentAlignment = Alignment.Center) { BrandMark(size = 72.dp) }
    }
}

/** "By continuing you agree to the Terms and the Privacy Policy", with both as links. */
@Composable
private fun LegalLine(termsUrl: String, privacyUrl: String) {
    val terms = brandString(R.string.legal_terms)
    val privacy = brandString(R.string.legal_privacy)
    // The raw template, unformatted: its %1$s and %2$s become links below. Formatting it
    // with no arguments (brandString) throws MissingFormatArgumentException.
    val template = brandText(stringResource(R.string.auth_legal_notice_links), LocalAppName.current)
    val linkStyle = TextLinkStyles(SpanStyle(color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold, textDecoration = TextDecoration.Underline))
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
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
        modifier = Modifier.padding(top = Space.xs),
    )
}

// MARK: - Phone number

@Composable
private fun PhoneStep(state: AuthUiState, model: AuthViewModel, language: AppLanguage) {
    val otp = state.otp
    var picking by rememberSaveable { mutableStateOf(false) }
    val home = remember { otp.country }
    val haptics = LocalHapticFeedback.current
    LaunchedEffect(otp.sendError) {
        if (otp.sendError != null) haptics.performHapticFeedback(HapticFeedbackType.Reject)
    }
    val parsed = otp.parsed
    val invalidShown = parsed is PhoneParse.Invalid && PhoneNumbers.national(otp.phoneInput).length >= 4
    FlowScaffold(
        title = brandString(R.string.auth_phone_title),
        subtitle = brandString(R.string.auth_phone_body),
        onBack = { model.back() },
        actions = {
            PrimaryButton(
                text = otp.sendError.waitLabel(otp.nowMillis) ?: brandString(R.string.auth_send_code),
                onClick = { model.sendCode() },
                enabled = otp.canSend,
                busy = otp.sending,
                busyLabel = brandString(R.string.auth_sending),
            )
        },
    ) {
        CompositionLocalLtr {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                Surface(
                    onClick = { picking = true },
                    shape = RoundedCornerShape(Radius.md),
                    color = MaterialTheme.colorScheme.surfaceContainer,
                    modifier = Modifier.heightIn(min = 56.dp),
                ) {
                    Row(
                        Modifier.padding(horizontal = Space.md, vertical = Space.md),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Space.xs),
                    ) {
                        Text(otp.country.flag, style = MaterialTheme.typography.titleLarge)
                        Text(
                            Digits.localize("+${otp.country.dialCode}", language),
                            style = MaterialTheme.typography.titleMedium.copy(textDirection = TextDirection.Ltr),
                        )
                        Icon(Icons.Filled.ArrowDropDown, contentDescription = brandString(R.string.auth_country_choose, otp.country.displayName(java.util.Locale.forLanguageTag(language.tag))))
                    }
                }
                OutlinedTextField(
                    value = otp.phoneInput,
                    onValueChange = model::phoneChanged,
                    singleLine = true,
                    isError = invalidShown || otp.sendError == SendError.Invalid,
                    placeholder = { Text(Digits.localize(PhoneNumbers.group(otp.country, otp.country.example), language)) },
                    label = { Text(brandString(R.string.auth_phone_label)) },
                    textStyle = MaterialTheme.typography.titleMedium.copy(textDirection = TextDirection.Ltr),
                    visualTransformation = PhoneVisualTransformation(otp.country, language),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { model.sendCode() }),
                    leadingIcon = { Icon(Icons.Filled.Phone, contentDescription = null) },
                    modifier = Modifier
                        .weight(1f)
                        .semantics { contentType = ContentType.PhoneNumberNational },
                )
            }
        }
        InlineMessage(
            when {
                otp.sendError != null -> sendErrorText(otp.sendError, otp.nowMillis)
                invalidShown -> brandString(R.string.auth_phone_invalid_local)
                else -> null
            },
            shakeKey = otp.sendError,
        )
        NoteCard {
            Text(brandString(R.string.auth_phone_note), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (picking) {
        CountryPickerSheet(
            selected = otp.country,
            home = home,
            language = language,
            onPick = {
                model.countryChanged(it)
                picking = false
            },
            onDismiss = { picking = false },
        )
    }
}

@Composable
private fun CompositionLocalLtr(content: @Composable () -> Unit) {
    androidx.compose.runtime.CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr, content = content)
}

/** "Try again in 0:42" while a refusal's wait runs, else null. */
@Composable
private fun SendError?.waitLabel(nowMillis: Long): String? {
    val until = (this as? SendError.RateLimited)?.untilMillis ?: return null
    val seconds = ((until - nowMillis + 999) / 1000).toInt()
    if (seconds <= 0) return null
    return brandString(R.string.auth_wait, seconds / 60, seconds % 60)
}

@Composable
private fun sendErrorText(error: SendError, nowMillis: Long): String = when (error) {
    SendError.Invalid -> brandString(R.string.auth_error_phone_invalid)
    SendError.NotAllowed -> brandString(R.string.auth_error_phone_not_allowed)
    SendError.Banned -> brandString(R.string.auth_error_banned)
    is SendError.RateLimited -> {
        val until = error.untilMillis
        if (until != null && until > nowMillis) {
            val s = ((until - nowMillis + 999) / 1000).toInt()
            brandString(R.string.auth_error_rate_limited_wait, s / 60, s % 60)
        } else {
            brandString(R.string.auth_error_rate_limited)
        }
    }
    SendError.SmsUnavailable -> brandString(R.string.auth_error_sms_unavailable)
    SendError.Offline -> brandString(R.string.error_offline)
    SendError.Maintenance -> brandString(R.string.maintenance_body)
    SendError.Failed -> brandString(R.string.error_generic)
}

// MARK: - Code

@Composable
private fun CodeStep(state: AuthUiState, model: AuthViewModel, language: AppLanguage) {
    val graph = LocalAppGraph.current
    val context = LocalContext.current
    val otp = state.otp
    val challenge = otp.challenge ?: return
    val haptics = LocalHapticFeedback.current

    // The text message, read without the SMS permission where the build can (Play's SMS Retriever).
    LaunchedEffect(challenge.id) {
        graph.auth.smsCodes.codes(context.applicationContext, challenge.codeLength).collect { model.codeReceived(it) }
    }
    LaunchedEffect(otp.codeError) {
        if (otp.codeError != null && otp.codeError != CodeError.Offline) haptics.performHapticFeedback(HapticFeedbackType.Reject)
    }
    LaunchedEffect(state.success) {
        if (state.success) haptics.performHapticFeedback(HapticFeedbackType.Confirm)
    }

    val number = Digits.localize(PhoneNumbers.display(challenge.e164), language)
    FlowScaffold(
        title = brandString(R.string.auth_code_title),
        subtitle = brandString(
            if (challenge.channel == OtpChannel.Call) R.string.auth_code_body_call else R.string.auth_code_body,
            "\u2066$number\u2069",
        ),
        onBack = { model.back() },
        actions = {
            when {
                otp.codeError == CodeError.Offline || otp.codeError == CodeError.Failed ->
                    PrimaryButton(brandString(R.string.action_try_again), onClick = model::retryVerify, busy = otp.verifying)
                otp.expired ->
                    PrimaryButton(
                        text = if (otp.resendInSeconds > 0) brandString(R.string.auth_wait, otp.resendInSeconds / 60, otp.resendInSeconds % 60) else brandString(R.string.auth_send_new_code),
                        onClick = { model.resend() },
                        enabled = otp.canResend,
                        busy = otp.sending,
                    )
                else -> ResendRow(otp, model)
            }
        },
    ) {
        TextButton(onClick = { model.back() }, modifier = Modifier.padding(top = 0.dp)) {
            Text(brandString(R.string.auth_change_number))
        }
        OtpCodeField(
            code = otp.code,
            length = challenge.codeLength,
            onCodeChange = model::codeChanged,
            language = language,
            label = brandString(R.string.auth_code_label, challenge.codeLength),
            enabled = !otp.verifying && !state.success && !otp.expired,
            isError = otp.codeError is CodeError.Wrong || otp.codeError == CodeError.Locked,
            errorKey = (otp.codeError as? CodeError.Wrong)?.let { otp.lastVerified to it } ?: otp.codeError,
            success = state.success,
            onDone = model::retryVerify,
            modifier = Modifier.padding(vertical = Space.sm),
        )
        Box(Modifier.fillMaxWidth().heightIn(min = 28.dp), contentAlignment = Alignment.Center) {
            when {
                otp.verifying -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text(brandString(R.string.auth_checking), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                state.success -> Text(brandString(R.string.auth_signed_in), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                !otp.expired && otp.codeError == null -> Text(
                    brandString(R.string.auth_code_expires, otp.expiresInSeconds / 60, otp.expiresInSeconds % 60),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        InlineMessage(otp.codeError?.let { codeErrorText(it, otp) } ?: otp.sendError?.let { sendErrorText(it, otp.nowMillis) })
    }
}

@Composable
private fun ResendRow(otp: OtpState, model: AuthViewModel) {
    val wait = otp.resendInSeconds
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs)) {
        Text(brandString(R.string.auth_no_code), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { model.resend(OtpChannel.Sms) }, enabled = otp.canResend) {
                Text(
                    if (wait > 0) brandString(R.string.auth_resend_in, wait / 60, wait % 60) else brandString(R.string.auth_resend),
                )
            }
            if (wait == 0) {
                TextButton(onClick = { model.resend(OtpChannel.Call) }, enabled = otp.canResend) {
                    Icon(Icons.Filled.Call, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(Space.xs))
                    Text(brandString(R.string.auth_call_me))
                }
            }
        }
    }
}

@Composable
private fun codeErrorText(error: CodeError, otp: OtpState): String = when (error) {
    is CodeError.Wrong -> {
        val left = error.attemptsLeft
        if (left != null && left in 1..3) {
            brandPlural(R.plurals.auth_code_wrong_left, left, left)
        } else {
            brandString(R.string.auth_code_wrong)
        }
    }
    CodeError.Expired -> brandString(R.string.auth_code_expired)
    CodeError.Locked -> brandString(R.string.auth_code_locked)
    CodeError.Banned -> brandString(R.string.auth_error_banned)
    is CodeError.RateLimited -> {
        val until = error.untilMillis
        if (until != null && until > otp.nowMillis) {
            val s = ((until - otp.nowMillis + 999) / 1000).toInt()
            brandString(R.string.auth_error_rate_limited_wait, s / 60, s % 60)
        } else {
            brandString(R.string.auth_error_rate_limited)
        }
    }
    CodeError.Offline -> brandString(R.string.error_offline)
    CodeError.Failed -> brandString(R.string.error_generic)
}
