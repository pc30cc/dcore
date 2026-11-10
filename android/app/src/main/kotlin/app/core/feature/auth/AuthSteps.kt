package app.core.feature.auth

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import app.core.LocalAppGraph
import app.core.R
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.brandString
import app.core.model.OtpChannel
import app.core.ui.components.overhangingTarget
import app.core.ui.components.BandFlag
import app.core.ui.components.HelperLine
import app.core.ui.components.PhoneField
import app.core.ui.components.PrimaryButton
import app.core.ui.components.SecondaryButton
import app.core.ui.components.TextAction
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Motion
import kotlinx.coroutines.delay

// MARK: - Phone number

/**
 * The number: the title, the field (country pill, the number left to right,
 * the clear button) and «کد رو بفرست». Where Google sign-in is offered (the
 * Play build) the button follows the field, then «یا» and «ادامه با گوگل»;
 * otherwise the button is docked above the keyboard, which comes up at once.
 */
@Composable
internal fun PhoneStep(state: AuthUiState, model: AuthViewModel, language: AppLanguage) {
    val t = AppTheme.template
    val otp = state.otp
    var picking by rememberSaveable { mutableStateOf(false) }
    val home = remember { otp.country }
    val haptics = LocalHapticFeedback.current
    val activity = LocalActivity.current
    LaunchedEffect(otp.sendError) {
        if (otp.sendError != null) haptics.performHapticFeedback(HapticFeedbackType.Reject)
    }
    val invalidShown = otp.parsed is PhoneParse.Invalid && PhoneNumbers.national(otp.phoneInput).length >= 4
    val numberWrong = invalidShown || otp.sendError == SendError.Invalid || otp.sendError == SendError.NotAllowed
    val wait = otp.sendError.waitLabel(otp.nowMillis)
    val message = when {
        // The button counts the wait down: no second clock under the field.
        otp.sendError is SendError.RateLimited && wait != null -> null
        otp.sendError != null -> sendErrorText(otp.sendError)
        invalidShown -> brandString(R.string.auth_error_phone_invalid)
        else -> null
    }
    val google = state.googleOffered
    // Without Google on the page the keyboard comes up with it, under the docked button.
    val numberFocus = remember { FocusRequester() }
    LaunchedEffect(google) {
        if (!google) {
            delay(Motion.MEDIUM_MS.toLong())
            runCatching { numberFocus.requestFocus() }
        }
    }
    val send: @Composable () -> Unit = {
        PrimaryButton(
            text = wait ?: brandString(R.string.auth_send_code),
            onClick = { model.sendCode() },
            enabled = otp.canSend || otp.sending,
            loading = otp.sending,
        )
    }
    AuthPage(
        title = brandString(R.string.auth_phone_title),
        onBack = { model.back() },
        actions = if (google) null else ({ send() }),
    ) {
        Gap(PhoneLayout.fieldTop)
        PhoneField(
            value = otp.phoneInput,
            onValueChange = model::phoneChanged,
            dialCode = Digits.localize("+${otp.country.dialCode}", language),
            onCountryClick = { picking = true },
            contentDescription = brandString(R.string.auth_phone_label),
            flag = { CountryFlag(otp.country) },
            error = message,
            errorFrame = numberWrong,
            visualTransformation = PhoneVisualTransformation(otp.country, language),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { model.sendCode() }),
            fieldModifier = Modifier
                .focusRequester(numberFocus)
                .semantics { contentType = ContentType.PhoneNumberNational },
        )
        if (google) {
            Gap(PhoneLayout.buttonTop)
            send()
            OrLine()
            SecondaryButton(
                text = brandString(R.string.auth_continue_google),
                onClick = { activity?.let(model::signInWithGoogle) },
                enabled = !state.googleBusy,
                icon = {
                    if (state.googleBusy) {
                        CircularProgressIndicator(Modifier.size(PhoneLayout.googleLogo), strokeWidth = PhoneLayout.spinnerStroke, color = t.colors.text)
                    } else {
                        Icon(painterResource(R.drawable.ic_sign_in_google), contentDescription = null, tint = Color.Unspecified, modifier = Modifier.size(PhoneLayout.googleLogo))
                    }
                },
            )
            state.googleError?.let {
                HelperLine(googleErrorText(it), Modifier.fillMaxWidth().padding(top = PhoneLayout.errorTop), error = true)
            }
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

/** «یا» between two hairlines. */
@Composable
private fun OrLine() {
    val t = AppTheme.template
    Row(Modifier.fillMaxWidth().padding(vertical = PhoneLayout.orGap), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PhoneLayout.orSpace)) {
        HorizontalDivider(Modifier.weight(1f), thickness = PhoneLayout.hairline, color = t.colors.line)
        Text(brandString(R.string.auth_or), style = t.type.bodySm, color = t.colors.text3)
        HorizontalDivider(Modifier.weight(1f), thickness = PhoneLayout.hairline, color = t.colors.line)
    }
}

/**
 * The country's flag in the pill: IR's three bands from the template's flag
 * tokens (the design draws it so), any other country's emoji flag.
 */
@Composable
internal fun CountryFlag(country: DialCountry) {
    val t = AppTheme.template
    if (country.iso == "IR") {
        BandFlag(t.colors.flagGreen, t.colors.flagWhite, t.colors.flagRed)
    } else {
        Text(country.flag, style = t.type.labelSm)
    }
}

private object PhoneLayout {
    val fieldTop = 28.dp
    val buttonTop = 20.dp
    val orGap = 18.dp
    val orSpace = 12.dp
    val googleLogo = 22.dp
    val spinnerStroke = 2.dp
    val hairline = 1.dp
    val errorTop = 8.dp
}

// MARK: - Code

/**
 * The code: the title, one line saying where it went with «ویرایش» in it,
 * the cells, then one line under them: the wait before a new code can be
 * sent, or what went wrong, and one text button («یه کد تازه بفرست»;
 * «دوباره امتحان کن» when the check itself failed; «بهم زنگ بزن» once a
 * text was already sent again, or when texts cannot be delivered).
 */
@Composable
internal fun CodeStep(state: AuthUiState, model: AuthViewModel, language: AppLanguage) {
    val graph = LocalAppGraph.current
    val context = LocalContext.current
    val otp = state.otp
    // Going back clears the challenge before this page has slid out: it keeps drawing the last one.
    val last = remember { arrayOfNulls<ActiveChallenge>(1) }
    val challenge = otp.challenge?.also { last[0] = it } ?: last[0] ?: return
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

    val number = Digits.localize(PhoneNumbers.displayNational(challenge.e164), language)
    val codeError = otp.codeError ?: if (otp.expired) CodeError.Expired else null
    AuthPage(title = brandString(R.string.auth_code_title), onBack = { model.back() }) {
        Gap(CodeLayout.subTop)
        SentTo(
            text = brandString(
                if (challenge.channel == OtpChannel.Call) R.string.auth_code_calling else R.string.auth_code_sent_to,
                "\u2066$number\u2069",
            ),
            onEdit = { model.back() },
        )
        Gap(CodeLayout.cellsTop)
        OtpCodeField(
            code = otp.code,
            length = challenge.codeLength,
            onCodeChange = model::codeChanged,
            language = language,
            label = brandString(R.string.auth_code_label, challenge.codeLength),
            enabled = !otp.verifying && !state.success && !otp.expired,
            isError = otp.codeError is CodeError.Wrong || codeError == CodeError.Locked || codeError == CodeError.Expired,
            errorKey = (otp.codeError as? CodeError.Wrong)?.let { otp.lastVerified to it } ?: otp.codeError,
            shown = if (otp.code.isEmpty() && otp.codeError is CodeError.Wrong) otp.lastVerified.orEmpty() else otp.code,
            onDone = model::retryVerify,
        )
        val problem = codeError?.let { codeErrorText(it) } ?: otp.sendError?.let { sendErrorText(it) }
        // A text that cannot be delivered: the call is the way forward.
        val callInstead = challenge.channel != OtpChannel.Call && (otp.sendError == SendError.SmsUnavailable || (problem == null && challenge.resent))
        when {
            otp.verifying || state.success -> Box(Modifier.fillMaxWidth().padding(top = CodeLayout.lineTop), contentAlignment = Alignment.Center) {
                val checking = brandString(R.string.ui_loading)
                CircularProgressIndicator(
                    Modifier.size(CodeLayout.spinner).semantics {
                        contentDescription = checking
                        liveRegion = LiveRegionMode.Polite
                    },
                    strokeWidth = CodeLayout.spinnerStroke,
                    color = AppTheme.template.colors.text3,
                )
            }
            problem != null -> {
                CenteredLine(problem, Modifier.padding(top = CodeLayout.errorTop), error = true)
                Gap(CodeLayout.actionTop)
                if (codeError == CodeError.Offline || codeError == CodeError.Failed) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                        TextAction(brandString(R.string.action_try_again), model::retryVerify)
                    }
                } else {
                    NextCode(otp, model, call = callInstead, modifier = Modifier.padding(top = CodeLayout.buttonLift))
                }
            }
            otp.resendInSeconds > 0 -> CenteredLine(resendIn(otp.resendInSeconds, language), Modifier.padding(top = CodeLayout.lineTop))
            else -> {
                Gap(CodeLayout.lineTop - CodeLayout.buttonLift)
                NextCode(otp, model, call = callInstead)
            }
        }
    }
}

