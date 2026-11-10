package app.core.feature.profile

import androidx.annotation.StringRes
import androidx.annotation.VisibleForTesting
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.core.R
import app.core.common.Clock
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.onboarding.FieldAnswer
import app.core.feature.onboarding.PhotosController
import app.core.feature.onboarding.StepError
import app.core.feature.onboarding.offeredInOnboarding
import app.core.model.Config
import app.core.model.FieldDef
import app.core.model.FieldEdit
import app.core.model.OwnPrompt
import app.core.model.OwnProfile
import app.core.model.ProblemCodes
import app.core.model.ProfilePatch
import app.core.model.PromptEdit
import app.core.net.ApiError
import app.core.net.ServerApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What the profile editor draws. */
data class EditProfileUi(
    val loading: Boolean = true,
    val profile: OwnProfile? = null,
    val loadError: StepError? = null,
    /** A text, a field or a question on its way to the server. */
    val saving: Boolean = false,
)

/** How a save went: the sheet closes on [Saved], says [Failed.text] and keeps what was written otherwise. */
sealed interface SaveOutcome {
    data object Saved : SaveOutcome

    data class Failed(@param:StringRes val text: Int) : SaveOutcome

    /** Nothing was sent: another save is still out, or there is nothing to save. */
    data object NotSent : SaveOutcome
}

/**
 * The profile editor's work, through the account's own routes: the photos
 * ([photos]: add, remove, reorder, the server's states while it decides;
 * kept by the app in [ownPhotos], so what is on its way finishes after the
 * editor closes), the questions, the catalogue's fields, the job and the
 * about text (each `PATCH /v1/me/profile` with only what changed; the answer
 * is the profile as it now is). A save answers how it went ([SaveOutcome]:
 * the sheet closes only once saved, and says why and keeps the text
 * otherwise); the profile stays as the server has it. An answer older than
 * the profile already held is ignored.
 */
