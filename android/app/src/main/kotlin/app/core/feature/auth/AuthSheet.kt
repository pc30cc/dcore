package app.core.feature.auth

import androidx.activity.compose.LocalActivity
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Call
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.auth.welcome.BubbleArt
import app.core.feature.auth.welcome.WelcomePalette
import app.core.feature.auth.welcome.WelcomeType
import app.core.feature.legal.PrivacyAcceptNote
import app.core.feature.legal.PrivacyNoticeBody
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.brandString
import app.core.model.OtpChannel
import app.core.ui.theme.DarkSemantic
import app.core.ui.theme.LocalSemanticColors
import app.core.ui.theme.Motion
import app.core.ui.theme.Radius
import app.core.ui.theme.Space
import kotlinx.coroutines.delay

/** Which button opened the sheet: the steps are the same, the greeting differs. */
enum class SheetIntent { SignIn, SignUp }

/**
 * The sheet over the welcome: the privacy notice when it is still to be
 * accepted, the phone number, then the code, in a dark warm sheet that rises
 * from the bottom. Back steps out (code → number → welcome).
 */
@Composable
fun AuthSheet(
    state: AuthUiState,
    model: AuthViewModel,
    intent: SheetIntent,
    language: AppLanguage,
    art: BubbleArt,
    reduced: Boolean,
) {
    val visible = state.stage != AuthStage.Welcome
    Box(Modifier.fillMaxSize()) {
        AnimatedVisibility(visible = visible, enter = fadeIn(tween(Motion.MEDIUM_MS)), exit = fadeOut(tween(Motion.MEDIUM_MS))) {
            // A light dim: the scene above the sheet stays bright.
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.20f)))
        }
        AnimatedVisibility(
            visible = visible,
            enter = if (reduced) fadeIn(tween(Motion.SHORT_MS)) else slideInVertically(spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMediumLow)) { it } + fadeIn(tween(Motion.SHORT_MS)),
            exit = if (reduced) fadeOut(tween(Motion.SHORT_MS)) else slideOutVertically(tween(Motion.MEDIUM_MS)) { it } + fadeOut(tween(Motion.MEDIUM_MS)),
        ) {
            SheetTheme {
                Column(
                    Modifier
                        .fillMaxSize()
                        .statusBarsPadding()
                        .padding(top = 16.dp)
                        .clip(RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp))
                        .background(Brush.verticalGradient(*WelcomePalette.sheetStops))
                        .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime).only(WindowInsetsSides.Bottom)),
                ) {
                    Box(
                        Modifier
                            .align(Alignment.CenterHorizontally)
                            .padding(top = 8.dp)
                            .size(width = 36.dp, height = 4.dp)
                            .clip(CircleShape)
                            .background(Color.White.copy(alpha = 0.28f)),
                    )
                    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
                    // The stage the sheet last showed: closing keeps it, so the sheet does not change as it slides away.
                    val last = remember { arrayOf(AuthStage.Phone) }
                    if (state.stage != AuthStage.Welcome) last[0] = state.stage
                    AnimatedContent(
                        targetState = last[0],
                        transitionSpec = {
                            if (reduced) {
                                fadeIn(tween(Motion.SHORT_MS)) togetherWith fadeOut(tween(Motion.SHORT_MS))
                            } else {
                                val forward = targetState.ordinal > initialState.ordinal
                                val sign = (if (rtl) -1 else 1) * (if (forward) 1 else -1)
                                (slideInHorizontally(Motion.screen) { it * sign / 4 } + fadeIn(tween(Motion.MEDIUM_MS))) togetherWith
                                    (slideOutHorizontally(Motion.screen) { -it * sign / 4 } + fadeOut(tween(Motion.SHORT_MS)))
                            }
                        },
                        label = "sheetStage",
                        modifier = Modifier.weight(1f),
                    ) { stage ->
                        when (stage) {
                            AuthStage.Privacy -> PrivacyStep(state, model, language, art)
                            AuthStage.Code -> CodeStep(state, model, language, art)
                            else -> PhoneStep(state, model, intent, language, art)
                        }
                    }
                }
            }
        }
    }
}