/**
 * «به ۰۹۱۲ ۳۴۵ ۶۷۸۹ فرستادیم.» with «ویرایش» after it, set apart by a gap
 * that grows with the text. The link's touch area is 48 dp tall; the line
 * keeps its own height ([overhangingTarget]).
 */
@Composable
private fun SentTo(text: String, onEdit: () -> Unit) {
    val t = AppTheme.template
    val gap = with(LocalDensity.current) { (t.type.bodySm.fontSize * CodeLayout.EDIT_GAP_EM).toDp() }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = t.type.bodySm, color = t.colors.text2, modifier = Modifier.weight(1f, fill = false))
        Text(
            brandString(R.string.auth_code_edit),
            style = t.type.link,
            color = t.colors.primary,
            maxLines = 1,
            modifier = Modifier
                .overhangingTarget(onEdit, CodeLayout.target)
                .padding(start = gap, end = CodeLayout.editPad),
        )
    }
}

/** The one text button under the cells: a new code by text, or a call; the wait while it runs ([modifier] places that line). */
@Composable
private fun NextCode(otp: OtpState, model: AuthViewModel, call: Boolean, modifier: Modifier = Modifier) {
    val language = screenLanguage()
    if (otp.resendInSeconds > 0) {
        CenteredLine(resendIn(otp.resendInSeconds, language), modifier)
        return
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
        if (call) {
            TextAction(brandString(R.string.auth_call_me), { model.resend(OtpChannel.Call) }, enabled = otp.canResend)
        } else {
            TextAction(brandString(R.string.auth_new_code), { model.resend(OtpChannel.Sms) }, enabled = otp.canResend)
        }
    }
}

