package app.core.feature.likes

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.core.common.Clock
import app.core.feature.card.LikeTarget
import app.core.feature.deck.DeckViewModel
import app.core.feature.deck.ItemLikeError
import app.core.feature.deck.ItemLikeState
import app.core.feature.deck.MatchUi
import app.core.model.LikeItem
import app.core.model.LikeKind
import app.core.model.LikesPage
import app.core.model.Me
import app.core.model.Photo
import app.core.model.ProfileCard
import app.core.model.SwipeAction
import app.core.net.ApiError
import app.core.sync.DeckRepository
import app.core.sync.EntitlementRepository
import app.core.sync.LikeOutcome
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant

/** The server calls behind the likes list. */
interface LikesServices {
    suspend fun likes(cursor: String?, limit: Int): LikesPage
    suspend fun me(): Me
}

enum class LikesStatus { Loading, Ready, Offline, Failed }

enum class LikesNotice { LikeOffline, LikeFailed, RateLimited, Passed }

data class LikesMessage(val notice: LikesNotice, val id: Long, val name: String? = null)

data class LikesUiState(
    val status: LikesStatus = LikesStatus.Loading,
    val items: List<LikeItem> = emptyList(),
    val total: Int = 0,
    val totalPlus: Boolean = false,
    val nextCursor: String? = null,
    val loadingMore: Boolean = false,
    val moreFailed: Boolean = false,
    val refreshing: Boolean = false,
    /** Whether the plan opens every like; null until known. */
    val seeLikes: Boolean? = null,
    val details: ProfileCard? = null,
    val upsell: Boolean = false,
    val itemLike: LikeTarget? = null,
    val itemLikeState: ItemLikeState = ItemLikeState(),
    val quota: Pair<SwipeAction, Instant?>? = null,
    val match: MatchUi? = null,
    val message: LikesMessage? = null,
) {
    /** True when at least one like is hidden: the plan does not include seeing them. */
    val anyHidden: Boolean get() = items.any { it.liker == null }

    /** Free plan: the like shown open that is neither a super like nor bought access is the day's free look. */
    fun isDailyReveal(item: LikeItem): Boolean =
        item.liker != null && item.kind != LikeKind.Superlike && (seeLikes == false || (seeLikes == null && anyHidden))
}

/**
 * Who liked the account (`GET /v1/likes`). On the free plan the server sends
 * only blurhashes, except the day's free look and super likes; with
 * `see_likes`, every card and comment. Liking back is a normal swipe through
 * the deck's [DeckRepository], so that person also leaves the deck.
 */
