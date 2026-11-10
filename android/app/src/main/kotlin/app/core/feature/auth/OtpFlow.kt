package app.core.feature.auth

import app.core.model.OtpChallenge
import app.core.model.OtpChannel
import app.core.model.ProblemCodes
import app.core.net.ApiError

/**
 * Why a code could not be sent, in the terms the phone screen shows.
 * [RateLimited] carries the moment (this phone's clock) the next try is allowed.
 */
sealed interface SendError {
    data object Invalid : SendError
    data object NotAllowed : SendError
    data object Banned : SendError
    data class RateLimited(val untilMillis: Long?) : SendError
    data object SmsUnavailable : SendError
    data object Offline : SendError
    data object Maintenance : SendError
    data object Failed : SendError
}

/** Why a code was not accepted. */
sealed interface CodeError {
    data class Wrong(val attemptsLeft: Int?) : CodeError

    /** Too old: a new one has to be sent. */
    data object Expired : CodeError

    /** Too many wrong tries: this code is dead, a new one has to be sent. */
    data object Locked : CodeError
    data object Banned : CodeError
    data class RateLimited(val untilMillis: Long?) : CodeError
    data object Offline : CodeError
    data object Failed : CodeError
}

/** A code on its way: what the server said about it, on this phone's clock. */
data class ActiveChallenge(
    val id: String,
    val e164: String,
    val codeLength: Int,
    val channel: OtpChannel,
    val sentAtMillis: Long,
    val expiresAtMillis: Long,
    val resendAtMillis: Long,
    /** A code sent again to the same number on the code step (a call is then offered once the wait is over). */
    val resent: Boolean = false,
)

/**
 * The phone sign-in: number → code → signed in. Pure state, no I/O: every
 * transition takes the time it happens at, so tests drive it with numbers
 * and the view model with the clock.
 *
 * Rules:
 * - the number is sent only when it reads as complete;
 * - the code boxes follow the length the server sent (never a fixed six);
 * - a complete code is verified at once, once (a second identical code does
 *   not verify again until it changes);
 * - "send again" opens after `resendAfterSeconds`, and at once when the code
 *   expired or was locked;
 * - a refusal that carries `retryAfterSeconds` keeps the button closed until then.
 */
data class OtpState(
    val country: DialCountry,
    /** What the number field holds, as typed. */
    val phoneInput: String = "",
    val sending: Boolean = false,
    val sendError: SendError? = null,
    val challenge: ActiveChallenge? = null,
    val code: String = "",
    val verifying: Boolean = false,
    val codeError: CodeError? = null,
    /** The last code sent for verification, so the same one is not sent twice. */
    val lastVerified: String? = null,
    /** "Now" as of the last tick, for the countdowns. */
    val nowMillis: Long = 0,
) {
    val parsed: PhoneParse get() = PhoneNumbers.parse(country, phoneInput)

    val canSend: Boolean
        get() = !sending && parsed is PhoneParse.Valid && !sendBlocked

    /** A refusal's wait is still running. */
    val sendBlocked: Boolean
        get() = (sendError as? SendError.RateLimited)?.untilMillis?.let { it > nowMillis } == true

    val onCodeStep: Boolean get() = challenge != null

    val codeLength: Int get() = challenge?.codeLength ?: 0

    val expired: Boolean
        get() = codeError == CodeError.Expired || codeError == CodeError.Locked ||
            (challenge != null && nowMillis >= challenge.expiresAtMillis)

    /** Seconds until "send again" opens; 0 when it is open. */
    val resendInSeconds: Int
        get() {
            val c = challenge ?: return 0
            if (expired) return rateWaitSeconds
            return maxOf(secondsUntil(c.resendAtMillis), rateWaitSeconds)
        }

    private val rateWaitSeconds: Int
        get() = ((codeError as? CodeError.RateLimited)?.untilMillis ?: (sendError as? SendError.RateLimited)?.untilMillis)
            ?.let(::secondsUntil) ?: 0

    val canResend: Boolean get() = challenge != null && !sending && !verifying && resendInSeconds == 0

    /** Seconds the code stays good for, for the screen to say. */
    val expiresInSeconds: Int get() = challenge?.let { secondsUntil(it.expiresAtMillis) } ?: 0

    private fun secondsUntil(at: Long): Int = ((at - nowMillis + 999) / 1000).coerceAtLeast(0).toInt()
}

