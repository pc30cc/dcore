package app.core.feature.profile

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.core.LocalAppGraph
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.onboarding.LocalPreview
import app.core.feature.onboarding.StepError
import app.core.media.PhotoImage
import app.core.model.Catalog
import app.core.model.Me
import app.core.model.OwnPhoto
import app.core.model.OwnProfile
import app.core.model.Photo
import app.core.model.PhotoStatus
import app.core.model.ProfileCard
import app.core.model.ProfilePrompt
import app.core.net.ApiError
import app.core.net.ServerApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The account as the Profile tab draws it: `GET /v1/me` (revalidated with its ETag, so a repeat read is cheap). */
data class OwnProfileUi(
    val loading: Boolean = true,
    val me: Me? = null,
    val error: StepError? = null,
)

/** Reads the account for the Profile tab; [refresh] whenever the tab comes into view. */
class OwnProfileModel(private val api: ServerApi) : ViewModel() {
    private val _state = MutableStateFlow(OwnProfileUi())
    val state: StateFlow<OwnProfileUi> = _state.asStateFlow()
    private var reading: Job? = null

    fun refresh() {
        if (reading?.isActive == true) return
        _state.update { it.copy(loading = it.me == null, error = null) }
        reading = viewModelScope.launch {
            runCatchingUnlessCancelled { api.me().value }
                .onSuccess { me -> _state.update { it.copy(loading = false, me = me, error = null) } }
                .onFailure { e -> _state.update { it.copy(loading = false, error = if (e is ApiError.Network) StepError.Offline else StepError.Failed) } }
        }
    }
}

/** The account's photos in their order. */
internal val OwnProfile.orderedPhotos: List<OwnPhoto> get() = photos.sortedBy { it.position }

/** The photo that leads the profile: the first one with a picture to draw (refused ones never lead). */
internal val OwnProfile.mainPhoto: OwnPhoto? get() = orderedPhotos.firstOrNull { it.status != PhotoStatus.Rejected }

/**
 * The profile as other people see it ([app.core.feature.card.ProfileDetails]
 * draws it for «پیش‌نمایش»): approved photos only, the answered prompts in
 * their order, and the fields that are not kept private.
 */
internal fun OwnProfile.asSeenByOthers(catalog: Catalog): ProfileCard {
    val private = catalog.fields.filter { it.isPrivate }.map { it.id }.toSet()
    return ProfileCard(
        id = id,
        v = v,
        name = name,
        age = age,
        gender = gender,
        verified = verified,
        intention = intention,
        job = job,
        about = about,
        city = city,
        traveling = traveling,
        photos = orderedPhotos
            .filter { it.status == PhotoStatus.Approved && !it.url.isNullOrBlank() }
            .map { Photo(it.id, it.w, it.h, it.blurhash, it.url.orEmpty()) },
        prompts = prompts
            .sortedBy { it.position ?: Int.MAX_VALUE }
            .filter { !it.answer.isNullOrBlank() || it.audioUrl != null }
            .map { ProfilePrompt(it.promptId, it.answer, it.audioMs, it.audioUrl) },
        fields = fields.filter { it.fieldId !in private },
    )
}

/**
 * One of the account's own photos: the server's copy once it has one, else
 * the copy this phone uploaded (a photo still being processed has no URL).
 */
@Composable
internal fun OwnPhotoImage(photo: OwnPhoto, modifier: Modifier = Modifier, alignment: Alignment = Alignment.Center) {
    val url = photo.url
    if (!url.isNullOrBlank()) {
        PhotoImage(Photo(photo.id, photo.w, photo.h, photo.blurhash, url), contentDescription = null, modifier = modifier, alignment = alignment)
    } else {
        val cache = LocalAppGraph.current.photoCache
        val file = remember(photo.id) { cache.file(photo.id) }
        LocalPreview(file, modifier)
    }
}
