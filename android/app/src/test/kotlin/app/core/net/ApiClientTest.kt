package app.core.net

import app.core.common.Diag
import app.core.common.FakeClock
import app.core.model.AccountStatus
import app.core.model.AuthResult
import app.core.model.AuthUser
import app.core.model.ProblemCodes
import app.core.storage.MemorySecretStore
import app.core.storage.SessionStore
import app.core.testing.Fixtures
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.Serializable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

@OptIn(ExperimentalCoroutinesApi::class)
class ApiClientTest {

    @Serializable
    data class Doc(val n: Int, val name: String = "")

    @Serializable
    data class Note(val text: String)

    private val clock = FakeClock()
    private val secrets = MemorySecretStore()
    private val session = SessionStore(secrets, clock, Diag.Silent)
    private val cache = MemoryResponseCache()
    private val requests = mutableListOf<HttpRequestData>()
    private val waits = mutableListOf<Long>()
    private val events = mutableListOf<ApiEvent>()

    private val json = headersOf(HttpHeaders.ContentType, "application/json")

    private fun TestScope.client(
        retry: RetryPolicy = RetryPolicy(),
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): ApiClient {
        val engine = MockEngine { request ->
            synchronized(requests) { requests += request }
            handler(request)
        }
        val api = ApiClient(
            baseUrl = "https://api.test/",
            tokens = session,
            cache = cache,
            engine = engine,
            clientHeader = ApiClient.clientHeader("bazaar", 12031),
            language = { "fa" },
            diag = Diag.Silent,
            clock = clock,
            retry = retry,
            random = Random(7),
            pause = { waits += it },
        )
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { api.events.collect { events += it } }
        return api
    }

    private suspend fun signIn(access: String = "at-1", refresh: String = "rt-1", ttlSeconds: Long = 900) {
        session.signIn(
            AuthResult(access, clock.now().plusSeconds(ttlSeconds), refresh, null, AuthUser("aaaaaaaaaaaaa", AccountStatus.Active, 0)),
            receivedAtMillis = clock.nowMillis(),
        )
    }

    private fun HttpRequestData.bearer(): String? = headers[HttpHeaders.Authorization]?.removePrefix("Bearer ")
    private fun HttpRequestData.bodyText(): String? = (body as? TextContent)?.text
    private fun HttpRequestData.path(): String = url.encodedPath

    private fun MockRequestHandleScope.ok(body: String, vararg extra: Pair<String, String>) =
        respond(body, HttpStatusCode.OK, headersOf(*(listOf(HttpHeaders.ContentType to listOf("application/json")) + extra.map { it.first to listOf(it.second) }).toTypedArray()))

    private fun MockRequestHandleScope.problem(status: HttpStatusCode, code: String, vararg members: String) =
        respond(
            """{"status":${status.value},"code":"$code"${members.joinToString("") { ",$it" }}}""",
            status,
            headersOf(HttpHeaders.ContentType, "application/problem+json"),
        )

    private val tokenPair = Fixtures.text("token-pair")

    // MARK: - Headers

    @Test
    fun everyRequestCarriesTheSessionTheClientAndTheLanguage() = runTest {
        signIn()
        val api = client { ok("""{"n":1}""") }
        assertEquals(1, api.get("me", "v1/me", Doc.serializer()).value.n)
        val request = requests.single()
        assertEquals("https://api.test/v1/me", request.url.toString())
        assertEquals("at-1", request.bearer())
        assertEquals("bazaar/12031", request.headers[ApiClient.CLIENT_HEADER])
        assertEquals("fa", request.headers[HttpHeaders.AcceptLanguage])
        assertTrue(Regex("[0-9a-f]{16}").matches(request.headers[ApiClient.REQUEST_ID_HEADER]!!))
    }

    @Test
    fun aPublicRouteNeverCarriesTheSession() = runTest {
        signIn()
        val api = client { ok("""{"n":1}""") }
        api.get("config", "v1/config", Doc.serializer(), listOf("store" to "bazaar", "locale" to "fa", "skip" to null), authenticated = false)
        val request = requests.single()
        assertNull(request.headers[HttpHeaders.Authorization])
        assertEquals("bazaar", request.url.parameters["store"])
        assertNull("a null query value is left out", request.url.parameters["skip"])
    }

    @Test
    fun withoutASessionAPrivateRouteFailsWithoutARequest() = runTest {
        val api = client { ok("{}") }
        try {
            api.get("me", "v1/me", Doc.serializer())
            fail("expected Unauthorized")
        } catch (e: ApiError.Unauthorized) {
            assertNull(e.problem)
        }
        assertTrue(requests.isEmpty())
        assertTrue("no session, nothing lost", events.isEmpty())
    }

