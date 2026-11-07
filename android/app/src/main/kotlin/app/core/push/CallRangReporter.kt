package app.core.push

import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.model.Id
import app.core.net.ApiError
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Tells the server this phone is ringing for a call (`POST /v1/calls/:id/rang`),
 * so the caller's "Calling…" becomes "Ringing…" only once a phone actually
 * rings (and only when this account shows that it is online: the server
 * decides that, not the phone).
 *
 * Once per call per phone: the ring posted from push, the one from the
 * realtime socket and the in-app ring screen all ask, and only the first
 * sends. A failure is tried twice more, 3 s apart, then dropped: the caller
 * then stays on "Calling…". 409 (no longer ringing) and 404 are final.
 */
class CallRangReporter(
    private val send: suspend (callId: Id) -> Unit,
    private val scope: CoroutineScope,
    private val retryDelayMs: Long = RETRY_DELAY_MS,
    private val diag: Diag = Diag.Silent,
) {
    private val reported = LinkedHashSet<Id>()

    fun report(callId: Id) {
        val first = synchronized(reported) {
            val added = reported.add(callId)
            while (reported.size > MAX_REMEMBERED) reported.remove(reported.first())
            added
        }
        if (!first) return
        scope.launch {
            repeat(ATTEMPTS) { attempt ->
                val result = runCatchingUnlessCancelled { send(callId) }
                if (result.isSuccess) return@launch
                val status = (result.exceptionOrNull() as? ApiError.Http)?.status
                if (status in FINAL_STATUSES) return@launch
                if (attempt < ATTEMPTS - 1) delay(retryDelayMs)
            }
            diag.warn(AREA, "rang not sent for ${Diag.id(callId)}")
        }
    }

    internal companion object {
        const val ATTEMPTS = 3
        const val RETRY_DELAY_MS = 3_000L
        const val MAX_REMEMBERED = 64
        val FINAL_STATUSES = setOf(404, 409)
        const val AREA = "Ring"
    }
}
