package app.core.feature.deck

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.core.feature.card.LikeTarget
import app.core.media.PhotoPreloader
import app.core.model.BoostStarted
import app.core.model.DiscoveryPreferences
import app.core.model.Entitlements
import app.core.model.Id
import app.core.model.Me
import app.core.model.OwnPhoto
import app.core.model.Photo
import app.core.model.PhotoStatus
import app.core.model.PreferencesPatch
import app.core.model.ProfileCard
import app.core.model.Settings
import app.core.model.SettingsPatch
import app.core.model.SwipeAction
import app.core.net.ApiError
import app.core.sync.DeckQueue
import app.core.sync.DeckRepository
import app.core.sync.DeckState
import app.core.sync.DeckStatus
import app.core.sync.EntitlementRepository
import app.core.sync.LikeOutcome
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant

/** The server calls the deck screen makes besides the deck itself. */
interface DeckServices {
    suspend fun me(): Me
    suspend fun updatePreferences(patch: PreferencesPatch): DiscoveryPreferences
    suspend fun updateSettings(patch: SettingsPatch): Settings
    suspend fun boost(): BoostStarted
}

/** A bottom sheet over the deck. */
sealed interface DeckSheet {
    data class OutOfQuota(val action: SwipeAction, val resetsAt: Instant?) : DeckSheet
    data object RewindUpsell : DeckSheet
    data object Filters : DeckSheet
    data class LikeItem(val target: LikeTarget) : DeckSheet
}

enum class ItemLikeError { Refused, Offline, Failed }

data class ItemLikeState(val sending: Boolean = false, val error: ItemLikeError? = null)

/** The full-screen match moment: who, the new conversation, and this account's own photo. */
data class MatchUi(val card: ProfileCard, val conversationId: Id?, val myPhoto: Photo?)

/** A one-line message under the deck. */
enum class DeckNotice {
    LikeOffline, LikeFailed, RateLimited, RewindNothing, Offline, BoostStarted, BoostNone, FiltersFailed, FiltersLimit, SnoozeFailed,
}

data class DeckMessage(val notice: DeckNotice, val id: Long, val at: Instant? = null)

data class DeckUiState(
    val deck: DeckState = DeckState(),
    val entitlements: Entitlements? = null,
    val preferences: DiscoveryPreferences? = null,
    val details: ProfileCard? = null,
    val sheet: DeckSheet? = null,
    val itemLike: ItemLikeState = ItemLikeState(),
    val match: MatchUi? = null,
    /** A filter change is being saved (the out-of-cards buttons or the sheet). */
    val saving: Boolean = false,
    val message: DeckMessage? = null,
) {
    /** Super likes the account can still send, when the entitlements are known. */
    val superlikesLeft: Int?
        get() = entitlements?.let { e ->
            val quota = e.quotas.superlikes
            val fromQuota = when {
                quota == null -> 0
                quota.unlimited -> return@let null
                else -> quota.left
            }
            fromQuota + e.wallet.superlike
        }
}

private data class Local(
    val preferences: DiscoveryPreferences? = null,
    val myPhoto: Photo? = null,
    val details: ProfileCard? = null,
    val sheet: DeckSheet? = null,
    val itemLike: ItemLikeState = ItemLikeState(),
    val match: MatchUi? = null,
    val saving: Boolean = false,
    val message: DeckMessage? = null,
)

/**
 * The deck screen's state and actions. The deck itself (queue, batching,
 * pages) is [DeckRepository]'s; this adds what one screen needs on top: the
 * open profile, the sheets, the match moment, the filters and their widening.
 */