/** What the view model must do after a transition. */
sealed interface OtpEffect {
    data class Send(val e164: String, val channel: OtpChannel?) : OtpEffect
    data class Verify(val challengeId: String, val code: String) : OtpEffect
}

object OtpFlow {

    fun start(country: DialCountry, nowMillis: Long) = OtpState(country = country, nowMillis = nowMillis)

    fun tick(state: OtpState, nowMillis: Long): OtpState {
        var next = state.copy(nowMillis = nowMillis)
        val c = next.challenge
        if (c != null && nowMillis >= c.expiresAtMillis && next.codeError == null && !next.verifying) {
            next = next.copy(codeError = CodeError.Expired)
        }
        return next
    }

    /**
     * The number field changed. It keeps only ASCII digits and a leading `+`
     * (whatever the keyboard typed or a paste brought); a number typed with
     * its country code moves the picker to that country.
     */
    fun phoneChanged(state: OtpState, input: String): OtpState {
        val clean = PhoneNumbers.digits(input).take(MAX_INPUT)
        val international = PhoneNumbers.international(clean)
        val country = international?.first ?: state.country
        val keep = if (state.sendError is SendError.RateLimited && state.sendBlocked) state.sendError else null
        return state.copy(phoneInput = clean, country = country, sendError = keep)
    }

    fun countryChanged(state: OtpState, country: DialCountry): OtpState {
        // The national part stays; a typed `+code` is replaced by the new country.
        val national = PhoneNumbers.international(state.phoneInput)?.second ?: PhoneNumbers.national(state.phoneInput)
        return state.copy(country = country, phoneInput = national, sendError = null)
    }

    /** "Send code" on the phone step. */
    fun send(state: OtpState, channel: OtpChannel? = null): Pair<OtpState, OtpEffect?> {
        val parsed = state.parsed
        if (!state.canSend || parsed !is PhoneParse.Valid) return state to null
        return state.copy(sending = true, sendError = null) to OtpEffect.Send(parsed.e164, channel)
    }

    /** "Send again" (or "call me") on the code step. */
    fun resend(state: OtpState, channel: OtpChannel? = null): Pair<OtpState, OtpEffect?> {
        val c = state.challenge ?: return state to null
        if (!state.canResend) return state to null
        return state.copy(sending = true, sendError = null) to OtpEffect.Send(c.e164, channel ?: c.channel)
    }

    fun sent(state: OtpState, e164: String, challenge: OtpChallenge, nowMillis: Long): OtpState {
        val length = challenge.codeLength.coerceIn(MIN_CODE, MAX_CODE)
        return state.copy(
            sending = false,
            sendError = null,
            challenge = ActiveChallenge(
                id = challenge.challengeId,
                e164 = e164,
                codeLength = length,
                channel = challenge.channel.takeIf { it != OtpChannel.Unknown } ?: OtpChannel.Sms,
                sentAtMillis = nowMillis,
                expiresAtMillis = nowMillis + challenge.ttlSeconds.coerceAtLeast(1) * 1000L,
                resendAtMillis = nowMillis + challenge.resendAfterSeconds.coerceAtLeast(0) * 1000L,
                resent = state.challenge?.e164 == e164,
            ),
            code = "",
            codeError = null,
            lastVerified = null,
            verifying = false,
            nowMillis = nowMillis,
        )
    }

    fun sendFailed(state: OtpState, error: Throwable, nowMillis: Long): OtpState {
        val reason = sendError(error, nowMillis)
        // On the code step a failed resend keeps the code that is there.
        return state.copy(sending = false, sendError = reason, nowMillis = nowMillis)
    }

