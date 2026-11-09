package app.core.net.origins

import app.core.common.Clock
import app.core.common.Diag
import app.core.net.ApiHosts
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The signed origins list: the one the app holds, where it is fetched from,
 * when, and the API hosts that follow from it ([apiHosts], for the funnel).
 *
 * **Held list.** The last accepted document is kept as received
 * ([OriginsStore]). At start it is verified again (signature and brand, not
 * expiry): a list that was valid when accepted stays the last known good one
 * after it expires, and asks for a fetch. One signed with a key this build no
 * longer carries (a release after a rotation) is dropped.
 *
 * **Accepting.** A fetched document is verified ([OriginsVerifier], expiry
 * included) and accepted only when (`version`, `issuedAt`) is greater than the
 * held one's; an equal one keeps the held copy, an older one is refused.
 *
 * **Fetching**, in order, stopping at the first source that gives a valid
 * answer: the API host requests use now (`GET /v1/origins`, with
 * `If-None-Match`: a 304 costs nothing), the list's other API hosts, the
 * published copies (the list's, then the build's), then the build's API host.
 *
 * **When:** at cold start, when `GET /v1/config` shows a new `v` (every host
 * change raises it), every six hours while the app is in front, when the held
 * list is within seven days of its expiry or past it (hourly at most), and
 * when every API host failed a request ([recover], the published copies all
 * at once). Never more than once a minute, except that failure path.
 *
 * A build without keys ([OriginsTrust.enabled] false) never fetches: it stays
 * on the host it was built with.
 */
