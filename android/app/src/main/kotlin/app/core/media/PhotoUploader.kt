package app.core.media

import app.core.common.Clock
import app.core.common.Diag
import app.core.model.Id
import app.core.model.PhotoMime
import app.core.model.PhotoProcessing
import app.core.model.PhotoUploadTicket
import app.core.model.ProblemCodes
import app.core.net.ApiError
import app.core.net.ServerApi
import kotlinx.coroutines.delay
import java.io.File

/**
 * One photo, from bytes on the phone to "processing" on the server:
 *
 * 1. `POST /v1/me/photos` for a presigned upload at a free position;
 * 2. the bytes go straight to storage ([BlobTransport]), with the API's
 *    session nowhere near them;
 * 3. `POST /v1/me/photos/:id/complete` hands it to the server's pipeline
 *    (EXIF and GPS stripped, variants, moderation). Nobody sees it before
 *    the moderation says so.
 *
 * A dropped connection retries the same ticket (the PUT is idempotent and
 * the ticket lives an hour); a position someone else took meanwhile (another
 * phone) moves to the next free one.
 */
class PhotoUploader(
    private val api: ServerApi,
    private val blobs: BlobTransport,
    private val clock: Clock,
    private val diag: Diag,
) {
    /** Where an upload got to, for a retry that should not start over. */
    class Progress internal constructor() {
        @Volatile internal var ticket: PhotoUploadTicket? = null
        @Volatile internal var uploaded: Boolean = false
        val photoId: Id? get() = ticket?.photoId
    }

    /**
     * Uploads [bytes] at [position] (or, when taken, the next of
     * [otherPositions]). [onProgress] gets the bytes' share sent, 0..1.
     * Throws [ApiError] when it cannot finish; calling again with the same
     * [progress] carries on from where it stopped.
     */
    suspend fun upload(
        bytes: ByteArray,
        position: Int,
        otherPositions: List<Int> = emptyList(),
        progress: Progress = Progress(),
        onProgress: (Float) -> Unit = {},
    ): PhotoProcessing {
        val ticket = progress.ticket?.takeIf { it.upload.expiresAt?.isAfter(clock.now().plusSeconds(60)) ?: true }
            ?: startAt(listOf(position) + otherPositions, bytes.size.toLong()).also {
                progress.ticket = it
                progress.uploaded = false
            }
        if (!progress.uploaded) {
            put(ticket, bytes, onProgress)
            progress.uploaded = true
        }
        return try {
            api.completePhotoUpload(ticket.photoId)
        } catch (e: ApiError.Http) {
            if (e.code != ProblemCodes.UPLOAD_MISSING) throw e
            // Storage had not kept it after all: once more, then complete.
            diag.info(AREA, "upload missing at complete; sending again")
            put(ticket, bytes, onProgress)
            api.completePhotoUpload(ticket.photoId)
        }
    }

    private suspend fun startAt(positions: List<Int>, size: Long): PhotoUploadTicket {
        var last: ApiError? = null
        for (position in positions.distinct().take(MAX_POSITIONS)) {
            try {
                return api.startPhotoUpload(position, PhotoMime.Jpeg, size)
            } catch (e: ApiError.Http) {
                if (e.code != ProblemCodes.POSITION_TAKEN) throw e
                last = e
            }
        }
        throw last ?: ApiError.Http(409, app.core.model.Problem.of(409, ProblemCodes.POSITION_TAKEN))
    }

    private suspend fun put(ticket: PhotoUploadTicket, bytes: ByteArray, onProgress: (Float) -> Unit) {
        var attempt = 0
        while (true) {
            try {
                blobs.put(ticket.upload, bytes, PreparedPhoto.MIME, onProgress)
                return
            } catch (e: ApiError.Network) {
                attempt++
                if (attempt >= PUT_ATTEMPTS) throw e
                delay(PUT_BACKOFF_MS * attempt)
            }
        }
    }

    private companion object {
        const val AREA = "PhotoUploader"
        const val PUT_ATTEMPTS = 3
        const val PUT_BACKOFF_MS = 1_500L
        const val MAX_POSITIONS = 4
    }
}

/**
 * The photos this phone uploaded, kept in the cache folder by photo id, so a
 * tile can show the picture at once while the server is still processing it
 * (its own URL arrives only once it is approved). The system may clear it;
 * the tile then waits for the server's copy.
 */
class LocalPhotoCache(private val dir: File) {
    fun save(photoId: Id, bytes: ByteArray) {
        runCatching {
            dir.mkdirs()
            File(dir, name(photoId)).writeBytes(bytes)
        }
    }

    fun file(photoId: Id): File? = File(dir, name(photoId)).takeIf { it.isFile }

    fun remove(photoId: Id) {
        runCatching { File(dir, name(photoId)).delete() }
    }

    fun clear() {
        runCatching { dir.listFiles()?.forEach { it.delete() } }
    }

    // Ids are decimal strings; anything else is refused rather than used as a path.
    private fun name(photoId: Id): String = photoId.filter(Char::isDigit).ifEmpty { "0" } + ".jpg"
}
