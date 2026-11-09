package app.core.net.origins

import app.core.common.Clock
import app.core.common.Diag
import app.core.net.origins.OriginsRepository.Result
import app.core.net.origins.OriginsRepository.Trigger
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.net.UnknownHostException
import java.time.Instant

/**
 * The held list: accepting and ordering, the fetch order, the cache across a
 * restart and a rotation, the failure path, and when checks happen (cold
 * start, config `v`, every six hours in front, near expiry, at most once a
 * minute), on a virtual clock against a scripted transport.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class OriginsRepositoryTest {

    @get:Rule val folder = TemporaryFolder()

    /** Every GET, in order, and what each URL answers (no route: no answer). */
    private class Transport : OriginsTransport {
        val calls = mutableListOf<Pair<String, String?>>()
        val routes = mutableMapOf<String, suspend (String?) -> OriginsFetch>()

        override suspend fun get(url: String, ifNoneMatch: String?): OriginsFetch {
            synchronized(calls) { calls += url to ifNoneMatch }
            val route = routes[url] ?: throw UnknownHostException("no route in the test")
            return route(ifNoneMatch)
        }

        fun urls(): List<String> = synchronized(calls) { calls.map { it.first } }
    }

    private val transport = Transport()

    private fun TestScope.clock() = Clock { BASE + testScheduler.currentTime }

    private fun TestScope.repository(
        store: OriginsStore = MemoryOriginsStore(),
        trust: OriginsTrust = OriginsKit.trust(),
    ) = OriginsRepository(
        trust = trust,
        compiledApi = BUILD,
        compiledBootstrap = listOf(BUILD_COPY),
        store = store,
        transport = transport,
        clock = clock(),
        diag = Diag.Silent,
        io = UnconfinedTestDispatcher(testScheduler),
    )

    private fun ok(text: String, etag: String? = null) = OriginsFetch(200, text, etag, problem = false)

    private fun document(version: Long = 7, issuedAt: String = "2026-11-09T10:00:00.000Z", expiresAt: String = "2026-12-09T10:00:00.000Z", api: List<String> = listOf(A, B), bootstrap: List<String> = listOf(LIST_COPY)) =
        OriginsKit.sign(OriginsKit.payload(version = version, issuedAt = issuedAt, expiresAt = expiresAt, api = api, bootstrap = bootstrap))

    private fun TestScope.holding(text: String = document(), etag: String? = "\"o7\""): OriginsRepository {
        val store = MemoryOriginsStore(StoredOrigins(text, etag, BASE - 3_600_000))
        return repository(store)
    }

    // MARK: - Accepting and ordering

    @Test
    fun withNothingHeldTheBuildsHostIsAskedAndTheListAccepted() = runTest {
        val store = MemoryOriginsStore()
        val repo = repository(store)
        val text = document()
        transport.routes["$BUILD/v1/origins"] = { ok(text, "\"o7-a\"") }
        assertEquals(Result.ACCEPTED, repo.refresh(Trigger.COLD_START))
        assertEquals(listOf("$BUILD/v1/origins" to null), transport.calls)
        assertEquals(7L, repo.current.value?.version)
        assertEquals(listOf(A, B, BUILD), repo.apiHosts.candidates())
        assertEquals(StoredOrigins(text, "\"o7-a\"", BASE), store.value)
    }

    @Test
    fun aNewerListReplacesTheHeldOneAndAnOlderOneIsRefused() = runTest {
        val repo = holding()
        repo.restore()
        val answers = ArrayDeque(
            listOf(
                document(version = 7) to 7L,
                document(version = 7, issuedAt = "2026-11-09T11:00:00.000Z", api = listOf(B)) to 7L,
                document(version = 6, issuedAt = "2026-11-19T00:00:00.000Z", api = listOf(C)) to 7L,
                document(version = 8, issuedAt = "2026-11-01T00:00:00.000Z", api = listOf(C)) to 8L,
            ),
        )
        val expectedHosts = listOf(listOf(A, B), listOf(B), listOf(B), listOf(C))
        var round = 0
        while (answers.isNotEmpty()) {
            val (text, version) = answers.removeFirst()
            transport.routes["$A/v1/origins"] = { ok(text) }
            transport.routes["$B/v1/origins"] = { ok(text) }
            repo.refresh(Trigger.PERIODIC)
            assertEquals("round $round", version, repo.current.value?.version)
            assertEquals("round $round", expectedHosts[round], repo.book.listed())
            advanceTimeBy(OriginsRepository.MIN_INTERVAL_MS)
            round++
        }
    }

    @Test
    fun anUnchangedListCostsA304() = runTest {
        val repo = holding(etag = "\"o7\"")
        transport.routes["$A/v1/origins"] = { tag -> if (tag == "\"o7\"") OriginsFetch(304, "", null, false) else ok(document()) }
        assertEquals(Result.UNCHANGED, repo.refresh(Trigger.PERIODIC))
        assertEquals(listOf("$A/v1/origins" to "\"o7\""), transport.calls)
        assertEquals(BASE, repo.lastCheckedAt)
    }

    // MARK: - Where from

    @Test
    fun sourcesAreTriedInOrderUntilOneGivesAValidList() = runTest {
        val repo = holding()
        val forged = document(version = 99, api = listOf("https://evil.test")).let { text ->
            text.replace(Regex("\"sig\":\"[^\"]+\""), "\"sig\":\"${OriginsKit.sign(OriginsKit.payload()).substringAfter("\"sig\":\"").substringBefore('"')}\"")
        }
        transport.routes["$B/v1/origins"] = { OriginsFetch(503, """{"code":"service_unavailable"}""", null, problem = true) }
        transport.routes[LIST_COPY] = { ok(forged) }
        transport.routes[BUILD_COPY] = { OriginsFetch(404, "", null, false) }
        transport.routes["$BUILD/v1/origins"] = { ok(document(version = 8, api = listOf(C))) }
        assertEquals(Result.ACCEPTED, repo.refresh(Trigger.PERIODIC))
        // The current API host, the list's other API host, the list's copy, the build's copy, the build's API host.
        assertEquals(listOf("$A/v1/origins", "$B/v1/origins", LIST_COPY, BUILD_COPY, "$BUILD/v1/origins"), transport.urls())
        assertEquals(8L, repo.current.value?.version)
        assertTrue("no answer marks the host bad", repo.book.isBad(A))
        assertFalse("the API's own 503 does not", repo.book.isBad(B))
    }

    @Test
    fun theFirstValidAnswerEndsTheWalk() = runTest {
        val repo = holding()
        transport.routes["$A/v1/origins"] = { OriginsFetch(502, "<html>", null, problem = false) }
        transport.routes["$B/v1/origins"] = { ok(document()) }
        assertEquals(Result.UNCHANGED, repo.refresh(Trigger.PERIODIC))
        assertEquals(listOf("$A/v1/origins", "$B/v1/origins"), transport.urls())
        assertTrue("an edge failure marks the host bad", repo.book.isBad(A))
        assertEquals("the host that answered is used first now", B, repo.book.candidates().first())
    }

    @Test
    fun aCheckIsNeverRepeatedWithinAMinute() = runTest {
        val repo = holding()
        transport.routes["$A/v1/origins"] = { ok(document()) }
        assertEquals(Result.UNCHANGED, repo.refresh(Trigger.PERIODIC))
        advanceTimeBy(59_999)
        assertEquals(Result.SKIPPED, repo.refresh(Trigger.CONFIG))
        assertEquals(1, transport.calls.size)
        advanceTimeBy(1)
        assertEquals(Result.UNCHANGED, repo.refresh(Trigger.CONFIG))
        assertEquals(2, transport.calls.size)
    }

    // MARK: - The cache

    @Test
    fun theListSurvivesARestart() = runTest {
        val file = File(folder.root, "origins.json")
        val first = repository(FileOriginsStore(file))
        transport.routes["$BUILD/v1/origins"] = { ok(document(api = listOf(C, A)), "\"o7\"") }
        first.refresh(Trigger.COLD_START)

        transport.calls.clear()
        val second = repository(FileOriginsStore(file))
        // The first request's host choice restores the list, without a request.
        assertEquals(listOf(C, A, BUILD), second.apiHosts.candidates())
        assertEquals(7L, second.current.value?.version)
        assertTrue(transport.calls.isEmpty())
        // The stored ETag goes with the next check.
        transport.routes["$C/v1/origins"] = { OriginsFetch(304, "", null, false) }
        assertEquals(Result.UNCHANGED, second.refresh(Trigger.COLD_START))
        assertEquals(listOf("$C/v1/origins" to "\"o7\""), transport.calls)
    }

    @Test
    fun aListSignedWithAKeyTheBuildNoLongerCarriesIsDropped() = runTest {
        val store = MemoryOriginsStore(StoredOrigins(document(), "\"o7\"", BASE))
        val repo = repository(store, trust = OriginsKit.trust(OriginsKit.NEXT_KID to OriginsKit.NEXT_PUBLIC))
        assertEquals(listOf(BUILD), repo.apiHosts.candidates())
        assertNull(repo.current.value)
        assertNull("the stale copy is gone", store.value)
    }

    @Test
    fun aDamagedOrForeignCopyIsDropped() = runTest {
        val store = MemoryOriginsStore(StoredOrigins(document().replace("\"kid\"", "\"kidd\""), null, BASE))
        val repo = repository(store)
        repo.restore()
        assertNull(repo.current.value)
        assertNull(store.value)
    }

    @Test
    fun anExpiredHeldListIsKeptButAsksForACheck() = runTest {
        val repo = holding(document(issuedAt = "2026-10-01T00:00:00.000Z", expiresAt = "2026-10-31T00:00:00.000Z"))
        repo.restore()
        assertEquals("the last known good list", listOf(A, B, BUILD), repo.apiHosts.candidates())
        assertEquals(BASE, repo.nextCheckAt(BASE))
    }

    // MARK: - The failure path

    @Test
    fun whenEveryHostFailedTheCopiesAreReadAtOnceAndTheNewestWins() = runTest {
        val repo = holding()
        repo.restore()
        transport.routes[LIST_COPY] = { delay(5_000); ok(document(version = 8, api = listOf(C))) }
        transport.routes[BUILD_COPY] = { delay(5_000); ok(document(version = 9, api = listOf(D))) }
        val started = testScheduler.currentTime
        assertTrue(repo.recover())
        assertEquals("both copies at once", 5_000L, testScheduler.currentTime - started)
        assertEquals(9L, repo.current.value?.version)
        assertEquals(listOf(D, BUILD), repo.apiHosts.candidates())
    }

    @Test
    fun overlappingFailuresShareOneRoundAndAFruitlessOneWaits() = runTest {
        val repo = holding()
        repo.restore()
        transport.routes[LIST_COPY] = { delay(1_000); ok(document(version = 8, api = listOf(C))) }
        val results = listOf(async { repo.recover() }, async { repo.recover() }, async { repo.recover() }).awaitAll()
        assertEquals(listOf(true, true, true), results)
        assertEquals(listOf(LIST_COPY, BUILD_COPY), transport.urls().distinct())
        assertEquals(2, transport.calls.size)

        // Nothing newer: the next failure within 15 s reads nothing.
        transport.calls.clear()
        transport.routes.remove(LIST_COPY)
        advanceTimeBy(OriginsRepository.RECOVERY_FLOOR_MS)
        assertFalse(repo.recover())
        val calls = transport.calls.size
        assertFalse(repo.recover())
        assertEquals(calls, transport.calls.size)
    }

    @Test
    fun theFailurePathIgnoresTheMinuteLimit() = runTest {
        val repo = holding()
        transport.routes["$A/v1/origins"] = { ok(document()) }
        repo.refresh(Trigger.PERIODIC)
        transport.routes[LIST_COPY] = { ok(document(version = 8, api = listOf(C))) }
        assertTrue(repo.recover())
    }

    // MARK: - A build without keys

    @Test
    fun aBuildWithoutKeysNeverFetches() = runTest {
        val repo = repository(trust = OriginsTrust("_template", emptyMap()))
        assertEquals(Result.DISABLED, repo.refresh(Trigger.COLD_START))
        assertFalse(repo.recover())
        repo.start(backgroundScope, MutableStateFlow(true), MutableStateFlow(1L))
        advanceTimeBy(7 * 3_600_000L)
        assertTrue(transport.calls.isEmpty())
        assertEquals(listOf(BUILD), repo.apiHosts.candidates())
    }

    // MARK: - When

    @Test
    fun aColdStartChecksAtOnceAndANewConfigVersionAfterTheMinute() = runTest {
        val repo = holding()
        transport.routes["$A/v1/origins"] = { ok(document()) }
        val config = MutableStateFlow<Long?>(null)
        repo.start(backgroundScope, MutableStateFlow(false), config)
        runCurrent()
        assertEquals("the cold start", 1, transport.calls.size)

        config.value = 41
        runCurrent()
        assertEquals("the first version is the cold start's", 1, transport.calls.size)
        advanceTimeBy(10_000)
        config.value = 42
        runCurrent()
        assertEquals("not within the minute", 1, transport.calls.size)
        advanceTimeBy(50_000)
        runCurrent()
        assertEquals("a panel save reaches the app a minute later at most", 2, transport.calls.size)
        assertEquals(60_000L, repo.lastAttemptAt!! - BASE)
    }

    @Test
    fun inFrontTheListIsCheckedEverySixHoursAndNotInTheBackground() = runTest {
        val repo = holding()
        transport.routes["$A/v1/origins"] = { ok(document()) }
        val front = MutableStateFlow(true)
        repo.start(backgroundScope, front, MutableStateFlow(null))
        runCurrent()
        assertEquals(1, transport.calls.size)

        advanceTimeBy(OriginsRepository.PERIODIC_MS - 1_000)
        runCurrent()
        assertEquals(1, transport.calls.size)
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals("six hours later", 2, transport.calls.size)

        front.value = false
        runCurrent()
        advanceTimeBy(OriginsRepository.PERIODIC_MS + 3_600_000)
        runCurrent()
        assertEquals("nothing while in the background", 2, transport.calls.size)
        front.value = true
        runCurrent()
        assertEquals("back in front after more than six hours: at once", 3, transport.calls.size)
    }

    @Test
    fun nearExpiryTheListIsCheckedHourly() = runTest {
        val expires = Instant.ofEpochMilli(BASE + 3 * 24 * 3_600_000L).toString()
        val text = document(issuedAt = "2026-11-09T10:00:00.000Z", expiresAt = expires)
        val repo = holding(text)
        transport.routes["$A/v1/origins"] = { ok(text) }
        repo.start(backgroundScope, MutableStateFlow(true), MutableStateFlow(null))
        runCurrent()
        assertEquals(1, transport.calls.size)
        advanceTimeBy(OriginsRepository.RETRY_MS)
        runCurrent()
        assertEquals(2, transport.calls.size)
        advanceTimeBy(OriginsRepository.RETRY_MS)
        runCurrent()
        assertEquals(3, transport.calls.size)
    }

    @Test
    fun withoutAListAFailedCheckIsRetriedHourlyNotEveryMinute() = runTest {
        // A fresh install whose server has no signing key yet, say.
        val repo = repository()
        repo.start(backgroundScope, MutableStateFlow(true), MutableStateFlow(null))
        runCurrent()
        assertEquals("the build's API host, then the build's copy", listOf("$BUILD/v1/origins", BUILD_COPY), transport.urls())
        advanceTimeBy(OriginsRepository.RETRY_MS - 1_000)
        runCurrent()
        assertEquals(2, transport.calls.size)
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(4, transport.calls.size)
    }

    @Test
    fun withAGoodListAFailedCheckWaitsForTheRegularOne() = runTest {
        val repo = holding()
        repo.start(backgroundScope, MutableStateFlow(true), MutableStateFlow(null))
        runCurrent()
        val perCheck = transport.calls.size
        assertEquals(5, perCheck)
        advanceTimeBy(OriginsRepository.RETRY_MS)
        runCurrent()
        assertEquals("not every minute, nor hourly while the held list is far from expiry", perCheck, transport.calls.size)
        // Six hours after the stored copy was last confirmed (an hour before the start).
        advanceTimeBy(OriginsRepository.PERIODIC_MS - 2 * OriginsRepository.RETRY_MS)
        runCurrent()
        assertEquals(2 * perCheck, transport.calls.size)
    }

    // MARK: - The other roles

    @Test
    fun realtimeFallbacksAndTheDeletionPageComeFromTheList() = runTest {
        val repo = holding()
        assertEquals(emptyList<String>(), repo.realtimeSockets())
        assertNull(repo.deletionPage("fa"))
        repo.restore()
        assertEquals(listOf("wss://rt.example.com/connection/websocket"), repo.realtimeSockets())
        assertEquals("https://example.com/fa/delete-account/", repo.deletionPage("fa"))
        assertNull("never a path from outside", repo.deletionPage("../x"))
    }

    private companion object {
        val BASE: Long = Instant.parse("2026-11-20T00:00:00Z").toEpochMilli()
        const val A = "https://a.test"
        const val B = "https://b.test"
        const val C = "https://c.test"
        const val D = "https://d.test"
        const val BUILD = "https://build.test"
        const val LIST_COPY = "https://copy.test/origins.json"
        const val BUILD_COPY = "https://build-copy.test/origins.json"
    }
}