class EditProfileModel(
    private val api: ServerApi,
    private val ownPhotos: OwnPhotos,
    private val clock: Clock,
    private val config: () -> Config?,
) : ViewModel() {
    private val _state = MutableStateFlow(EditProfileUi())
    val state: StateFlow<EditProfileUi> = _state.asStateFlow()

    val photos: PhotosController = ownPhotos.controller
    private var poll: Job? = null

    init {
        config()?.limits?.let { photos.limits(it.photosMin, it.photosMax) }
        viewModelScope.launch { ownPhotos.profiles.collect { adopt(it) } }
        viewModelScope.launch { ownPhotos.changed.collect { refresh() } }
        load()
    }

    /** Prepares a framed picture and adds it, where closing the editor cannot cancel it. */
    suspend fun addPhoto(prepare: suspend () -> ByteArray?): Boolean = ownPhotos.addPrepared(prepare)

    fun load() {
        _state.update { it.copy(loading = it.profile == null, loadError = null) }
        viewModelScope.launch {
            runCatchingUnlessCancelled { api.me().value }
                .onSuccess { me -> me.profile?.let(::adopt) ?: _state.update { it.copy(loading = false, loadError = StepError.Failed) } }
                .onFailure { e -> _state.update { it.copy(loading = false, loadError = if (e is ApiError.Network) StepError.Offline else StepError.Failed) } }
        }
    }

    /** Reads the account again (a photo processed, a change on another phone). */
    fun refresh() {
        viewModelScope.launch {
            runCatchingUnlessCancelled { api.me() }.onSuccess { fetched ->
                if (fetched.changed || _state.value.profile == null) fetched.value.profile?.let(::adopt)
            }
        }
    }

    /** The fields the editor offers: the catalogue's, as sign-up offers them (sensitive ones need a consent this screen does not ask for). */
    fun fields(): List<FieldDef> = config()?.catalog?.fields.orEmpty().filter { it.offeredInOnboarding() }

    /** The questions answered in writing, in their order (the ones the editor lists). */
    fun prompts(): List<OwnPrompt> = answered().filter { !it.answer.isNullOrBlank() }

    /** Every answered question, written or spoken: what counts toward the limit and holds a position. */
    fun answered(): List<OwnPrompt> = _state.value.profile?.prompts.orEmpty()
        .filter { !it.answer.isNullOrBlank() || it.audioMs != null || it.audioUrl != null }
        .sortedBy { it.position ?: Int.MAX_VALUE }

    fun promptsMax(): Int = config()?.limits?.promptsMax ?: DEFAULT_PROMPTS

    fun aboutMax(): Int = config()?.limits?.aboutMax ?: DEFAULT_ABOUT

    /**
     * Writes [answer] to [promptId]: in place of [replacing] (the question at
     * that position, changed or edited), else at the first free position (a
     * spoken answer holds its position too).
     */
    suspend fun savePrompt(promptId: Int, answer: String, replacing: OwnPrompt? = null): SaveOutcome {
        val text = answer.trim()
        if (text.isEmpty()) return SaveOutcome.NotSent
        val taken = answered().mapNotNull { it.position }.toSet()
        val position = replacing?.position ?: (0 until promptsMax()).firstOrNull { it !in taken } ?: return SaveOutcome.Failed(R.string.settings_save_failed)
        return save(ProfilePatch(prompts = listOf(PromptEdit(position, promptId, text))))
    }

    suspend fun removePrompt(prompt: OwnPrompt): SaveOutcome {
        val position = prompt.position ?: return SaveOutcome.Failed(R.string.settings_save_failed)
        return save(ProfilePatch(prompts = listOf(PromptEdit(position, prompt.promptId, null))))
    }

    /** One catalogue field; an empty [answer] removes it. */
    suspend fun saveField(field: FieldDef, answer: FieldAnswer): SaveOutcome {
        val edit = when (field.kind) {
            "single" -> FieldEdit(field.id, option = answer.option)
            "multi" -> FieldEdit(field.id, options = answer.options.toList().sorted().takeIf { it.isNotEmpty() })
            "number" -> FieldEdit(field.id, number = answer.number)
            else -> FieldEdit(field.id, text = answer.text.trim().takeIf { it.isNotEmpty() })
        }
        return save(ProfilePatch(fields = listOf(edit)))
    }

    suspend fun saveJob(text: String): SaveOutcome = save(ProfilePatch(jobTitle = text.trim()))

    suspend fun saveAbout(text: String): SaveOutcome = save(ProfilePatch(about = text.trim()))

    /** One save at a time: a second one while the first is out is not sent (the sheet's button waits). */
    private suspend fun save(patch: ProfilePatch): SaveOutcome {
        if (_state.value.saving) return SaveOutcome.NotSent
        _state.update { it.copy(saving = true) }
        return try {
            runCatchingUnlessCancelled { api.updateProfile(patch) }.fold(
                onSuccess = { profile ->
                    adopt(profile)
                    SaveOutcome.Saved
                },
                onFailure = { e -> SaveOutcome.Failed(failureText(e)) },
            )
        } finally {
            _state.update { it.copy(saving = false) }
        }
    }

    @VisibleForTesting
    internal fun adopt(profile: OwnProfile) {
        val held = _state.value.profile
        // An answer that left the server before the one already drawn: the newer one stays.
        if (held != null && profile.v < held.v) return
        _state.update { it.copy(loading = false, loadError = null, profile = profile) }
        photos.sync(profile.photos)
        watchProcessing()
    }

    /** While the server decides on a photo, ask again with a growing wait (2 s up to 15 s), for at most 3 minutes. */
    private fun watchProcessing() {
        if (!photos.state.value.processing) {
            poll?.cancel()
            poll = null
            return
        }
        if (poll?.isActive == true) return
        poll = viewModelScope.launch {
            var wait = POLL_FIRST_MS
            val until = clock.nowMillis() + POLL_FOR_MS
            while (photos.state.value.processing && clock.nowMillis() < until) {
                delay(wait)
                runCatchingUnlessCancelled { api.me() }.onSuccess { fetched -> if (fetched.changed) fetched.value.profile?.let(::adopt) }
                wait = (wait * 3 / 2).coerceAtMost(POLL_MAX_MS)
            }
        }
    }

    @StringRes
    private fun failureText(e: Throwable): Int = when {
        e is ApiError.Network -> R.string.error_offline
        (e as? ApiError.Http)?.code == ProblemCodes.TEXT_REFUSED -> R.string.onboarding_error_text_refused
        else -> R.string.settings_save_failed
    }

    companion object {
        const val PROMPT_MAX = 150
        const val JOB_MAX = 80
        private const val DEFAULT_PROMPTS = 3
        private const val DEFAULT_ABOUT = 500
        private const val POLL_FIRST_MS = 2_000L
        private const val POLL_MAX_MS = 15_000L
        private const val POLL_FOR_MS = 180_000L
    }
}
