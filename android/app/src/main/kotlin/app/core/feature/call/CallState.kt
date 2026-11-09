package app.core.feature.call

import androidx.annotation.StringRes
import app.core.R
import app.core.media.ImageLoading
import app.core.model.Call
import app.core.model.CallKind
import app.core.model.CallOutcome
import app.core.model.CallRole
import app.core.model.CallState
import app.core.model.Id
import app.core.model.ProblemCodes
import app.core.net.ApiError
import app.core.push.RingStopReason
import java.time.Instant

/**
 * Where a call is on this phone, from the tap on the call button (or the
 * ring) to "Call ended". One value, so "ringing and also live" cannot be said.
 *
 * The server's states (ringing, connecting, active, ended, missed,
 * cancelled) map onto these as: placed = [Placing], ringing = [Ringing],
 * answered = [Connecting], active = [Live], and every end, with its reason,
 * = [Ended].
 */
sealed interface CallPhase {
    /** Outgoing: the request to ring is on its way, or the other phone has not said it rings yet ("Calling…"). */
    data object Placing : CallPhase

    /** Outgoing: the other phone says it rings ("Ringing…"). Incoming: this phone rings. */
    data object Ringing : CallPhase

    /** Answered: the room is being joined, or the other person is not in it yet. */
    data object Connecting : CallPhase

    /**
     * Both in the room since [since], what the timer counts from.
     * [reconnecting]: this phone lost the media server and is getting it
     * back. [peerAway]: the other person dropped out of the room and may come
     * back. The call is still on in both cases; the screen says so.
     */
    data class Live(val since: Instant, val reconnecting: Boolean = false, val peerAway: Boolean = false) : CallPhase

    /** Over, for [end]. [detail] is a short technical reason for a failure (shown small, under the title). */
    data class Ended(val end: CallEnd, val detail: String? = null) : CallPhase

    val isOver: Boolean get() = this is Ended

    /** Not answered yet, on either side. */
    val isRinging: Boolean get() = this == Placing || this == Ringing
}

/**
 * Why a call ended, in the terms the call screen says it. One value for every
 * way a call can stop, on either side: most come from the server ([resolve]),
 * the refusals from `POST /v1/calls` ([refusal]), the ring stops from push
 * ([of]), and [HUNG_UP] is this phone's own End, Decline or Cancel.
 */
enum class CallEnd {
    /** Ended on this phone: End after an answer, Decline, or Cancel. */
    HUNG_UP,

    /** The other person hung up, or left the room for good. */
    PEER_ENDED,

    /** The other person declined (seen by the caller). */
    DECLINED,

    /** Declined on another phone of this account (seen by the callee). */
    DECLINED_ELSEWHERE,

    /** The caller gave up before an answer (seen by the callee). */
    CANCELLED,

    /**
     * Nobody answered in time (seen by the caller). Also what a busy callee
     * looks like: the server never says a callee is busy.
     */
    NO_ANSWER,

    /** Nobody answered in time (seen by the callee): a missed call. */
    MISSED,

    /** Another phone of this account answered first. */
    ANSWERED_ELSEWHERE,

    /** `409 caller_busy`: this account is already in a call. */
    CALLER_BUSY,

    /** `403 calls_not_allowed` (consent): one of the two has calls off for this match. */
    NOT_ALLOWED,

    /** `403 calls_not_allowed` (disabled): calls are switched off for now. */
    CALLS_OFF,

    /** `403 calls_not_allowed` (plan): calls need a plan this account does not have. */
    NEEDS_PLAN,

    /** `404`: no active match to call (unmatched, blocked, deleted: never told apart). */
    UNAVAILABLE,

    /** `422 limit_reached`: the call servers are full. */
    LIMIT_REACHED,

    /** `429`: too many calls in a short time. */
    RATE_LIMITED,

    /** No connection: the request could not be sent. */
    OFFLINE,

    /** The microphone was refused, so nobody was rung. */
    NO_MICROPHONE,

    /** The call dropped: this phone lost the room and could not get back. */
    CONNECTION_LOST,

    /** Anything else: answered but never connected, or a refusal this build cannot place. */
    FAILED,
    ;

    /** The title under the other person's name. */
    @StringRes
    fun title(kind: CallKind): Int = when (this) {
        HUNG_UP, PEER_ENDED -> R.string.call_end_ended
        DECLINED, DECLINED_ELSEWHERE -> R.string.call_end_declined
        CANCELLED -> R.string.call_end_cancelled
        NO_ANSWER -> R.string.call_end_no_answer
        MISSED -> if (kind == CallKind.Video) R.string.call_end_missed_video else R.string.call_end_missed_audio
        ANSWERED_ELSEWHERE -> R.string.call_end_answered_elsewhere
        CALLER_BUSY -> R.string.call_end_caller_busy
        NOT_ALLOWED -> R.string.call_end_not_allowed
        CALLS_OFF -> R.string.call_end_calls_off
        NEEDS_PLAN -> R.string.call_end_needs_plan
        UNAVAILABLE -> R.string.call_end_unavailable
        LIMIT_REACHED -> R.string.call_end_limit
        RATE_LIMITED -> R.string.call_end_rate_limited
        OFFLINE -> R.string.call_end_offline
        NO_MICROPHONE -> R.string.call_end_no_microphone
        CONNECTION_LOST -> R.string.call_end_connection_lost
        FAILED -> R.string.call_end_failed
    }