class OriginsRepository(
    private val trust: OriginsTrust,
    compiledApi: String,
    compiledBootstrap: List<String>,
    private val store: OriginsStore,
    private val transport: OriginsTransport,
    private val clock: Clock = Clock.System,
    private val diag: Diag = Diag.Android,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val verifier = OriginsVerifier(trust)
    private val compiledBootstrap = bootstrapUrls(compiledBootstrap)

    /** API host selection: the held list's hosts, the bad marks, the build's host. */
    val book = HostBook(compiledApi, clock)

    private val _current = MutableStateFlow<OriginsList?>(null)

    /** The held list, once restored or fetched; null while there is none. */
    val current: StateFlow<OriginsList?> = _current.asStateFlow()

    @Volatile private var stored: StoredOrigins? = null

    private val restoreLock = Mutex()
    @Volatile private var restored = false

    private val fetchLock = Mutex()
    private val acceptLock = Mutex()
    private val recoverLock = Mutex()

    /** When the last check (normal path) started. */
    @Volatile var lastAttemptAt: Long? = null
        private set

    /** When a source last confirmed the held list or gave a newer one. */
    @Volatile var lastCheckedAt: Long? = null
        private set

    @Volatile private var lastRecoveryAt: Long? = null

    private val started = AtomicBoolean(false)
    private val wanted = Channel<Long>(Channel.CONFLATED)

    /** What [app.core.net.ApiClient] sends requests by. */
    val apiHosts: ApiHosts = object : ApiHosts {
        override suspend fun candidates(): List<String> {
            restore()
            return book.candidates()
        }

        override fun trusted(base: String): Boolean = book.trusted(base)

        override fun reached(base: String) = book.reached(base)

        override fun failed(base: String) = book.failed(base)

        override suspend fun recover(): Boolean = this@OriginsRepository.recover()
    }

    enum class Trigger(val label: String) {
        COLD_START("cold start"),
        CONFIG("config changed"),
        PERIODIC("periodic"),
        EXPIRY("near expiry"),
    }

    enum class Result {
        /** This build carries no keys. */
        DISABLED,

        /** Less than a minute since the last check. */
        SKIPPED,

        /** A newer list was accepted. */
        ACCEPTED,

        /** A source confirmed the held list (304, the same list, or only an older one). */
        UNCHANGED,

        /** No source gave a valid answer. */
        FAILED,
    }

    // MARK: - The held list

    /** Reads and re-verifies the stored document, once; every other call returns at once. */
    suspend fun restore() {
        if (restored) return
        restoreLock.withLock {
            if (restored) return
            try {
                if (trust.enabled) restoreNow()
            } finally {
                restored = true
            }
        }
    }

    private suspend fun restoreNow() {
        val saved = withContext(io) {
            try {
                store.read()
            } catch (e: IOException) {
                null
            }
        } ?: return
        when (val verdict = withContext(io) { verifier.verify(saved.envelope, now = null) }) {
            is Verified.Valid -> {
                stored = saved
                _current.value = verdict.list
                book.adopt(verdict.list.api)
                diag.info(AREA, "restored v${verdict.list.version} (${verdict.list.api.size} API hosts)")
            }
            is Verified.Refused -> {
                diag.warn(AREA, "stored list dropped (${verdict.reason.name.lowercase()})")
                withContext(io) { runCatching { store.clear() } }
            }
        }
    }

    // MARK: - Checking (the normal path)

    /** One check, unless one started less than a minute ago. */
    suspend fun refresh(trigger: Trigger): Result {
        if (!trust.enabled) return Result.DISABLED
        restore()
        return fetchLock.withLock {
            val now = clock.nowMillis()
            val last = lastAttemptAt
            if (last != null && now - last < MIN_INTERVAL_MS) return@withLock Result.SKIPPED
            lastAttemptAt = now
            walk(trigger)
        }
    }

    private enum class Step { NEXT, ACCEPTED, CONFIRMED }

    private suspend fun walk(trigger: Trigger): Result {
        val listed = book.listed()
        val apiFirst = (listOf(book.candidates().first()) + book.order().filter { it in listed && !book.isBad(it) }).distinct()
        val tried = HashSet<String>()
        for ((index, base) in apiFirst.withIndex()) {
            tried += base
            when (fromApi(base, "api#$index")) {
                Step.ACCEPTED -> return Result.ACCEPTED
                Step.CONFIRMED -> return Result.UNCHANGED
                Step.NEXT -> Unit
            }
        }
        for ((index, url) in bootstrapSources().withIndex()) {
            when (fromCopy(url, "copy#$index")) {
                Step.ACCEPTED -> return Result.ACCEPTED
                Step.CONFIRMED -> return Result.UNCHANGED
                Step.NEXT -> Unit
            }
        }
        if (book.compiled !in tried) {
            when (fromApi(book.compiled, "build")) {
                Step.ACCEPTED -> return Result.ACCEPTED
                Step.CONFIRMED -> return Result.UNCHANGED
                Step.NEXT -> Unit
            }
        }
        diag.info(AREA, "no source gave a valid list (${trigger.label})")
        return Result.FAILED
    }

    private suspend fun fromApi(base: String, source: String): Step {
        val etag = stored?.etag?.takeIf { _current.value != null }
        val answer = try {
            transport.get(base + PATH, etag)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            book.failed(base)
            diag.info(AREA, "$source: no answer (${e.javaClass.simpleName})")
            return Step.NEXT
        }
        if (answer.isEdgeFailure()) {
            book.failed(base)
            diag.info(AREA, "$source: ${answer.status} from the edge")
            return Step.NEXT
        }
        book.reached(base)
        if (answer.status == STATUS_NOT_MODIFIED && etag != null) {
            confirmed(etag = null)
            return Step.CONFIRMED
        }
        if (answer.status == STATUS_OK && answer.body != null) return consider(answer.body, answer.etag, source)
        diag.info(AREA, "$source: ${answer.status}")
        return Step.NEXT
    }

    private suspend fun fromCopy(url: String, source: String): Step {
        val answer = try {
            transport.get(url, null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            diag.info(AREA, "$source: no answer (${e.javaClass.simpleName})")
            return Step.NEXT
        }
        if (answer.status == STATUS_OK && answer.body != null) return consider(answer.body, etag = null, source)
        diag.info(AREA, "$source: ${answer.status}")
        return Step.NEXT
    }

    private suspend fun consider(text: String, etag: String?, source: String): Step {
        val verdict = withContext(io) { verifier.verify(text, clock.now()) }
        if (verdict is Verified.Refused) {
            diag.warn(AREA, "$source: refused (${verdict.reason.name.lowercase()}: ${verdict.detail})")
            return Step.NEXT
        }
        val list = (verdict as Verified.Valid).list
        return if (offer(text, list, etag)) Step.ACCEPTED else Step.CONFIRMED
    }

    /** Accepts [list] when it is newer than the held one; true when it was. */
    private suspend fun offer(text: String, list: OriginsList, etag: String?): Boolean = acceptLock.withLock {
        val held = _current.value
        val now = clock.nowMillis()
        val order = if (held == null) 1 else list.compareOrder(held)
        when {
            order > 0 -> {
                val record = StoredOrigins(text, etag, now)
                save(record)
                stored = record
                _current.value = list
                book.adopt(list.api)
                lastCheckedAt = now
                diag.info(AREA, "accepted v${list.version} (${list.api.size} API hosts)")
                true
            }
            order == 0 -> {
                confirmedLocked(etag, now)
                false
            }
            else -> {
                lastCheckedAt = now
                diag.warn(AREA, "an older list (v${list.version}) than the held v${held?.version}: kept the held one")
                false
            }
        }
    }

    private suspend fun confirmed(etag: String?) = acceptLock.withLock { confirmedLocked(etag, clock.nowMillis()) }

    private suspend fun confirmedLocked(etag: String?, now: Long) {
        lastCheckedAt = now
        val held = stored ?: return
        val record = held.copy(etag = etag ?: held.etag, fetchedAtMillis = now)
        save(record)
        stored = record
    }

    private suspend fun save(record: StoredOrigins) {
        withContext(io) {
            try {
                store.write(record)
            } catch (e: IOException) {
                diag.warn(AREA, "list not stored (${e.javaClass.simpleName}); kept in memory")
            }
        }
    }

    private fun bootstrapSources(): List<String> = (_current.value?.bootstrap.orEmpty() + compiledBootstrap).distinct()

    // MARK: - The failure path

    /**
     * Every API host failed a request: reads every published copy at once (each
     * with its own timeout), accepts the newest valid one, and says whether the
     * held list changed. Calls that overlap share one round; a round that found
     * nothing is not repeated for [RECOVERY_FLOOR_MS].
     */
    suspend fun recover(): Boolean {
        if (!trust.enabled) return false
        restore()
        val before = _current.value
        recoverLock.withLock {
            if (_current.value != before) return true
            val now = clock.nowMillis()
            val last = lastRecoveryAt
            if (last != null && now - last < RECOVERY_FLOOR_MS) return false
            lastRecoveryAt = now
            val sources = bootstrapSources()
            diag.info(AREA, "every API host failed; reading ${sources.size} published copies")
            val found = coroutineScope {
                sources.mapIndexed { index, url -> async { copy(url, "copy#$index") } }.awaitAll()
            }.filterNotNull()
            val newest = found.maxWithOrNull { a, b -> a.second.compareOrder(b.second) }
            if (newest != null) offer(newest.first, newest.second, etag = null)
        }
        return _current.value != before
    }

    private suspend fun copy(url: String, source: String): Pair<String, OriginsList>? {
        val answer = try {
            transport.get(url, null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            diag.info(AREA, "$source: no answer (${e.javaClass.simpleName})")
            return null
        }
        val body = answer.body
        if (answer.status != STATUS_OK || body == null) return null
        return when (val verdict = withContext(io) { verifier.verify(body, clock.now()) }) {
            is Verified.Valid -> body to verdict.list
            is Verified.Refused -> {
                diag.warn(AREA, "$source: refused (${verdict.reason.name.lowercase()}: ${verdict.detail})")
                null
            }
        }
    }

    // MARK: - When to check

    /**
     * Starts the checks: one now (the cold start), one after every new config
     * `v`, and the cadence while [foreground] is true. Idempotent.
     */
    fun start(scope: CoroutineScope, foreground: Flow<Boolean>, configVersions: Flow<Long?>) {
        if (!started.compareAndSet(false, true)) return
        if (!trust.enabled) {
            diag.warn(AREA, "this build carries no origins keys: it stays on its compiled hosts")
            return
        }
        val coldStart = scope.launch { refresh(Trigger.COLD_START) }
        scope.launch {
            // The first value is the cold start's, which the check above covers.
            configVersions.filterNotNull().distinctUntilChanged().drop(1).collect { wanted.trySend(clock.nowMillis()) }
        }
        scope.launch {
            for (at in wanted) refreshAfter(at)
        }
        scope.launch {
            // The cadence counts from the cold start's check, not from the stored copy's time.
            coldStart.join()
            foreground.distinctUntilChanged().collectLatest { inFront -> if (inFront) whileInFront(scope) }
        }
    }

    /** A check that starts at or after [at]: at once when the minute allows, else when it does. */
    private suspend fun refreshAfter(at: Long) {
        while (true) {
            val last = lastAttemptAt
            if (last != null && last >= at) return
            val wait = if (last == null) 0 else last + MIN_INTERVAL_MS - clock.nowMillis()
            if (wait > 0) {
                delay(wait)
                continue
            }
            if (refresh(Trigger.CONFIG) != Result.SKIPPED) return
        }
    }

    private suspend fun whileInFront(scope: CoroutineScope) {
        while (true) {
            val now = clock.nowMillis()
            val due = nextCheckAt(now)
            if (due > now) delay(due - now)
            val trigger = if (nearExpiry(clock.nowMillis())) Trigger.EXPIRY else Trigger.PERIODIC
            // In the app's scope, so going to the background stops the
            // waiting, not a check already on its way.
            scope.launch { refresh(trigger) }.join()
        }
    }

    /**
     * When the foreground cadence checks next: six hours after the last
     * confirmed check (at once without one); hourly while the held list is
     * within seven days of its expiry, past it, or missing; not within the hour
     * after a check that failed; never within a minute of the last one.
     */
    internal fun nextCheckAt(now: Long): Long {
        val last = lastAttemptAt
        val checked = lastCheckedAt ?: stored?.fetchedAtMillis
        val regular = checked?.plus(PERIODIC_MS) ?: now
        val soon = if (nearExpiry(now)) last?.plus(RETRY_MS) ?: now else Long.MAX_VALUE
        var due = minOf(regular, soon)
        if (last != null && (checked == null || last > checked)) due = maxOf(due, last + RETRY_MS)
        if (last != null) due = maxOf(due, last + MIN_INTERVAL_MS)
        return due
    }

    private fun nearExpiry(now: Long): Boolean {
        val list = _current.value ?: return true
        return list.expiresAt.toEpochMilli() - now <= NEAR_EXPIRY_MS
    }

    // MARK: - The other roles

    /**
     * Realtime sockets to try after the token's own address failed more than
     * once: `wss://<host>/connection/websocket` for `hosts.realtime`, in order.
     */
    fun realtimeSockets(): List<String> =
        _current.value?.realtime.orEmpty().map { "wss://${it.removePrefix("https://")}$REALTIME_PATH" }

    /**
     * The website's account-deletion page under `hosts.web[0]`
     * (`https://<web>/<locale>/delete-account/`), for when no config is at
     * hand; null without a list.
     */
    fun deletionPage(locale: String): String? {
        val web = _current.value?.web?.firstOrNull() ?: return null
        val tag = locale.lowercase().takeIf { LOCALE.matches(it) } ?: return null
        return "$web/$tag/delete-account/"
    }

    private fun OriginsFetch.isEdgeFailure(): Boolean =
        (status == 502 || status == 503 || status in 520..526) && !problem

    companion object {
        const val PATH = "/v1/origins"
        const val REALTIME_PATH = "/connection/websocket"

        const val MIN_INTERVAL_MS = 60_000L
        const val PERIODIC_MS = 6 * 3_600_000L
        const val RETRY_MS = 3_600_000L
        const val NEAR_EXPIRY_MS = 7 * 24 * 3_600_000L
        const val RECOVERY_FLOOR_MS = 15_000L

        private const val STATUS_OK = 200
        private const val STATUS_NOT_MODIFIED = 304
        private const val AREA = "Origins"
        private val LOCALE = Regex("[a-z]{2,3}")
    }
}
