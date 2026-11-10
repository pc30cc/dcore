package app.core.feature.onboarding

import app.core.ui.components.keepTyped
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.core.common.Clock
import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.auth.AuthGate
import app.core.feature.auth.GateNotice
import app.core.feature.auth.Root
import app.core.feature.legal.LegalAcceptance
import app.core.media.LocalPhotoCache
import app.core.media.PhotoUploader
import app.core.model.AccountLocation
import app.core.model.AccountStatus
import app.core.model.AuthUser
import app.core.model.City
import app.core.model.Config
import app.core.model.ConsentKind
import app.core.model.EXPLICIT_CONSENT_VERSION
import app.core.model.FieldDef
import app.core.model.FieldEdit
import app.core.model.Gender
import app.core.model.Intention
import app.core.model.LegalVersions
import app.core.model.LocationSource
import app.core.model.LocationUpdate
import app.core.model.Me
import app.core.model.NotificationPrefsPatch
import app.core.model.OnboardingCodes
import app.core.model.OwnProfile
import app.core.model.PreferencesPatch
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
import java.time.LocalDate
import java.time.Period
import java.time.ZoneId

/** What went wrong with a step, in the terms the step shows. */
sealed interface StepError {
    data object Offline : StepError
    data object TextRefused : StepError
    data object Invalid : StepError
    data class RateLimited(val seconds: Long?) : StepError

    /** The server says something required is still missing. */
    data object Incomplete : StepError
    data object Failed : StepError
}

/** A prompt the person picked and what they wrote. */
data class PromptAnswer(val promptId: Int, val answer: String)

/** An answer to a catalogue field: one of the four, by the field's kind. */
data class FieldAnswer(val option: Int? = null, val options: Set<Int> = emptySet(), val number: Int? = null, val text: String = "") {
    fun isEmpty(): Boolean = option == null && options.isEmpty() && number == null && text.isBlank()
}

/** Where the location step is. */
sealed interface LocationPhase {
    data object Idle : LocationPhase
    data object Locating : LocationPhase

    /** The phone could not tell (no provider, no fix in time): the city list is the way. */
    data object Unavailable : LocationPhase
    data object Saving : LocationPhase
    data class Set(val city: City?, val country: String?) : LocationPhase
}

data class OnboardingUiState(
    val loading: Boolean = true,
    /** The account could not be read: [StepError.Offline] or [StepError.Failed], with a retry. */
    val loadError: StepError? = null,
    val step: OnboardingStep? = null,
    val position: Int = 0,
    val count: Int = 0,
    val canGoBack: Boolean = false,
    val busy: Boolean = false,
    val error: StepError? = null,
    /** Sign-up is being finished (the last step's answer is in). */
    val finishing: Boolean = false,
    /** Sign-up is finished on the server: the done screen, until the person moves on ([OnboardingViewModel.leave]). */
    val done: AuthUser? = null,

    val name: String = "",
    val birthDate: LocalDate? = null,
    val gender: Gender? = null,
    val interestedIn: Set<Gender> = emptySet(),
    val intention: Intention? = null,
    val prompts: List<PromptAnswer> = emptyList(),
    val fields: Map<Int, FieldAnswer> = emptyMap(),
    val location: LocationPhase = LocationPhase.Idle,
    val cityQuery: String = "",
    val cityResults: List<City> = emptyList(),
    val citySearching: Boolean = false,

    val config: Config? = null,
    val legalVersions: LegalVersions = LegalVersions(),
) {
    /** Age on the birth date as entered, today. */
    fun age(today: LocalDate): Int? = birthDate?.let { Period.between(it, today).years }
}

/**
 * Sign-up, step by step, carried on from wherever the server's account says
 * (another phone included): [OnboardingPlan] picks the step from `GET /v1/me`,
 * and every step writes its answer together with the step reached
 * (`onboardingStep`). The last step finishes sign-up; the server then moves
 * the account to `active` (or `pending_review`), and [AuthGate] moves the app.
 */
