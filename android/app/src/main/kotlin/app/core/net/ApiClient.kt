package app.core.net

import app.core.BuildConfig
import app.core.diag.Diag
import app.core.storage.AccessTokenSource
import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logger
import io.ktor.client.plugins.logging.Logging
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.io.IOException

/**
 * The app's one funnel to the REST API (Ktor on OkHttp).
 *
 * Every request goes through [send]: the base URL, the bearer token, the
 * client and language headers, timeouts and the status mapping into [ApiError]
 * are in one place, and nothing else in the app builds a URL.
 *
 * **Few requests, cheap requests.** A GET that names a cache key is stored
 * with its `ETag`; the next one asks `If-None-Match`, and a 304 is answered
 * from the stored body. Together with showing the stored copy first, that is
 * what keeps an app launch from costing the database anything when nothing
 * changed.
 *
 * Bodies are encoded and decoded with explicit serializers, never by
 * reflection, so R8 can rename freely (see proguard-rules.pro).
 */
class ApiClient(
    baseUrl: String,
    private val tokens: AccessTokenSource,
    private val cache: ResponseCache,
    engine: HttpClientEngine,
    /** `X-Client`: platform, store and version, so the server can tell builds apart (minimum version, store rules). */
    private val clientDescriptor: String,
    /** The language the person reads, for server-rendered texts. */
    private val language: () -> String,
    private val diag: Diag = Diag.Android,
    /** Header-level request logging, debug builds only. Never bodies. */
    private val debugLog: ((String) -> Unit)? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val base = baseUrl.trimEnd('/')

    val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
    }

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
                // Headers, never bodies: a body is a message, a phone number
                // or a one-time code.
                level = LogLevel.HEADERS
                sanitizeHeader { name -> name.equals(HttpHeaders.Authorization, ignoreCase = true) }
                // Sign-in is not logged at all, even its URL.
                filter { request -> "auth" !in request.url.pathSegments }
            }
        }
    }

    private val _unauthorized = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Emits when the server rejects the session (401): the app signs out. */
    val unauthorized: Flow<Unit> = _unauthorized.asSharedFlow()

    // MARK: - Endpoints

    /** `GET /config`, revalidated with its ETag. */
    suspend fun config(): ClientConfig = get("config", ClientConfig.serializer(), cacheKey = CONFIG_CACHE_KEY)

    /** The last `GET /config` this phone stored, without a request: what a cold start shows first. */
    suspend fun cachedConfig(): ClientConfig? = cached(CONFIG_CACHE_KEY, ClientConfig.serializer())

    // MARK: - Funnel

    /**
     * GET [path] (relative to the base URL) and decode it with [serializer].
     *
     * With a [cacheKey] the answer is stored and later revalidated; a 304 is
     * served from the stored copy. The key must say whose answer it is when
     * the answer is personal (`me:<accountId>`), so one account never reads
     * another's cached copy.
     */
    suspend fun <T> get(path: String, serializer: KSerializer<T>, cacheKey: String? = null): T {
        val stored = cacheKey?.let { key -> cache.read(key)?.let { key to it } }
        val response = send(HttpMethod.Get, path) {
            stored?.second?.etag?.let { header(HttpHeaders.IfNoneMatch, it) }
        }
        if (response.status == HttpStatusCode.NotModified && stored != null) {
            val (key, copy) = stored
            cache.touch(key, clock())
            return decode(copy.body, serializer)
        }
        val body = successBody(response)
        val value = decode(body, serializer)
        if (cacheKey != null) {
            cache.write(cacheKey, CachedResponse(response.headers[HttpHeaders.ETag], body, clock()))
        }
        return value
    }

    /** The stored answer for [cacheKey], or null; never a request. */
    suspend fun <T> cached(cacheKey: String, serializer: KSerializer<T>): T? {
        val stored = cache.read(cacheKey) ?: return null
        return runCatching { json.decodeFromString(serializer, stored.body) }
            .onFailure { diag.warn(AREA, "stored copy of '$cacheKey' no longer decodes; dropped") }
            .getOrElse {
                cache.remove(cacheKey)
                null
            }
    }

    /** POST [body] as JSON to [path] and decode the answer. */
    suspend fun <B, T> post(
        path: String,
        body: B,
        bodySerializer: KSerializer<B>,
        responseSerializer: KSerializer<T>,
    ): T {
        val response = send(HttpMethod.Post, path) {
            contentType(ContentType.Application.Json)
            setBody(json.encodeToString(bodySerializer, body))
        }
        return decode(successBody(response), responseSerializer)
    }

    private suspend fun send(method: HttpMethod, path: String, configure: HttpRequestBuilder.() -> Unit): HttpResponse {
        val token = tokens.accessToken()
        return try {
            http.request("$base/${path.trimStart('/')}") {
                this.method = method
                header(HttpHeaders.Accept, ContentType.Application.Json.toString())
                header(HttpHeaders.AcceptLanguage, language())
                header(CLIENT_HEADER, clientDescriptor)
                if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
                configure()
            }
        } catch (e: IOException) {
            diag.info(AREA, "${method.value} ${path.substringBefore('?')}: no answer (${e.javaClass.simpleName})")
            throw ApiError.Network(e)
        }
    }

    private suspend fun successBody(response: HttpResponse): String {
        val text = try {
            response.bodyAsText()
        } catch (e: IOException) {
            throw ApiError.Network(e)
        }
        if (response.status.isSuccess()) return text
        val code = errorCode(text)
        diag.info(AREA, "${response.call.request.method.value} ${response.call.request.url.encodedPath}: ${response.status.value}")
        if (response.status == HttpStatusCode.Unauthorized) {
            _unauthorized.tryEmit(Unit)
            throw ApiError.Unauthorized(code)
        }
        throw ApiError.Http(response.status.value, code)
    }

    private fun <T> decode(text: String, serializer: KSerializer<T>): T =
        try {
            json.decodeFromString(serializer, text)
        } catch (e: SerializationException) {
            throw ApiError.Decoding(e)
        } catch (e: IllegalArgumentException) {
            throw ApiError.Decoding(e)
        }

    /**
     * The server's error code from a failure body, best effort: `{"code": …}`
     * or `{"error": {"code": …}}` or `{"error": "…"}`. Null for anything else.
     */
    private fun errorCode(text: String): String? = runCatching {
        val root = json.parseToJsonElement(text).jsonObject
        (root["code"] as? JsonPrimitive)?.content
            ?: ((root["error"] as? JsonObject)?.get("code") as? JsonPrimitive)?.content
            ?: (root["error"] as? JsonPrimitive)?.content
    }.getOrNull()?.take(MAX_ERROR_CODE)

    fun close() = http.close()

    companion object {
        const val CLIENT_HEADER = "X-Client"
        const val CONFIG_CACHE_KEY = "config"
        private const val AREA = "Http"
        private const val MAX_ERROR_CODE = 64
    }
}
