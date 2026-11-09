package app.core.net.origins

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

/** The stored document: the exact text, its ETag and time; atomic replacement; damage reads as nothing. */
class FileOriginsStoreTest {

    @get:Rule val folder = TemporaryFolder()

    private fun file() = File(folder.root, "net/origins.json")

    @Test
    fun keepsTheEnvelopeExactlyAsReceived() {
        val text = OriginsKit.sign(OriginsKit.payload()) + "\n"
        val store = FileOriginsStore(file())
        store.write(StoredOrigins(text, "\"o7-abc\"", 1234L))
        // Another instance: a new process after a restart.
        assertEquals(StoredOrigins(text, "\"o7-abc\"", 1234L), FileOriginsStore(file()).read())
        assertFalse("no temporary file is left", File(file().parentFile, "origins.json.tmp").exists())
    }

    @Test
    fun aFailedWriteLeavesTheOldDocument() {
        val store = FileOriginsStore(file())
        store.write(StoredOrigins("old", null, 1L))
        // The temporary file cannot be created: the write fails before the rename.
        File(file().parentFile, "origins.json.tmp").mkdirs()
        try {
            store.write(StoredOrigins("new", null, 2L))
            fail("expected IOException")
        } catch (expected: IOException) {
        }
        assertEquals("old", store.read()?.envelope)
    }

    @Test
    fun nothingOrDamageReadsAsNothing() {
        assertNull(FileOriginsStore(file()).read())
        file().parentFile!!.mkdirs()
        file().writeText("{\"envelope\":")
        assertNull(FileOriginsStore(file()).read())
        file().writeText("x".repeat(70_000))
        assertNull(FileOriginsStore(file()).read())
    }

    @Test
    fun clearRemovesIt() {
        val store = FileOriginsStore(file())
        store.write(StoredOrigins("x", null, 1L))
        store.clear()
        assertNull(store.read())
    }
}
