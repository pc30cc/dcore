package app.core.feature.onboarding

import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.media.LocalPhotoCache
import app.core.media.PhotoUploader
import app.core.model.Id
import app.core.model.OwnPhoto
import app.core.model.OwnProfile
import app.core.model.PhotoStatus
import app.core.model.ProblemCodes
import app.core.net.ApiError
import app.core.net.ServerApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File

/** Why a photo did not go up. */
enum class UploadError { Offline, TooMany, Failed }

/** One tile of the photo grid. */
sealed interface PhotoTile {
    /** Stable across recompositions and moves. */
    val key: String

    /** On its way up: [progress] 0..1 of the bytes, then the server's pipeline. */
    data class Uploading(override val key: String, val position: Int, val progress: Float, val preview: File?) : PhotoTile

    data class Failed(override val key: String, val position: Int, val error: UploadError, val preview: File?) : PhotoTile

    /** On the server: processing, in review, approved or rejected (with its reason). */
    data class Uploaded(val photo: OwnPhoto, val preview: File?) : PhotoTile {
        override val key: String get() = "p:${photo.id}"
    }
}

data class PhotosState(
    val tiles: List<PhotoTile> = emptyList(),
    val max: Int = 9,
    val min: Int = 2,
    /** A delete, a reorder in flight. */
    val busy: Boolean = false,
    val error: UploadError? = null,
    /** `photo_min`: the server would not let this one go. */
    val keepMinimum: Boolean = false,
) {
    val uploaded: List<OwnPhoto> get() = tiles.filterIsInstance<PhotoTile.Uploaded>().map { it.photo }

    /** Photos that count toward the minimum: on the server and not refused. */
    val usable: Int get() = uploaded.count { it.status != PhotoStatus.Rejected && it.status != PhotoStatus.Unknown }

    val uploading: Boolean get() = tiles.any { it is PhotoTile.Uploading }

    /** The server is still deciding on one: worth asking again shortly. */
    val processing: Boolean get() = uploaded.any { it.status == PhotoStatus.Processing || it.status == PhotoStatus.Review }

    val free: Int get() = (max - tiles.size).coerceAtLeast(0)

    val enough: Boolean get() = usable >= min && !uploading
}

/** The positions and ordering rules of the grid, without I/O. */
object PhotoGrid {
    /** The positions an upload may take: none of the server's photos and no upload in flight holds them. */
    fun freePositions(taken: Collection<Int>, max: Int): List<Int> = (0 until max).filter { it !in taken }

    /** [ids] with the element at [from] moved to [to]. */
    fun <T> move(ids: List<T>, from: Int, to: Int): List<T> {
        if (from !in ids.indices || to !in ids.indices || from == to) return ids
        val list = ids.toMutableList()
        val item = list.removeAt(from)
        list.add(to, item)
        return list
    }
}

/**
 * The photo step's grid: uploads (several at once), their progress, the
 * server's states as they change, removal and reordering.
 *
 * The server's account is the truth ([sync] with every fresh `GET /v1/me`);
 * the uploads in flight live here only, and a finished one becomes the
 * server's tile.
 */
