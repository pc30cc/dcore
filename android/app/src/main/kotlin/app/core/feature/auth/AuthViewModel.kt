package app.core.feature.auth

import android.app.Activity
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.core.common.Clock
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.legal.LegalAcceptance
import app.core.model.AuthMethod
import app.core.model.AuthResult
import app.core.model.Config
import app.core.model.DeviceInfo
import app.core.model.LegalVersions
import app.core.model.OtpChannel
import app.core.model.OtpStartRequest
import app.core.model.ProblemCodes
import app.core.net.ApiError
import app.core.net.ServerApi
import app.core.store.ExternalSignIn
import app.core.store.ExternalSignInResult
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.security.MessageDigest

/** The sign-in screens, in order. */
enum class AuthStage { Welcome, Privacy, Phone, Code }

/** How the person chose to sign in, remembered across the privacy notice. */
enum class SignInMethod { Phone, Google }

sealed interface GoogleError {
    data object NoAccount : GoogleError
    data object Unavailable : GoogleError
    data object Banned : GoogleError
    data object Offline : GoogleError
    data object Failed : GoogleError
}

data class AuthUiState(
    val stage: AuthStage = AuthStage.Welcome,
    val otp: OtpState,
    /** "Continue with Google" is offered: the Play build, configured, and the server allows it. */
    val googleOffered: Boolean = false,
    val googleBusy: Boolean = false,
    val googleError: GoogleError? = null,
    /** The privacy notice was accepted on this install, in its current version. */
    val privacyAccepted: Boolean = false,
    val pending: SignInMethod? = null,
    /** A one-shot: the screen should start the Google sheet now (it holds the activity). */
    val launchGoogle: Boolean = false,
    /** The versions of the texts shown on the notice. */
    val legalVersions: LegalVersions = LegalVersions(),
    /** Signed in: the screen shows it for a moment before it moves on. */
    val success: Boolean = false,
)

/**
 * Sign-in: the welcome, the in-app privacy notice, then the phone and code
 * steps ([OtpFlow]) or Google (the Play build only).
 *
 * The number, the country and the code in flight survive the process being
 * killed (a person who switches to the messages app and back finds the code
 * step where they left it).
 */
