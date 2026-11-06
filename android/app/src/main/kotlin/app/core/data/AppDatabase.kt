package app.core.data

import android.content.Context
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

/**
 * The app's local database: a cache, never a source of truth.
 *
 * Its job is to keep requests off the server, which is how the app keeps its
 * share of the database load small: what the phone already has is shown
 * first, and a refresh asks the server "has this changed?" with the ETag
 * the last answer carried. An unchanged answer is a 304 with no body, which
 * the server can give from its own cache without touching Postgres.
 *
 * One table so far, [CachedResponseEntity]. Profiles, matches and
 * conversations get their own tables when those screens are built.
 *
 * **Versioned, with a cache's migration policy.** Every schema change bumps
 * [VERSION] and exports its JSON (`app/schemas`). Where no migration is written
 * the database is rebuilt empty: every row is a copy of something the server
 * still has, so a rebuild costs one slower first sync, never data. A table that
 * ever holds something the server does not (an outbox of unsent messages)
 * needs a real entry in [MIGRATIONS].
 *
 * Not a credential store: tokens stay in [app.core.storage.SecureStore]. Kept
 * out of backups and device transfers by `data_extraction_rules.xml`.
 */
@Database(entities = [CachedResponseEntity::class], version = AppDatabase.VERSION, exportSchema = true)
abstract class AppDatabase : RoomDatabase() {
    abstract fun cachedResponses(): CachedResponseDao

    companion object {
        const val VERSION = 1
        const val NAME = "app-cache.db"

        /** Real migrations, oldest first. See the class note for when one is owed. */
        val MIGRATIONS: Array<Migration> = emptyArray()

        /** [name] null builds an in-memory database (tests). */
        fun build(context: Context, name: String? = NAME): AppDatabase {
            val builder = if (name == null) {
                Room.inMemoryDatabaseBuilder(context.applicationContext, AppDatabase::class.java)
            } else {
                Room.databaseBuilder(context.applicationContext, AppDatabase::class.java, name)
            }
            return builder
                .addMigrations(*MIGRATIONS)
                // A cache with no migration path is rebuilt, in both
                // directions, never a crash at launch.
                .fallbackToDestructiveMigration(dropAllTables = true)
                .build()
        }
    }
}

/**
 * The last answer to a cacheable GET, with the validator it came with.
 *
 * [cacheKey] is the request's own key (its path and query, and the account
 * when the answer is personal), never a URL with a token in it.
 */
@Entity(tableName = "http_cache")
data class CachedResponseEntity(
    @PrimaryKey @ColumnInfo(name = "cache_key") val cacheKey: String,
    /** The `ETag` the server sent; null when it sent none (then the row only serves offline reads). */
    @ColumnInfo(name = "etag") val etag: String?,
    /** The response body, as received (JSON). */
    @ColumnInfo(name = "body") val body: String,
    /** When the body was stored, epoch milliseconds. */
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

    /** Drops rows nobody has refreshed since [beforeMillis]. */
    @Query("DELETE FROM http_cache WHERE stored_at < :beforeMillis")
    suspend fun deleteOlderThan(beforeMillis: Long): Int

    @Query("DELETE FROM http_cache")
    suspend fun clear()
}
