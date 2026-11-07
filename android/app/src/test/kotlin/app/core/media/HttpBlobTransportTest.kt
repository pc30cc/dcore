package app.core.media

import app.core.model.UploadTarget
import app.core.net.ApiError
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

/** The presigned PUT: the signed headers, the exact bytes, and nothing of the API's session. */
class HttpBlobTransportTest {

    private val target = UploadTarget(
        url = "https://storage.example.com/private/u/1287390234923410099?X-Amz-Signature=abc",
        method = "PUT",
        headers = mapOf("Content-Type" to "image/jpeg", "Content-Length" to "4", "x-amz-meta-photo" to "1287390234923410099"),
    )

    @Test
    fun putSendsTheBytesWithTheSignedHeadersOnly() = runTest {
        val body = byteArrayOf(1, 2, 3, 4)
        val engine = MockEngine { request ->
            assertEquals(HttpMethod.Put, request.method)
            assertEquals(target.url, request.url.toString())
            assertEquals("1287390234923410099", request.headers["x-amz-meta-photo"])
            assertNull("no session on a storage upload", request.headers[HttpHeaders.Authorization])
            assertNull(request.headers["X-Client"])
            assertEquals("image/jpeg", request.body.contentType?.toString())
            assertArrayEquals(body, request.body.toByteArray())
            respond("", HttpStatusCode.OK)
        }
        var last = 0f
        HttpBlobTransport(engine).put(target, body, "image/jpeg") { last = it }
        assertEquals(1f, last)
    }

    @Test
    fun aRefusalIsAnHttpErrorAndNoAnswerIsANetworkError() = runTest {
        val refused = MockEngine { respond("<Error>SignatureDoesNotMatch</Error>", HttpStatusCode.Forbidden) }
        try {
            HttpBlobTransport(refused).put(target, byteArrayOf(1, 2, 3, 4), "image/jpeg")
            fail("expected a refusal")
        } catch (e: ApiError.Http) {
            assertEquals(403, e.status)
        }
        val down = MockEngine { throw java.io.IOException("connection reset") }
        try {
            HttpBlobTransport(down).put(target, byteArrayOf(1, 2, 3, 4), "image/jpeg")
            fail("expected no answer")
        } catch (e: ApiError.Network) {
            // retried by PhotoUploader with the same ticket
        }
    }
}
