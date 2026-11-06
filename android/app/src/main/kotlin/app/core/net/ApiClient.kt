package app.core.net

import app.core.BuildConfig
import app.core.common.Clock
import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.model.Problem
import app.core.model.ProblemCodes
import app.core.model.RefreshRequest
import app.core.model.TokenPair
import app.core.model.Wire
import app.core.storage.StoredTokens
import app.core.storage.TokenStore
import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logger
import io.ktor.client.plugins.logging.Logging
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.content.TextContent
import io.ktor.http.encodeURLParameter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlin.random.Random

/** What the funnel tells the app about, outside any one request. */
sealed interface ApiEvent {
    /** The session is over (revoked, expired, reused): sign out. */
    data object SessionLost : ApiEvent

    /** This build is below the server's minimum for its store (426). */
    data class UpgradeRequired(val minVersionCode: Int?) : ApiEvent

    /** The service is in maintenance (503 `maintenance`). */
    data class Maintenance(val message: String?) : ApiEvent
}

/** A decoded answer and the headers it came with. */
class Answer<T>(val value: T, val status: Int, val headers: Headers) {
    /** The server's clock (`Date`), when it sent one. */
    val serverDateMillis: Long? get() = headers[HttpHeaders.Date]?.let(::parseHttpDate)
}

/**
 * The app's one funnel to the REST API (Ktor on OkHttp).
 *
 * Every request goes through [exchange]: the base URL, the bearer token, the
 * `X-Client`, language and request-id headers, timeouts, the status mapping
 * into [ApiError], token refresh and retries are in one place, and nothing
 * else in the app builds a URL.
 *
 * **Sessions.** The access token lives 15 minutes. It is renewed shortly
 * before its deadline, and once more after any 401 (one refresh, one replay,
 * then the session is over). Refreshes are single-flight: requests that find
 * the token renewed while they waited use the new one instead of rotating it
 * again. A 401 ends the session only when it was sent with the session in
 * hand; one sent before a sign-out and a new sign-in says nothing about the
 * session there is now.
 *
 * **Few requests, cheap requests.** A read that names a cache key is stored
 * with its `ETag`; the next one asks `If-None-Match`, and a 304 is answered
 * from the stored body, decided on the server without its database.
 *
 * **Retries.** Only what cannot do something twice ([Idempotency]) is
 * retried, and only after no answer or a gateway failure ([RetryPolicy]).
 *
 * Bodies are encoded and decoded with explicit serializers, never by
 * reflection, so R8 can rename freely.
 */