/**
 * A centred line under the cells. Only an [error] is announced as it comes
 * (a live region); the countdown changes every second and is read when the
 * person moves to it.
 */
@Composable
private fun CenteredLine(text: String, modifier: Modifier = Modifier, error: Boolean = false) {
    val t = AppTheme.template
    Text(
        text,
        style = t.type.bodySm,
        color = if (error) t.colors.error else t.colors.text3,
        textAlign = TextAlign.Center,
        modifier = modifier.fillMaxWidth().then(if (error) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier),
    )
}

private object CodeLayout {
    val subTop = 6.dp
    val cellsTop = 28.dp
    val lineTop = 18.dp
    val errorTop = 16.dp
    val actionTop = 6.dp
    val editPad = 4.dp
    /** The space before «ویرایش», in the line's own text size, so it grows with large text. */
    const val EDIT_GAP_EM = 0.6f
    val target = 48.dp
    val spinner = 18.dp
    val spinnerStroke = 2.dp
    /** A 48 dp text button sits this much higher than a line, so its words stay where the line's were. */
    val buttonLift = 13.dp
}

// MARK: - Messages

/** «۰:۴۲» in the screen's digits. */
internal fun clock(seconds: Int, language: AppLanguage): String =
    Digits.localize("%d:%02d".format(java.util.Locale.ROOT, seconds / 60, seconds % 60), language)

@Composable
private fun resendIn(seconds: Int, language: AppLanguage): String = brandString(R.string.auth_resend_in, clock(seconds, language))

/** «ارسال دوباره تا ۰:۴۲» while a refusal's wait runs, else null. */
@Composable
internal fun SendError?.waitLabel(nowMillis: Long): String? {
    val until = (this as? SendError.RateLimited)?.untilMillis ?: return null
    val seconds = ((until - nowMillis + 999) / 1000).toInt()
    if (seconds <= 0) return null
    return resendIn(seconds, screenLanguage())
}

@Composable
internal fun sendErrorText(error: SendError): String = when (error) {
    SendError.Invalid -> brandString(R.string.auth_error_phone_invalid)
    SendError.NotAllowed -> brandString(R.string.auth_error_phone_not_allowed)
    SendError.Banned -> brandString(R.string.auth_error_banned)
    // The time itself is on the button or the line under the cells, never twice.
    is SendError.RateLimited -> brandString(R.string.auth_error_rate_limited)
    SendError.SmsUnavailable -> brandString(R.string.auth_error_sms_unavailable)
    SendError.Offline -> brandString(R.string.error_offline)
    SendError.Maintenance -> brandString(R.string.maintenance_body)
    SendError.Failed -> brandString(R.string.error_generic)
}

@Composable
internal fun codeErrorText(error: CodeError): String = when (error) {
    is CodeError.Wrong -> {
        val left = error.attemptsLeft
        if (left != null && left in 1..3) brandPlural(R.plurals.auth_code_wrong_left, left, left) else brandString(R.string.auth_code_wrong)
    }
    CodeError.Expired -> brandString(R.string.auth_code_expired)
    CodeError.Locked -> brandString(R.string.auth_code_locked)
    CodeError.Banned -> brandString(R.string.auth_error_banned)
    is CodeError.RateLimited -> brandString(R.string.auth_error_rate_limited)
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
