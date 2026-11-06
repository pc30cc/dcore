package app.core.cache

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.common.Diag
import app.core.net.CachedResponse
import app.core.net.RoomResponseCache
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/** The Room table behind the HTTP cache, on an in-memory database. */
@RunWith(AndroidJUnit4::class)
class ResponseCacheRoomTest {

    private val holder = CacheDatabaseHolder(ApplicationProvider.getApplicationContext(), name = null, diag = Diag.Silent)
    private val cache = RoomResponseCache(holder, Diag.Silent)

    @Test
    fun `a stored answer reads back with its validator`() = runTest {
        cache.write("config", CachedResponse("\"v1\"", """{"a":1}""", 10L))
        assertEquals(CachedResponse("\"v1\"", """{"a":1}""", 10L), cache.read("config"))
    }

    @Test
    fun `a newer answer replaces the old one`() = runTest {
        cache.write("config", CachedResponse("\"v1\"", "{}", 10L))
        cache.write("config", CachedResponse("\"v2\"", """{"b":2}""", 20L))
        assertEquals("\"v2\"", cache.read("config")?.etag)
    }

    @Test
    fun `a 304 refreshes only the age`() = runTest {
        cache.write("config", CachedResponse("\"v1\"", "{}", 10L))
        cache.touch("config", 99L)
        assertEquals(CachedResponse("\"v1\"", "{}", 99L), cache.read("config"))
    }

    @Test
    fun `old rows are trimmed and the rest kept`() = runTest {
        cache.write("old", CachedResponse(null, "{}", 10L))
        cache.write("new", CachedResponse(null, "{}", 50L))
        assertEquals(1, holder.get().cachedResponses().deleteOlderThan(30L))
        assertNull(cache.read("old"))
        assertEquals(50L, cache.read("new")?.storedAtMillis)
    }

    @Test
    fun `clearing empties the cache`() = runTest {
        cache.write("a", CachedResponse(null, "{}", 1L))
        cache.clear()
        assertNull(cache.read("a"))
    }
}