/** Material's colours and the semantic ones, turned to the sheet's dark warm brown. */
@Composable
private fun SheetTheme(content: @Composable () -> Unit) {
    val scheme = remember { WelcomePalette.sheetScheme() }
    CompositionLocalProvider(LocalSemanticColors provides DarkSemantic) {
        MaterialTheme(colorScheme = scheme, typography = MaterialTheme.typography, shapes = MaterialTheme.shapes, content = content)
    }
}

/**
 * One step in the sheet: back, the three-face mark, the title (its
 * emphasised words in the welcome's emphasis face) and a line under it, the
 * step's content (scrolling with large text), and its actions at the bottom.
 */
@Composable
private fun SheetStep(
    title: AnnotatedString,
    subtitle: String?,
    onBack: () -> Unit,
    art: BubbleArt,
    actions: @Composable ColumnScope.() -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val backLabel = brandString(R.string.action_back)
    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Space.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(Modifier.fillMaxWidth().padding(top = Space.sm)) {
                // A small glass circle, inside a full-size touch target.
                Box(
                    Modifier
                        .size(Space.minTouch)
                        .clip(CircleShape)
                        .clickable(onClick = onBack, role = Role.Button, onClickLabel = null)
                        .semantics { contentDescription = backLabel },
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.size(36.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.12f)), contentAlignment = Alignment.Center) {
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp))
                    }
                }
            }
            FaceCluster(art)
            Spacer(Modifier.height(Space.md))
            Text(
                title,
                style = MaterialTheme.typography.headlineSmall.copy(fontSize = 22.sp, fontWeight = FontWeight.Bold, lineHeight = 1.3.em),
                color = WelcomePalette.SheetText,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() },
            )
            if (subtitle != null) {
                Spacer(Modifier.height(Space.sm))
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodyMedium.copy(lineBreak = LineBreak.Heading),
                    color = WelcomePalette.SheetTextSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.widthIn(max = 340.dp),
                )
            }
            Spacer(Modifier.height(Space.xl))
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.md), content = content)
            Spacer(Modifier.height(Space.lg))
        }
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = Space.xl)
                .padding(top = Space.sm, bottom = Space.lg),
            verticalArrangement = Arrangement.spacedBy(Space.sm),
            horizontalAlignment = Alignment.CenterHorizontally,
            content = actions,
        )
    }
}

/** Three faces in overlapping bubbles: the sheet's small mark. Decorative. */
@Composable
private fun FaceCluster(art: BubbleArt) {
    Canvas(Modifier.padding(top = Space.xs).size(width = 72.dp, height = 34.dp)) {
        val r = size.height * 0.40f
        val cy = size.height / 2f
        drawIntoCanvas { canvas ->
            val c = canvas.nativeCanvas
            art.drawBadge(c, size.width / 2f - r * 0.95f, cy + r * 0.08f, r * 0.9f, 2, 40f)
            art.drawBadge(c, size.width / 2f + r * 0.95f, cy + r * 0.08f, r * 0.9f, 4, 200f)
            art.drawBadge(c, size.width / 2f, cy, r * 1.05f, 0, 120f)
        }
    }
}

/** The sheet's main button: a light pill, faint while it cannot be pressed. */
@Composable
private fun SheetButton(text: String, onClick: () -> Unit, enabled: Boolean = true, busy: Boolean = false, busyLabel: String? = null) {
    PrimaryButton(
        text = text,
        onClick = onClick,
        enabled = enabled,
        busy = busy,
        busyLabel = busyLabel,
        colors = ButtonDefaults.buttonColors(
            containerColor = WelcomePalette.LightPill,
            contentColor = WelcomePalette.OnLightPill,
            // Still a light pill while it waits, its word faded.
            disabledContainerColor = WelcomePalette.LightPill.copy(alpha = 0.80f),
            disabledContentColor = WelcomePalette.DisabledOnLightPill,
        ),
    )
}

