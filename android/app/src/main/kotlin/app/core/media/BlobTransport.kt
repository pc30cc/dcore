package app.core.media

import app.core.model.Problem
import app.core.model.UploadTarget
import app.core.net.ApiError
import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.onUpload
import io.ktor.client.request.headers
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.content.ByteArrayContent
import io.ktor.http.isSuccess
import kotlinx.coroutines.CancellationException

/**
 * Where an upload's bytes go: the presigned URL the server handed out, never
 * the API itself. Nothing of the session travels with it (no
 * `Authorization`, no client headers): the URL's signature is the only
 * credential, and it names the photo, never the person.
 */
interface BlobTransport {
    /**
     * Sends [body] to [target] with the headers the server signed.
     * [onProgress] gets 0..1 as bytes leave the phone. Throws [ApiError] on
     * failure ([ApiError.Network] when there was no answer).
     */
    suspend fun put(target: UploadTarget, body: ByteArray, contentType: String, onProgress: (Float) -> Unit = {})
}

/** [BlobTransport] over plain HTTP(S), on its own client so no API header or token can leak into it. */
class HttpBlobTransport(engine: HttpClientEngine) : BlobTransport {

    private val http = HttpClient(engine) {
        expectSuccess = false
        install(HttpTimeout) {
            connectTimeoutMillis = 15_000
            // A slow uplink moves a 1-2 MB photo in well under this.
            requestTimeoutMillis = 120_000
            socketTimeoutMillis = 30_000
        }
    }

    override suspend fun put(target: UploadTarget, body: ByteArray, contentType: String, onProgress: (Float) -> Unit) {
        val answer = try {
            http.request(target.url) {
                method = HttpMethod.parse(target.method.uppercase())
                headers {
                    target.headers.forEach { (name, value) ->
                        // Content-Type travels with the body, below; the length and host are the
                        // engine's to set (the body is exactly the size the ticket was asked for).
                        if (ENGINE_HEADERS.none { it.equals(name, ignoreCase = true) }) append(name, value)
                    }
                }
                val type = target.headers.entries.firstOrNull { it.key.equals("Content-Type", ignoreCase = true) }?.value ?: contentType
                setBody(ByteArrayContent(body, ContentType.parse(type)))
                onUpload { sent, total ->
                    val all = total ?: body.size.toLong()
                    if (all > 0) onProgress((sent.toFloat() / all).coerceIn(0f, 1f))
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            throw ApiError.Network(error)
        }
        if (!answer.status.isSuccess()) {
            // Storage answers in XML or plain text: keep the status, not the body.
            runCatching { answer.bodyAsText() }
            throw ApiError.Http(answer.status.value, Problem(status = answer.status.value, code = null))
        }
        onProgress(1f)
    }

    private companion object {
        val ENGINE_HEADERS = listOf("Content-Type", "Content-Length", "Host", "Transfer-Encoding")
    }
}