    /** A call that never rang anybody: the screen offers to try again instead of just closing. */
    val retryable: Boolean get() = this == OFFLINE || this == LIMIT_REACHED || this == FAILED || this == CONNECTION_LOST || this == NO_ANSWER

    companion object {
        /**
         * What a call the server reports means for this phone, or null while
         * it is still on. [answeredHere]: this phone's accept went through (or
         * is being sent), so an answered call is this phone's own.
         */
        fun resolve(call: Call, answeredHere: Boolean): CallEnd? {
            val caller = call.role == CallRole.Caller
            return when (call.state) {
                CallState.Ringing, CallState.Unknown -> null
                CallState.Connecting, CallState.Active -> if (!caller && !answeredHere) ANSWERED_ELSEWHERE else null
                CallState.Missed -> if (caller) NO_ANSWER else MISSED
                CallState.Cancelled -> if (caller) HUNG_UP else CANCELLED
                CallState.Ended -> when (call.outcome) {
                    CallOutcome.Declined -> if (caller) DECLINED else DECLINED_ELSEWHERE
                    CallOutcome.Missed -> if (caller) NO_ANSWER else MISSED
                    CallOutcome.Cancelled -> if (caller) HUNG_UP else CANCELLED
                    CallOutcome.Failed -> FAILED
                    CallOutcome.Completed, CallOutcome.Unknown, null -> PEER_ENDED
                }
            }
        }

        /** Why `POST /v1/calls` (or an accept) refused, from its status and problem code. */
        fun refusal(error: Throwable): CallEnd = when (error) {
            is ApiError.Network -> OFFLINE
            is ApiError.Http -> when {
                error.status == 409 && error.code == ProblemCodes.CALLER_BUSY -> CALLER_BUSY
                // Never sent for a busy callee by contract; if it is, it reads as unanswered.
                error.status == 409 && error.code == ProblemCodes.CALLEE_BUSY -> NO_ANSWER
                error.status == 403 && error.code == ProblemCodes.CALLS_NOT_ALLOWED -> when (error.problem.reason) {
                    "disabled" -> CALLS_OFF
                    "plan" -> NEEDS_PLAN
                    else -> NOT_ALLOWED
                }
                error.status == 404 -> UNAVAILABLE
                error.status == 422 && error.code == ProblemCodes.LIMIT_REACHED -> LIMIT_REACHED
                error.status == 429 -> RATE_LIMITED
                else -> FAILED
            }
            else -> FAILED
        }

        /** What a ring the server stopped on this phone means for the ring on screen. */
        fun of(reason: RingStopReason): CallEnd = when (reason) {
            RingStopReason.ANSWERED_ELSEWHERE -> ANSWERED_ELSEWHERE
            RingStopReason.DECLINED -> DECLINED_ELSEWHERE
            RingStopReason.CANCELLED -> CANCELLED
            RingStopReason.MISSED -> MISSED
            RingStopReason.ENDED -> PEER_ENDED
        }
    }
}

/** A call that connected, but without everything it was meant to carry. */
enum class CallDegradation {
    /** The microphone would not start (permission, or another app holds it). */
    NO_MICROPHONE,

    /** The camera would not start: the call carries on as audio. */
    NO_CAMERA,
    ;

    @get:StringRes
    val title: Int get() = when (this) {
        NO_MICROPHONE -> R.string.call_degraded_microphone
        NO_CAMERA -> R.string.call_degraded_camera
    }
}

/** Who is on the other end, as the call screen names them: the match's first name and photo. */
data class CallPeer(
    val conversationId: Id,
    val name: String,
    val photoUrl: String? = null,
    val blurhash: String? = null,
) {
    /**
     * This peer with the face the chat's cache knows for the conversation
     * ([photoUrl] and [blurhash] of the match's photo there), for a ring that
     * carried only a photo URL, or none:
     * - no URL in the ring: the cached photo, URL and blurhash;
     * - the same photo (same address without its signature): the ring's
     *   fresher URL with the cached blurhash, drawn first while it loads;
     * - another photo (the match changed it since): the ring's URL alone; an
     *   old picture's blur would show the wrong face first.
     * What the peer already has is kept.
     */
    fun withCachedFace(photoUrl: String?, blurhash: String?): CallPeer {
        val cachedUrl = photoUrl?.takeIf { it.isNotBlank() }
        val cachedBlur = blurhash?.takeIf { it.isNotBlank() }
        val ringUrl = this.photoUrl
        return when {
            ringUrl == null -> copy(photoUrl = cachedUrl, blurhash = this.blurhash ?: cachedBlur.takeIf { cachedUrl != null })
            this.blurhash != null -> this
            cachedUrl != null && ImageLoading.cacheKey(cachedUrl) == ImageLoading.cacheKey(ringUrl) -> copy(blurhash = cachedBlur)
            else -> this
        }
    }
}

/**
 * What the rest of the app heard about a call, for the session on screen to
 * act on. Each names its call; a session acts only on its own.
 */
sealed interface CallNudge {
    val callId: Id

    /** The server's realtime `call` event: the call as it now stands. */
    data class Update(val call: Call) : CallNudge {
        override val callId: Id get() = call.id
    }

    /** The server stopped this phone's ring (`call_cancel` push), for [reason]. */
    data class RingStopped(override val callId: Id, val reason: RingStopReason) : CallNudge

    /** Declined from the ring's own notification, which has told the server already. */
    data class DeclinedHere(override val callId: Id) : CallNudge
}
