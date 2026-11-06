package app.core.net

import app.core.data.CachedResponseDao
import app.core.data.CachedResponseEntity

/** A stored answer to a GET and its validator. */
data class CachedResponse(val etag: String?, val body: String, val storedAtMillis: Long)

/**
 * Where [ApiClient] keeps the answers it may revalidate with `If-None-Match`.
 *
 * An interface so the client is tested without a database ([MemoryResponseCache]).
 */
interface ResponseCache {
    suspend fun read(key: String): CachedResponse?
    suspend fun write(key: String, response: CachedResponse)
    suspend fun touch(key: String, storedAtMillis: Long)
    suspend fun remove(key: String)
    suspend fun clear()
}

/** The Room-backed cache the app uses. [dao] is a provider so the database opens on first use, not at launch. */
class RoomResponseCache(private val dao: () -> CachedResponseDao) : ResponseCache {
    override suspend fun read(key: String): CachedResponse? =
        dao().get(key)?.let { CachedResponse(it.etag, it.body, it.storedAtMillis) }

    override suspend fun write(key: String, response: CachedResponse) {
        dao().upsert(CachedResponseEntity(key, response.etag, response.body, response.storedAtMillis))
    }

    override suspend fun touch(key: String, storedAtMillis: Long) = dao().touch(key, storedAtMillis)

    override suspend fun remove(key: String) = dao().delete(key)

    override suspend fun clear() = dao().clear()
}

/** In memory: tests, and a launch whose database cannot be opened. */
class MemoryResponseCache : ResponseCache {
    private val entries = mutableMapOf<String, CachedResponse>()

    override suspend fun read(key: String): CachedResponse? = synchronized(entries) { entries[key] }

    override suspend fun write(key: String, response: CachedResponse) {
        synchronized(entries) { entries[key] = response }
    }

    override suspend fun touch(key: String, storedAtMillis: Long) {
        synchronized(entries) { entries[key]?.let { entries[key] = it.copy(storedAtMillis = storedAtMillis) } }
    }

    override suspend fun remove(key: String) {
        synchronized(entries) { entries.remove(key) }
    }

    override suspend fun clear() {
        synchronized(entries) { entries.clear() }
    }
}