class OnboardingViewModel(
    private val api: ServerApi,
    private val gate: AuthGate,
    private val legal: LegalAcceptance,
    private val clock: Clock,
    private val diag: Diag,
    private val saved: SavedStateHandle,
    private val config: () -> Config?,
    uploader: PhotoUploader,
    photoCache: LocalPhotoCache,
    /** Android 13+ and the notification permission not granted yet. */
    private val notificationsAskable: () -> Boolean,
    private val zone: () -> ZoneId = { ZoneId.systemDefault() },
) : ViewModel() {

    private val _state = MutableStateFlow(OnboardingUiState())
    val state: StateFlow<OnboardingUiState> = _state.asStateFlow()

    val photos = PhotosController(
        api = api,
        uploader = uploader,
        cache = photoCache,
        scope = viewModelScope,
        diag = diag,
        onProfile = ::profileChanged,
        onChanged = { refresh(quiet = true) },
    )

    private var me: Me? = null
    private var storedStep = 0
    private var privacyAccepted = false
    private var poll: Job? = null
    private var citySearch: Job? = null

    init {
        load()
    }

    fun today(): LocalDate = clock.now().atZone(zone()).toLocalDate()

    // MARK: - Loading and the plan

    fun load() {
        _state.update { it.copy(loading = me == null, loadError = null) }
        viewModelScope.launch {
            val versions = config()?.legal?.versions ?: LegalVersions()
            privacyAccepted = runCatchingUnlessCancelled { legal.acceptedCurrent(versions) }.getOrNull() != null
            runCatchingUnlessCancelled { api.me().value }
                .onSuccess { fresh ->
                    adopt(fresh, initial = true)
                }
                .onFailure { e ->
                    _state.update { it.copy(loading = false, loadError = if (e is ApiError.Network) StepError.Offline else StepError.Failed) }
                }
        }
    }

    /** Reads the account again (photos processing, a change on another phone). */
    fun refresh(quiet: Boolean = false) {
        // Finished: the done screen stays until the person moves on.
        if (_state.value.done != null) return
        viewModelScope.launch {
            runCatchingUnlessCancelled { api.me() }.onSuccess { fetched ->
                if (fetched.changed || me == null) adopt(fetched.value, initial = false)
            }.onFailure { if (!quiet) diag.info(AREA, "refresh failed: ${it.javaClass.simpleName}") }
        }
    }

    private fun facts(): OnboardingFacts {
        val account = me ?: return emptyFacts()
        return OnboardingFacts.from(account.copy(onboardingStep = maxOf(account.onboardingStep, storedStep)), config(), privacyAccepted, notificationsAskable())
    }

    private fun emptyFacts() = OnboardingFacts(0, "", false, Gender.Unknown, emptyList(), null, 0, 2, false, false, true, privacyAccepted, notificationsAskable(), false, false)

    private fun adopt(fresh: Me, initial: Boolean) {
        // Finished: the done screen stays until the person moves on (a late read never moves the app under it).
        if (_state.value.done != null) return
        me = fresh
        storedStep = maxOf(storedStep, fresh.onboardingStep)
        if (fresh.status != AccountStatus.Onboarding && fresh.status != AccountStatus.Unknown) {
            // Finished elsewhere, or the account's state changed: the gate moves the app.
            gate.accountChanged(AuthUser(fresh.id, fresh.status, fresh.onboardingStep))
            return
        }
        val cfg = config()
        val limits = cfg?.limits
        photos.limits(min = limits?.photosMin ?: 2, max = limits?.photosMax ?: 9)
        photos.sync(fresh.profile?.photos.orEmpty())
        val profile = fresh.profile
        _state.update { s ->
            s.copy(
                loading = false,
                loadError = null,
                config = cfg,
                legalVersions = cfg?.legal?.versions ?: LegalVersions(),
                // Drafts start from the server's answers, once; typing is never overwritten by a refresh.
                name = if (initial || s.name.isEmpty()) profile?.name.orEmpty() else s.name,
                birthDate = profile?.birthDate ?: s.birthDate ?: saved.get<String>(KEY_BIRTH)?.let(LocalDate::parse),
                gender = profile?.gender?.takeIf { it != Gender.Unknown } ?: s.gender,
                interestedIn = if (initial) fresh.preferences?.interestedIn.orEmpty().filter { it != Gender.Unknown }.toSet() else s.interestedIn,
                intention = if (initial) profile?.intention?.takeIf { it != Intention.Unknown } else s.intention ?: profile?.intention,
                prompts = if (initial) profile?.prompts.orEmpty().filter { !it.answer.isNullOrBlank() }.sortedBy { it.position ?: 0 }
                    .map { PromptAnswer(it.promptId, it.answer.orEmpty()) } else s.prompts,
                fields = if (initial) profile?.fields.orEmpty().associate { it.fieldId to FieldAnswer(it.option, it.options.orEmpty().toSet(), it.number, it.text.orEmpty()) } else s.fields,
                location = when {
                    s.location is LocationPhase.Set || fresh.location?.city != null -> LocationPhase.Set(fresh.location?.city, fresh.location?.country)
                    else -> s.location
                },
            )
        }
        if (initial || _state.value.step == null) goTo(OnboardingPlan.resume(facts()))
        else placeProgress(_state.value.step)
        watchProcessing()
    }

    private fun goTo(step: OnboardingStep?) {
        if (step == null) {
            // Everything is there: the finish was not recorded (an app closed at the last moment).
            finish()
            return
        }
        saved[KEY_STEP] = step.name
        placeProgress(step)
    }

    private fun placeProgress(step: OnboardingStep?) {
        step ?: return
        val f = facts()
        val (position, count) = OnboardingPlan.progress(step, f)
        _state.update { it.copy(step = step, position = position, count = count, canGoBack = OnboardingPlan.previous(step, f) != null, error = null) }
    }

    fun back(): Boolean {
        val step = _state.value.step ?: return false
        if (_state.value.busy) return true
        val previous = OnboardingPlan.previous(step, facts()) ?: return false
        goTo(previous)
        return true
    }

    private fun advance(from: OnboardingStep) {
        storedStep = maxOf(storedStep, from.passedCode)
        goTo(OnboardingPlan.next(from, facts()))
    }

    /** Runs [block] for a step with the busy flag and the error mapping; [then] on success. */
    private fun submit(block: suspend () -> Unit, then: () -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val result = runCatchingUnlessCancelled { block() }
            _state.update { it.copy(busy = false) }
            result.onSuccess { then() }.onFailure { e -> failed(e) }
        }
    }

    private fun failed(e: Throwable) {
        val error = when {
            e is ApiError.Network -> StepError.Offline
            e is ApiError.Http && e.code == ProblemCodes.UNDER_AGE -> {
                gate.ended(GateNotice.AccountClosed)
                return
            }
            e is ApiError.Http && e.code == ProblemCodes.TEXT_REFUSED -> StepError.TextRefused
            e is ApiError.Http && e.code == ProblemCodes.RATE_LIMITED -> StepError.RateLimited(e.problem.retryAfterSeconds)
            e is ApiError.Http && (e.code == ProblemCodes.ALREADY_SET || e.code == ProblemCodes.CONSENT_REQUIRED) -> {
                // Another phone moved on, or the texts changed: read the account again and resume from there.
                if (e.code == ProblemCodes.CONSENT_REQUIRED) privacyAccepted = false
                me = null
                load()
                return
            }
            e is ApiError.Http && (e.code == ProblemCodes.FIELD_INVALID || e.code == ProblemCodes.VALIDATION_FAILED || e.status == 422) -> StepError.Invalid
            e is ApiError.Unauthorized -> return
            else -> StepError.Failed
        }
        _state.update { it.copy(error = error) }
    }

    fun dismissError() = _state.update { it.copy(error = null) }

    private fun profileChanged(profile: OwnProfile) {
        me = me?.copy(profile = profile)
        photos.sync(profile.photos)
    }

    private suspend fun writeStep(code: Int, patch: ProfilePatch = ProfilePatch()) {
        val profile = api.updateProfile(patch.copy(onboardingStep = maxOf(storedStep, code)))
        profileChanged(profile)
        storedStep = maxOf(storedStep, code)
    }

    // MARK: - Privacy (a sign-up carried on from another phone)

    fun acceptPrivacy() {
        val versions = _state.value.legalVersions
        submit({
            legal.accept(versions)
            // After the basics the server holds the record: a raised version is accepted there.
            if (me?.profile?.birthDate != null) {
                api.setConsent(ConsentKind.Terms, versions.terms, accepted = true)
                api.setConsent(ConsentKind.Privacy, versions.privacy, accepted = true)
                me = me?.copy(consentsDue = me?.consentsDue.orEmpty() - ConsentKind.Terms - ConsentKind.Privacy)
            }
        }) {
            privacyAccepted = true
            goTo(OnboardingPlan.next(OnboardingStep.Privacy, facts()))
        }
    }

    // MARK: - Name

    fun nameChanged(value: String) = _state.update { it.copy(name = keepTyped(value, it.name, NAME_MAX), error = null) }

    /** A first name: letters (any script), spaces, hyphens and apostrophes, no digits or contact details. */
    fun nameValid(name: String = _state.value.name): Boolean {
        val trimmed = name.trim()
        return trimmed.length in 1..NAME_ACCEPTED && trimmed.none { it.isDigit() || it == '@' || it == '/' || it == ':' } && trimmed.any { it.isLetter() }
    }

    fun submitName() {
        val name = _state.value.name.trim().replace(Regex("\\s+"), " ")
        if (!nameValid(name)) return
        submit({ writeStep(OnboardingStep.Name.passedCode, ProfilePatch(displayName = name)) }) { advance(OnboardingStep.Name) }
    }

    // MARK: - Birth date and gender (the basics, sent once)

    fun birthDateChanged(date: LocalDate?) {
        saved[KEY_BIRTH] = date?.toString()
        _state.update { it.copy(birthDate = date, error = null) }
    }

    /** The birth date is kept here until the gender is picked: the basics go together, once. */
    fun submitBirthDate() {
        if (_state.value.birthDate == null) return
        advance(OnboardingStep.BirthDate)
    }

    fun genderChanged(gender: Gender) = _state.update { it.copy(gender = gender, error = null) }

    fun submitBasics() {
        val s = _state.value
        val birth = s.birthDate ?: return goTo(OnboardingStep.BirthDate)
        val gender = s.gender ?: return
        submit({
            val consents = legal.acceptedCurrent(s.legalVersions) ?: legal.accepted()
                ?: throw ApiError.Http(403, app.core.model.Problem.of(403, ProblemCodes.CONSENT_REQUIRED))
            val profile = api.setBasics(birth, gender, consents)
            profileChanged(profile)
            me = me?.copy(profile = profile)
            writeStep(OnboardingStep.Gender.passedCode)
        }) {
            saved.remove<String>(KEY_BIRTH)
            advance(OnboardingStep.Gender)
        }
    }

    // MARK: - Interested in

    fun toggleInterest(gender: Gender) = _state.update {
        it.copy(interestedIn = if (gender in it.interestedIn) it.interestedIn - gender else it.interestedIn + gender, error = null)
    }

    fun submitInterests() {
        val chosen = _state.value.interestedIn.toList()
        if (chosen.isEmpty()) return
        submit({
            // Matching on gender is an explicit consent of its own; the person gives it by continuing here.
            api.setConsent(ConsentKind.GenderMatching, EXPLICIT_CONSENT_VERSION, accepted = true)
            val prefs = api.updatePreferences(PreferencesPatch(interestedIn = chosen))
            me = me?.copy(preferences = prefs)
            writeStep(OnboardingStep.InterestedIn.passedCode)
        }) { advance(OnboardingStep.InterestedIn) }
    }

    // MARK: - Intention

    fun intentionChanged(intention: Intention) = _state.update { it.copy(intention = intention, error = null) }

    fun submitIntention() {
        val intention = _state.value.intention ?: return
        submit({ writeStep(OnboardingStep.Intention.passedCode, ProfilePatch(intention = intention)) }) { advance(OnboardingStep.Intention) }
    }

    // MARK: - Photos

    fun submitPhotos() {
        if (!photos.state.value.enough) return
        submit({ writeStep(OnboardingStep.Photos.passedCode) }) { advance(OnboardingStep.Photos) }
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
                runCatchingUnlessCancelled { api.me() }.onSuccess { if (it.changed) adopt(it.value, initial = false) }
                wait = (wait * 3 / 2).coerceAtMost(POLL_MAX_MS)
            }
        }
    }

    // MARK: - Prompts

    fun promptAdded(promptId: Int) = _state.update {
        val max = it.config?.limits?.promptsMax ?: 3
        if (it.prompts.size >= max || it.prompts.any { p -> p.promptId == promptId }) it
        else it.copy(prompts = it.prompts + PromptAnswer(promptId, ""))
    }

    fun promptAnswered(promptId: Int, answer: String) = _state.update {
        it.copy(prompts = it.prompts.map { p -> if (p.promptId == promptId) p.copy(answer = keepTyped(answer, p.answer, PROMPT_MAX)) else p }, error = null)
    }

    fun promptRemoved(promptId: Int) = _state.update { it.copy(prompts = it.prompts.filterNot { p -> p.promptId == promptId }) }

    /** «عوض کن»: [promptId]'s place (and its answer) goes to the question [to]. */
    fun promptReplaced(promptId: Int, to: Int) = _state.update {
        if (promptId == to || it.prompts.any { p -> p.promptId == to }) it
        else it.copy(prompts = it.prompts.map { p -> if (p.promptId == promptId) p.copy(promptId = to) else p })
    }

    fun submitPrompts(skip: Boolean = false) {
        val answered = if (skip) emptyList() else _state.value.prompts.filter { it.answer.isNotBlank() }
        val previous = me?.profile?.prompts.orEmpty()
        val edits = answered.mapIndexed { index, p -> PromptEdit(index, p.promptId, p.answer.trim()) } +
            // Positions the person emptied: named with the prompt that was there, answer null.
            previous.filter { (it.position ?: -1) >= answered.size }.distinctBy { it.position }.map { PromptEdit(it.position!!, it.promptId, null) }
        submit({
            writeStep(OnboardingStep.Prompts.passedCode, if (skip || edits.isEmpty()) ProfilePatch() else ProfilePatch(prompts = edits))
        }) { advance(OnboardingStep.Prompts) }
    }

    // MARK: - Fields

    fun fieldChanged(fieldId: Int, answer: FieldAnswer) = _state.update { it.copy(fields = it.fields + (fieldId to answer), error = null) }

    /** Catalogue fields sign-up offers, required ones first. */
    fun offeredFields(): List<FieldDef> = config()?.catalog?.fields.orEmpty().filter { it.offeredInOnboarding() }.sortedByDescending { it.required }

    fun fieldsComplete(): Boolean = offeredFields().filter { it.required }.all { _state.value.fields[it.id]?.isEmpty() == false }

    fun submitFields(skip: Boolean = false) {
        if (!skip && !fieldsComplete()) return
        val defs = offeredFields().associateBy { it.id }
        val edits = if (skip) emptyList() else _state.value.fields.filterKeys { it in defs }.map { (id, a) ->
            when (defs.getValue(id).kind) {
                "single" -> FieldEdit(id, option = a.option)
                "multi" -> FieldEdit(id, options = a.options.toList().sorted().takeIf { it.isNotEmpty() })
                "number" -> FieldEdit(id, number = a.number)
                else -> FieldEdit(id, text = a.text.trim().takeIf { it.isNotEmpty() })
            }
        }
        submit({ writeStep(OnboardingStep.Fields.passedCode, if (edits.isEmpty()) ProfilePatch() else ProfilePatch(fields = edits)) }) {
            advance(OnboardingStep.Fields)
        }
    }

    // MARK: - Location

    fun locating() = _state.update { it.copy(location = LocationPhase.Locating, error = null) }

    fun locationUnavailable() = _state.update { it.copy(location = LocationPhase.Unavailable) }

    /** A position from the phone (coarse): the server keeps only its cell and answers with the city. */
    fun located(lat: Double, lng: Double, accuracyM: Int?, fromGps: Boolean) =
        saveLocation(LocationUpdate(lat = lat, lng = lng, accuracyM = accuracyM, source = if (fromGps) LocationSource.Gps else LocationSource.Network))

    fun cityPicked(city: City) = saveLocation(LocationUpdate(source = LocationSource.City, cityId = city.id))

    private fun saveLocation(update: LocationUpdate) {
        if (_state.value.busy) return
        val before = _state.value.location
        _state.update { it.copy(location = LocationPhase.Saving, busy = true, error = null) }
        viewModelScope.launch {
            runCatchingUnlessCancelled { api.updateLocation(update) }
                .onSuccess { result ->
                    me = me?.copy(location = (me?.location ?: AccountLocation()).copy(city = result.city, country = result.country))
                    _state.update {
                        it.copy(busy = false, location = LocationPhase.Set(result.city, result.country), cityQuery = "", cityResults = emptyList())
                    }
                    // The area is the whole step: on to the next one.
                    submitLocation()
                }
                .onFailure { e ->
                    // A refusal puts the step back where it was (a device fix that failed: the city list).
                    val back = when (before) {
                        is LocationPhase.Set -> before
                        LocationPhase.Locating -> LocationPhase.Unavailable
                        else -> before
                    }
                    _state.update { it.copy(busy = false, location = back) }
                    failed(e)
                }
        }
    }

    fun cityQueryChanged(query: String) {
        _state.update { it.copy(cityQuery = query) }
        citySearch?.cancel()
        val q = query.trim()
        if (q.length < 2) {
            _state.update { it.copy(cityResults = emptyList(), citySearching = false) }
            return
        }
        citySearch = viewModelScope.launch {
            delay(CITY_DEBOUNCE_MS)
            _state.update { it.copy(citySearching = true) }
            val results = runCatchingUnlessCancelled { api.cities(q) }.getOrElse { e ->
                _state.update { it.copy(error = if (e is ApiError.Network) StepError.Offline else StepError.Failed) }
                emptyList()
            }
            _state.update { it.copy(cityResults = results.take(CITY_RESULTS), citySearching = false) }
        }
    }

    fun submitLocation() {
        if (_state.value.location !is LocationPhase.Set) return
        submit({ writeStep(OnboardingStep.Location.passedCode) }) { advance(OnboardingStep.Location) }
    }

    // MARK: - Notifications

    /** Asked (granted or not) or skipped: either way the step is passed. */
    fun submitNotifications() {
        submit({ writeStep(OnboardingStep.Notifications.passedCode) }) { advance(OnboardingStep.Notifications) }
    }

    /**
     * «روشن کن» with the two switches: what is switched off is saved on the
     * account first (both kinds of each pair), then [then] asks the phone.
     */
    fun turnOnNotifications(matches: Boolean, messages: Boolean, then: () -> Unit) {
        if (matches && messages) {
            then()
            return
        }
        submit({
            api.updateNotifications(NotificationPrefsPatch(matches = matches, likes = matches, messages = messages, calls = messages))
        }) { then() }
    }

    // MARK: - Guidelines and the finish

    fun acceptGuidelines() {
        val version = _state.value.legalVersions.guidelines
        submit({
            api.setConsent(ConsentKind.Guidelines, version, accepted = true)
            me = me?.copy(consentsDue = me?.consentsDue.orEmpty() - ConsentKind.Guidelines)
        }) {
            storedStep = maxOf(storedStep, OnboardingStep.Guidelines.passedCode)
            finish()
        }
    }

    /** `onboardingStep = DONE`: the server checks the account and moves it out of sign-up. */
    private fun finish() {
        if (_state.value.finishing) return
        _state.update { it.copy(finishing = true, busy = true, error = null) }
        viewModelScope.launch {
            val result = runCatchingUnlessCancelled {
                api.updateProfile(ProfilePatch(onboardingStep = OnboardingCodes.DONE))
                api.me().value
            }
            _state.update { it.copy(busy = false) }
            result.onSuccess { fresh ->
                me = fresh
                if (fresh.status == AccountStatus.Onboarding) {
                    // Accepted, yet not finished: show what the plan still finds missing.
                    _state.update { it.copy(finishing = false, error = StepError.Incomplete) }
                    goTo(OnboardingPlan.resume(facts()) ?: OnboardingStep.Guidelines)
                } else {
                    // Nothing more to wait for here: a photo still in review is the app's to follow from now on.
                    poll?.cancel()
                    poll = null
                    _state.update { it.copy(done = AuthUser(fresh.id, fresh.status, fresh.onboardingStep)) }
                }
            }.onFailure { e ->
                _state.update { it.copy(finishing = false) }
                if (e is ApiError.Http && e.status == 422) {
                    // Something required is not on the server: read it again and go there.
                    runCatchingUnlessCancelled { api.me().value }.onSuccess { me = it; photos.sync(it.profile?.photos.orEmpty()) }
                    goTo(OnboardingPlan.resume(facts()) ?: OnboardingStep.Guidelines)
                    _state.update { it.copy(error = StepError.Incomplete) }
                } else {
                    failed(e)
                    if (_state.value.step == null) goTo(OnboardingStep.Guidelines)
                }
            }
        }
    }

    /**
     * From the done screen into the app: the account's own place (the deck,
     * or the review screen while the profile waits for one); [profile] opens
     * the Profile tab there, where there is one.
     */
    fun leave(profile: Boolean = false, openProfile: () -> Unit = {}) {
        val user = _state.value.done ?: return
        if (profile && Root.of(user) == Root.Main) openProfile()
        gate.signedIn(user)
    }

    /** Sign-up left from its first step (back, then «خروج»). */
    fun signOut() {
        viewModelScope.launch { gate.signOut() }
    }

    companion object {
        /** What a new name or answer may be typed up to (the design's counters). */
        const val NAME_MAX = 20
        const val PROMPT_MAX = 150
        /** A name the server accepts (`displayName` max 40): one kept from an older, longer limit still goes through. */
        const val NAME_ACCEPTED = 40
        private const val AREA = "Onboarding"
        private const val KEY_STEP = "onboarding.step"
        private const val KEY_BIRTH = "onboarding.birth"
        private const val POLL_FIRST_MS = 2_000L
        private const val POLL_MAX_MS = 15_000L
        private const val POLL_FOR_MS = 180_000L
        private const val CITY_DEBOUNCE_MS = 300L
        private const val CITY_RESULTS = 20
    }
}