    // MARK: - ETag

    @Test
    fun anUnchangedAnswerIsRevalidatedAndServedFromTheStoredCopy() = runTest {
        signIn()
        val api = client { request ->
            if (request.headers[HttpHeaders.IfNoneMatch] == "\"v1\"") {
                respond("", HttpStatusCode.NotModified)
            } else {
                ok("""{"n":1,"name":"first"}""", HttpHeaders.ETag to "\"v1\"")
            }
        }
        val first = api.revalidate("me", "v1/me", Doc.serializer(), cacheKey = "u:a:me")
        clock.advance(5_000)
        val second = api.revalidate("me", "v1/me", Doc.serializer(), cacheKey = "u:a:me")

        assertTrue(first.changed)
        assertFalse("a 304 is reported as unchanged", second.changed)
        assertEquals(first.value, second.value)
        assertNull(requests[0].headers[HttpHeaders.IfNoneMatch])
        assertEquals("\"v1\"", requests[1].headers[HttpHeaders.IfNoneMatch])
        assertEquals("the 304 refreshed the copy's age", clock.millis, cache.read("u:a:me")?.storedAtMillis)
        assertEquals(first.value, api.cached("u:a:me", Doc.serializer()))
    }

    @Test
    fun aChangedAnswerReplacesTheStoredCopyAndItsValidator() = runTest {
        signIn()
        var version = 1
        val api = client { request ->
            val etag = "\"v$version\""
            if (request.headers[HttpHeaders.IfNoneMatch] == etag) respond("", HttpStatusCode.NotModified) else ok("""{"n":$version}""", HttpHeaders.ETag to etag)
        }
        api.revalidate("me", "v1/me", Doc.serializer(), cacheKey = "k")
        version = 2
        val changed = api.revalidate("me", "v1/me", Doc.serializer(), cacheKey = "k")
        assertTrue(changed.changed)
        assertEquals(2, changed.value.n)
        assertEquals("\"v2\"", cache.read("k")?.etag)
    }

    @Test
    fun aStoredCopyThatNoLongerDecodesIsDroppedAndAskedForAgain() = runTest {
        signIn()
        cache.write("k", CachedResponse("\"v1\"", """{"shape":"old"}""", 0))
        val api = client { request ->
            if (request.headers[HttpHeaders.IfNoneMatch] != null) respond("", HttpStatusCode.NotModified) else ok("""{"n":3}""", HttpHeaders.ETag to "\"v1\"")
        }
        val fetched = api.revalidate("me", "v1/me", Doc.serializer(), cacheKey = "k")
        assertEquals(3, fetched.value.n)
        assertTrue(fetched.changed)
        assertEquals(2, requests.size)
        assertNull("the second ask carries no validator", requests[1].headers[HttpHeaders.IfNoneMatch])
    }

    @Test
    fun aFailureIsNeverStored() = runTest {
        signIn()
        val api = client { problem(HttpStatusCode.NotFound, ProblemCodes.NOT_FOUND) }
        runCatching { api.revalidate("me", "v1/me", Doc.serializer(), cacheKey = "k") }
        assertNull(cache.read("k"))
    }

    // MARK: - Sessions

    @Test
    fun a401RenewsTheSessionOnceAndReplaysTheRequest() = runTest {
        signIn()
        val api = client { request ->
            when {
                request.path() == "/v1/auth/refresh" -> ok(tokenPair)
                request.bearer() == "at-1" -> problem(HttpStatusCode.Unauthorized, ProblemCodes.TOKEN_EXPIRED)
                else -> ok("""{"n":2}""")
            }
        }
        assertEquals(2, api.get("me", "v1/me", Doc.serializer()).value.n)

        assertEquals(listOf("/v1/me", "/v1/auth/refresh", "/v1/me"), requests.map { it.path() })
        val refresh = requests[1]
        assertEquals(HttpMethod.Post, refresh.method)
        assertNull("the refresh token is the credential, not a bearer", refresh.headers[HttpHeaders.Authorization])
        assertEquals("""{"refreshToken":"rt-1"}""", refresh.bodyText())
        assertEquals("eyJhbGciOiJFZERTQSJ9.e30.new", requests[2].bearer())
        assertEquals(
            "one request id across the replay",
            requests[0].headers[ApiClient.REQUEST_ID_HEADER],
            requests[2].headers[ApiClient.REQUEST_ID_HEADER],
        )
        val stored = session.tokens()!!
        assertEquals("rt1.1287390234923401.YmFy", stored.refresh)
        // Both tokens in one sealed value: a rotation can never leave them out of step.
        assertEquals(setOf("session.tokens"), secrets.storedSecrets.keys)
        assertTrue(events.isEmpty())
    }

