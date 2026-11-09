package app.core.net.origins

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a fetch of the origins document sends and reads: nothing but `Accept` and `If-None-Match`, no redirects, a size cap. */
class KtorOriginsTransportTest {

    private val requests = mutableListOf<HttpRequestData>()

    @Test
    fun aFetchCarriesNoSessionNoClientHeaderAndNoCookie() = runTest {
        val engine = MockEngine { request ->
            requests += request
            respond("{}", HttpStatusCode.OK, headersOf(HttpHeaders.ETag, "\"o7\""))
        }
        val transport = KtorOriginsTransport(engine)
        val copy = transport.get("https://copy.test/origins.json", ifNoneMatch = null)
        val api = transport.get("https://api.test/v1/origins", ifNoneMatch = "\"o6\"")
        assertEquals(200, copy.status)
        assertEquals("\"o7\"", copy.etag)
        assertEquals("{}", api.body)

        val names = requests.map { request -> request.headers.names().map { it.lowercase() }.toSet() }
        assertEquals(setOf("accept"), names[0] - setOf("accept-charset"))
        assertEquals(setOf("accept", "if-none-match"), names[1] - setOf("accept-charset"))
        for (request in requests) {
            assertNull(request.headers[HttpHeaders.Authorization])
            assertNull(request.headers[HttpHeaders.Cookie])
            assertNull(request.headers["X-Client"])
        }
    }

    @Test
    fun aRedirectIsNotFollowed() = runTest {
        val engine = MockEngine { request ->
            requests += request
            respond("", HttpStatusCode.TemporaryRedirect, headersOf(HttpHeaders.Location, "https://elsewhere.test/origins.json"))
        }
        val answer = KtorOriginsTransport(engine).get("https://copy.test/origins.json", null)
        assertEquals(307, answer.status)
        assertEquals(listOf("copy.test"), requests.map { it.url.host })
    }

    @Test
    fun aBodyLargerThanAnyDocumentIsNotRead() = runTest {
        val big = "x".repeat(KtorOriginsTransport.MAX_BODY_BYTES.toInt() + 1)
        val engine = MockEngine { respond(big, HttpStatusCode.OK) }
        assertNull(KtorOriginsTransport(engine).get("https://copy.test/origins.json", null).body)
        val engineWithoutLength = MockEngine { respond(io.ktor.utils.io.ByteReadChannel(big.toByteArray()), HttpStatusCode.OK) }
        assertNull(KtorOriginsTransport(engineWithoutLength).get("https://copy.test/origins.json", null).body)
    }

    @Test
    fun theApisOwnProblemDocumentIsRecognised() = runTest {
        val engine = MockEngine {
            respond("""{"code":"service_unavailable"}""", HttpStatusCode.ServiceUnavailable, headersOf(HttpHeaders.ContentType, "application/problem+json"))
        }
        val answer = KtorOriginsTransport(engine).get("https://api.test/v1/origins", null)
        assertEquals(503, answer.status)
        assertTrue(answer.problem)
    }
}
