package app.core.cache

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.common.Diag
import app.core.net.CachedResponse
import app.core.net.RoomResponseCache
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The holder opens the cache off the main thread and never lets a damaged file cost the app. */
@RunWith(AndroidJUnit4::class)
class CacheDatabaseHolderTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val name = "holder-test.db"
    private val diag = Diag.Recording()

    @After
    fun cleanUp() {
        context.deleteDatabase(name)
    }

    @Test
    fun opensOnFirstUseAndKeepsOneInstance() = runTest {
        val holder = CacheDatabaseHolder(context, name, diag)
        val first = holder.get()
        assertTrue(first === holder.get())
        assertFalse(holder.isVolatile)
        first.cachedResponses().upsert(CachedResponseEntity("k", null, "{}", 1))
        assertEquals("{}", holder.get().cachedResponses().get("k")?.body)
    }

    @Test
    fun aFileThatIsNotADatabaseIsReplaced() = runTest {
        val file = context.getDatabasePath(name)
        file.parentFile?.mkdirs()
        file.writeBytes(ByteArray(8192) { 0x5A })

        val holder = CacheDatabaseHolder(context, name, diag)
        val db = holder.get()
        db.cachedResponses().upsert(CachedResponseEntity("k", "\"e\"", "{}", 1))
        assertEquals("\"e\"", db.cachedResponses().get("k")?.etag)
        assertFalse("replaced on disk, not run from memory", holder.isVolatile)
        assertEquals("SQLite format 3", String(file.readBytes().copyOfRange(0, 15), Charsets.US_ASCII))
    }

    @Test
    fun aDatabaseThatFailsVerificationIsRebuilt() = runTest {
        // The same version number with another schema: Room refuses to open it.
        val file = context.getDatabasePath(name)
        file.parentFile?.mkdirs()
        SQLiteDatabase.openOrCreateDatabase(file, null).use { raw ->
            raw.execSQL("CREATE TABLE room_master_table (id INTEGER PRIMARY KEY, identity_hash TEXT)")
            raw.execSQL("INSERT INTO room_master_table (id, identity_hash) VALUES (42, 'not-this-schema')")
            raw.execSQL("CREATE TABLE stale (x INTEGER)")
            raw.version = CacheDatabase.VERSION
        }

        val holder = CacheDatabaseHolder(context, name, diag)
        val db = holder.get()
        db.cachedResponses().upsert(CachedResponseEntity("k", null, "{}", 1))
        assertEquals("{}", db.cachedResponses().get("k")?.body)
        assertFalse(holder.isVolatile)
        assertTrue(diag.lines.toString(), diag.lines.any { "failed verification" in it })
        assertTrue(diag.lines.any { "rebuilding" in it })
    }

    @Test
    fun aResetStartsEmptyAndMovesTheGeneration() = runTest {
        val holder = CacheDatabaseHolder(context, name, diag)
        holder.get().cachedResponses().upsert(CachedResponseEntity("k", null, "{}", 1))
        assertEquals(0, holder.generation.value)

        holder.reset("test")

        assertEquals(1, holder.generation.value)
        assertNull(holder.get().cachedResponses().get("k"))
    }

    @Test
    fun theResponseCacheGoesThroughTheHolder() = runTest {
        val holder = CacheDatabaseHolder(context, name, diag)
        val cache = RoomResponseCache(holder, diag)
        cache.write("me", CachedResponse("\"1\"", "{}", 5))
        assertEquals("\"1\"", cache.read("me")?.etag)
        holder.reset("test")
        assertNull("a reset cache reads as a miss, never an error", cache.read("me"))
    }
}
