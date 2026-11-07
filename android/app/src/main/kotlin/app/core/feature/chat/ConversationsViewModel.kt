package app.core.feature.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.core.model.Conversation
import app.core.model.Id
import app.core.model.PublicUid
import app.core.model.RequestBox
import app.core.push.PushAvailability
import app.core.realtime.RealtimeHealth
import app.core.sync.ChatSync
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** What the chat list shows. */
data class ConversationsUiState(
    val me: PublicUid? = null,
    /** Matches nobody has written in yet: the row of faces at the top. */
    val newMatches: List<Conversation> = emptyList(),
    /** Conversations with a last message, newest activity first. */
    val conversations: List<Conversation> = emptyList(),
    val typing: Set<Id> = emptySet(),
    val requests: Int = 0,
    /** Nothing stored yet, and the first read is on its way. */
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    /** The last read failed for lack of a network; what is shown is what the phone has. */
    val offline: Boolean = false,
    val failed: Boolean = false,
    val connection: RealtimeHealth = RealtimeHealth.IDLE,
    /** No push on this phone (no Google Play services): news arrives only while the app is open. */
    val pushUnavailable: Boolean = false,
) {
    val empty: Boolean get() = newMatches.isEmpty() && conversations.isEmpty() && requests == 0
}

/**
 * The chat list, read from the cache; realtime and the sync keep it current.
 * The screen itself never polls: it asks only when the person pulls.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ConversationsViewModel(
    private val sync: ChatSync,
    pushAvailability: Flow<PushAvailability>,
) : ViewModel() {

    private val pushNoticeDismissed = MutableStateFlow(false)
    private val pulling = MutableStateFlow(false)

    private val rows: Flow<List<Conversation>> = sync.account.flatMapLatest { who ->
        if (who == null) flowOf(emptyList()) else sync.conversations.observeList(who)
    }

    private val status = combine(sync.list, sync.health, pulling) { list, health, pull -> Triple(list, health, pull) }

    private val push = combine(pushAvailability, pushNoticeDismissed) { availability, dismissed ->
        availability == PushAvailability.NO_PLAY_SERVICES && !dismissed
    }

    val state: StateFlow<ConversationsUiState> =
        combine(sync.account, rows, sync.typing, sync.requests.inbox, combine(status, push) { s, p -> s to p }) { me, all, typing, inbox, statusAndPush ->
            val (st, pushUnavailable) = statusAndPush
            val (list, health, pull) = st
            ConversationsUiState(
                me = me,
                newMatches = all.filter { it.lastMessage == null },
                conversations = all.filter { it.lastMessage != null },
                typing = typing.keys,
                requests = inbox.items.size,
                loading = all.isEmpty() && !list.readOnce && !list.failed && inbox.items.isEmpty(),
                refreshing = pull,
                offline = list.offline || health == RealtimeHealth.DEGRADED && list.failed,
                failed = list.failed,
                connection = health,
                pushUnavailable = pushUnavailable,
            )
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_AFTER_MS), ConversationsUiState())

    /** The screen is shown: the inbox of requests is read once per process. */
    fun shown() {
        viewModelScope.launch { sync.requests.ensure(RequestBox.Inbox) }
    }

    fun refresh() {
        if (pulling.value) return
        pulling.value = true
        viewModelScope.launch {
            try {
                sync.refreshList()
                sync.requests.refresh(RequestBox.Inbox)
            } finally {
                pulling.value = false
            }
        }
    }

    /** The end of the list came into view: the next page, if there is one. */
    fun nearEnd() {
        val who = sync.account.value ?: return
        viewModelScope.launch {
            if (sync.conversations.hasMore(who)) sync.conversations.loadMore(who)
        }
    }

    fun dismissPushNotice() {
        pushNoticeDismissed.value = true
    }

    private companion object {
        const val STOP_AFTER_MS = 5_000L
    }
}