class AuthViewModel(
    private val api: ServerApi,
    private val gate: AuthGate,
    private val legal: LegalAcceptance,
    private val clock: Clock,
    private val saved: SavedStateHandle,
    private val config: () -> Config?,
    private val device: () -> DeviceInfo,
    private val locale: () -> String,
    /** The SMS Retriever's app hash, or null (the Bazaar build, no Play services). */
    private val appHash: () -> String?,
    /** A Play Integrity token for a request hash, or null where there is none. */
    private val integrity: suspend (String) -> String?,
    defaultCountry: DialCountry,
    private val googleBuild: Boolean,
    /** Keeps what the account was signed in with (the number, or the Google address) for Settings to show. */
    private val rememberSignIn: suspend (String?) -> Unit = {},
) : ViewModel() {

    private val externalSignIn: ExternalSignIn get() = gate.externalSignIn

    private val _state = MutableStateFlow(
        AuthUiState(otp = restoreOtp(defaultCountry), stage = saved.get<String>(KEY_STAGE)?.let(::stageOf) ?: AuthStage.Welcome),
    )
    val state: StateFlow<AuthUiState> = _state.asStateFlow()

    private var ticker: Job? = null

    init {
        refreshOptions()
        viewModelScope.launch {
            val versions = config()?.legal?.versions ?: LegalVersions()
            val accepted = runCatchingUnlessCancelled { legal.acceptedCurrent(versions) }.getOrNull() != null
            _state.update { it.copy(privacyAccepted = accepted, legalVersions = versions) }
        }
        if (_state.value.otp.onCodeStep) startTicker()
    }

    /** The config may arrive after the screen opened (a first launch). */
    fun refreshOptions() {
        val methods = config()?.auth?.methods
        val serverAllows = methods == null || AuthMethod.Google in methods
        _state.update {
            it.copy(
                googleOffered = googleBuild && externalSignIn.available && serverAllows,
                legalVersions = config()?.legal?.versions ?: it.legalVersions,
            )
        }
    }

    // MARK: - Stages

    fun continueWithPhone() = proceed(SignInMethod.Phone)

    fun continueWithGoogle() = proceed(SignInMethod.Google)

    private fun proceed(method: SignInMethod) {
        val state = _state.value
        if (!state.privacyAccepted) {
            setStage(AuthStage.Privacy, pending = method)
            return
        }
        when (method) {
            SignInMethod.Phone -> setStage(if (state.otp.onCodeStep) AuthStage.Code else AuthStage.Phone)
            SignInMethod.Google -> _state.update { it.copy(launchGoogle = true, googleError = null) }
        }
    }

    fun acceptPrivacy() {
        val versions = _state.value.legalVersions
        viewModelScope.launch {
            runCatchingUnlessCancelled { legal.accept(versions) }
            val pending = _state.value.pending ?: SignInMethod.Phone
            _state.update { it.copy(privacyAccepted = true, pending = null) }
            when (pending) {
                SignInMethod.Phone -> setStage(AuthStage.Phone)
                SignInMethod.Google -> {
                    // Back where Google is offered (the number's page), so its progress and errors are in sight.
                    setStage(AuthStage.Phone)
                    _state.update { it.copy(launchGoogle = true, googleError = null) }
                }
            }
        }
    }

    /** Back: code → number → welcome. False when there is nowhere further back in this flow. */
    fun back(): Boolean {
        when (_state.value.stage) {
            AuthStage.Code -> {
                updateOtp { OtpFlow.changeNumber(it) }
                stopTicker()
                if (_state.value.otp.sendBlocked) startTicker()
                setStage(AuthStage.Phone)
            }
            AuthStage.Phone, AuthStage.Privacy -> {
                // Google's error belongs to the number's page; the welcome never shows it.
                _state.update { it.copy(googleError = null) }
                setStage(AuthStage.Welcome)
            }
            AuthStage.Welcome -> return false
        }
        return true
    }

    private fun setStage(stage: AuthStage, pending: SignInMethod? = _state.value.pending) {
        saved[KEY_STAGE] = stage.name
        _state.update { it.copy(stage = stage, pending = pending) }
    }

    // MARK: - Phone and code

    fun phoneChanged(input: String) = updateOtp { OtpFlow.phoneChanged(it, input) }

    fun countryChanged(country: DialCountry) = updateOtp { OtpFlow.countryChanged(it, country) }

    fun sendCode(channel: OtpChannel? = null) {
        val (next, effect) = OtpFlow.send(_state.value.otp.copy(nowMillis = clock.nowMillis()), channel)
        updateOtp { next }
        (effect as? OtpEffect.Send)?.let(::runSend)
    }

    fun resend(channel: OtpChannel? = null) {
        val (next, effect) = OtpFlow.resend(OtpFlow.tick(_state.value.otp, clock.nowMillis()), channel)
        updateOtp { next }
        (effect as? OtpEffect.Send)?.let(::runSend)
    }

    private fun runSend(effect: OtpEffect.Send) {
        viewModelScope.launch {
            val hash = runCatchingUnlessCancelled { appHash() }.getOrNull()
            val token = runCatchingUnlessCancelled { integrity(requestHash(effect.e164)) }.getOrNull()
            val request = OtpStartRequest(
                phone = effect.e164,
                locale = locale(),
                channel = effect.channel,
                smsAppHash = hash,
                integrityToken = token,
            )
            runCatchingUnlessCancelled { api.startOtp(request) }
                .onSuccess { challenge ->
                    updateOtp { OtpFlow.sent(it, effect.e164, challenge, clock.nowMillis()) }
                    setStage(AuthStage.Code)
                    startTicker()
                }
                .onFailure { error ->
                    updateOtp { OtpFlow.sendFailed(it, error, clock.nowMillis()) }
                    // A refusal with a wait: the button counts it down.
                    if (_state.value.otp.sendBlocked) startTicker()
                }
        }
    }

    fun codeChanged(input: String) {
        val (next, effect) = OtpFlow.codeChanged(OtpFlow.tick(_state.value.otp, clock.nowMillis()), input)
        updateOtp { next }
        (effect as? OtpEffect.Verify)?.let(::runVerify)
    }

    /** A code read from the text message: filled in and verified like a typed one. */
    fun codeReceived(code: String) {
        if (_state.value.otp.verifying) return
        codeChanged(code)
    }

    fun retryVerify() {
        val (next, effect) = OtpFlow.retryVerify(OtpFlow.tick(_state.value.otp, clock.nowMillis()))
        updateOtp { next }
        (effect as? OtpEffect.Verify)?.let(::runVerify)
    }

    private fun runVerify(effect: OtpEffect.Verify) {
        viewModelScope.launch {
            runCatchingUnlessCancelled { api.verifyOtp(effect.challengeId, effect.code, device()) }
                .onSuccess { result -> finished(result, _state.value.otp.challenge?.e164) }
                .onFailure { error -> updateOtp { OtpFlow.verifyFailed(it, error, clock.nowMillis()) } }
        }
    }

    // MARK: - Google

    /** Called by the screen when [AuthUiState.launchGoogle] is set, or from the button once the notice is accepted. */
    fun signInWithGoogle(activity: Activity) {
        val state = _state.value
        _state.update { it.copy(launchGoogle = false) }
        if (state.googleBusy) return
        if (!state.privacyAccepted) {
            proceed(SignInMethod.Google)
            return
        }
        _state.update { it.copy(googleBusy = true, googleError = null) }
        viewModelScope.launch {
            val error: GoogleError? = try {
                val nonce = api.googleNonce()
                when (val picked = externalSignIn.signIn(activity, nonce.nonce)) {
                    is ExternalSignInResult.Token -> {
                        finished(api.signInWithGoogle(picked.idToken, nonce.nonceId, device()), googleTokenEmail(picked.idToken))
                        null
                    }
                    ExternalSignInResult.Cancelled -> null
                    ExternalSignInResult.NoAccount -> GoogleError.NoAccount
                    ExternalSignInResult.Unavailable -> GoogleError.Unavailable
                    is ExternalSignInResult.Failed -> GoogleError.Failed
                }
            } catch (e: ApiError) {
                googleError(e)
            }
            _state.update { it.copy(googleBusy = false, googleError = error) }
        }
    }

    fun dismissGoogleError() = _state.update { it.copy(googleError = null) }

    private fun googleError(e: ApiError): GoogleError = when {
        e is ApiError.Network -> GoogleError.Offline
        e.code == ProblemCodes.STORE_NOT_SUPPORTED -> GoogleError.Unavailable
        e.code == ProblemCodes.PHONE_BANNED || e.code == ProblemCodes.DEVICE_BANNED -> GoogleError.Banned
        else -> GoogleError.Failed
    }

    // MARK: - Done

    private suspend fun finished(result: AuthResult, identity: String?) {
        runCatchingUnlessCancelled { rememberSignIn(identity) }
        stopTicker()
        saved.remove<String>(KEY_STAGE)
        CHALLENGE_KEYS.forEach { saved.remove<Any>(it) }
        _state.update { it.copy(success = true, otp = it.otp.copy(verifying = false)) }
        // Long enough to see the code turn green and feel the tick; short enough not to wait for.
        delay(SUCCESS_MS)
        gate.signedIn(result.user)
    }

    // MARK: - Time

    private fun startTicker() {
        ticker?.cancel()
        ticker = viewModelScope.launch {
            while (isActive) {
                updateOtp { OtpFlow.tick(it, clock.nowMillis()) }
                val otp = _state.value.otp
                if (!otp.onCodeStep && !otp.sendBlocked) break
                delay(TICK_MS)
            }
        }
    }

    private fun stopTicker() {
        ticker?.cancel()
        ticker = null
    }

    // MARK: - Saved state

    private fun updateOtp(transform: (OtpState) -> OtpState) {
        _state.update { it.copy(otp = transform(it.otp)) }
        persist(_state.value.otp)
    }

    private fun persist(otp: OtpState) {
        saved[KEY_PHONE] = otp.phoneInput
        saved[KEY_COUNTRY] = otp.country.iso
        val c = otp.challenge
        if (c == null) {
            CHALLENGE_KEYS.forEach { saved.remove<Any>(it) }
        } else {
            saved[KEY_CH_ID] = c.id
            saved[KEY_CH_PHONE] = c.e164
            saved[KEY_CH_LENGTH] = c.codeLength
            saved[KEY_CH_CHANNEL] = c.channel.wire
            saved[KEY_CH_TIMES] = longArrayOf(c.sentAtMillis, c.expiresAtMillis, c.resendAtMillis)
            saved[KEY_CH_RESENT] = c.resent
        }
    }

    private fun restoreOtp(defaultCountry: DialCountry): OtpState {
        val country = PhoneNumbers.country(saved.get<String>(KEY_COUNTRY)) ?: defaultCountry
        val base = OtpFlow.start(country, clock.nowMillis()).copy(phoneInput = saved.get<String>(KEY_PHONE).orEmpty())
        val id = saved.get<String>(KEY_CH_ID) ?: return base
        val times = saved.get<LongArray>(KEY_CH_TIMES) ?: return base
        if (times.size != 3) return base
        val challenge = ActiveChallenge(
            id = id,
            e164 = saved.get<String>(KEY_CH_PHONE).orEmpty(),
            codeLength = saved.get<Int>(KEY_CH_LENGTH) ?: return base,
            channel = OtpChannel.entries.firstOrNull { it.wire == saved.get<String>(KEY_CH_CHANNEL) } ?: OtpChannel.Sms,
            sentAtMillis = times[0],
            expiresAtMillis = times[1],
            resendAtMillis = times[2],
            resent = saved.get<Boolean>(KEY_CH_RESENT) == true,
        )
        return OtpFlow.tick(base.copy(challenge = challenge), clock.nowMillis())
    }

    private fun stageOf(name: String): AuthStage? {
        val stage = AuthStage.entries.firstOrNull { it.name == name } ?: return null
        // The code step without a code in flight is the number step.
        return if (stage == AuthStage.Code && saved.get<String>(KEY_CH_ID) == null) AuthStage.Phone else stage
    }

    companion object {
        private const val TICK_MS = 1_000L
        private const val SUCCESS_MS = 450L
        private const val KEY_STAGE = "auth.stage"
        private const val KEY_PHONE = "auth.phone"
        private const val KEY_COUNTRY = "auth.country"
        private const val KEY_CH_ID = "auth.challenge.id"
        private const val KEY_CH_PHONE = "auth.challenge.phone"
        private const val KEY_CH_LENGTH = "auth.challenge.length"
        private const val KEY_CH_CHANNEL = "auth.challenge.channel"
        private const val KEY_CH_TIMES = "auth.challenge.times"
        private const val KEY_CH_RESENT = "auth.challenge.resent"
        private val CHALLENGE_KEYS = listOf(KEY_CH_ID, KEY_CH_PHONE, KEY_CH_LENGTH, KEY_CH_CHANNEL, KEY_CH_TIMES, KEY_CH_RESENT)

        /**
         * What a Play Integrity token for the code request is bound to:
         * base64url SHA-256 of `otp.start:<E.164>`, so a token cannot be
         * replayed for another number.
         */
        fun requestHash(e164: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest("otp.start:$e164".toByteArray(Charsets.UTF_8))
            return base64Url(digest)
        }

        private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

        /** RFC 4648 base64url without padding (java.util.Base64 needs API 26). */
        internal fun base64Url(bytes: ByteArray): String = buildString((bytes.size * 4 + 2) / 3) {
            var i = 0
            while (i + 2 < bytes.size) {
                val n = (bytes[i].toInt() and 0xFF shl 16) or (bytes[i + 1].toInt() and 0xFF shl 8) or (bytes[i + 2].toInt() and 0xFF)
                append(ALPHABET[n shr 18 and 63]); append(ALPHABET[n shr 12 and 63]); append(ALPHABET[n shr 6 and 63]); append(ALPHABET[n and 63])
                i += 3
            }
            val rest = bytes.size - i
            if (rest == 1) {
                val n = bytes[i].toInt() and 0xFF shl 16
                append(ALPHABET[n shr 18 and 63]); append(ALPHABET[n shr 12 and 63])
            } else if (rest == 2) {
                val n = (bytes[i].toInt() and 0xFF shl 16) or (bytes[i + 1].toInt() and 0xFF shl 8)
                append(ALPHABET[n shr 18 and 63]); append(ALPHABET[n shr 12 and 63]); append(ALPHABET[n shr 6 and 63])
            }
        }
    }
}

/** The address a Google ID token names (its `email` claim), for Settings to show; null when it names none. */
internal fun googleTokenEmail(idToken: String): String? = runCatching {
    val payload = idToken.split('.').getOrNull(1) ?: return null
    val flags = android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP
    val json = String(android.util.Base64.decode(payload, flags), Charsets.UTF_8)
    kotlinx.serialization.json.Json.parseToJsonElement(json).jsonObject["email"]?.jsonPrimitive?.contentOrNull
}.getOrNull()?.takeIf { '@' in it }