@Composable
private fun SheetLink(text: String, onClick: () -> Unit, enabled: Boolean = true, icon: (@Composable () -> Unit)? = null) {
    TextButton(onClick = onClick, enabled = enabled, modifier = Modifier.heightIn(min = Space.minTouch)) {
        if (icon != null) {
            icon()
            Spacer(Modifier.width(Space.sm))
        }
        Text(
            text,
            style = MaterialTheme.typography.labelLarge.copy(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            color = WelcomePalette.SheetText,
        )
    }
}

// MARK: - Privacy

@Composable
private fun PrivacyStep(state: AuthUiState, model: AuthViewModel, language: AppLanguage, art: BubbleArt) {
    SheetStep(
        title = sheetTitle(brandString(R.string.auth_sheet_privacy_title), language),
        subtitle = brandString(R.string.privacy_intro),
        onBack = { model.back() },
        art = art,
        actions = {
            SheetButton(brandString(R.string.privacy_accept), onClick = model::acceptPrivacy)
            PrivacyAcceptNote(state.legalVersions)
        },
    ) {
        PrivacyNoticeBody()
    }
}

// MARK: - Phone number

@Composable
private fun PhoneStep(state: AuthUiState, model: AuthViewModel, intent: SheetIntent, language: AppLanguage, art: BubbleArt) {
    val otp = state.otp
    var picking by rememberSaveable { mutableStateOf(false) }
    val home = remember { otp.country }
    val haptics = LocalHapticFeedback.current
    val activity = LocalActivity.current
    LaunchedEffect(otp.sendError) {
        if (otp.sendError != null) haptics.performHapticFeedback(HapticFeedbackType.Reject)
    }
    val parsed = otp.parsed
    val invalidShown = parsed is PhoneParse.Invalid && PhoneNumbers.national(otp.phoneInput).length >= 4
    val title = brandString(if (intent == SheetIntent.SignUp) R.string.auth_sheet_signup_title else R.string.auth_sheet_signin_title)
    // The number field takes the focus once the sheet has risen, so the keypad comes up under Continue.
    val numberFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        delay(Motion.MEDIUM_MS.toLong())
        runCatching { numberFocus.requestFocus() }
    }
    SheetStep(
        title = sheetTitle(title, language),
        subtitle = brandString(if (intent == SheetIntent.SignUp) R.string.auth_sheet_signup_body else R.string.auth_sheet_signin_body),
        onBack = { model.back() },
        art = art,
        actions = {
            if (state.googleOffered) {
                SheetLink(
                    text = brandString(R.string.auth_continue_google),
                    onClick = { activity?.let(model::signInWithGoogle) },
                    enabled = !state.googleBusy,
                    icon = {
                        if (state.googleBusy) {
                            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = WelcomePalette.SheetText)
                        } else {
                            Icon(painterResource(R.drawable.ic_sign_in_google), contentDescription = null, tint = Color.Unspecified, modifier = Modifier.size(18.dp))
                        }
                    },
                )
            }
            InlineMessage(state.googleError?.let { googleErrorText(it) })
            SheetButton(
                text = otp.sendError.waitLabel(otp.nowMillis) ?: brandString(R.string.auth_sheet_continue),
                onClick = { model.sendCode() },
                enabled = otp.canSend,
                busy = otp.sending,
                busyLabel = brandString(R.string.auth_sending),
            )
        },
    ) {
        PhoneRow(
            otp = otp,
            language = language,
            focus = numberFocus,
            isError = invalidShown || otp.sendError == SendError.Invalid,
            onPick = { picking = true },
            onChange = model::phoneChanged,
            onDone = { model.sendCode() },
        )
        InlineMessage(
            when {
                otp.sendError != null -> sendErrorText(otp.sendError, otp.nowMillis)
                invalidShown -> brandString(R.string.auth_phone_invalid_local)
                else -> null
            },
            shakeKey = otp.sendError,
        )
        Text(
            brandString(R.string.auth_phone_note),
            style = MaterialTheme.typography.bodySmall,
            color = WelcomePalette.SheetTextSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
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

/**
 * The country's flag and calling code, then the number, in one pill.
 * Always left to right, also in Persian: a phone number reads that way.
 */
@Composable
private fun PhoneRow(
    otp: OtpState,
    language: AppLanguage,
    focus: FocusRequester,
    isError: Boolean,
    onPick: () -> Unit,
    onChange: (String) -> Unit,
    onDone: () -> Unit,
) {
    val pill = RoundedCornerShape(Radius.pill)
    val label = brandString(R.string.auth_phone_label)
    val chooseLabel = brandString(R.string.auth_country_choose, otp.country.displayName(java.util.Locale.forLanguageTag(language.tag)))
    val text = MaterialTheme.typography.titleMedium.copy(color = WelcomePalette.SheetText, textDirection = TextDirection.Ltr)
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 52.dp)
                .clip(pill)
                .background(WelcomePalette.SheetField)
                .then(if (isError) Modifier.border(1.dp, DarkSemantic.danger, pill) else Modifier)
                .padding(5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(
                onClick = onPick,
                shape = pill,
                color = WelcomePalette.SheetChip,
                contentColor = WelcomePalette.SheetText,
                modifier = Modifier.heightIn(min = Space.minTouch).semantics { contentDescription = chooseLabel },
            ) {
                Row(
                    Modifier.padding(start = Space.md, end = Space.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.xs),
                ) {
                    Text(otp.country.flag, style = MaterialTheme.typography.titleMedium)
                    Text(
                        Digits.localize("+${otp.country.dialCode}", language),
                        style = MaterialTheme.typography.titleSmall.copy(textDirection = TextDirection.Ltr),
                    )
                    Icon(Icons.Filled.ArrowDropDown, contentDescription = null, tint = WelcomePalette.SheetText.copy(alpha = 0.7f), modifier = Modifier.size(18.dp))
                }
            }
            Spacer(Modifier.width(Space.md))
            BasicTextField(
                value = otp.phoneInput,
                onValueChange = onChange,
                singleLine = true,
                textStyle = text,
                cursorBrush = SolidColor(WelcomePalette.SheetText),
                visualTransformation = PhoneVisualTransformation(otp.country, language),
                keyboardOptions = KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Phone, imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { onDone() }),
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = Space.minTouch)
                    .focusRequester(focus)
                    .semantics {
                        contentType = ContentType.PhoneNumberNational
                        contentDescription = label
                    },
                decorationBox = { inner ->
                    Box(Modifier.padding(end = Space.md), contentAlignment = Alignment.CenterStart) {
                        if (otp.phoneInput.isEmpty()) {
                            Text(
                                brandString(R.string.auth_phone_placeholder),
                                style = text.copy(textDirection = TextDirection.Content, fontWeight = FontWeight.Medium),
                                color = WelcomePalette.SheetPlaceholder,
                            )
                        }
                        inner()
                    }
                },
            )
        }
    }
}

