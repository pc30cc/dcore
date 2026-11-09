package app.core.net

import app.core.common.Clock
import app.core.common.Diag
import app.core.model.AccountStatus
import app.core.model.AuthResult
import app.core.model.AuthUser
import app.core.net.origins.MemoryOriginsStore
import app.core.net.origins.OriginsFetch
import app.core.net.origins.OriginsKit
import app.core.net.origins.OriginsRepository
import app.core.net.origins.OriginsTransport
import app.core.net.origins.StoredOrigins
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
import io.ktor.http.headersOf
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.Serializable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.UnknownHostException
import java.time.Instant
import kotlin.random.Random

/**
 * The funnel on the origins list's hosts: the fallback state machine (bad
 * marks, the next host, the build's host, the published copies) against a
 * fake HTTP layer, the safe-retry rules, and that no session or token ever
 * reaches a host outside the list and the build.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ApiClientHostsTest {

    @Serializable
    data class Doc(val n: Int)

    @Serializable
    data class Note(val text: String)

    private val requests = mutableListOf<HttpRequestData>()
    private val copies = mutableMapOf<String, String>()
    private val copyReads = mutableListOf<String>()

    private fun TestScope.clock() = Clock { BASE + testScheduler.currentTime }

    private fun TestScope.session(): SessionStore = SessionStore(MemorySecretStore(), clock(), Diag.Silent)

    private fun list(version: Long, api: List<String>) =
        OriginsKit.sign(OriginsKit.payload(version = version, api = api, bootstrap = listOf(COPY)))

    private fun TestScope.origins(held: String? = list(7, listOf(A, B))): OriginsRepository {
        val transport = OriginsTransport { url, _ ->
            copyReads += url
            copies[url]?.let { OriginsFetch(200, it, null, false) } ?: throw UnknownHostException("no copy")
        }
        return OriginsRepository(
            trust = OriginsKit.trust(),
            compiledApi = BUILD,
            compiledBootstrap = emptyList(),
            store = MemoryOriginsStore(held?.let { StoredOrigins(it, null, BASE) }),
            transport = transport,
            clock = clock(),
            diag = Diag.Silent,
            io = UnconfinedTestDispatcher(testScheduler),
        )
    }

    private fun TestScope.client(
        hosts: ApiHosts,
        tokens: SessionStore = session(),
        retry: RetryPolicy = RetryPolicy.NONE,
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ) = ApiClient(
        baseUrl = BUILD,
        tokens = tokens,
        cache = MemoryResponseCache(),
        engine = MockEngine { request ->
            synchronized(requests) { requests += request }
            handler(request)
        },
        clientHeader = ApiClient.clientHeader("play", 1),
        language = { "en" },
        diag = Diag.Silent,
        clock = clock(),
        retry = retry,
        random = Random(1),
        pause = {},
        hosts = hosts,
    )

    private suspend fun signIn(tokens: SessionStore, at: Instant, ttlSeconds: Long = 900) {
        tokens.signIn(
            AuthResult("at-1", at.plusSeconds(ttlSeconds), "rt-1", null, AuthUser("aaaaaaaaaaaaa", AccountStatus.Active, 0)),
            receivedAtMillis = at.toEpochMilli(),
        )
    }

    private fun MockRequestHandleScope.ok() =
        respond("""{"n":1}""", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))

    private fun HttpRequestData.origin() = "https://${url.host}"

    private fun hostsAsked() = synchronized(requests) { requests.map { it.origin() } }

    /** Every request that carried a session went to a host the list or the build names. */
    private fun assertSessionsOnlyWentTo(vararg allowed: String) {
        val carriers = synchronized(requests) { requests.filter { it.headers[HttpHeaders.Authorization] != null } }
        for (request in carriers) assertTrue("a session went to ${request.origin()}", request.origin() in allowed)
    }

    // MARK: - The fallback state machine

    @Test
    fun aHostThatGivesNoAnswerIsLeftForTheNextAndAvoidedForFiveMinutes() = runTest {
        val origins = origins()
        val api = client(origins.apiHosts) { request ->
            if (request.origin() == A) throw UnknownHostException("a.test") else ok()
        }
        assertEquals(1, api.get("me", "v1/me", Doc.serializer(), authenticated = false).value.n)
        assertEquals(listOf(A, B), hostsAsked())
        assertTrue(origins.book.isBad(A))

        requests.clear()
        api.get("me", "v1/me", Doc.serializer(), authenticated = false)
        assertEquals("the bad host is skipped", listOf(B), hostsAsked())

        advanceTimeBy(5 * 60_000L + 1)
        requests.clear()
        api.get("me", "v1/me", Doc.serializer(), authenticated = false)
        assertEquals("the host that worked stays first until it fails", listOf(B), hostsAsked())
    }

    @Test
    fun anEdgeFailureMovesTheRequestButTheApisOwnAnswerDoesNot() = runTest {
        for (status in listOf(502, 503, 520, 522, 526)) {
            requests.clear()
            val origins = origins()
            val api = client(origins.apiHosts) { request ->
                if (request.origin() == A) respond("<html>edge</html>", HttpStatusCode.fromValue(status)) else ok()
            }
            api.get("me", "v1/me", Doc.serializer(), authenticated = false)
            assertEquals("$status", listOf(A, B), hostsAsked())
            assertTrue("$status", origins.book.isBad(A))
        }

        requests.clear()
        val origins = origins()
        val api = client(origins.apiHosts) {
            respond("""{"status":503,"code":"maintenance"}""", HttpStatusCode.ServiceUnavailable, headersOf(HttpHeaders.ContentType, "application/problem+json"))
        }
        runCatching { api.get("me", "v1/me", Doc.serializer(), authenticated = false) }
        assertEquals("the API answered: no other host is asked", listOf(A), hostsAsked())
        assertFalse(origins.book.isBad(A))
    }

    @Test
    fun aNonIdempotentPostMovesOnlyWhenNothingWasSent() = runTest {
        val origins = origins()
        var reset = true
        val api = client(origins.apiHosts) { request ->
            when {
                request.origin() == A && reset -> throw IOException("connection reset")
                request.origin() == A -> throw ConnectException("refused")
                else -> ok()
            }
        }
        try {
            api.send("swipes", HttpMethod.Post, "v1/swipes", Note("x"), Note.serializer(), Doc.serializer(), Idempotency.NONE, authenticated = false)
            fail("expected Network")
        } catch (e: ApiError.Network) {
            assertFalse(e.unsent)
        }
        assertEquals("it may have reached the server: never resent", listOf(A), hostsAsked())

        // Nothing left the phone: another host is safe even for a swipe.
        origins.book.reached(A)
        reset = false
        requests.clear()
        api.send("swipes", HttpMethod.Post, "v1/swipes", Note("x"), Note.serializer(), Doc.serializer(), Idempotency.NONE, authenticated = false)
        assertEquals(listOf(A, B), hostsAsked())
    }

    @Test
    fun aNonIdempotentPostIsNotMovedOnAnEdgeFailure() = runTest {
        val origins = origins()
        val api = client(origins.apiHosts) { respond("<html>", HttpStatusCode.BadGateway) }
        runCatching {
            api.send("calls.place", HttpMethod.Post, "v1/calls", Note("x"), Note.serializer(), Doc.serializer(), Idempotency.NONE, authenticated = false)
        }
        assertEquals(listOf(A), hostsAsked())
        assertTrue("still marked for the requests after it", origins.book.isBad(A))
    }

    @Test
    fun whenEveryListedHostFailsTheBuildsHostIsUsed() = runTest {
        val origins = origins()
        val api = client(origins.apiHosts) { request ->
            if (request.origin() == BUILD) ok() else throw UnknownHostException(request.url.host)
        }
        api.get("me", "v1/me", Doc.serializer(), authenticated = false)
        assertEquals(listOf(A, B, BUILD), hostsAsked())
        assertTrue(copyReads.isEmpty())
    }

    @Test
    fun whenEveryHostFailsThePublishedCopyBringsNewHosts() = runTest {
        val origins = origins()
        copies[COPY] = list(8, listOf(C))
        val api = client(origins.apiHosts) { request ->
            if (request.origin() == C) ok() else throw UnknownHostException(request.url.host)
        }
        assertEquals(1, api.get("me", "v1/me", Doc.serializer(), authenticated = false).value.n)
        assertEquals(listOf(A, B, BUILD, C), hostsAsked())
        assertEquals(listOf(COPY), copyReads)
        assertEquals(8L, origins.current.value?.version)
    }

    @Test
    fun aRefreshMovesToAnotherHostOnlyWhileNothingWasSent() = runTest {
        val origins = origins()
        val tokens = session()
        // A token ten seconds from its deadline: renewed before the request.
        signIn(tokens, Instant.ofEpochMilli(BASE - 890_000), ttlSeconds = 900)
        val api = client(origins.apiHosts, tokens) { request ->
            when {
                request.origin() == A -> throw UnknownHostException("a.test")
                request.url.encodedPath == "/v1/auth/refresh" ->
                    respond(Fixtures.text("token-pair"), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
                else -> ok()
            }
        }
        api.get("me", "v1/me", Doc.serializer())
        assertEquals(listOf(A, B, B), hostsAsked())
        assertEquals("/v1/auth/refresh", requests[1].url.encodedPath)
    }

    // MARK: - No token to an unknown host

    @Test
    fun aForgedListNeverTakesTheSessionAnywhere() = runTest {
        val origins = origins()
        val tokens = session()
        signIn(tokens, Instant.ofEpochMilli(BASE))
        // A copy listing another host, signed by a key the build does not carry.
        copies[COPY] = OriginsKit.sign(OriginsKit.payload(version = 99, api = listOf(EVIL)), kid = OriginsKit.NEXT_KID, seed = OriginsKit.NEXT_SEED)
        val api = client(origins.apiHosts, tokens) { request ->
            if (request.origin() == EVIL) ok() else throw UnknownHostException(request.url.host)
        }
        runCatching { api.get("me", "v1/me", Doc.serializer()) }
        assertFalse("the forged host was never asked", EVIL in hostsAsked())
        assertEquals(listOf(COPY), copyReads)
        assertEquals(7L, origins.current.value?.version)
        assertSessionsOnlyWentTo(A, B, BUILD)
    }

    @Test
    fun aRedirectNeverTakesTheSessionOrTheBodyAnywhere() = runTest {
        val origins = origins()
        val tokens = session()
        signIn(tokens, Instant.ofEpochMilli(BASE))
        val api = client(origins.apiHosts, tokens) { request ->
            if (request.origin() == EVIL) {
                ok()
            } else {
                respond("", HttpStatusCode.TemporaryRedirect, headersOf(HttpHeaders.Location, "$EVIL/v1/auth/refresh"))
            }
        }
        try {
            api.get("me", "v1/me", Doc.serializer())
            fail("expected Http")
        } catch (e: ApiError.Http) {
            assertEquals(307, e.status)
        }
        try {
            api.send("auth.logout", HttpMethod.Post, "v1/auth/logout", Note("rt-1"), Note.serializer(), Doc.serializer(), Idempotency.KEYED)
            fail("expected Http")
        } catch (e: ApiError.Http) {
            assertEquals(307, e.status)
        }
        assertEquals(listOf(A, A), hostsAsked())
        assertSessionsOnlyWentTo(A, B, BUILD)
    }

    @Test
    fun aHostOutsideTheListAndTheBuildIsNeverSentTo() = runTest {
        val tokens = session()
        signIn(tokens, Instant.ofEpochMilli(BASE))
        // Host selection gone wrong: it offers a host it does not vouch for.
        val broken = object : ApiHosts {
            override suspend fun candidates() = listOf(EVIL)
            override fun trusted(base: String) = base == BUILD
            override fun reached(base: String) = Unit
            override fun failed(base: String) = Unit
            override suspend fun recover() = false
        }
        val api = client(broken, tokens, retry = RetryPolicy()) { ok() }
        try {
            api.get("me", "v1/me", Doc.serializer())
            fail("expected Network")
        } catch (e: ApiError.Network) {
            assertTrue(e.cause is UntrustedHostException)
            assertTrue(e.unsent)
        }
        assertTrue("nothing at all left the phone", requests.isEmpty())
    }

    @Test
    fun aHostTheNewerListDroppedGetsNothingMore() = runTest {
        val origins = origins()
        val tokens = session()
        signIn(tokens, Instant.ofEpochMilli(BASE))
        copies[COPY] = list(8, listOf(C))
        val api = client(origins.apiHosts, tokens) { request ->
            if (request.origin() == C) ok() else throw UnknownHostException(request.url.host)
        }
        api.get("me", "v1/me", Doc.serializer())
        assertFalse(origins.apiHosts.trusted(A))
        requests.clear()
        api.get("me", "v1/me", Doc.serializer())
        assertEquals(listOf(C), hostsAsked())
        assertSessionsOnlyWentTo(A, B, BUILD, C)
    }

    private companion object {
        val BASE: Long = Instant.parse("2026-11-20T00:00:00Z").toEpochMilli()
        const val A = "https://a.test"
        const val B = "https://b.test"
        const val C = "https://c.test"
        const val BUILD = "https://build.test"
        const val EVIL = "https://evil.test"
        const val COPY = "https://copy.test/origins.json"
    }
}
