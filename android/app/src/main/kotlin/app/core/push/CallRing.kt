package app.core.push

import app.core.model.CallKind
import app.core.model.Id
import app.core.model.InstantSerializer
import java.time.Instant

/**
 * A call ringing this phone, as the server's ring says it.
 *
 * The server rings with a data-only, high-priority FCM message (no
 * `notification` block, so the system draws nothing and the app is handed it
 * open, in the background or not running) and stops it with a second one
 * sent only to the devices it rang. These are the two, read. The same ring can
 * also arrive over the realtime socket as a `call` event; [IncomingCallRouter]
 * makes the two one ring.
 *
 * Everything in them is a routing hint, never authority: answering asks the
 * server, as whoever is signed in here, and the server decides (it answers 404
 * to anybody but the two people of the call).
 */
data class CallRing(
    val callId: Id,
    val conversationId: Id,
    val kind: CallKind,
    /** The match's first name, as the server writes it; never an e-mail or a number. */
    val peerName: String,
    /** The match's photo; https only, or null. */
    val peerPhotoUrl: String?,
    /** When the ring stops being a call, on this phone's clock ([onPhoneClock]). */
    val expiresAt: Instant,
) {
    fun expired(now: Instant): Boolean = !now.isBefore(expiresAt)

    /**
     * The same ring with its expiry on this phone's clock rather than the
     * server's. [expiresAt] is the server's time and a ring lives 45 s of it:
     * a phone whose clock runs a minute fast would read every ring as expired
     * and never ring, one an hour slow would ring for an hour. FCM's own stamp
     * of when the ring left ([sentAt]) is on the server's side of that gap:
     * when the phone's clock puts the arrival inside the ring's life nothing
     * changes; when it does not, the phone's clock is what is wrong (FCM drops
     * a ring its life outlasted) and the ring gets its whole life from now.
     */
    fun onPhoneClock(now: Instant, sentAt: Instant?): CallRing {
        val onPhone = expiryOnPhoneClock(expiresAt, now, sentAt)
        return if (onPhone == expiresAt) this else copy(expiresAt = onPhone)
    }

    companion object {
        const val TYPE = "call_incoming"

        /** The ring, or null when this is not one or does not hold together. */
        fun from(data: Map<String, String>): CallRing? {
            if (data[KEY_TYPE] != TYPE) return null
            val callId = data[KEY_CALL]?.takeIf(::isId) ?: return null
            val conversationId = data[KEY_CONVERSATION]?.takeIf(::isId) ?: return null
            val kind = when (data[KEY_KIND]) {
                "video" -> CallKind.Video
                "audio" -> CallKind.Audio
                else -> return null
            }
            val expiresAt = data[KEY_EXPIRES]?.let(InstantSerializer::parse) ?: return null
            return CallRing(
                callId = callId,
                conversationId = conversationId,
                kind = kind,
                peerName = data[KEY_PEER_NAME]?.trim()?.take(MAX_NAME).orEmpty(),
                peerPhotoUrl = photoUrl(data[KEY_PEER_PHOTO]),
                expiresAt = expiresAt,
            )
        }

        /**
         * A photo address the phone may fetch: https only, as the server's
         * signed CDN links are. Anything else in that key (another scheme, a
         * local path) is not a photo this app goes and reads.
         */
        fun photoUrl(raw: String?): String? = raw?.trim()?.takeIf { it.startsWith("https://") && it.length <= MAX_PHOTO_URL }

        /** The server's ids are decimal; anything else in an id key is not a ring of ours. */
        fun isId(value: String): Boolean = value.length in 1..20 && value.all { it in '0'..'9' }

        const val KEY_TYPE = "type"
        const val KEY_CALL = "callId"
        const val KEY_CONVERSATION = "conversationId"
        const val KEY_KIND = "kind"
        const val KEY_PEER_NAME = "peerName"
        const val KEY_PEER_PHOTO = "peerPhotoUrl"
        const val KEY_EXPIRES = "expiresAt"
        const val KEY_REASON = "reason"

        private const val MAX_NAME = 40
        private const val MAX_PHOTO_URL = 1500
    }
}

/** Why the server stopped a ring on this phone (`call_cancel`). */
enum class RingStopReason(val wire: String) {
    /** Another phone of this account answered first. */
    ANSWERED_ELSEWHERE("answered_elsewhere"),

    /** Declined, on another phone of this account. */
    DECLINED("declined"),

    /** The caller gave up before an answer. */
    CANCELLED("cancelled"),

    /** Nobody answered before the ring ran out. */
    MISSED("missed"),

    /** Over for any other reason, or a reason this build does not know. */
    ENDED("ended"),
    ;

    /**
     * Whether a call was missed here: the caller gave up, or the ring ran out.
     * Answered or declined on another phone is the person's own decision and
     * leaves nothing behind.
     */
    val missed: Boolean get() = this == CANCELLED || this == MISSED

    companion object {
        fun of(wire: String?): RingStopReason = entries.firstOrNull { it.wire == wire } ?: ENDED
    }
}

/** The server stopped a ring (`call_cancel`). */
data class CallRingStop(val callId: Id, val reason: RingStopReason) {
    companion object {
        const val TYPE = "call_cancel"

        fun from(data: Map<String, String>): CallRingStop? {
            if (data[CallRing.KEY_TYPE] != TYPE) return null
            val callId = data[CallRing.KEY_CALL]?.takeIf(CallRing::isId) ?: return null
            return CallRingStop(callId, RingStopReason.of(data[CallRing.KEY_REASON]))
        }
    }
}

/**
 * A ring's expiry on this phone's clock, read against FCM's stamp of when the
 * ring left ([sentAt], null when unknown): see [CallRing.onPhoneClock].
 */
internal fun expiryOnPhoneClock(expiresAt: Instant, now: Instant, sentAt: Instant?): Instant {
    if (sentAt == null) return expiresAt
    val lifeMs = expiresAt.toEpochMilli() - sentAt.toEpochMilli()
    if (lifeMs <= 0) return expiresAt
    val sinceSent = now.toEpochMilli() - sentAt.toEpochMilli()
    if (sinceSent in 0..lifeMs) return expiresAt
    return now.plusMillis(lifeMs)
}
