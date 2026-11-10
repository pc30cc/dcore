package app.core.feature.profile

import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.onboarding.PhotosController
import app.core.media.LocalPhotoCache
import app.core.media.PhotoUploader
import app.core.model.OwnProfile
import app.core.net.ServerApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * The account's photos as the profile editor changes them, kept by the app
 * rather than by the editor: an upload, a delete or a reorder already
 * started finishes after the editor closes (its own scope would cancel it),
 * and the editor opened again shows the uploads still on their way. What
 * the work answers reaches whichever editor is open through [profiles] and
 * [changed]. Signing out cancels what is left and starts afresh ([reset]).
 */
class OwnPhotos(
    private val api: ServerApi,
    private val uploader: PhotoUploader,
    private val cache: LocalPhotoCache,
    private val parent: CoroutineScope,
    private val diag: Diag,
) {
    private val _profiles = MutableSharedFlow<OwnProfile>(extraBufferCapacity = BUFFER)

    /** The account as a reorder answered it. */
    val profiles: SharedFlow<OwnProfile> = _profiles.asSharedFlow()

    private val _changed = MutableSharedFlow<Unit>(extraBufferCapacity = BUFFER)

    /** An upload or a delete went through: the account is worth reading again. */
    val changed: SharedFlow<Unit> = _changed.asSharedFlow()

    private var scope = child()

    /** The grid's work, on a scope that outlives any one screen. */
    var controller: PhotosController = make()
        private set

    /** Another account (or none) from now on: what was on its way is dropped. */
    fun reset() {
        scope.cancel()
        scope = child()
        controller = make()
    }

    /**
     * Runs [prepare] (framing and compressing a picked picture) where a
     * closing screen cannot cancel it, then adds the result to the grid.
     * True once it is on its way up.
     */
    suspend fun addPrepared(prepare: suspend () -> ByteArray?): Boolean {
        val target = controller
        return scope.async {
            val bytes = runCatchingUnlessCancelled { prepare() }.getOrNull()
            bytes != null && target.add(bytes)
        }.await()
    }

    private fun child(): CoroutineScope = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]))

    private fun make() = PhotosController(
        api = api,
        uploader = uploader,
        cache = cache,
        scope = scope,
        diag = diag,
        onProfile = { _profiles.tryEmit(it) },
        onChanged = { _changed.tryEmit(Unit) },
    )

    private companion object {
        const val BUFFER = 8
    }
}
