package app.core.cache

import android.content.Context
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.database.sqlite.SQLiteDatabaseLockedException
import android.database.sqlite.SQLiteException
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Upsert
import androidx.room.migration.Migration
import app.core.common.Diag
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The app's local database: a cache, never a source of truth.
 *
 * Its job is to keep requests off the server: what the phone already has is
 * shown first, and a refresh asks "has this changed?" with the ETag the last
 * answer carried. An unchanged answer is a 304 with no body, decided on the
 * server without touching its database.
 *
 * Tables: [CachedResponseEntity] (stored answers and their validators), and
 * the chat's [ConversationEntity], [MessageEntity] (with the outbox) and
 * [SyncStateEntity] (see ChatTables.kt).
 *
 * **Versioned, with a cache's migration policy.** Every schema change bumps
 * [VERSION] and exports its JSON (`app/schemas`). Where no migration is written
 * the database is rebuilt empty: every row is a copy of something the server
 * still has, so a rebuild costs one slower first sync, never data. A table that
 * ever holds something the server does not (an outbox of unsent messages)
 * needs a real entry in [MIGRATIONS].
 *
 * Not a credential store: tokens stay in [app.core.storage.SecureStore]. Kept
 * out of backups and device transfers by `data_extraction_rules.xml`. Not
 * encrypted beyond the platform's file-based encryption: the sandbox keeps
 * the file from other apps, and a key for it could only live in the same
 * Keystore that already protects the session.
 */
@Database(
    entities = [
        CachedResponseEntity::class,
        ConversationEntity::class,
        MessageEntity::class,
        SyncStateEntity::class,
    ],
    version = CacheDatabase.VERSION,
    exportSchema = true,
)
abstract class CacheDatabase : RoomDatabase() {
    abstract fun cachedResponses(): CachedResponseDao
    abstract fun conversations(): ConversationDao
    abstract fun messages(): MessageDao
    abstract fun syncState(): SyncStateDao

    companion object {
        /**
         * 2: the chat tables (conversations, messages with the outbox,
         * sync_state). No build with version 1 was ever released, so 1 -> 2
         * is the rebuild. From 2 on, `messages` holds the outbox (rows the
         * server does not have yet): every later version owes it a real
         * migration in [MIGRATIONS].
         */
        const val VERSION = 2

        /** A fixed neutral name: never derived from the brand. */
        const val NAME = "app-cache.db"

        /** Real migrations, oldest first. See the class note for when one is owed. */
        val MIGRATIONS: Array<Migration> = emptyArray()

        /** [name] null builds an in-memory database: tests, and the last resort. */
        fun build(
            context: Context,
            name: String? = NAME,
            configure: (RoomDatabase.Builder<CacheDatabase>) -> Unit = {},
        ): CacheDatabase {
            val builder = if (name == null) {
                Room.inMemoryDatabaseBuilder(context.applicationContext, CacheDatabase::class.java)
            } else {
                Room.databaseBuilder(context.applicationContext, CacheDatabase::class.java, name)
            }
            configure(builder)
            return builder
                .addMigrations(*MIGRATIONS)
                // A cache with no migration path is rebuilt, in both
                // directions, never a crash at launch: someone who installs an
                // older build gets an empty cache, not an app that will not
                // open. This one call covers both; adding the downgrade-only
                // variant after it would turn the upgrade case back off.
                .fallbackToDestructiveMigration(dropAllTables = true)
                .build()
        }
    }
}

/**
 * Owns the one [CacheDatabase], and replaces it when it cannot be used.
 *
 * A damaged cache must never cost anyone the app. Opening is therefore
 * checked here, off the main thread, where a failure can be answered: first
 * rebuild the file from nothing (the server fills it again), and if even a
 * fresh file cannot be opened (a full disk, a broken file system) run this
 * launch on an in-memory database. The app then works as it would on disk;
 * it just forgets on exit.
 *
 * [generation] moves on every replacement, so a flow reading the old
 * instance knows to subscribe to the new one.
 */
