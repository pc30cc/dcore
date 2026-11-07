package app.core.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import app.core.CoreApp
import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.call.CallGraph
import app.core.feature.call.OngoingCallService
import app.core.model.Id
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The buttons on a call's notifications, pressed without opening the app.
 *
 *  - **Decline** on the ring: the ring stops at once and the server is told
 *    (`POST decline`), which ends the call for the caller. A ring screen open
 *    for the call closes with it, without telling the server twice.
 *  - **End** on the ongoing call: the call on screen hangs up as if its own red
 *    button were pressed; with no call left on screen, the server is told
 *    from here (`POST end`).
 *
 * A broadcast rather than an activity, so neither opens the app. Not
 * exported: only this app's own notifications can send it.
 */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val callId = intent.getStringExtra(CallNotifications.EXTRA_CALL)?.takeIf(CallRing::isId) ?: return
        val calls = (context.applicationContext as? CoreApp)?.graph?.calls ?: return
        when (intent.action) {
            CallNotifications.ACTION_DECLINE -> {
                CallNotifications.stopRing(context, callId, missed = false)
                CallNotifications.forget(callId)
                calls.incoming.dealtWith(callId)
                calls.signals.declinedHere(callId)
                tellServer(calls, callId, "decline") { calls.api().declineCall(callId) }
            }
            CallNotifications.ACTION_HANG_UP -> {
                if (calls.controller.hangUpFromNotification(callId)) return
                // Nothing on screen holds this call any more: the notification
                // goes, and the server hears.
                OngoingCallService.stop(context, callId)
                tellServer(calls, callId, "end") { calls.api().endCall(callId) }
            }
        }
    }

    /**
     * [request], kept alive past this method: a receiver's process may be
     * dropped as soon as `onReceive` returns, so the broadcast is held open
     * ([goAsync]) for one short request, well inside the time a broadcast gets.
     */
    private fun tellServer(calls: CallGraph, callId: Id, what: String, request: suspend () -> Unit) {
        val pending = goAsync()
        calls.scope.launch {
            try {
                val done = withTimeoutOrNull(REQUEST_TIMEOUT_MS) {
                    runCatchingUnlessCancelled { request() }
                        .onFailure { calls.diag.warn(AREA, "$what not sent for ${Diag.id(callId)}: ${it.javaClass.simpleName}") }
                }
                if (done == null) calls.diag.warn(AREA, "$what timed out for ${Diag.id(callId)}")
            } finally {
                pending.finish()
            }
        }
    }

    private companion object {
        const val AREA = "Call"

        /** Inside the ten seconds a broadcast is given, with room to spare. */
        const val REQUEST_TIMEOUT_MS = 8_000L
    }
}