    /**
     * The code boxes changed (typed, pasted, or read from the message). Only
     * digits are kept, up to the code's length. A full code is verified.
     */
    fun codeChanged(state: OtpState, input: String): Pair<OtpState, OtpEffect?> {
        val c = state.challenge ?: return state to null
        val code = PhoneNumbers.digits(input).filter { it.isDigit() }.take(c.codeLength)
        // Typing again clears a "wrong code", not an expiry or a lock.
        val keptError = state.codeError.takeIf { it == CodeError.Expired || it == CodeError.Locked || it is CodeError.Banned }
        var next = state.copy(code = code, codeError = keptError)
        if (code.length == c.codeLength && !state.verifying && keptError == null && code != state.lastVerified && !next.expired) {
            next = next.copy(verifying = true, lastVerified = code)
            return next to OtpEffect.Verify(c.id, code)
        }
        return next to null
    }

    /** "Try again" after a verification that got no answer. */
    fun retryVerify(state: OtpState): Pair<OtpState, OtpEffect?> {
        val c = state.challenge ?: return state to null
        if (state.verifying || state.code.length != c.codeLength || state.expired) return state to null
        return state.copy(verifying = true, codeError = null, lastVerified = state.code) to OtpEffect.Verify(c.id, state.code)
    }

    fun verifyFailed(state: OtpState, error: Throwable, nowMillis: Long): OtpState {
        val reason = codeError(error, nowMillis)
        val clearCode = reason is CodeError.Wrong || reason == CodeError.Locked || reason == CodeError.Expired
        return state.copy(
            verifying = false,
            codeError = reason,
            code = if (clearCode) "" else state.code,
            // A network failure may be retried with the same code.
            lastVerified = if (reason == CodeError.Offline || reason == CodeError.Failed) null else state.lastVerified,
            nowMillis = nowMillis,
        )
    }

    /** Back to the number, to correct it. */
    fun changeNumber(state: OtpState): OtpState =
        state.copy(challenge = null, code = "", codeError = null, verifying = false, sending = false, lastVerified = null)

    fun sendError(error: Throwable, nowMillis: Long): SendError = when (error) {
        is ApiError.Network -> SendError.Offline
        is ApiError.Http -> when (error.code) {
            ProblemCodes.PHONE_INVALID -> SendError.Invalid
            ProblemCodes.PHONE_NOT_ALLOWED -> SendError.NotAllowed
            ProblemCodes.PHONE_BANNED, ProblemCodes.DEVICE_BANNED -> SendError.Banned
            ProblemCodes.RATE_LIMITED, ProblemCodes.OTP_LOCKED ->
                SendError.RateLimited(error.problem.retryAfterSeconds?.let { nowMillis + it * 1000 })
            ProblemCodes.SMS_UNAVAILABLE -> SendError.SmsUnavailable
            ProblemCodes.MAINTENANCE -> SendError.Maintenance
            else -> if (error.status == 429) SendError.RateLimited(error.problem.retryAfterSeconds?.let { nowMillis + it * 1000 }) else SendError.Failed
        }
        else -> SendError.Failed
    }

    fun codeError(error: Throwable, nowMillis: Long): CodeError = when (error) {
        is ApiError.Network -> CodeError.Offline
        is ApiError.Http -> when (error.code) {
            ProblemCodes.OTP_INVALID -> CodeError.Wrong(error.problem.attemptsLeft)
            ProblemCodes.OTP_EXPIRED -> CodeError.Expired
            ProblemCodes.OTP_LOCKED -> CodeError.Locked
            ProblemCodes.PHONE_BANNED, ProblemCodes.DEVICE_BANNED -> CodeError.Banned
            ProblemCodes.RATE_LIMITED -> CodeError.RateLimited(error.problem.retryAfterSeconds?.let { nowMillis + it * 1000 })
            else -> when (error.status) {
                400 -> CodeError.Wrong(error.problem.attemptsLeft)
                410 -> CodeError.Expired
                429 -> CodeError.RateLimited(error.problem.retryAfterSeconds?.let { nowMillis + it * 1000 })
                else -> CodeError.Failed
            }
        }
        else -> CodeError.Failed
    }

    /** Codes are at least 4 and at most 10 digits, whatever a server says. */
    const val MIN_CODE = 4
    const val MAX_CODE = 10
    private const val MAX_INPUT = 24
}
