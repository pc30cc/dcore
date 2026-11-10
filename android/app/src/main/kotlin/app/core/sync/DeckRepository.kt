package app.core.sync

import app.core.common.Clock
import app.core.common.Diag
import app.core.model.Conversation
import app.core.model.DeckPage
import app.core.model.DeckSuggestion
import app.core.model.LikedItem
import app.core.model.ProblemCodes
import app.core.model.ProfileCard
import app.core.model.PublicUid
import app.core.model.Quota
import app.core.model.Swipe
import app.core.model.SwipeAction
import app.core.model.SwipeOutcome
import app.core.model.SwipesResult
import app.core.net.ApiError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant

/** Why the deck cannot be shown at all; each has its own way out on screen. */
enum class DeckBlock { OnboardingIncomplete, Snoozed, LocationRequired }

/** What the deck screen shows when it has no card to draw. */
sealed interface DeckStatus {
    /** The first page is on its way. */
    data object Loading : DeckStatus

    /** Cards are queued, or the next page is on its way while some are. */
    data object Ready : DeckStatus

    /** The server has nobody more for these filters: offer to widen them. */
    data object Exhausted : DeckStatus

    /** No answer from the server. */
    data object Offline : DeckStatus

    /** The server answered with a failure the screen cannot fix by itself. */
    data object Failed : DeckStatus

    data class Blocked(val reason: DeckBlock) : DeckStatus
}

/** The side a card comes back from when it returns to the top of the stack. */
enum class ReturnSide { Left, Right, Top }

data class ReturningCard(val id: PublicUid, val side: ReturnSide)

data class DeckState(
    /** Top first. */
    val cards: List<ProfileCard> = emptyList(),
    val status: DeckStatus = DeckStatus.Loading,
    val suggestions: List<DeckSuggestion> = emptyList(),
    /** The person whose pass a rewind would undo now, or null. */
    val rewindable: PublicUid? = null,
    /** A card that just came back on top (rewind, a like that did not go), to animate in once. */
    val returning: ReturningCard? = null,
    /** True while a page is being fetched behind cards already shown. */
    val loadingMore: Boolean = false,
)

/** What became of a like or a super like. */
sealed interface LikeOutcome {
    /** The server has it. */
    data object Sent : LikeOutcome

    /** It was mutual: [conversation] is the new match's conversation (null only if the server left it out). */
    data class Matched(val card: ProfileCard, val conversation: Conversation?) : LikeOutcome

    /** No likes (or super likes) left; [resetsAt] is when they come back, when the server said. */
    data class OutOfQuota(val action: SwipeAction, val resetsAt: Instant?) : LikeOutcome

    /** The comment was refused by moderation; nothing was sent. */
    data object CommentRefused : LikeOutcome

    /** Too many swipes this hour. */
    data object RateLimited : LikeOutcome

    /** No answer: nothing was sent. */
    data object Offline : LikeOutcome

    data object Failed : LikeOutcome
}

/**
 * The deck: the queue of cards, the swipes on their way, and the page
 * requests, for the deck screen and for the likes list's "like back".
 *
 * Rules that keep the server light (docs: "client rules"):
 * - a page is asked for only when 5 or fewer cards are left, and the waiting
 *   passes are sent first, so the page starts after them;
 * - passes are batched, likes sent at once with the waiting passes
 *   ([SwipeOutbox]);
 * - the queue and the unsent swipes are saved ([DeckSnapshotStore]), so a
 *   launch shows the previous cards with no request.
 *
 * Every method is called on the main thread; [scope]'s coroutines run there.
 */