/** A sheet's title: its emphasised words (between asterisks) in the welcome's emphasis face. */
@Composable
private fun sheetTitle(source: String, language: AppLanguage): AnnotatedString {
    val persian = language == AppLanguage.FA
    return remember(source, persian) { WelcomeType.headline(source, WelcomeType.emphasis(persian, if (persian) 25.sp else 27.sp)) }
}

// MARK: - Code

@Composable
private fun CodeStep(state: AuthUiState, model: AuthViewModel, language: AppLanguage, art: BubbleArt) {
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
    SheetStep(
        title = AnnotatedString(brandString(R.string.auth_code_title)),
        subtitle = brandString(
            if (challenge.channel == OtpChannel.Call) R.string.auth_code_body_call else R.string.auth_code_body,
            "\u2066$number\u2069",
        ),
        onBack = { model.back() },
        art = art,
        actions = {
            when {
                otp.codeError == CodeError.Offline || otp.codeError == CodeError.Failed ->
                    SheetButton(brandString(R.string.action_try_again), onClick = model::retryVerify, busy = otp.verifying)
                otp.expired ->
                    SheetButton(
                        text = if (otp.resendInSeconds > 0) brandString(R.string.auth_wait, otp.resendInSeconds / 60, otp.resendInSeconds % 60) else brandString(R.string.auth_send_new_code),
                        onClick = { model.resend() },
                        enabled = otp.canResend,
                        busy = otp.sending,
                    )
                else -> ResendRow(otp, model)
            }
        },
    ) {
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
            modifier = Modifier.padding(vertical = Space.xs),
        )
        Box(Modifier.fillMaxWidth().heightIn(min = 28.dp), contentAlignment = Alignment.Center) {
            when {
                otp.verifying -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = WelcomePalette.SheetText)
                    Text(brandString(R.string.auth_checking), style = MaterialTheme.typography.bodyMedium, color = WelcomePalette.SheetTextSecondary)
                }
                state.success -> Text(brandString(R.string.auth_signed_in), style = MaterialTheme.typography.bodyMedium, color = DarkSemantic.success)
                !otp.expired && otp.codeError == null -> Text(
                    brandString(R.string.auth_code_expires, otp.expiresInSeconds / 60, otp.expiresInSeconds % 60),
                    style = MaterialTheme.typography.bodySmall,
                    color = WelcomePalette.SheetTextSecondary,
                )
            }
        }
        InlineMessage(otp.codeError?.let { codeErrorText(it, otp) } ?: otp.sendError?.let { sendErrorText(it, otp.nowMillis) })
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            SheetLink(brandString(R.string.auth_change_number), onClick = { model.back() })
        }
    }
}

