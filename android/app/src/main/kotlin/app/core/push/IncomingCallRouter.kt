package app.core.push

import app.core.common.Clock
import app.core.common.Diag
import app.core.model.Call
import app.core.model.CallOutcome
import app.core.model.CallRole
import app.core.model.CallState
import app.core.model.Id
import java.time.Instant

/**
 * A ring, or its stop, turned into what the phone should do, whichever way it
 * came: a data-only FCM message ([onMessage]) or a `call` event on the
 * realtime socket ([onRealtimeCall]). Neither is polled for.
 *
 * It runs in every state of the app (FCM hands a data message to the app
 * open, in the background or cold), so it leans only on what survives a cold
 * start: whether somebody is signed in here, read from storage.
 *
 *  - A ring rings only when somebody is signed in here, and not after its
 *    expiry (on this phone's clock, corrected with FCM's send time).
 *  - The same ring from both paths rings once.
 *  - A stop always stops the ring, signed in or not. FCM keeps no order, so a
 *    stop can arrive before its ring: the stop is remembered and the ring
 *    that follows is dropped.
 *  - A ring the phone already dealt with (answered or declined here) is never
 *    shown again.
 *  - A stop for a call nobody answered or declined here leaves a missed call.
 */
class IncomingCallRouter(
    private val signedIn: suspend () -> Boolean,
    /**
     * Posts the ring (fetching the photo first, briefly) and returns whether
     * it was posted: not without the notification permission, nor past its
     * expiry. Suspends and is waited for: FCM's handler must not return before
     * the ring is up, or a cold-started process could be gone first.
     */
    private val ring: suspend (CallRing) -> Boolean,
    /** Takes the ring down; [missed] leaves a missed call in its place. */
    private val stop: (callId: Id, missed: Boolean, reason: RingStopReason) -> Unit,
    /** The match a realtime ring is from (its first name and photo); null when this phone does not know it. */
    private val peerOf: suspend (conversationId: Id) -> RingPeer?,
    /** This phone is ringing for [callId] now: the caller's "Calling…" may become "Ringing…". */
    private val rang: (callId: Id) -> Unit,
    private val clock: Clock = Clock.System,
    private val diag: Diag = Diag.Silent,
) {
    /** The first name and photo a ring shows. */
    data class RingPeer(val name: String, val photoUrl: String?)

    private enum class Seen { RINGING, STOPPED }

    /** What this phone did with each recent call, newest last; bounded. */
    private val seen = object : LinkedHashMap<Id, Seen>(32, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Id, Seen>?): Boolean = size > MAX_REMEMBERED
    }

    /**
     * Whether [data] was a call message, handled or dropped, and nothing else
     * should look at it. [sentAtMillis] is FCM's send time (0 when unknown).
     */
    suspend fun onMessage(data: Map<String, String>, sentAtMillis: Long = 0): Boolean {
        when (data[CallRing.KEY_TYPE]) {
            CallRingStop.TYPE -> {
                val stop = CallRingStop.from(data) ?: run {
                    diag.warn(AREA, "ring stop dropped: malformed")
                    return true
                }
                stopRing(stop.callId, stop.reason)
                return true
            }
            CallRing.TYPE -> {
                val now = clock.now()
                val sentAt = sentAtMillis.takeIf { it > 0 }?.let(Instant::ofEpochMilli)
                val ring = CallRing.from(data)?.onPhoneClock(now, sentAt) ?: run {
                    diag.warn(AREA, "ring dropped: malformed")
                    return true
                }
                show(ring, now)
                return true
            }
            else -> return false
        }
    }

    /**
     * Every `call` event of this account. A ring for this account (callee,
     * ringing) rings unless push already did; any other state of a call
     * ringing here stops it, as the push stop would.
     */
    suspend fun onRealtimeCall(call: Call) {
        if (call.role != CallRole.Callee) return
        if (call.state == CallState.Ringing) {
            val now = clock.now()
            // A ring replayed from the channel's history after a reconnect can
            // be long over: only one whose life is still running here rings.
            val expiresAt = call.ringExpiresAt ?: call.placedAt.plusSeconds(RING_SECONDS)
            val life = (expiresAt.toEpochMilli() - call.placedAt.toEpochMilli()).coerceAtLeast(0)
            if (now.toEpochMilli() - call.placedAt.toEpochMilli() > life + CLOCK_SKEW_MS) {
                diag.info(AREA, "realtime ring dropped: placed too long ago")
                return
            }
            if (isKnown(call.id)) return
            val peer = peerOf(call.conversationId)
            val ring = CallRing(
                callId = call.id,
                conversationId = call.conversationId,
                kind = call.kind,
                peerName = peer?.name.orEmpty(),
                peerPhotoUrl = peer?.photoUrl?.let(CallRing::photoUrl),
                expiresAt = expiresAt.coerceAtLeast(now.plusSeconds(MIN_RING_SECONDS)),
            )
            show(ring, now)
            return
        }
        val reason = when {
            call.state == CallState.Missed || call.outcome == CallOutcome.Missed -> RingStopReason.MISSED
            call.state == CallState.Cancelled || call.outcome == CallOutcome.Cancelled -> RingStopReason.CANCELLED
            call.outcome == CallOutcome.Declined -> RingStopReason.DECLINED
            call.state == CallState.Connecting || call.state == CallState.Active -> RingStopReason.ANSWERED_ELSEWHERE
            else -> RingStopReason.ENDED
        }
        if (stateOf(call.id) == Seen.RINGING) stopRing(call.id, reason)
    }

    /** Answered or declined on this phone: the ring is down, and nothing that arrives later puts it back. */
    fun dealtWith(callId: Id) {
        synchronized(seen) { seen[callId] = Seen.STOPPED }
    }

    /** Whether [callId] is ringing on this phone, as far as this router knows. */
    fun isRinging(callId: Id): Boolean = stateOf(callId) == Seen.RINGING

    private suspend fun show(ring: CallRing, now: Instant) {
        if (ring.expired(now)) {
            diag.info(AREA, "ring dropped: arrived after it expired")
            return
        }
        if (!signedIn()) {
            diag.warn(AREA, "ring dropped: nobody signed in")
            return
        }
        // Claimed before posting: the other path's copy of the same ring,
        // arriving while this one is being posted, finds it taken.
        val claimed = synchronized(seen) {
            if (seen.containsKey(ring.callId)) false else {
                seen[ring.callId] = Seen.RINGING
                true
            }
        }
        if (!claimed) {
            diag.info(AREA, "ring for ${Diag.id(ring.callId)} already seen")
            return
        }
        val posted = ring(ring)
        if (!posted) {
            synchronized(seen) { if (seen[ring.callId] == Seen.RINGING) seen.remove(ring.callId) }
            diag.warn(AREA, "ring for ${Diag.id(ring.callId)} not shown")
            return
        }
        // A stop that arrived while the ring was being posted wins.
        if (stateOf(ring.callId) == Seen.STOPPED) {
            stop(ring.callId, false, RingStopReason.ENDED)
            return
        }
        diag.info(AREA, "ringing for ${Diag.id(ring.callId)}")
        rang(ring.callId)
    }

    private fun stopRing(callId: Id, reason: RingStopReason) {
        val before = synchronized(seen) { seen.put(callId, Seen.STOPPED) }
        diag.info(AREA, "ring stopped (${reason.wire}) for ${Diag.id(callId)}")
        // Missed only when it rang here and was not dealt with here.
        stop(callId, reason.missed && before == Seen.RINGING, reason)
    }

    private fun isKnown(callId: Id): Boolean = synchronized(seen) { seen.containsKey(callId) }

    private fun stateOf(callId: Id): Seen? = synchronized(seen) { seen[callId] }

    private fun Instant.coerceAtLeast(other: Instant): Instant = if (isBefore(other)) other else this

    internal companion object {
        const val AREA = "Ring"
        const val MAX_REMEMBERED = 64
        const val RING_SECONDS = 45L
        const val MIN_RING_SECONDS = 5L
        const val CLOCK_SKEW_MS = 15_000L
    }
}