class DeckRepository(
    private val scope: CoroutineScope,
    private val fetchPage: suspend (limit: Int) -> DeckPage,
    sendSwipes: suspend (List<Swipe>) -> SwipesResult,
    /** The signed-in account's public id, or null. */
    private val account: suspend () -> PublicUid?,
    private val store: DeckSnapshotStore = MemoryDeckSnapshotStore(),
    private val onQuotas: (SwipesResult) -> Unit = {},
    private val clock: Clock = Clock.System,
    private val diag: Diag = Diag.Silent,
    val pageSize: Int = PAGE_SIZE,
) {
    val queue = DeckQueue()

    private val _state = MutableStateFlow(DeckState())
    val state: StateFlow<DeckState> = _state.asStateFlow()

    val outbox = SwipeOutbox(
        scope = scope,
        send = sendSwipes,
        onSent = onQuotas,
        diag = diag,
        onChanged = { rewindable ->
            _state.update { it.copy(rewindable = rewindable) }
            scheduleSave()
        },
    )

    private var loadedFor: PublicUid? = null
    private var starting: Job? = null
    private var fetching: Job? = null
    private var saveJob: Job? = null
    private var exhausted = false

    /** [exhausted] came from the saved deck, not from a page this launch: worth one more look when it runs out. */
    private var exhaustedFromSnapshot = false
    private var emptyPages = 0

    /** The last card passed, kept for a rewind. */
    private var lastPassed: ProfileCard? = null

    /**
     * Shows the deck: the saved cards when they are recent and the account's,
     * then the next page if they are few. Called each time the screen opens;
     * cheap when nothing is wanted.
     */
    fun start() {
        if (starting?.isActive == true) return
        starting = scope.launch {
            val uid = account()
            if (uid == null) {
                reset(clearSaved = false)
                publish(status = DeckStatus.Failed)
                return@launch
            }
            if (loadedFor != uid) {
                if (loadedFor != null) reset(clearSaved = true)
                loadedFor = uid
                restore(uid)
            }
            if (queue.wantsMore && !exhausted) fetchMore() else publish()
        }
    }

    private suspend fun restore(uid: PublicUid) {
        val saved = runCatching { store.load() }.getOrNull() ?: return
        if (saved.account != uid) {
            store.save(null)
            return
        }
        outbox.restore(saved.pending)
        queue.markHandled(saved.pending.map { it.target })
        if (clock.nowMillis() - saved.savedAtMillis in 0..DeckSnapshot.MAX_CARD_AGE_MS) {
            queue.load(saved.cards.filterNot { card -> saved.pending.any { it.target == card.id } })
            exhausted = saved.exhausted && !queue.isEmpty
            exhaustedFromSnapshot = exhausted
            _state.update { it.copy(suggestions = saved.suggestions) }
        }
        diag.info(AREA, "restored ${queue.size} cards, ${saved.pending.size} swipes")
        publish(status = if (queue.isEmpty) DeckStatus.Loading else DeckStatus.Ready)
    }

    /** Asks for the next page unless one is on its way. */
    fun fetchMore() {
        if (fetching?.isActive == true) return
        fetching = scope.launch { fetchPage() }
    }

    /** "Try again" on an error screen, or the network came back. */
    fun retry() {
        exhausted = false
        exhaustedFromSnapshot = false
        emptyPages = 0
        if (queue.isEmpty) publish(status = DeckStatus.Loading)
        fetchMore()
    }

    /**
     * The filters changed (`PATCH /v1/me/preferences` rebuilds the server's
     * deck): the queued cards no longer fit them. Swipes already made stay
     * handled and are still sent.
     */
    fun filtersChanged() {
        fetching?.cancel()
        queue.clear()
        outbox.pending().forEach { queue.markHandled(listOf(it.target)) }
        lastPassed = null
        exhausted = false
        exhaustedFromSnapshot = false
        emptyPages = 0
        publish(status = DeckStatus.Loading)
        scope.launch {
            // The server rebuilds the deck in the background after the change;
            // the first page may be asked for a moment later.
            delay(REBUILD_WAIT_MS)
            fetchMore()
        }
    }

    private suspend fun fetchPage() {
        if (queue.isEmpty) publish(status = DeckStatus.Loading) else _state.update { it.copy(loadingMore = true) }
        try {
            outbox.flush()
            val page = fetchPage(pageSize)
            val added = queue.add(page.cards)
            exhausted = page.exhausted
            exhaustedFromSnapshot = false
            emptyPages = if (added == 0) emptyPages + 1 else 0
            diag.info(AREA, "page: ${page.cards.size} cards, $added new, exhausted=${page.exhausted}")
            _state.update { it.copy(suggestions = page.suggestions.filter { s -> s != DeckSuggestion.Unknown }) }
            when {
                !queue.isEmpty -> publish(status = DeckStatus.Ready)
                exhausted -> publish(status = DeckStatus.Exhausted)
                emptyPages <= EMPTY_PAGE_RETRIES -> {
                    // Nothing new yet, and the server says more is coming: its
                    // queue is being refilled in the background.
                    publish(status = DeckStatus.Loading)
                    delay(EMPTY_PAGE_WAIT_MS shl (emptyPages - 1))
                    fetchPage()
                }
                else -> {
                    exhausted = true
                    publish(status = DeckStatus.Exhausted)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            diag.warn(AREA, "page failed (${e.code ?: e.javaClass.simpleName})")
            if (queue.isEmpty) publish(status = statusFor(e)) else _state.update { it.copy(loadingMore = false) }
        } finally {
            _state.update { it.copy(loadingMore = false) }
        }
    }

    private fun statusFor(e: ApiError): DeckStatus = when {
        e is ApiError.Network -> DeckStatus.Offline
        e is ApiError.Http && e.status == 403 && e.code == ProblemCodes.ONBOARDING_INCOMPLETE -> DeckStatus.Blocked(DeckBlock.OnboardingIncomplete)
        e is ApiError.Http && e.status == 403 && e.code == ProblemCodes.SNOOZED -> DeckStatus.Blocked(DeckBlock.Snoozed)
        e is ApiError.Http && e.status == 403 && e.code == ProblemCodes.LOCATION_REQUIRED -> DeckStatus.Blocked(DeckBlock.LocationRequired)
        else -> DeckStatus.Failed
    }

    /** A pass on [card] (from the deck or the likes list): it leaves with the next batch. */
    fun pass(card: ProfileCard) {
        queue.remove(card.id)
        outbox.pass(card.id)
        lastPassed = card
        afterSwipe()
    }

    /**
     * [card] leaves the deck after a block or a report, and is no longer the
     * pass a rewind brings back. A block needs nothing more (the server keeps
     * the two apart); with [pass] (a report without a block, which hides
     * nobody on the server) a pass goes out with the next batch, so later
     * pages leave them out too.
     */
    fun drop(card: ProfileCard, pass: Boolean = false) {
        queue.remove(card.id)
        if (pass) outbox.pass(card.id, rewindable = false)
        if (lastPassed?.id == card.id) lastPassed = null
        afterSwipe()
    }

    /**
     * A like or a super like on [card], optionally on one photo or prompt
     * ([item]) with a [comment]. The card leaves the queue at once; if the
     * like does not go through it comes back on top.
     */
    suspend fun like(
        card: ProfileCard,
        action: SwipeAction = SwipeAction.Like,
        item: LikedItem? = null,
        comment: String? = null,
    ): LikeOutcome {
        require(action == SwipeAction.Like || action == SwipeAction.Superlike) { "like() sends likes and super likes" }
        val wasQueued = queue.remove(card.id) != null
        lastPassed = null
        afterSwipe()
        val swipe = Swipe(card.id, action, item, comment?.trim()?.takeIf { it.isNotEmpty() })
        val outcome = try {
            val result = outbox.sendNow(swipe)
            val mine = result.results.firstOrNull { it.target == card.id }
            when (mine?.result) {
                SwipeOutcome.Matched -> LikeOutcome.Matched(card, mine.conversation)
                SwipeOutcome.Quota -> {
                    val quota: Quota? = if (action == SwipeAction.Superlike) result.quotas.superlikes else result.quotas.likes
                    LikeOutcome.OutOfQuota(action, quota?.resetsAt)
                }
                else -> LikeOutcome.Sent
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            diag.warn(AREA, "like not sent (${e.code ?: e.javaClass.simpleName})")
            when {
                e is ApiError.Network -> LikeOutcome.Offline
                e is ApiError.Http && e.code == ProblemCodes.TEXT_REFUSED -> LikeOutcome.CommentRefused
                e is ApiError.Http && e.status == 429 -> LikeOutcome.RateLimited
                else -> LikeOutcome.Failed
            }
        }
        if (outcome !is LikeOutcome.Sent && outcome !is LikeOutcome.Matched && wasQueued) {
            queue.restore(card)
            publish(status = DeckStatus.Ready, returning = ReturningCard(card.id, if (action == SwipeAction.Superlike) ReturnSide.Top else ReturnSide.Right))
        }
        return outcome
    }

    /** Undoes the last pass while it is still on the phone. Returns the card that came back, or null. */
    fun rewind(): ProfileCard? {
        val card = lastPassed ?: return null
        if (!outbox.takeBack(card.id)) return null
        lastPassed = null
        queue.restore(card)
        publish(status = DeckStatus.Ready, returning = ReturningCard(card.id, ReturnSide.Left))
        return card
    }

    /** The screen drew a returning card: do not animate it in again. */
    fun returnShown(id: PublicUid) {
        _state.update { if (it.returning?.id == id) it.copy(returning = null) else it }
    }

    /** The app went to the background: send everything waiting, and save. */
    fun onBackground() {
        outbox.flushAll()
        saveNow()
    }

    private fun afterSwipe() {
        if (queue.isEmpty && exhaustedFromSnapshot) {
            // "Nobody more" was said in an earlier launch: ask once now.
            exhausted = false
            exhaustedFromSnapshot = false
        }
        publish(status = when {
            !queue.isEmpty -> DeckStatus.Ready
            exhausted -> DeckStatus.Exhausted
            else -> DeckStatus.Loading
        })
        if (queue.wantsMore && !exhausted) fetchMore()
    }

    private fun publish(status: DeckStatus? = null, returning: ReturningCard? = null) {
        _state.update {
            it.copy(
                cards = queue.snapshot(),
                status = status ?: it.status,
                returning = returning ?: it.returning?.takeIf { r -> queue.top?.id == r.id },
            )
        }
        scheduleSave()
    }

    private fun scheduleSave() {
        if (saveJob?.isActive == true) return
        saveJob = scope.launch {
            delay(SAVE_DEBOUNCE_MS)
            save()
        }
    }

    private fun saveNow() {
        saveJob?.cancel()
        saveJob = scope.launch { save() }
    }

    private suspend fun save() {
        val uid = loadedFor ?: return
        val snapshot = DeckSnapshot(
            account = uid,
            savedAtMillis = clock.nowMillis(),
            cards = queue.snapshot(),
            pending = outbox.pending(),
            suggestions = _state.value.suggestions,
            exhausted = exhausted,
        )
        runCatching { store.save(snapshot) }.onFailure { diag.warn(AREA, "deck snapshot not saved: ${it.javaClass.simpleName}") }
    }

    private suspend fun reset(clearSaved: Boolean) {
        fetching?.cancel()
        queue.clear()
        lastPassed = null
        exhausted = false
        emptyPages = 0
        loadedFor = null
        if (clearSaved) runCatching { store.save(null) }
        _state.value = DeckState()
    }

    companion object {
        const val PAGE_SIZE = 10
        const val SAVE_DEBOUNCE_MS = 500L
        const val REBUILD_WAIT_MS = 1_200L
        const val EMPTY_PAGE_WAIT_MS = 1_500L
        const val EMPTY_PAGE_RETRIES = 3
        private const val AREA = "Deck"
    }
}