class PhotosController(
    private val api: ServerApi,
    private val uploader: PhotoUploader,
    private val cache: LocalPhotoCache,
    private val scope: CoroutineScope,
    private val diag: Diag,
    private val onProfile: (OwnProfile) -> Unit,
    /** After an upload or a delete: the account changed, read it again. */
    private val onChanged: () -> Unit,
) {
    private val _state = MutableStateFlow(PhotosState())
    val state: StateFlow<PhotosState> = _state.asStateFlow()

    private class Pending(
        val key: String,
        var position: Int,
        val bytes: ByteArray,
        val progress: PhotoUploader.Progress = PhotoUploader.Progress(),
        var job: Job? = null,
        var tile: PhotoTile,
    )

    private val pending = linkedMapOf<String, Pending>()
    private var server: List<OwnPhoto> = emptyList()
    private var localCounter = 0

    fun limits(min: Int, max: Int) = _state.update { it.copy(min = min, max = max) }

    /** The server's photos, as `GET /v1/me` (or an edit's answer) last said. */
    fun sync(photos: List<OwnPhoto>) {
        server = photos.sortedBy { it.position }
        publish()
    }

    /** A prepared photo (cropped, compressed) to upload; refused when the grid is full. */
    fun add(bytes: ByteArray): Boolean {
        val state = _state.value
        if (state.free <= 0) {
            _state.update { it.copy(error = UploadError.TooMany) }
            return false
        }
        val key = "l:${++localCounter}"
        val taken = server.map { it.position } + pending.values.map { it.position }
        val position = PhotoGrid.freePositions(taken, state.max).firstOrNull() ?: return false
        val preview = cache.saveTemp(key, bytes)
        val entry = Pending(key, position, bytes, tile = PhotoTile.Uploading(key, position, 0f, preview))
        pending[key] = entry
        _state.update { it.copy(error = null) }
        start(entry)
        publish()
        return true
    }

    fun retry(key: String) {
        val entry = pending[key] ?: return
        if (entry.job?.isActive == true) return
        entry.tile = PhotoTile.Uploading(key, entry.position, 0f, previewOf(entry))
        start(entry)
        publish()
    }

    /** Removes [key]: cancels an upload, or deletes the server's photo. */
    fun remove(key: String) {
        pending[key]?.let { entry ->
            entry.job?.cancel()
            pending.remove(key)
            cache.removeTemp(key)
            publish()
            return
        }
        val photo = server.firstOrNull { "p:${it.id}" == key } ?: return
        _state.update { it.copy(busy = true, keepMinimum = false) }
        scope.launch {
            runCatchingUnlessCancelled { api.deletePhoto(photo.id) }
                .onSuccess {
                    cache.remove(photo.id)
                    server = server.filterNot { it.id == photo.id }
                    onChanged()
                }
                .onFailure { e ->
                    val minimum = (e as? ApiError.Http)?.code.let { it == ProblemCodes.PHOTO_MIN || it == ProblemCodes.LAST_PHOTO }
                    _state.update { it.copy(error = if (minimum) null else errorOf(e), keepMinimum = minimum) }
                }
            _state.update { it.copy(busy = false) }
            publish()
        }
    }

    /**
     * Moves the server's photo [from] → [to] (indices among the server's
     * photos) and saves the order. The grid moves at once; a refusal puts it back.
     */
    fun move(from: Int, to: Int) {
        val before = server
        val moved = PhotoGrid.move(before, from, to)
        if (moved == before) return
        server = moved.mapIndexed { index, photo -> photo.copy(position = index) }
        publish()
        _state.update { it.copy(busy = true) }
        scope.launch {
            runCatchingUnlessCancelled { api.reorderPhotos(moved.map { it.id }) }
                .onSuccess { profile -> onProfile(profile) }
                .onFailure { e ->
                    server = before
                    _state.update { it.copy(error = errorOf(e)) }
                }
            _state.update { it.copy(busy = false) }
            publish()
        }
    }

    fun dismissError() = _state.update { it.copy(error = null, keepMinimum = false) }

    private fun start(entry: Pending) {
        entry.job = scope.launch {
            val others = PhotoGrid.freePositions(server.map { it.position } + pending.values.filter { it !== entry }.map { it.position }, _state.value.max)
                .filter { it != entry.position }
            runCatchingUnlessCancelled {
                uploader.upload(entry.bytes, entry.position, others, entry.progress) { sent ->
                    entry.tile = PhotoTile.Uploading(entry.key, entry.position, sent, previewOf(entry))
                    publish()
                }
            }.onSuccess { processing ->
                cache.save(processing.id, entry.bytes)
                cache.removeTemp(entry.key)
                pending.remove(entry.key)
                // Shown at once as processing; the next read of the account brings its real state.
                server = (server.filterNot { it.id == processing.id } +
                    OwnPhoto(processing.id, processing.position, processing.status)).sortedBy { it.position }
                publish()
                onChanged()
            }.onFailure { e ->
                diag.info(AREA, "upload failed: ${(e as? ApiError)?.code ?: e.javaClass.simpleName}")
                entry.tile = PhotoTile.Failed(entry.key, entry.position, errorOf(e), previewOf(entry))
                publish()
            }
        }
    }

    private fun previewOf(entry: Pending): File? = cache.temp(entry.key)

    private fun errorOf(e: Throwable): UploadError = when {
        e is ApiError.Network -> UploadError.Offline
        e is ApiError.Http && e.code == ProblemCodes.PHOTO_LIMIT -> UploadError.TooMany
        else -> UploadError.Failed
    }

    private fun publish() {
        val tiles = server.map { PhotoTile.Uploaded(it, cache.file(it.id)) } + pending.values.map { it.tile }
        _state.update { it.copy(tiles = tiles) }
    }

    private companion object {
        const val AREA = "Photos"
    }
}

/** A picked photo's bytes before the server named it, under a local key. */
internal fun LocalPhotoCache.saveTemp(key: String, bytes: ByteArray): File? {
    save(tempId(key), bytes)
    return file(tempId(key))
}

internal fun LocalPhotoCache.temp(key: String): File? = file(tempId(key))

internal fun LocalPhotoCache.removeTemp(key: String) = remove(tempId(key))

// Local keys are "l:<n>"; temp files live beside the photos under a name no server id can have (ids never start with 0).
private fun tempId(key: String): Id = "0" + key.filter(Char::isDigit)