class DeckViewModel(
    private val deck: DeckRepository,
    private val entitlements: EntitlementRepository,
    private val services: DeckServices,
    private val preloader: PhotoPreloader,
) : ViewModel() {

    private val local = MutableStateFlow(Local())
    private var messageIds = 0L

    val state: StateFlow<DeckUiState> = combine(deck.state, entitlements.entitlements, local) { d, e, l ->
        DeckUiState(
            deck = d,
            entitlements = e,
            preferences = l.preferences,
            details = l.details,
            sheet = l.sheet,
            itemLike = l.itemLike,
            match = l.match,
            saving = l.saving,
            message = l.message,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, DeckUiState(deck = deck.state.value, entitlements = entitlements.entitlements.value))

    init {
        viewModelScope.launch {
            // The top card and the next three, with all their photos, are always on their way.
            deck.state.map { DeckQueue.preloadUrls(it.cards) }.distinctUntilChanged().collect(preloader::preload)
        }
        viewModelScope.launch {
            // The end of the deck offers to widen the filters: it needs their current values.
            deck.state.map { it.status }.distinctUntilChanged().collect { if (it == DeckStatus.Exhausted) loadMe() }
        }
    }

    /** The screen is in front: the deck starts, or checks it is still this account's. */
    fun start() = deck.start()

    /** The app went to the background. */
    fun stop() = deck.onBackground()

    fun retry() = deck.retry()

    /** The network came back while the deck could not load. */
    fun online() {
        if (deck.state.value.status == DeckStatus.Offline) deck.retry()
    }

    /** A card was thrown (by a finger, a button or TalkBack). */
    fun swiped(card: ProfileCard, action: SwipeAction) {
        when (action) {
            SwipeAction.Pass -> deck.pass(card)
            SwipeAction.Like, SwipeAction.Superlike -> viewModelScope.launch { handle(deck.like(card, action)) }
            SwipeAction.Unknown -> Unit
        }
    }

    fun returnShown(id: String) = deck.returnShown(id)

    fun openDetails(card: ProfileCard) = local.update { it.copy(details = card) }

    fun closeDetails() = local.update { it.copy(details = null) }

    /** Pass, like or super like from the open profile: it closes, and the card leaves the deck. */
    fun fromDetails(action: SwipeAction) {
        val card = local.value.details ?: return
        local.update { it.copy(details = null) }
        swiped(card, action)
    }

    fun openItemLike(target: LikeTarget) = local.update { it.copy(sheet = DeckSheet.LikeItem(target), itemLike = ItemLikeState()) }

    /** A like on one photo or answer, with its comment. The sheet stays open until the server answered. */
    fun sendItemLike(target: LikeTarget, comment: String) {
        if (local.value.itemLike.sending) return
        local.update { it.copy(itemLike = ItemLikeState(sending = true)) }
        viewModelScope.launch {
            when (val outcome = deck.like(target.card, SwipeAction.Like, target.item, comment)) {
                LikeOutcome.Sent, is LikeOutcome.Matched -> {
                    local.update { it.copy(sheet = null, details = null, itemLike = ItemLikeState()) }
                    handle(outcome)
                }
                LikeOutcome.CommentRefused -> local.update { it.copy(itemLike = ItemLikeState(error = ItemLikeError.Refused)) }
                LikeOutcome.Offline -> local.update { it.copy(itemLike = ItemLikeState(error = ItemLikeError.Offline)) }
                LikeOutcome.Failed, LikeOutcome.RateLimited -> local.update { it.copy(itemLike = ItemLikeState(error = ItemLikeError.Failed)) }
                is LikeOutcome.OutOfQuota -> local.update { it.copy(sheet = DeckSheet.OutOfQuota(outcome.action, outcome.resetsAt), itemLike = ItemLikeState()) }
            }
        }
    }

    /** Rewind: the last pass comes back, for accounts that have the feature. */
    fun rewind() {
        viewModelScope.launch {
            val known = entitlements.ensure()
            when {
                known == null -> notice(DeckNotice.Offline)
                !known.features.rewind -> local.update { it.copy(sheet = DeckSheet.RewindUpsell) }
                deck.rewind() == null -> notice(DeckNotice.RewindNothing)
            }
        }
    }

    fun openFilters() {
        local.update { it.copy(sheet = DeckSheet.Filters) }
        loadMe()
    }

    fun dismissSheet() = local.update { it.copy(sheet = null, itemLike = ItemLikeState()) }

    fun dismissMatch() = local.update { it.copy(match = null) }

    fun messageShown(id: Long) = local.update { if (it.message?.id == id) it.copy(message = null) else it }

    /** Saves [patch] and starts the deck again with it. */
    fun applyFilters(patch: PreferencesPatch) {
        if (local.value.saving) return
        local.update { it.copy(saving = true) }
        viewModelScope.launch {
            try {
                val saved = services.updatePreferences(patch)
                local.update { it.copy(preferences = saved, saving = false, sheet = if (it.sheet == DeckSheet.Filters) null else it.sheet) }
                deck.filtersChanged()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                local.update { it.copy(saving = false) }
                notice(
                    when {
                        e is ApiError.Network -> DeckNotice.Offline
                        e is ApiError.Http && e.status == 429 -> DeckNotice.FiltersLimit
                        else -> DeckNotice.FiltersFailed
                    },
                )
            }
        }
    }

    /** "Search up to N km" at the end of the deck. */
    fun widenDistance() {
        val prefs = local.value.preferences ?: return loadMe()
        applyFilters(Widening.distance(prefs))
    }

    /** "Widen ages to A-B" at the end of the deck. */
    fun widenAge() {
        val prefs = local.value.preferences ?: return loadMe()
        applyFilters(Widening.age(prefs))
    }

    fun boost() {
        viewModelScope.launch {
            try {
                val started = services.boost()
                notice(DeckNotice.BoostStarted, started.endsAt)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                notice(if (e is ApiError.Network) DeckNotice.Offline else DeckNotice.BoostNone)
            }
        }
    }

    /** Snooze off, from the snoozed state. */
    fun wakeUp() {
        viewModelScope.launch {
            try {
                services.updateSettings(SettingsPatch(snoozed = false))
                deck.retry()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                notice(if (e is ApiError.Network) DeckNotice.Offline else DeckNotice.SnoozeFailed)
            }
        }
    }

    private suspend fun handle(outcome: LikeOutcome) {
        when (outcome) {
            LikeOutcome.Sent -> Unit
            is LikeOutcome.Matched -> {
                // At once, with this account's photo as soon as it is known.
                local.update { it.copy(match = MatchUi(outcome.card, outcome.conversation?.id, it.myPhoto)) }
                if (local.value.myPhoto == null) {
                    loadMeNow()
                    local.update { l -> l.copy(match = l.match?.takeIf { it.card.id == outcome.card.id }?.copy(myPhoto = l.myPhoto) ?: l.match) }
                }
            }
            is LikeOutcome.OutOfQuota -> local.update { it.copy(sheet = DeckSheet.OutOfQuota(outcome.action, outcome.resetsAt)) }
            LikeOutcome.Offline -> notice(DeckNotice.LikeOffline)
            LikeOutcome.RateLimited -> notice(DeckNotice.RateLimited)
            LikeOutcome.CommentRefused, LikeOutcome.Failed -> notice(DeckNotice.LikeFailed)
        }
    }

    private fun notice(notice: DeckNotice, at: Instant? = null) {
        local.update { it.copy(message = DeckMessage(notice, ++messageIds, at)) }
    }

    private fun loadMe() {
        if (local.value.preferences != null) return
        viewModelScope.launch { loadMeNow() }
    }

    private suspend fun loadMeNow() {
        try {
            val me = services.me()
            local.update {
                it.copy(
                    preferences = me.preferences ?: it.preferences,
                    myPhoto = me.profile?.photos?.let(::firstShownPhoto) ?: it.myPhoto,
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            // The screen works without it: generic labels, no own photo in the match moment.
        }
    }

    companion object {
        /** The account's own first approved photo, as a [Photo] the image loader can draw. */
        fun firstShownPhoto(photos: List<OwnPhoto>): Photo? = photos
            .sortedBy { it.position }
            .firstOrNull { it.status == PhotoStatus.Approved && !it.url.isNullOrBlank() }
            ?.let { Photo(it.id, it.w, it.h, it.blurhash, it.url!!) }
    }
}

/** How the end of the deck widens the filters: one step at a time, within the server's bounds. */
object Widening {
    const val MAX_DISTANCE_KM = 300
    const val MIN_AGE = 18
    const val MAX_AGE = 99
    const val AGE_STEP = 3

    /** Twice as far (at least 20 km more), up to [MAX_DISTANCE_KM]; past that, the whole country. */
    fun distance(prefs: DiscoveryPreferences): PreferencesPatch =
        if (prefs.maxDistanceKm >= MAX_DISTANCE_KM) {
            PreferencesPatch(wholeCountry = true)
        } else {
            PreferencesPatch(maxDistanceKm = nextDistance(prefs.maxDistanceKm))
        }

    fun nextDistance(km: Int): Int = maxOf(km * 2, km + 20).coerceAtMost(MAX_DISTANCE_KM)

    /** Whether widening the distance now means "the whole country". */
    fun widensToCountry(prefs: DiscoveryPreferences): Boolean = prefs.maxDistanceKm >= MAX_DISTANCE_KM

    fun age(prefs: DiscoveryPreferences): PreferencesPatch {
        val (min, max) = nextAges(prefs)
        return PreferencesPatch(ageMin = min, ageMax = max)
    }

    fun nextAges(prefs: DiscoveryPreferences): Pair<Int, Int> =
        (prefs.ageMin - AGE_STEP).coerceAtLeast(MIN_AGE) to (prefs.ageMax + AGE_STEP).coerceAtMost(MAX_AGE)

    /** Nothing left to widen: the whole country and every age already. */
    fun ageIsWidest(prefs: DiscoveryPreferences): Boolean = prefs.ageMin <= MIN_AGE && prefs.ageMax >= MAX_AGE
}
