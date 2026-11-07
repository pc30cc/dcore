package app.core.feature.call

import app.core.model.Call
import app.core.model.Id
import app.core.push.RingStopReason
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Everything a call hears from outside its own screen, in one place.
 *
 * - The realtime socket's `call` events ([onRealtimeCall]): every state move
 *   of every call of this account, with the whole call, so nothing is read
 *   again. The ring on this phone listens too ([ringListener]): a ring that
 *   arrives over the socket rings like one from push.
 * - Whether that socket is connected ([setRealtimeConnected]). While it is, a
 *   call asks the server nothing on a timer; only while it is down does a
 *   call fall back to reading its state (3 s ringing, 15 s answered).
 * - The ring stopped by push, and Decline pressed on the ring's notification.
 *
 * The realtime layer feeds the first two; nothing here opens a socket.
 */
class CallSignals {

    private val _nudges = MutableSharedFlow<CallNudge>(extraBufferCapacity = 64)
    val nudges: SharedFlow<CallNudge> = _nudges.asSharedFlow()

    private val _realtimeConnected = MutableStateFlow(false)
    val realtimeConnected: StateFlow<Boolean> = _realtimeConnected.asStateFlow()

    /** The ring on this phone, told of every call event too (set once by the call graph). */
    @Volatile var ringListener: ((Call) -> Unit)? = null

    /** A `call` envelope's payload, as the realtime layer decoded it. */
    fun onRealtimeCall(call: Call) {
        ringListener?.invoke(call)
        _nudges.tryEmit(CallNudge.Update(call))
    }

    fun setRealtimeConnected(connected: Boolean) {
        _realtimeConnected.value = connected
    }

    fun ringStopped(callId: Id, reason: RingStopReason) {
        _nudges.tryEmit(CallNudge.RingStopped(callId, reason))
    }

    fun declinedHere(callId: Id) {
        _nudges.tryEmit(CallNudge.DeclinedHere(callId))
    }
}
