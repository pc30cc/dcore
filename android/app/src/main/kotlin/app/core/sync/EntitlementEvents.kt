package app.core.sync

import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.model.RealtimeEvent
import app.core.model.StoreName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * `entitlement` events, as this build takes them.
 *
 * The server publishes the entitlements as a session of one store's build
 * sees them ([RealtimeEvent.EntitlementsChanged.store]): a build counts its
 * own store's purchases, and the other store's only when cross-store
 * entitlements are on. A view of [store] (or of no store) is applied as it
 * is. Another store's view is only a hint that something changed: the
 * entitlements are read again (`GET /v1/me/entitlements`, revalidated with
 * its ETag), and a burst of such events costs at most one read in flight and
 * one queued after it ([CoalescedRun]).
 *
 * A hint stays pending until a read answers it: a read that fails is tried
 * again after [retryDelays], then when the network comes back or the app
 * returns to the front ([retryPending]). A view of [store] published after
 * the hint answers it as well (it counts the same change).
 */
class EntitlementEvents(
    private val entitlements: EntitlementRepository,
    /** This build's store, as the wire names it. */
    private val store: StoreName,
    private val scope: CoroutineScope,
    diag: Diag = Diag.Silent,
    /** The waits before a failed hint is read again; after the last one, only [retryPending] reads it. */
    private val retryDelays: List<Long> = RETRY_DELAYS_MS,
) {
    /** A hint no read has answered yet. */
    private val pending = AtomicBoolean(false)

    /** Failed reads since the last answer: which of [retryDelays] comes next. */
    private val failures = AtomicInteger(0)

    @Volatile private var retry: Job? = null

    private val reread = CoalescedRun(scope, diag) {
        // A hint that arrives from here on is answered by the run queued after this one.
        pending.set(false)
        if (entitlements.reread()) {
            failures.set(0)
            retry?.cancel()
        } else {
            pending.set(true)
            retryLater()
        }
    }

    fun onEvent(event: RealtimeEvent.EntitlementsChanged) {
        val view = event.store
        if (view == null || view == store) {
            entitlements.apply(event.entitlements)
            settle()
        } else {
            // A new hint starts the waits again: the socket that brought it is up.
            pending.set(true)
            failures.set(0)
            reread.request()
        }
    }

    /** The network came back, or the app returned to the front: a pending hint is read now. */
    fun retryPending() {
        if (!pending.get()) return
        retry?.cancel()
        failures.set(0)
        reread.request()
    }

    /** The account signed out: nothing of its hints is read for the next one. */
    fun reset() = settle()

    private fun settle() {
        pending.set(false)
        failures.set(0)
        retry?.cancel()
    }

    private fun retryLater() {
        val wait = retryDelays.getOrNull(failures.getAndIncrement()) ?: return
        retry?.cancel()
        retry = scope.launch {
            delay(wait)
            if (pending.get()) reread.request()
        }
    }

    internal companion object {
        /** 5 s, 30 s, 2 min, 10 min. */
        val RETRY_DELAYS_MS: List<Long> = listOf(5_000L, 30_000L, 120_000L, 600_000L)
    }
}

/**
 * Runs [block] on [scope] when asked, one run at a time. Requests made while
 * a run is waiting to start are folded into it; requests made while it runs
 * are folded into one more run after it. So any burst costs at most one run
 * in flight and one queued, and the last request is always followed by a
 * run that started after it.
 */
internal class CoalescedRun(
    private val scope: CoroutineScope,
    private val diag: Diag = Diag.Silent,
    private val block: suspend () -> Unit,
) {
    private val running = Mutex()

    /** A run is launched and has not started [block] yet: later requests ride on it. */
    private val queued = AtomicBoolean(false)

    fun request() {
        if (!queued.compareAndSet(false, true)) return
        scope.launch {
            running.withLock {
                queued.set(false)
                runCatchingUnlessCancelled { block() }.onFailure { diag.warn(AREA, "run failed (${it.javaClass.simpleName})") }
            }
        }
    }

    private companion object {
        const val AREA = "Coalesced"
    }
}