class LikesViewModel(
    private val services: LikesServices,
    private val deck: DeckRepository,
    private val entitlements: EntitlementRepository,
    private val clock: Clock = Clock.System,
) : ViewModel() {

    private val _state = MutableStateFlow(LikesUiState())
    val state: StateFlow<LikesUiState> = _state.asStateFlow()

    private var loadedAt = 0L
    private var loading: Job? = null
    private var messageIds = 0L
    private var myPhoto: Photo? = null

    /** The tab is in front: load, or reload when the list is older than a few minutes. */
    fun start() {
        val stale = clock.nowMillis() - loadedAt > STALE_MS
        if (_state.value.status != LikesStatus.Ready || stale) refresh(pull = false)
        viewModelScope.launch {
            entitlements.ensure()?.let { e -> _state.update { it.copy(seeLikes = e.features.seeLikes) } }
        }
    }

    fun refresh(pull: Boolean = true) {
        if (loading?.isActive == true) return
        _state.update { if (pull) it.copy(refreshing = true) else if (it.items.isEmpty()) it.copy(status = LikesStatus.Loading) else it }
        loading = viewModelScope.launch {
            try {
                val page = services.likes(null, PAGE)
                loadedAt = clock.nowMillis()
                _state.update {
                    it.copy(
                        status = LikesStatus.Ready,
                        items = page.items,
                        total = page.total,
                        totalPlus = page.totalPlus,
                        nextCursor = page.nextCursor,
                        refreshing = false,
                        moreFailed = false,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                _state.update {
                    it.copy(
                        refreshing = false,
                        // Keep showing what was there; only an empty screen turns into the error.
                        status = if (it.items.isEmpty()) (if (e is ApiError.Network) LikesStatus.Offline else LikesStatus.Failed) else it.status,
                    )
                }
            }
        }
    }

    /** The end of the grid came into view. */
    fun loadMore() {
        val cursor = _state.value.nextCursor ?: return
        if (_state.value.loadingMore || loading?.isActive == true) return
        _state.update { it.copy(loadingMore = true, moreFailed = false) }
        loading = viewModelScope.launch {
            try {
                val page = services.likes(cursor, PAGE)
                _state.update { s ->
                    val known = s.items.mapNotNull { it.liker?.id }.toSet()
                    s.copy(
                        items = s.items + page.items.filter { it.liker == null || it.liker.id !in known },
                        nextCursor = page.nextCursor,
                        total = page.total,
                        totalPlus = page.totalPlus,
                        loadingMore = false,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                _state.update { it.copy(loadingMore = false, moreFailed = true) }
            }
        }
    }

    fun online() {
        if (_state.value.status == LikesStatus.Offline) refresh(pull = false)
    }

    /** A tile was tapped: an open like shows the profile, a hidden one what would open it. */
    fun open(item: LikeItem) {
        val card = item.liker
        _state.update { if (card != null) it.copy(details = card) else it.copy(upsell = true) }
    }

    fun closeDetails() = _state.update { it.copy(details = null) }

    fun dismissUpsell() = _state.update { it.copy(upsell = false) }

    fun dismissQuota() = _state.update { it.copy(quota = null) }

    fun dismissMatch() = _state.update { it.copy(match = null) }

    fun messageShown(id: Long) = _state.update { if (it.message?.id == id) it.copy(message = null) else it }

    /** "Like back" from the open profile. */
    fun likeBack() {
        val card = _state.value.details ?: return
        _state.update { it.copy(details = null) }
        viewModelScope.launch { handle(card, deck.like(card, SwipeAction.Like)) }
    }

    /** Pass from the open profile: the like leaves the list. */
    fun pass() {
        val card = _state.value.details ?: return
        deck.pass(card)
        _state.update { s -> s.without(card).copy(details = null, message = LikesMessage(LikesNotice.Passed, ++messageIds, card.name)) }
    }

    fun openItemLike(target: LikeTarget) = _state.update { it.copy(itemLike = target, itemLikeState = ItemLikeState()) }

    fun dismissItemLike() = _state.update { it.copy(itemLike = null, itemLikeState = ItemLikeState()) }

    fun sendItemLike(target: LikeTarget, comment: String) {
        if (_state.value.itemLikeState.sending) return
        _state.update { it.copy(itemLikeState = ItemLikeState(sending = true)) }
        viewModelScope.launch {
            val outcome = deck.like(target.card, SwipeAction.Like, target.item, comment)
            when (outcome) {
                LikeOutcome.Sent, is LikeOutcome.Matched -> {
                    _state.update { it.copy(itemLike = null, itemLikeState = ItemLikeState(), details = null) }
                    handle(target.card, outcome)
                }
                LikeOutcome.CommentRefused -> _state.update { it.copy(itemLikeState = ItemLikeState(error = ItemLikeError.Refused)) }
                LikeOutcome.Offline -> _state.update { it.copy(itemLikeState = ItemLikeState(error = ItemLikeError.Offline)) }
                LikeOutcome.Failed, LikeOutcome.RateLimited -> _state.update { it.copy(itemLikeState = ItemLikeState(error = ItemLikeError.Failed)) }
                is LikeOutcome.OutOfQuota -> {
                    _state.update { it.copy(itemLike = null, itemLikeState = ItemLikeState()) }
                    handle(target.card, outcome)
                }
            }
        }
    }

    private suspend fun handle(card: ProfileCard, outcome: LikeOutcome) {
        when (outcome) {
            LikeOutcome.Sent -> _state.update { it.without(card) }
            is LikeOutcome.Matched -> {
                _state.update { it.without(card).copy(match = MatchUi(card, outcome.conversation?.id, myPhoto)) }
                if (myPhoto == null) {
                    myPhoto = runCatching { services.me().profile?.photos?.let(DeckViewModel::firstShownPhoto) }.getOrNull()
                    myPhoto?.let { photo -> _state.update { s -> s.copy(match = s.match?.copy(myPhoto = photo)) } }
                }
            }
            is LikeOutcome.OutOfQuota -> _state.update { it.copy(quota = outcome.action to outcome.resetsAt) }
            LikeOutcome.Offline -> notice(LikesNotice.LikeOffline)
            LikeOutcome.RateLimited -> notice(LikesNotice.RateLimited)
            LikeOutcome.CommentRefused, LikeOutcome.Failed -> notice(LikesNotice.LikeFailed)
        }
    }

    private fun notice(notice: LikesNotice) = _state.update { it.copy(message = LikesMessage(notice, ++messageIds)) }

    private fun LikesUiState.without(card: ProfileCard): LikesUiState {
        val left = items.filterNot { it.liker?.id == card.id }
        return copy(items = left, total = (total - (items.size - left.size)).coerceAtLeast(left.size))
    }

    companion object {
        const val PAGE = 20
        const val STALE_MS = 5 * 60 * 1000L
    }
}
