package app.core.net

import app.core.diag.Diag
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

class ApiClientTest {

    private val requests = mutableListOf<HttpRequestData>()
    private val cache = MemoryResponseCache()
    private var token: String? = "access-1"
    private var now = 1_000L

    private fun client(handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData): ApiClient {
        val engine = MockEngine { request ->
            requests += request
            handler(request)
        }
        return ApiClient(
            baseUrl = "https://api.test/",
            tokens = { token },
            cache = cache,
            engine = engine,
            clientDescriptor = "android; store=test; version=1.0; build=1",
            language = { "fa" },
            diag = Diag.Silent,
            clock = { now },
        )
    }

    private val json = headersOf(HttpHeaders.ContentType, "application/json")

    @Test
    fun `every request carries the bearer token, the client and the language`() = runTest {
        val api = client { respond("""{"appName":"Example"}""", HttpStatusCode.OK, json) }
        assertEquals("Example", api.config().appName)
        val request = requests.single()
        assertEquals("https://api.test/config", request.url.toString())
        assertEquals("Bearer access-1", request.headers[HttpHeaders.Authorization])
        assertEquals("android; store=test; version=1.0; build=1", request.headers[ApiClient.CLIENT_HEADER])
        assertEquals("fa", request.headers[HttpHeaders.AcceptLanguage])
    }

    @Test
    fun `no token means no Authorization header`() = runTest {
        token = null
        val api = client { respond("{}", HttpStatusCode.OK, json) }
        api.config()
        assertNull(requests.single().headers[HttpHeaders.Authorization])
    }

    @Test
    fun `an unchanged document is revalidated with its ETag and served from the cache`() = runTest {
        val api = client { request ->
            if (request.headers[HttpHeaders.IfNoneMatch] == "\"v1\"") {
                respond("", HttpStatusCode.NotModified)
            } else {
                respond(
                    """{"appName":"Example","features":{"social":true}}""",
                    HttpStatusCode.OK,
                    headersOf(HttpHeaders.ContentType to listOf("application/json"), HttpHeaders.ETag to listOf("\"v1\"")),
                )
            }
        }
        val first = api.config()
        now = 5_000L
        val second = api.config()

        assertEquals(first, second)
        assertEquals(true, second.features["social"])
        assertNull(requests[0].headers[HttpHeaders.IfNoneMatch])
        assertEquals("\"v1\"", requests[1].headers[HttpHeaders.IfNoneMatch])
        // The 304 refreshed the stored copy's age, not its body.
        assertEquals(5_000L, cache.read(ApiClient.CONFIG_CACHE_KEY)?.storedAtMillis)
        assertEquals(first, api.cachedConfig())
    }

    @Test
    fun `unknown fields from a newer server are ignored`() = runTest {
        val api = client { respond("""{"appName":"Example","somethingNew":{"a":1}}""", HttpStatusCode.OK, json) }
        assertEquals("Example", api.config().appName)
    }

    @Test
    fun `a 401 ends the session and says so`() = runTest {
        val api = client { respond("""{"error":{"code":"token_expired"}}""", HttpStatusCode.Unauthorized, json) }
        var signalled = false
        val watcher = launch { api.unauthorized.first(); signalled = true }
        yield()
        try {
            api.config()
            fail("expected Unauthorized")
        } catch (e: ApiError.Unauthorized) {
            assertEquals("token_expired", e.code)
        }
        watcher.join()
        assertTrue(signalled)
    }

    @Test
    fun `a server error carries its status and code`() = runTest {
        val api = client { respond("""{"code":"maintenance"}""", HttpStatusCode.ServiceUnavailable, json) }
        try {
            api.config()
            fail("expected Http")
        } catch (e: ApiError.Http) {
            assertEquals(503, e.status)
            assertEquals("maintenance", e.code)
        }
        assertNull("a failure is never cached", cache.read(ApiClient.CONFIG_CACHE_KEY))
    }

    @Test
    fun `no answer is a network error`() = runTest {
        val api = client { throw IOException("unreachable") }
        try {
            api.config()
            fail("expected Network")
        } catch (e: ApiError.Network) {
            assertTrue(e.cause is IOException)
        }
    }

    @Test
    fun `a body in the wrong shape is a decoding error, not a crash`() = runTest {
        val api = client { respond("""{"features":"not-a-map"}""", HttpStatusCode.OK, json) }
        try {
            api.config()
            fail("expected Decoding")
        } catch (e: ApiError.Decoding) {
            assertFalse(e.message.isNullOrEmpty())
        }
    }
}