class ApiClient(
    baseUrl: String,
    private val tokens: TokenStore,
    private val cache: ResponseCache,
    engine: HttpClientEngine,
    /** `X-Client`: `<store>/<versionCode>`, e.g. `bazaar/12031`; required on every request. */
    private val clientHeader: String,
    /** The language the person reads (`fa`, `en`, `tr`), for server-rendered texts. */
    private val language: () -> String,
    private val diag: Diag = Diag.Android,
    /** Header-level request logging, debug builds only. Never bodies. */
    private val debugLog: ((String) -> Unit)? = null,
    private val clock: Clock = Clock.System,
    private val retry: RetryPolicy = RetryPolicy(),
    private val random: Random = Random.Default,
    /** How a retry waits; tests record it instead. */
    private val pause: suspend (Long) -> Unit = { delay(it) },
) {
    private val base = baseUrl.trimEnd('/')

    private val http = HttpClient(engine) {
        expectSuccess = false
        install(HttpTimeout) {
            // A hung request is worse than a failed one: fail fast enough to
            // show a retry.
            requestTimeoutMillis = 20_000
            connectTimeoutMillis = 15_000
            socketTimeoutMillis = 30_000
        }
        val sink = debugLog
        // BuildConfig.DEBUG is a constant: R8 drops this branch, and the
        // plugin with it, from release builds.
        if (BuildConfig.DEBUG && sink != null) {
            install(Logging) {
                logger = object : Logger {
                    override fun log(message: String) = sink(message)
                }
                // Headers, never bodies: a body is a message, a phone number,
                // a one-time code or a position.
                level = LogLevel.HEADERS
                sanitizeHeader { name -> name.equals(HttpHeaders.Authorization, ignoreCase = true) }
                // Requests whose very existence or URL is sensitive, or whose
                // answers are tokens, are not logged at all.
                filter { request ->
                    val path = request.url.buildString().substringBefore("?")
                    UNLOGGED_PATHS.none { path.contains(it) }
                }
            }
        }
    }

    private val _events = MutableSharedFlow<ApiEvent>(extraBufferCapacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Session loss, a required update, maintenance. */
    val events: SharedFlow<ApiEvent> = _events.asSharedFlow()

    private val renewLock = Mutex()

    // MARK: - What the endpoints use

    /** GET [path] and decode it. */
    suspend fun <T> get(
        route: String,
        path: String,
        response: KSerializer<T>,
        query: List<Pair<String, String?>> = emptyList(),
        authenticated: Boolean = true,
    ): Answer<T> {
        val reply = exchange(Outgoing(route, HttpMethod.Get, path, query.present(), null, authenticated, Idempotency.SAFE))
        return Answer(decode(reply.body, response), reply.status, reply.headers)
    }

    /**
     * GET [path], revalidated against the stored copy under [cacheKey]
     * (`If-None-Match`). A 304 answers from the stored body. The key must say
     * whose answer it is when the answer is personal, so one account never
     * reads another's copy; null skips the cache.
     */
    suspend fun <T> revalidate(
        route: String,
        path: String,
        response: KSerializer<T>,
        cacheKey: String?,
        query: List<Pair<String, String?>> = emptyList(),
        authenticated: Boolean = true,
    ): Fetched<T> = revalidate(route, path, response, cacheKey, query.present(), authenticated, useStored = true)

    private suspend fun <T> revalidate(
        route: String,
        path: String,
        response: KSerializer<T>,
        cacheKey: String?,
        query: List<Pair<String, String>>,
        authenticated: Boolean,
        useStored: Boolean,
    ): Fetched<T> {
        val stored = if (cacheKey != null && useStored) readCache(cacheKey) else null
        val reply = exchange(
            Outgoing(route, HttpMethod.Get, path, query, null, authenticated, Idempotency.SAFE, ifNoneMatch = stored?.etag),
        )
        if (reply.status == STATUS_NOT_MODIFIED && stored != null && cacheKey != null) {
            val value = decodeOrNull(stored.body, response)
            if (value != null) {
                guardCache("touch") { cache.touch(cacheKey, clock.nowMillis()) }
                return Fetched(value, changed = false)
            }
            // The stored copy no longer reads (this build's models changed):
            // drop it and ask for the whole answer.
            diag.warn(AREA, "$route: stored copy no longer decodes; asking again")
            guardCache("remove") { cache.remove(cacheKey) }
            return revalidate(route, path, response, cacheKey, query, authenticated, useStored = false)
        }
        val value = decode(reply.body, response)
        if (cacheKey != null) {
            guardCache("write") { cache.write(cacheKey, CachedResponse(reply.headers[HttpHeaders.ETag], reply.body, clock.nowMillis())) }
        }
        return Fetched(value, changed = true)
    }

    /** The stored answer for [cacheKey], or null; never a request. */
    suspend fun <T> cached(cacheKey: String, response: KSerializer<T>): T? {
        val stored = readCache(cacheKey) ?: return null
        return decodeOrNull(stored.body, response) ?: run {
            diag.warn(AREA, "a stored answer no longer decodes; dropped")
            guardCache("remove") { cache.remove(cacheKey) }
            null
        }
    }

    /** Sends [body] as JSON with [method] and decodes the answer. */
    suspend fun <B, T> send(
        route: String,
        method: HttpMethod,
        path: String,
        body: B,
        bodySerializer: KSerializer<B>,
        response: KSerializer<T>,
        idempotency: Idempotency,
        authenticated: Boolean = true,
    ): Answer<T> {
        val text = Wire.json.encodeToString(bodySerializer, body)
        val reply = exchange(Outgoing(route, method, path, emptyList(), text, authenticated, idempotency))
        return Answer(decode(reply.body, response), reply.status, reply.headers)
    }

    /** Sends [method] to [path] (with [body] as JSON, if any) for an answer that has no body worth reading. */
    suspend fun <B> sendNoContent(
        route: String,
        method: HttpMethod,
        path: String,
        body: B?,
        bodySerializer: KSerializer<B>?,
        idempotency: Idempotency,
        authenticated: Boolean = true,
    ) {
        val text = if (body != null && bodySerializer != null) Wire.json.encodeToString(bodySerializer, body) else null
        exchange(Outgoing(route, method, path, emptyList(), text, authenticated, idempotency))
    }

    /** A POST with no body that returns one. */
    suspend fun <T> post(
        route: String,
        path: String,
        response: KSerializer<T>,
        idempotency: Idempotency,
        authenticated: Boolean = true,
    ): Answer<T> {
        val reply = exchange(Outgoing(route, HttpMethod.Post, path, emptyList(), null, authenticated, idempotency))
        return Answer(decode(reply.body, response), reply.status, reply.headers)
    }

    /** Forgets every stored answer: at sign-out, and when the session is lost. */
    suspend fun clearCache() = guardCache("clear") { cache.clear() }

    fun close() = http.close()

    // MARK: - The funnel

    private class Outgoing(
        /** A label for logs and tests, never with an id in it: `conversations.messages`. */
        val route: String,
        val method: HttpMethod,
        val path: String,
        val query: List<Pair<String, String>>,
        val body: String?,
        val authenticated: Boolean,
        val idempotency: Idempotency,
        val ifNoneMatch: String? = null,
    )

    private class Incoming(val status: Int, val body: String, val headers: Headers)

    private suspend fun exchange(out: Outgoing): Incoming {
        // One id for the request across its retries and its replay after a
        // refresh, so the server's logs tie them together.
        val requestId = requestId()
        var failures = 0
        var renewed = false
        while (true) {
            val session = if (out.authenticated) sessionFor(out.route) else null
            val reply = try {
                transmit(out, session?.access, requestId)
            } catch (e: ApiError.Network) {
                failures++
                val wait = if (out.idempotency.retryable) retry.delayBefore(failures, null, random) else null
                if (wait == null) {
                    diag.info(AREA, "${out.route}: no answer (${e.cause?.javaClass?.simpleName}), not retried")
                    throw e
                }
                diag.info(AREA, "${out.route}: no answer, attempt $failures, retry in ${wait}ms")
                pause(wait)
                continue
            }
            val status = reply.status
            if (status in 200..299 || (status == STATUS_NOT_MODIFIED && out.ifNoneMatch != null)) return reply

            val problem = problemOf(reply)
            if (status == STATUS_UNAUTHORIZED && session != null) {
                if (renewed) {
                    // A token renewed a moment ago was refused: the session
                    // was revoked in between.
                    endSession(session, problem)
                    throw ApiError.Unauthorized(problem)
                }
                diag.info(AREA, "${out.route}: 401 ${problem.code ?: "-"}; renewing the session")
                renew(session)
                renewed = true
                continue
            }
            if (isGatewayFailure(status, problem) && out.idempotency.retryable) {
                failures++
                val wait = retry.delayBefore(failures, problem.retryAfterSeconds, random)
                if (wait != null) {
                    diag.info(AREA, "${out.route}: $status, attempt $failures, retry in ${wait}ms")
                    pause(wait)
                    continue
                }
            }
            throw failure(out.route, status, problem)
        }
    }

    /** The session to send with, renewed first when its access token is about to lapse. */
    private suspend fun sessionFor(route: String): StoredTokens {
        val current = tokens.tokens() ?: throw ApiError.Unauthorized(null)
        // A quarter of the token's life at most, so a server that hands out
        // short tokens is not asked for a new one before every request.
        val lifetime = (current.accessDeadlineMillis - current.receivedAtMillis).coerceAtLeast(0)
        val ahead = minOf(RENEW_AHEAD_MS, lifetime / 4)
        if (clock.nowMillis() < current.accessDeadlineMillis - ahead) return current
        diag.info(AREA, "$route: access token due; renewing first")
        return renew(current)
    }

    /**
     * Rotates the session that sent [used], once, however many requests ask
     * at the same time. Throws [ApiError.Unauthorized] when the server will
     * not renew it (and forgets it), [ApiError.Network] or [ApiError.Http]
     * when it could not ask, keeping the session for the next try.
     */
    private suspend fun renew(used: StoredTokens): StoredTokens = renewLock.withLock {
        val current = tokens.tokens() ?: throw ApiError.Unauthorized(null)
        // Renewed while this one waited for the lock: use the new token.
        if (current.access != used.access) return current

        // Never retried: a refresh rotates the token, so a lost answer is
        // reported rather than replayed into a reuse.
        val out = Outgoing(
            route = REFRESH_ROUTE,
            method = HttpMethod.Post,
            path = REFRESH_PATH,
            query = emptyList(),
            body = Wire.json.encodeToString(RefreshRequest.serializer(), RefreshRequest(current.refresh)),
            authenticated = false,
            idempotency = Idempotency.NONE,
        )
        val reply = transmit(out, token = null, requestId = requestId())
        val receivedAt = clock.nowMillis()
        if (reply.status in 200..299) {
            val pair = decode(reply.body, TokenPair.serializer())
            if (!tokens.rotate(current.refresh, pair, receivedAt, reply.headers[HttpHeaders.Date]?.let(::parseHttpDate))) {
                // Signed out (or in as someone else) while the refresh was out.
                throw ApiError.Unauthorized(null)
            }
            diag.info(AREA, "session renewed")
            return tokens.tokens() ?: throw ApiError.Unauthorized(null)
        }
        val problem = problemOf(reply)
        if (reply.status == STATUS_UNAUTHORIZED) {
            endSession(current, problem)
            throw ApiError.Unauthorized(problem)
        }
        if (reply.status == STATUS_FORBIDDEN && problem.code in ProblemCodes.ACCOUNT_STATE) {
            // A banned, suspended or deleted account still gets a pair, with
            // a restricted scope: the account's own routes keep working.
            val restricted = runCatching { Wire.json.decodeFromJsonElement(TokenPair.serializer(), problem.members) }.getOrNull()
            if (restricted != null && tokens.rotate(current.refresh, restricted, receivedAt, reply.headers[HttpHeaders.Date]?.let(::parseHttpDate))) {
                diag.info(AREA, "session renewed with a restricted scope (${problem.code})")
                return tokens.tokens() ?: throw ApiError.Unauthorized(null)
            }
        }
        throw failure(REFRESH_ROUTE, reply.status, problem)
    }

    /** Forgets [session] if it is still the one in hand, and says so. Stored answers go with it. */
    private suspend fun endSession(session: StoredTokens, problem: Problem?) {
        if (tokens.clear(ifRefresh = session.refresh)) {
            diag.warn(AREA, "session ended by the server (${problem?.code ?: "-"})")
            clearCache()
            _events.tryEmit(ApiEvent.SessionLost)
        }
    }

    private suspend fun transmit(out: Outgoing, token: String?, requestId: String): Incoming {
        val url = buildString {
            append(base)
            append('/')
            append(out.path.trimStart('/'))
            if (out.query.isNotEmpty()) {
                append('?')
                append(out.query.joinToString("&") { (k, v) -> "${k.encodeURLParameter()}=${v.encodeURLParameter()}" })
            }
        }
        return try {
            val response = http.request(url) {
                method = out.method
                header(HttpHeaders.Accept, ContentType.Application.Json.toString())
                header(HttpHeaders.AcceptLanguage, language())
                header(CLIENT_HEADER, clientHeader)
                header(REQUEST_ID_HEADER, requestId)
                if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
                out.ifNoneMatch?.let { header(HttpHeaders.IfNoneMatch, it) }
                out.body?.let { setBody(TextContent(it, ContentType.Application.Json)) }
            }
            Incoming(response.status.value, response.bodyAsText(), response.headers)
        } catch (e: CancellationException) {
            // The caller going away, not the network failing: wrapping it
            // would turn a closed screen into an error message.
            throw e
        } catch (e: Exception) {
            throw ApiError.Network(e)
        }
    }

    private fun problemOf(reply: Incoming): Problem =
        Problem.parse(reply.status, reply.body, reply.headers[HttpHeaders.RetryAfter])

    /** 502 and 504 from an edge, and a 503 without a reason the server chose. */
    private fun isGatewayFailure(status: Int, problem: Problem): Boolean = when (status) {
        502, 504 -> true
        503 -> problem.code == null || problem.code == ProblemCodes.SERVICE_UNAVAILABLE
        else -> false
    }

    private fun failure(route: String, status: Int, problem: Problem): ApiError {
        diag.info(AREA, "$route: $status ${problem.code ?: "-"}")
        when {
            status == 426 -> _events.tryEmit(ApiEvent.UpgradeRequired(problem.minVersionCode))
            status == 503 && problem.code == ProblemCodes.MAINTENANCE -> _events.tryEmit(ApiEvent.Maintenance(problem.message))
        }
        return ApiError.Http(status, problem)
    }

    private fun <T> decode(text: String, serializer: KSerializer<T>): T =
        try {
            Wire.json.decodeFromString(serializer, text)
        } catch (e: SerializationException) {
            throw ApiError.Decoding(e)
        } catch (e: IllegalArgumentException) {
            throw ApiError.Decoding(e)
        }

    private fun <T> decodeOrNull(text: String, serializer: KSerializer<T>): T? =
        runCatching { Wire.json.decodeFromString(serializer, text) }.getOrNull()

    private suspend fun readCache(key: String): CachedResponse? =
        runCatchingUnlessCancelled { cache.read(key) }.getOrElse {
            diag.warn(AREA, "cache read failed: ${it.javaClass.simpleName}")
            null
        }

    /** A cache that fails never fails the request it serves. */
    private suspend fun guardCache(what: String, block: suspend () -> Unit) {
        runCatchingUnlessCancelled { block() }.onFailure { diag.warn(AREA, "cache $what failed: ${it.javaClass.simpleName}") }
    }

    private fun requestId(): String = buildString(16) {
        repeat(16) { append(HEX[random.nextInt(16)]) }
    }

    companion object {
        const val CLIENT_HEADER = "X-Client"
        const val REQUEST_ID_HEADER = "X-Request-Id"
        const val WRITE_LAG_HEADER = "X-Write-Lag-Ms"

        /** Renew this long before the deadline, so a request in flight does not carry a token that lapses on the way. */
        const val RENEW_AHEAD_MS = 60_000L

        internal const val REFRESH_ROUTE = "auth.refresh"
        internal const val REFRESH_PATH = "v1/auth/refresh"

        private const val AREA = "Http"
        private const val STATUS_NOT_MODIFIED = 304
        private const val STATUS_UNAUTHORIZED = 401
        private const val STATUS_FORBIDDEN = 403
        private const val HEX = "0123456789abcdef"

        /** Never logged, even by URL: sign-in, tokens, the phone, purchases, the position. */
        private val UNLOGGED_PATHS = listOf(
            "/v1/auth/",
            "/v1/me/phone/",
            "/v1/me/location",
            "/v1/realtime/token",
            "/v1/calls/",
            "/v1/devices/",
            "/v1/store/",
            "/v1/public/",
        )

        /** `X-Client` for this build: `<store>/<versionCode>`. */
        fun clientHeader(store: String, versionCode: Int): String = "$store/$versionCode"
    }
}

private fun List<Pair<String, String?>>.present(): List<Pair<String, String>> =
    mapNotNull { (k, v) -> v?.let { k to it } }

private fun parseHttpDate(value: String): Long? =
    runCatching { ZonedDateTime.parse(value.trim(), DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() }.getOrNull()
