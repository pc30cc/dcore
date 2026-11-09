package app.core.net.origins

import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * The last accepted origins document as received (the envelope's exact text),
 * the `ETag` `GET /v1/origins` gave for it (null when it came from a published
 * copy) and when the list was last confirmed.
 */
data class StoredOrigins(val envelope: String, val etag: String?, val fetchedAtMillis: Long)

/** Where the accepted document is kept between runs. */
interface OriginsStore {
    /** Null when nothing is stored, or what is stored does not read. */
    fun read(): StoredOrigins?

    /** Replaces what is stored, all or nothing. */
    fun write(value: StoredOrigins)

    fun clear()
}

/**
 * One small file in app-private storage, written atomically: the new content
 * goes to a temporary file that is flushed to disk and then renamed over the
 * old one, so a crash or a full disk leaves either the old document or the new
 * one, never half of either.
 */
class FileOriginsStore(private val file: File) : OriginsStore {

    @Serializable
    private class Record(val envelope: String, val etag: String? = null, val fetchedAt: Long = 0)

    override fun read(): StoredOrigins? {
        if (!file.isFile || file.length() > MAX_FILE_BYTES) return null
        return try {
            val record = json.decodeFromString(Record.serializer(), file.readText(Charsets.UTF_8))
            StoredOrigins(record.envelope, record.etag, record.fetchedAt)
        } catch (e: IOException) {
            null
        } catch (e: SerializationException) {
            null
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    override fun write(value: StoredOrigins) {
        val text = json.encodeToString(Record.serializer(), Record(value.envelope, value.etag, value.fetchedAtMillis))
        val dir = file.absoluteFile.parentFile ?: throw IOException("no folder for the origins file")
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("cannot create the origins folder")
        val temporary = File(dir, file.name + ".tmp")
        FileOutputStream(temporary).use { out ->
            out.write(text.toByteArray(Charsets.UTF_8))
            out.flush()
            out.fd.sync()
        }
        if (!temporary.renameTo(file)) {
            temporary.delete()
            throw IOException("cannot replace the origins file")
        }
    }

    override fun clear() {
        file.delete()
        File(file.absoluteFile.parentFile, file.name + ".tmp").delete()
    }

    private companion object {
        const val MAX_FILE_BYTES = 64 * 1024L
        val json = Json { ignoreUnknownKeys = true }
    }
}

/** In memory: tests. */
class MemoryOriginsStore(initial: StoredOrigins? = null) : OriginsStore {
    @Volatile var value: StoredOrigins? = initial
        private set

    override fun read(): StoredOrigins? = value

    override fun write(value: StoredOrigins) {
        this.value = value
    }

    override fun clear() {
        value = null
    }
}
