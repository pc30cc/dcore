package app.core.sync

import app.core.common.Diag
import app.core.model.PublicUid
import app.core.model.Swipe
import app.core.model.SwipeAction
import app.core.model.SwipesResult
import app.core.net.ApiError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Where swipes leave the phone (`POST /v1/swipes`).
 *
 * - **Passes are batched:** one request per [windowMs] (2 s) after the first
 *   waiting pass, or at once when [batchSize] (10) are waiting. A pass costs
 *   the server nothing but a Bloom bit; a request per pass would cost it a
 *   request per pass.
 * - **Likes go at once** ([sendNow]), and take the waiting passes with them in
 *   the same request (1-20 swipes per request), so a like never costs a second
 *   request for passes that were about to go anyway.
 * - **The newest pass is held** while it is the last thing the person did
 *   ([holdLastPass]), so [takeBack] can undo it without any request: a rewind
 *   is "the last pass only", and while that pass is still on the phone the
 *   server never has to forget it. It leaves with the next batch, the next
 *   like, or [flushAll] when the app goes to the background.
 * - A batch that gets no answer, or a 429/5xx, stays and is sent again with
 *   backoff (2 s doubling to 60 s); swipes are idempotent on the server
 *   (`duplicate`). One the server refuses (4xx) is dropped and logged: sending
 *   it again would be refused again.
 *
 * Every method is called from one thread (the deck repository's).
 */
class SwipeOutbox(
    private val scope: CoroutineScope,
    private val send: suspend (List<Swipe>) -> SwipesResult,
    private val onSent: (SwipesResult) -> Unit = {},
    private val diag: Diag = Diag.Silent,
    val windowMs: Long = WINDOW_MS,
    val batchSize: Int = BATCH_SIZE,
    /** Called whenever the waiting swipes change (to save them), with who a rewind could bring back. */
    private val onChanged: (rewindable: PublicUid?) -> Unit = {},
) {
    /** Whether the newest pass waits for the next action, so it can be taken back. */
    var holdLastPass: Boolean = true

    private val pending = ArrayDeque<Swipe>()
    private val inFlight = HashSet<PublicUid>()
    private val flushLock = Mutex()
    private var timer: Job? = null
    private var retryJob: Job? = null
    private var failures = 0

    /** True while the newest waiting pass is the last action and can be taken back. */
    private var lastIsPass = false

    private val _rewindable = MutableStateFlow<PublicUid?>(null)

    /** The person whose pass [takeBack] can undo right now, or null. */
    val rewindable: StateFlow<PublicUid?> = _rewindable.asStateFlow()

    /** The swipes not yet answered by the server, oldest first. */
    fun pending(): List<Swipe> = pending.toList()

    val pendingCount: Int get() = pending.size

    /** Records a pass; it leaves with the next batch. */
    fun pass(target: PublicUid) {
        if (pending.any { it.target == target }) return
        pending.addLast(Swipe(target, SwipeAction.Pass))
        lastIsPass = true
        changed()
        if (sendableCount() >= batchSize) {
            launchFlush()
        } else if (sendableCount() > 0) {
            armTimer()
        }
    }

    /**
     * Undoes the pass on [target] when it is still the last action and has not
     * left the phone. True when it was taken back (no request is made).
     */
    fun takeBack(target: PublicUid): Boolean {
        val last = pending.lastOrNull() ?: return false
        if (!lastIsPass || last.target != target || target in inFlight) return false
        pending.removeLast()
        lastIsPass = false
        changed()
        return true
    }

    /**
     * Sends [swipe] (a like or a super like) now, with the waiting passes in
     * the same request. Throws what the request threw; the passes then stay
     * and go later.
     */
    suspend fun sendNow(swipe: Swipe): SwipesResult {
        lastIsPass = false
        timer?.cancel()
        timer = null
        val passes = pending.filter { it.target !in inFlight && it.target != swipe.target }.take(MAX_PER_REQUEST - 1)
        val batch = passes + swipe
        val targets = batch.map { it.target }.toSet()
        inFlight += targets
        changed()
        try {
            val result = send(batch)
            pending.removeAll { it.target in targets }
            failures = 0
            onSent(result)
            return result
        } finally {
            inFlight -= targets
            changed()
            if (sendableCount() > 0) armTimer()
        }
    }

    /** Sends everything waiting, the held pass included: the app is going to the background. */
    fun flushAll() {
        lastIsPass = false
        changed()
        launchFlush()
    }

    /** Starts from swipes saved by an earlier launch: they leave with the next batch. */
    fun restore(saved: List<Swipe>) {
        for (swipe in saved) {
            if (swipe.action == SwipeAction.Pass && pending.none { it.target == swipe.target }) pending.addLast(swipe)
        }
        lastIsPass = false
        changed()
        if (pending.isNotEmpty()) armTimer()
    }

    /**
     * Sends the waiting passes now, except a held one, and returns when the
     * server has answered them (or the attempt failed). The deck calls it
     * before asking for the next page, so the page starts past them.
     */
    suspend fun flush() {
        flushLock.withLock {
            while (true) {
                val batch = sendable().take(MAX_PER_REQUEST)
                if (batch.isEmpty()) return
                val targets = batch.map { it.target }.toSet()
                inFlight += targets
                changed()
                try {
                    val result = send(batch)
                    pending.removeAll { it.target in targets }
                    failures = 0
                    onSent(result)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiError) {
                    if (isRetryable(e)) {
                        failures++
                        diag.warn(AREA, "pass batch of ${batch.size} not sent (${e.code ?: e.javaClass.simpleName}); retry ${failures}")
                        scheduleRetry()
                        return
                    }
                    diag.warn(AREA, "pass batch of ${batch.size} refused (${e.code ?: e.javaClass.simpleName}); dropped")
                    pending.removeAll { it.target in targets }
                } finally {
                    inFlight -= targets
                    changed()
                }
            }
        }
    }

    private fun sendable(): List<Swipe> {
        val free = pending.filter { it.target !in inFlight }
        return if (holdLastPass && lastIsPass && free.isNotEmpty() && free.last() == pending.last()) free.dropLast(1) else free
    }

    private fun sendableCount(): Int = sendable().size

    private fun armTimer() {
        if (timer?.isActive == true || retryJob?.isActive == true) return
        timer = scope.launch {
            delay(windowMs)
            timer = null
            flush()
        }
    }

    private fun launchFlush() {
        timer?.cancel()
        timer = null
        scope.launch { flush() }
    }

    private fun scheduleRetry() {
        if (retryJob?.isActive == true) return
        val wait = (RETRY_BASE_MS shl (failures - 1).coerceIn(0, 5)).coerceAtMost(RETRY_MAX_MS)
        retryJob = scope.launch {
            delay(wait)
            retryJob = null
            flush()
        }
    }

    private fun changed() {
        _rewindable.value = if (lastIsPass) pending.lastOrNull()?.target?.takeIf { it !in inFlight } else null
        onChanged(_rewindable.value)
    }

    companion object {
        const val WINDOW_MS = 2_000L
        const val BATCH_SIZE = 10

        /** The route takes 1-20 swipes per request. */
        const val MAX_PER_REQUEST = 20

        const val RETRY_BASE_MS = 2_000L
        const val RETRY_MAX_MS = 60_000L

        private const val AREA = "Deck"

        /** No answer, a rate limit or a server failure: worth sending again later. */
        fun isRetryable(e: ApiError): Boolean = when (e) {
            is ApiError.Network -> true
            is ApiError.Http -> e.status == 429 || e.status >= 500
            is ApiError.Decoding -> false
            is ApiError.Unauthorized -> false
        }
    }
}