@Composable
private fun ResendRow(otp: OtpState, model: AuthViewModel) {
    val wait = otp.resendInSeconds
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs)) {
        Text(brandString(R.string.auth_no_code), style = MaterialTheme.typography.bodyMedium, color = WelcomePalette.SheetTextSecondary)
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { model.resend(OtpChannel.Sms) }, enabled = otp.canResend) {
                Text(if (wait > 0) brandString(R.string.auth_resend_in, wait / 60, wait % 60) else brandString(R.string.auth_resend))
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

// MARK: - Messages

/** "Try again in 0:42" while a refusal's wait runs, else null. */
@Composable
internal fun SendError?.waitLabel(nowMillis: Long): String? {
    val until = (this as? SendError.RateLimited)?.untilMillis ?: return null
    val seconds = ((until - nowMillis + 999) / 1000).toInt()
    if (seconds <= 0) return null
    return brandString(R.string.auth_wait, seconds / 60, seconds % 60)
}

@Composable
internal fun sendErrorText(error: SendError, nowMillis: Long): String = when (error) {
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

@Composable
internal fun codeErrorText(error: CodeError, otp: OtpState): String = when (error) {
    is CodeError.Wrong -> {
        val left = error.attemptsLeft
        if (left != null && left in 1..3) brandPlural(R.plurals.auth_code_wrong_left, left, left) else brandString(R.string.auth_code_wrong)
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

@Composable
internal fun googleErrorText(error: GoogleError): String = brandString(
    when (error) {
        GoogleError.NoAccount -> R.string.auth_google_no_account
        GoogleError.Unavailable -> R.string.auth_google_unavailable
        GoogleError.Banned -> R.string.auth_error_banned
        GoogleError.Offline -> R.string.error_offline
        GoogleError.Failed -> R.string.auth_google_failed
    },
)
