package app.core.net

import app.core.cache.CacheDatabaseHolder
import app.core.cache.CachedResponseDao
import app.core.cache.CachedResponseEntity
import app.core.cache.isCacheCorruption
import app.core.common.Diag
import kotlinx.coroutines.CancellationException

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

/**
 * The Room-backed cache the app uses, opened on first use through the
 * [CacheDatabaseHolder].
 *
 * A damaged file found mid-session resets the database and reads as a miss:
 * a cache that fails costs one full answer from the server, never the
 * request. Any other database failure is logged and treated the same way.
 */
class RoomResponseCache(
    private val holder: CacheDatabaseHolder,
    private val diag: Diag = Diag.Android,
) : ResponseCache {

    private suspend fun <T> guarded(what: String, fallback: T, block: suspend (CachedResponseDao) -> T): T =
        try {
            block(holder.get().cachedResponses())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e.isCacheCorruption()) {
                holder.reset("corruption during $what")
            } else {
                diag.warn(AREA, "cache $what failed: ${e.javaClass.simpleName}")
            }
            fallback
        }

    override suspend fun read(key: String): CachedResponse? = guarded("read", null) { dao ->
        dao.get(key)?.let { CachedResponse(it.etag, it.body, it.storedAtMillis) }
    }

    override suspend fun write(key: String, response: CachedResponse) = guarded("write", Unit) { dao ->
        dao.upsert(CachedResponseEntity(key, response.etag, response.body, response.storedAtMillis))
    }

    override suspend fun touch(key: String, storedAtMillis: Long) = guarded("touch", Unit) { dao ->
        dao.touch(key, storedAtMillis)
    }

    override suspend fun remove(key: String) = guarded("remove", Unit) { dao -> dao.delete(key) }

    override suspend fun clear() = guarded("clear", Unit) { dao -> dao.clear() }

    private companion object {
        const val AREA = "Cache"
    }
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