    @Test
    fun concurrentRequestsShareOneRefresh() = runTest {
        signIn()
        val refreshes = AtomicInteger()
        val api = client { request ->
            when {
                request.path() == "/v1/auth/refresh" -> {
                    refreshes.incrementAndGet()
                    ok(tokenPair)
                }
                request.bearer() == "at-1" -> problem(HttpStatusCode.Unauthorized, ProblemCodes.TOKEN_EXPIRED)
                else -> ok("""{"n":1}""")
            }
        }
        val answers = (1..5).map { async { api.get("me", "v1/me", Doc.serializer()).value.n } }.awaitAll()
        assertEquals(List(5) { 1 }, answers)
        assertEquals("a rotated token is never rotated again by a request that waited", 1, refreshes.get())
    }

    @Test
    fun aRefusedRefreshEndsTheSessionAndSaysSo() = runTest {
        signIn()
        cache.write("u:a:me", CachedResponse(null, "{}", 0))
        val api = client { request ->
            if (request.path() == "/v1/auth/refresh") {
                problem(HttpStatusCode.Unauthorized, ProblemCodes.REFRESH_REUSED)
            } else {
                problem(HttpStatusCode.Unauthorized, ProblemCodes.TOKEN_EXPIRED)
            }
        }
        try {
            api.get("me", "v1/me", Doc.serializer())
            fail("expected Unauthorized")
        } catch (e: ApiError.Unauthorized) {
            assertEquals(ProblemCodes.REFRESH_REUSED, e.code)
        }
        assertNull(session.tokens())
        assertTrue(secrets.storedSecrets.isEmpty())
        assertEquals(listOf<ApiEvent>(ApiEvent.SessionLost), events)
        assertNull("stored answers leave with the session", cache.read("u:a:me"))
    }

    @Test
    fun anUnreachableRefreshKeepsTheSession() = runTest {
        signIn()
        val api = client { request ->
            if (request.path() == "/v1/auth/refresh") throw IOException("offline")
            problem(HttpStatusCode.Unauthorized, ProblemCodes.TOKEN_EXPIRED)
        }
        try {
            api.get("me", "v1/me", Doc.serializer())
            fail("expected Network")
        } catch (e: ApiError.Network) {
            assertTrue(e.cause is IOException)
        }
        assertEquals("rt-1", session.tokens()?.refresh)
        assertTrue(events.isEmpty())
        assertEquals("the refresh is never retried", 1, requests.count { it.path() == "/v1/auth/refresh" })
    }

    @Test
    fun a401ToARenewedTokenEndsTheSessionInsteadOfLooping() = runTest {
        signIn()
        val api = client { request ->
            if (request.path() == "/v1/auth/refresh") ok(tokenPair) else problem(HttpStatusCode.Unauthorized, ProblemCodes.UNAUTHORIZED)
        }
        try {
            api.get("me", "v1/me", Doc.serializer())
            fail("expected Unauthorized")
        } catch (expected: ApiError.Unauthorized) {
        }
        assertEquals(listOf("/v1/me", "/v1/auth/refresh", "/v1/me"), requests.map { it.path() })
        assertNull(session.tokens())
        assertEquals(listOf<ApiEvent>(ApiEvent.SessionLost), events)
    }

    @Test
    fun a401ToATokenAlreadyReplacedSaysNothingAboutTheNewSession() = runTest {
        signIn()
        val api = client { request ->
            if (request.bearer() == "at-1") {
                // Signed out and in again while this request was out.
                signIn(access = "at-9", refresh = "rt-9")
                problem(HttpStatusCode.Unauthorized, ProblemCodes.UNAUTHORIZED)
            } else {
                ok("""{"n":9}""")
            }
        }
        assertEquals(9, api.get("me", "v1/me", Doc.serializer()).value.n)
        assertEquals(0, requests.count { it.path() == "/v1/auth/refresh" })
        assertEquals("rt-9", session.tokens()?.refresh)
        assertTrue(events.isEmpty())
    }

