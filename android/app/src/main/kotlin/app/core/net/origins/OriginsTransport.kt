package app.core.net.origins

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.header
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentLength
import io.ktor.utils.io.readBuffer
import kotlinx.io.readByteArray

/** One answer to a GET of the origins document. */
class OriginsFetch(
    val status: Int,
    /** The body as text; null when it was larger than any document can be. */
    val body: String?,
    val etag: String?,
    /** `Content-Type` was a problem document: the API itself answered. */
    val problem: Boolean,
)

/**
 * GETs the origins document from an API host (`/v1/origins`) or a published
 * copy. Throws when there is no answer (DNS, connection, TLS, timeout).
 */
fun interface OriginsTransport {
    suspend fun get(url: String, ifNoneMatch: String?): OriginsFetch
}

/**
 * [OriginsTransport] on Ktor. The request carries `Accept` and, to an API
 * host, `If-None-Match`, and nothing else: no session, no client or language
 * header, no cookies. Redirects are not followed, every request gives up after
 * [timeoutMillis], and a body is read up to [MAX_BODY_BYTES] only.
 */
class KtorOriginsTransport(engine: HttpClientEngine, private val timeoutMillis: Long = TIMEOUT_MS) : OriginsTransport {

    private val http = HttpClient(engine) {
        expectSuccess = false
        followRedirects = false
        install(HttpTimeout) {
            requestTimeoutMillis = timeoutMillis
            connectTimeoutMillis = timeoutMillis
            socketTimeoutMillis = timeoutMillis
        }
    }

    override suspend fun get(url: String, ifNoneMatch: String?): OriginsFetch =
        http.prepareGet(url) {
            header(HttpHeaders.Accept, ContentType.Application.Json.toString())
            if (ifNoneMatch != null) header(HttpHeaders.IfNoneMatch, ifNoneMatch)
        }.execute { response ->
            val status = response.status.value
            val type = response.headers[HttpHeaders.ContentType].orEmpty()
            val declared = response.contentLength()
            val body = if (declared != null && declared > MAX_BODY_BYTES) {
                null
            } else {
                val bytes = response.bodyAsChannel().readBuffer(MAX_BODY_BYTES + 1).readByteArray()
                if (bytes.size > MAX_BODY_BYTES) null else bytes.decodeToString()
            }
            OriginsFetch(status, body, response.headers[HttpHeaders.ETag], type.contains("problem+json", ignoreCase = true))
        }

    fun close() = http.close()

    companion object {
        const val TIMEOUT_MS = 10_000L
        const val MAX_BODY_BYTES = 64 * 1024L
    }
}