class CacheDatabaseHolder(
    private val context: Context,
    private val name: String? = CacheDatabase.NAME,
    private val diag: Diag = Diag.Android,
    /** Builder settings for tests (a query context on the test's clock). */
    private val configure: (RoomDatabase.Builder<CacheDatabase>) -> Unit = {},
) {
    private val lock = Mutex()

    @Volatile private var database: CacheDatabase? = null

    private val _generation = MutableStateFlow(0)
    val generation: StateFlow<Int> = _generation.asStateFlow()

    /** True when this launch fell back to memory. Shown nowhere; logged. */
    @Volatile var isVolatile: Boolean = name == null
        private set

    suspend fun get(): CacheDatabase {
        database?.let { return it }
        return lock.withLock {
            database ?: withContext(Dispatchers.IO) { open() }.also { database = it }
        }
    }

    /**
     * Throws the current database away and starts again: for corruption found
     * mid-session, and for tests. Returns once the new one is open.
     */
    suspend fun reset(reason: String) {
        lock.withLock {
            diag.warn(AREA, "cache database reset: $reason")
            withContext(Dispatchers.IO) {
                runCatching { database?.close() }
                database = null
                if (name != null) runCatching { context.deleteDatabase(name) }
                database = open()
            }
        }
        _generation.value = _generation.value + 1
    }

    private fun open(): CacheDatabase {
        if (name == null) return CacheDatabase.build(context, null, configure)
        attempt()?.let { return it }
        // The file would not open or would not verify: a torn write,
        // corruption, a schema that drifted at the same version. It is a
        // cache: delete it, and the next sync fills it again.
        diag.warn(AREA, "cache database unreadable; rebuilding")
        runCatching { context.deleteDatabase(name) }
        attempt()?.let { return it }
        diag.warn(AREA, "cache database cannot be created; running this launch from memory")
        isVolatile = true
        return CacheDatabase.build(context, null, configure)
    }

    private fun attempt(): CacheDatabase? {
        val db = CacheDatabase.build(context, name, configure)
        return try {
            // Forces the open, the migration and Room's identity check now,
            // here, rather than on the first query from some screen.
            db.openHelper.writableDatabase
            db
        } catch (e: SQLiteDatabaseLockedException) {
            // Busy is not damaged: another connection holds it for a moment.
            // Deleting it now would throw away a good cache.
            diag.warn(AREA, "cache database busy at open: ${e.javaClass.simpleName}")
            db
        } catch (e: SQLiteException) {
            diag.warn(AREA, "cache database open failed: ${e.javaClass.simpleName}")
            runCatching { db.close() }
            null
        } catch (e: IllegalStateException) {
            // "Room cannot verify the data integrity": the same version
            // number with a different schema. Only a development build can
            // get here, and a rebuild is exactly right for it.
            diag.warn(AREA, "cache database failed verification: ${e.javaClass.simpleName}")
            runCatching { db.close() }
            null
        }
    }

    internal companion object {
        const val AREA = "Cache"
    }
}

/** Whether a failure means the file itself is damaged, as against busy or full. */
internal fun Throwable.isCacheCorruption(): Boolean =
    this is SQLiteDatabaseCorruptException ||
        (this is SQLiteException && message?.contains("malformed", ignoreCase = true) == true)

/**
 * The last answer to a cacheable GET, with the validator it came with.
 *
 * [cacheKey] is the request's own key (its route, and the account when the
 * answer is personal), never a URL with a token in it.
 */
@Entity(tableName = "http_cache")
data class CachedResponseEntity(
    @PrimaryKey @ColumnInfo(name = "cache_key") val cacheKey: String,
    /** The `ETag` the server sent; null when it sent none (then the row only serves offline reads). */
    @ColumnInfo(name = "etag") val etag: String?,
    /** The response body, as received (JSON). */
    @ColumnInfo(name = "body") val body: String,
    /** When the body was stored or last confirmed by a 304, epoch milliseconds. */
    @ColumnInfo(name = "stored_at") val storedAtMillis: Long,
)

@Dao
interface CachedResponseDao {
    @Query("SELECT * FROM http_cache WHERE cache_key = :cacheKey")
    suspend fun get(cacheKey: String): CachedResponseEntity?

    @Upsert
    suspend fun upsert(entry: CachedResponseEntity)

    /** Bumps [CachedResponseEntity.storedAtMillis] after a 304: the copy is current again. */
    @Query("UPDATE http_cache SET stored_at = :storedAtMillis WHERE cache_key = :cacheKey")
    suspend fun touch(cacheKey: String, storedAtMillis: Long)

    @Query("DELETE FROM http_cache WHERE cache_key = :cacheKey")
    suspend fun delete(cacheKey: String)

    /** Drops rows nobody has confirmed since [beforeMillis]. */
    @Query("DELETE FROM http_cache WHERE stored_at < :beforeMillis")
    suspend fun deleteOlderThan(beforeMillis: Long): Int

    @Query("DELETE FROM http_cache")
    suspend fun clear()
}