    @Test
    fun aTokenAboutToLapseIsRenewedBeforeTheRequestNotAfterA401() = runTest {
        signIn(ttlSeconds = 900)
        clock.advance(870_000) // 30 s left, inside the 60 s margin
        val api = client { request ->
            when {
                request.path() == "/v1/auth/refresh" -> ok(tokenPair)
                request.bearer() == "at-1" -> problem(HttpStatusCode.Unauthorized, ProblemCodes.TOKEN_EXPIRED)
                else -> ok("""{"n":1}""")
            }
        }
        api.get("me", "v1/me", Doc.serializer())
        assertEquals(listOf("/v1/auth/refresh", "/v1/me"), requests.map { it.path() })
    }

    @Test
    fun aFreshTokenIsNotRenewedEvenWhenTheServerGivesShortOnes() = runTest {
        signIn(ttlSeconds = 40) // shorter than the 60 s margin
        val api = client { request -> if (request.path() == "/v1/auth/refresh") ok(tokenPair) else ok("""{"n":1}""") }
        api.get("me", "v1/me", Doc.serializer())
        assertEquals(listOf("/v1/me"), requests.map { it.path() })
    }

    @Test
    fun aRestrictedAccountGetsALimitedSessionForItsOwnRoutes() = runTest {
        signIn()
        val restricted = """"accessToken":"at-r","accessExpiresAt":"2026-11-06T09:44:03.120Z","refreshToken":"rt-r""""
        val api = client { request ->
            when {
                request.path() == "/v1/auth/refresh" -> problem(HttpStatusCode.Forbidden, ProblemCodes.ACCOUNT_BANNED, restricted, """"reasonText":"Spam"""")
                request.bearer() == "at-1" -> problem(HttpStatusCode.Unauthorized, ProblemCodes.TOKEN_EXPIRED)
                else -> ok("""{"n":5}""")
            }
        }
        assertEquals(5, api.get("me", "v1/me", Doc.serializer()).value.n)
        assertEquals("at-r", requests.last().bearer())
        assertEquals("rt-r", session.tokens()?.refresh)
        assertTrue(events.isEmpty())
    }

    // MARK: - Retries

    @Test
    fun aNonIdempotentCallIsNeverRetried() = runTest {
        signIn()
        val api = client { throw IOException("connection reset") }
        try {
            api.send("swipes", HttpMethod.Post, "v1/swipes", Note("x"), Note.serializer(), Doc.serializer(), Idempotency.NONE)
            fail("expected Network")
        } catch (expected: ApiError.Network) {
        }
        assertEquals(1, requests.size)
        assertTrue(waits.isEmpty())
    }

    @Test
    fun aNonIdempotentCallIsNotRetriedOnAGatewayFailureEither() = runTest {
        signIn()
        val api = client { respond("<html>bad gateway</html>", HttpStatusCode.BadGateway) }
        try {
            api.send("calls.place", HttpMethod.Post, "v1/calls", Note("x"), Note.serializer(), Doc.serializer(), Idempotency.NONE)
            fail("expected Http")
        } catch (e: ApiError.Http) {
            assertEquals(502, e.status)
            assertNull(e.code)
        }
        assertEquals(1, requests.size)
    }

    @Test
    fun aReadIsRetriedWithGrowingWaits() = runTest {
        signIn()
        var failures = 2
        val api = client {
            if (failures-- > 0) throw IOException("timeout")
            ok("""{"n":1}""")
        }
        assertEquals(1, api.get("me", "v1/me", Doc.serializer()).value.n)
        assertEquals(3, requests.size)
        assertEquals(2, waits.size)
        assertTrue("first wait ${waits[0]}", waits[0] in 320..480)
        assertTrue("second wait ${waits[1]}", waits[1] in 640..960)
    }

    @Test
    fun aKeyedPostIsRetriedWithTheSameBodyAndRequestId() = runTest {
        signIn()
        var first = true
        val api = client {
            if (first) {
                first = false
                respond("", HttpStatusCode.GatewayTimeout)
            } else {
                respond("""{"n":1}""", HttpStatusCode.Created, json)
            }
        }
        val answer = api.send("conversations.send", HttpMethod.Post, "v1/conversations/1/messages", Note("hi"), Note.serializer(), Doc.serializer(), Idempotency.KEYED)
        assertEquals(201, answer.status)
        assertEquals(2, requests.size)
        assertEquals(requests[0].bodyText(), requests[1].bodyText())
        assertEquals(requests[0].headers[ApiClient.REQUEST_ID_HEADER], requests[1].headers[ApiClient.REQUEST_ID_HEADER])
    }

    @Test
    fun retriesStopAtTheLimit() = runTest {
        signIn()
        val api = client { respond("", HttpStatusCode.BadGateway) }
        try {
            api.get("me", "v1/me", Doc.serializer())
            fail("expected Http")
        } catch (e: ApiError.Http) {
            assertEquals(502, e.status)
        }
        assertEquals(RetryPolicy().maxAttempts, requests.size)
    }

    @Test
    fun answersTheServerMeantAreNotRetried() = runTest {
        signIn()
        val answers = listOf(
            HttpStatusCode.InternalServerError to ProblemCodes.INTERNAL,
            HttpStatusCode.TooManyRequests to ProblemCodes.RATE_LIMITED,
            HttpStatusCode.ServiceUnavailable to ProblemCodes.SMS_UNAVAILABLE,
            HttpStatusCode.NotFound to ProblemCodes.NOT_FOUND,
            HttpStatusCode.Conflict to ProblemCodes.CONFIRM_REQUIRED,
        )
        for ((status, code) in answers) {
            requests.clear()
            val api = client { problem(status, code) }
            try {
                api.get("me", "v1/me", Doc.serializer())
                fail("expected Http for $code")
            } catch (e: ApiError.Http) {
                assertEquals(code, e.code)
            }
            assertEquals("$code was retried", 1, requests.size)
        }
        assertTrue(waits.isEmpty())
    }

    @Test
    fun aShortRetryAfterIsWaitedOutAndALongOneIsNot() = runTest {
        signIn()
        var first = true
        val short = client {
            if (first) {
                first = false
                respond("", HttpStatusCode.ServiceUnavailable, headersOf(HttpHeaders.RetryAfter, "2"))
            } else {
                ok("""{"n":1}""")
            }
        }
        short.get("me", "v1/me", Doc.serializer())
        assertEquals(listOf(2_000L), waits)

        requests.clear()
        val long = client { respond("", HttpStatusCode.ServiceUnavailable, headersOf(HttpHeaders.RetryAfter, "120")) }
        runCatching { long.get("me", "v1/me", Doc.serializer()) }
        assertEquals(1, requests.size)
    }

    // MARK: - Errors and events

    @Test
    fun maintenanceAndRequiredUpdatesAreAnnounced() = runTest {
        signIn()
        val maintenance = client { problem(HttpStatusCode.ServiceUnavailable, ProblemCodes.MAINTENANCE, """"message":"Back at 10:00"""") }
        val e = runCatching { maintenance.get("deck", "v1/deck", Doc.serializer()) }.exceptionOrNull() as ApiError.Http
        assertTrue(e.isMaintenance)
        assertEquals("maintenance is deliberate, never retried", 1, requests.size)

        val upgrade = client { problem(HttpStatusCode.UpgradeRequired, ProblemCodes.UPGRADE_REQUIRED, """"minVersionCode":12040""") }
        val u = runCatching { upgrade.get("deck", "v1/deck", Doc.serializer()) }.exceptionOrNull() as ApiError.Http
        assertTrue(u.isUpgradeRequired)
        assertTrue(ApiEvent.Maintenance("Back at 10:00") in events)
        assertTrue(ApiEvent.UpgradeRequired(12040) in events)
    }

    @Test
    fun aFailureCarriesTheProblemAndItsMembers() = runTest {
        val api = client { respond(Fixtures.text("problem-otp-invalid"), HttpStatusCode.BadRequest, headersOf(HttpHeaders.ContentType, "application/problem+json")) }
        try {
            api.send("auth.otp.verify", HttpMethod.Post, "v1/auth/otp/verify", Note("x"), Note.serializer(), Doc.serializer(), Idempotency.NONE, authenticated = false)
            fail("expected Http")
        } catch (e: ApiError.Http) {
            assertEquals(ProblemCodes.OTP_INVALID, e.code)
            assertEquals(3, e.problem.attemptsLeft)
        }
    }

    @Test
    fun aBodyInTheWrongShapeIsADecodingError() = runTest {
        signIn()
        val api = client { ok("""{"n":"not a number"}""") }
        try {
            api.get("me", "v1/me", Doc.serializer())
            fail("expected Decoding")
        } catch (e: ApiError.Decoding) {
            assertNotNull(e.cause)
        }
    }

    @Test
    fun unknownFieldsFromANewerServerAreIgnored() = runTest {
        signIn()
        val api = client { ok("""{"n":4,"somethingNew":{"a":[1,2]}}""") }
        assertEquals(4, api.get("me", "v1/me", Doc.serializer()).value.n)
    }
}
