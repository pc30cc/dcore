package app.core.feature.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.core.cache.ChatMapping
import app.core.cache.SendState
import app.core.common.Clock
import app.core.model.Conversation
import app.core.model.ConversationState
import app.core.model.Id
import app.core.model.MessageKind
import app.core.model.ProfileCard
import app.core.model.PublicUid
import app.core.model.ReportReason
import app.core.net.ApiError
import app.core.realtime.RealtimeHealth
import app.core.sync.ChatMessage
import app.core.sync.ChatSync
import app.core.sync.EntitlementRepository
import app.core.sync.OlderRead
import app.core.sync.ThreadRead
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.ZoneId

/** Where a message of the account's own is on its way to being seen. */
enum class Delivery { Pending, Failed, Confirm, Sent, Delivered, Read }

/** One row of the transcript, newest first (the list is drawn bottom-up). */
sealed interface ChatItem {
    val key: String

    data class Bubble(
        val message: ChatMessage,
        val delivery: Delivery?,
        /** Emoji reactions on it, one per person; [mine] is the account's own. */
        val reactions: List<String>,
        val mine: String?,
        /** Taken back by its sender, or hidden by moderation: no text is kept. */
        val unsent: Unsent?,
        /** The next older message is from the same person, close in time: no gap, a flatter corner. */
        val joinsOlder: Boolean,
        val joinsNewer: Boolean,
    ) : ChatItem {
        override val key: String get() = message.localId
    }

    data class Call(val message: ChatMessage) : ChatItem {
        override val key: String get() = message.localId
    }

    data class Day(val date: java.time.LocalDate) : ChatItem {
        override val key: String get() = "day:$date"
    }

    /**
     * The top of a thread: who matched, and when. [showDate] is false when the
     * day separator right under it already names that day ("Yesterday" under
     * "7 November" said the same day twice). [hint] (how to start) only while
     * nothing has been said yet.
     */
    data class Intro(val conversation: Conversation, val showDate: Boolean = true, val hint: Boolean = true) : ChatItem {
        override val key: String get() = "intro"
    }
}

enum class Unsent { BySender, Removed }

/** Something to say once (a snackbar), then forget. */
sealed interface ChatNotice {
    val id: Long

    data class ActionFailed(override val id: Long, val offline: Boolean) : ChatNotice
    data class Reported(override val id: Long, val blocked: Boolean) : ChatNotice
    data class UnsendFailed(override val id: Long) : ChatNotice
    data class Copied(override val id: Long) : ChatNotice
}

/** What the thread screen shows. */
data class ChatUiState(
    val me: PublicUid? = null,
    val conversation: Conversation? = null,
    val items: List<ChatItem> = emptyList(),
    /** The first read is on its way and nothing is stored. */
    val loading: Boolean = true,
    /** The first read failed and nothing is stored. */
    val loadFailed: Boolean = false,
    val offline: Boolean = false,
    val olderLoading: Boolean = false,
    val olderFailed: Boolean = false,
    /** The server has history before the oldest message loaded. */
    val moreOlder: Boolean = true,
    /** The conversation ended (the server never says why): read-only. */
    val ended: Boolean = false,
    /** Not this account's, or gone: nothing to show. */
    val gone: Boolean = false,
    val typing: Boolean = false,
    val connection: RealtimeHealth = RealtimeHealth.IDLE,
    /** A message the server asked "are you sure?" about, waiting for the answer. */
    val confirm: ChatMessage? = null,
    val profile: ProfileCard? = null,
    val profileLoading: Boolean = false,
    val busy: Boolean = false,
    /** The conversation was left (unmatched, blocked): the screen closes. */
    val left: Boolean = false,
    val notice: ChatNotice? = null,
)

/**
 * One thread, local-first: the newest messages from the cache at once, the
 * server asked only when something may be missing ([ChatSync.openThread]),
 * older pages as the person scrolls back. Sends go through the outbox in the
 * app's scope, so leaving the screen never strands a bubble.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModel(
    private val conversationId: Id,
    private val sync: ChatSync,
    private val entitlements: EntitlementRepository,
    private val profiles: suspend (PublicUid) -> ProfileCard,
    private val clock: Clock = Clock.System,
) : ViewModel() {

    private val window = MutableStateFlow(WINDOW)
    private val ui = MutableStateFlow(ChatUiState())
    private var noticeIds = 0L
    private var opening: Job? = null

    private val account: StateFlow<PublicUid?> = sync.account

    private val conversation: Flow<Conversation?> = account.flatMapLatest { who ->
        if (who == null) flowOf(null) else sync.conversations.observe(who, conversationId)
    }

    private val rows: Flow<List<ChatMessage>> = combine(account, window) { who, limit -> who to limit }.flatMapLatest { (who, limit) ->
        if (who == null) flowOf(emptyList()) else sync.messages.observeNewest(who, conversationId, limit).map { list -> list.map { ChatMessage.of(it, who) } }
    }

    private val marks: Flow<List<ChatMessage>> = account.flatMapLatest { who ->
        if (who == null) flowOf(emptyList()) else sync.messages.observeMarks(who, conversationId).map { list -> list.map { ChatMessage.of(it, who) } }
    }

    val state: StateFlow<ChatUiState> = combine(
        combine(ui, account, conversation) { base, me, c -> Triple(base, me, c) },
        combine(rows, marks) { r, m -> r to m },
        combine(sync.typing, sync.health, entitlements.entitlements) { typing, health, ent -> Triple(typing, health, ent?.features?.readReceipts == true) },
    ) { (base, me, conversation), (rows, marks), (typing, health, readReceipts) ->
        val ended = base.ended || conversation?.state == ConversationState.Ended
        base.copy(
            me = me,
            conversation = conversation ?: base.conversation,
            items = buildTranscript(rows, marks, conversation ?: base.conversation, readReceipts, atTop = !base.olderLoading && !base.moreOlder, me = me),
            loading = base.loading && rows.isEmpty(),
            loadFailed = base.loadFailed && rows.isEmpty(),
            ended = ended,
            typing = !ended && (typing[conversationId] ?: 0) > clock.nowMillis(),
            connection = health,
            confirm = rows.firstOrNull { it.mine && it.state == SendState.CONFIRM },
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, ChatUiState())

    init {
        viewModelScope.launch { entitlements.ensure() }
        // Failed unsends and reactions are not left lying around: the target
        // shows as it was, and the person is told once.
        viewModelScope.launch {
            marks.collect { list ->
                list.filter { it.mine && it.state == SendState.FAILED }.forEach { row ->
                    sync.discard(row.localId)
                    if (row.kind == MessageKind.Unsend) notify { ChatNotice.UnsendFailed(it) }
                }
            }
        }
        open()
    }

    /** Reads what may be missing (see [ChatSync.openThread]); "try again" calls it too. */
    fun open() {
        if (opening?.isActive == true) return
        opening = viewModelScope.launch {
            ui.update { it.copy(loadFailed = false, offline = false) }
            val who = account.value
            if (who != null && sync.conversations.get(who, conversationId) == null) {
                // Not in the list yet (a match from a push, or the list was
                // never read): one list read finds it, or it is not ours.
                sync.reconcile("open unknown")
                if (sync.conversations.get(who, conversationId) == null) {
                    ui.update { it.copy(loading = false, gone = true) }
                    return@launch
                }
            }
            when (val result = sync.openThread(conversationId)) {
                is ThreadRead.Read, ThreadRead.UpToDate -> ui.update { it.copy(loading = false) }
                ThreadRead.Gone -> ui.update { it.copy(loading = false, gone = true) }
                ThreadRead.Ended -> ui.update { it.copy(loading = false, ended = true) }
                is ThreadRead.Failed -> ui.update { it.copy(loading = false, loadFailed = true, offline = result.offline) }
            }
            val more = who?.let { sync.messages.syncState(it, conversationId)?.hasMoreBefore } ?: false
            ui.update { it.copy(moreOlder = more) }
        }
    }

    /** The screen is resumed (true) or not: receipts and push suppression follow. */
    fun visible(shown: Boolean) {
        sync.setVisible(conversationId, shown)
    }

    override fun onCleared() {
        sync.closed(conversationId)
    }

    /** The oldest loaded message came into view. */
    fun nearTop(shownRows: Int) {
        val current = state.value
        if (current.olderLoading) return
        if (shownRows >= window.value) {
            // The cache has more: show more of it.
            window.update { it + WINDOW_STEP }
            return
        }
        if (!current.moreOlder || current.olderFailed) return
        ui.update { it.copy(olderLoading = true, olderFailed = false) }
        viewModelScope.launch {
            when (val result = sync.loadOlder(conversationId)) {
                is OlderRead.Read -> {
                    window.update { it + WINDOW_STEP }
                    ui.update { it.copy(olderLoading = false, moreOlder = result.hasMore) }
                }
                OlderRead.NothingMore -> ui.update { it.copy(olderLoading = false, moreOlder = false) }
                is OlderRead.Failed -> ui.update { it.copy(olderLoading = false, olderFailed = true) }
            }
        }
    }

    fun retryOlder() {
        ui.update { it.copy(olderFailed = false) }
        nearTop(0)
    }

    // MARK: - Composing

    fun send(text: String): Boolean {
        val body = text.trim()
        if (body.isEmpty() || state.value.ended || state.value.gone) return false
        viewModelScope.launch { sync.send(conversationId, body) }
        return true
    }

    fun typed() = sync.typed(conversationId)

    fun retry(message: ChatMessage) = sync.retry(message.localId)

    fun delete(message: ChatMessage) = sync.discard(message.localId)

    fun sendAnyway(message: ChatMessage) = sync.confirmSend(message.localId)

    /** Sets the account's reaction to [message]; the same emoji again takes it back. */
    fun react(message: ChatMessage, emoji: String, current: String?) {
        val target = message.serverId ?: return
        viewModelScope.launch { sync.react(conversationId, target, if (emoji == current) "" else emoji) }
    }

    fun unsend(message: ChatMessage) {
        val target = message.serverId ?: return
        if (!message.mine) return
        viewModelScope.launch { sync.unsend(conversationId, target) }
    }

    fun copied() = notify { ChatNotice.Copied(it) }

    // MARK: - The conversation

    fun setMuted(muted: Boolean) = act { sync.setMuted(conversationId, muted).map { } }

    fun unmatch() = act(leaves = true) { sync.unmatch(conversationId) }

    fun block() {
        val peer = state.value.conversation?.peer?.id ?: return
        act(leaves = true) { sync.block(peer) }
    }

    /**
     * Reports the person, with [message] as the evidence when the report
     * started from one, else the newest messages from them (at most 20).
     */
    fun report(reason: ReportReason, details: String?, block: Boolean, message: ChatMessage?) {
        val peer = state.value.conversation?.peer?.id ?: return
        val ids = message?.serverId?.let { listOf(it) }
            ?: state.value.items.filterIsInstance<ChatItem.Bubble>()
                .map { it.message }
                .filter { !it.mine && it.serverId != null }
                .take(MAX_EVIDENCE)
                .mapNotNull { it.serverId }
                .reversed()
        ui.update { it.copy(busy = true) }
        viewModelScope.launch {
            val result = sync.report(peer, conversationId, reason, details, ids, block)
            ui.update { it.copy(busy = false, left = block && result.isSuccess) }
            result
                .onSuccess { notify { id -> ChatNotice.Reported(id, block) } }
                .onFailure { e -> notify { id -> ChatNotice.ActionFailed(id, offline = e is ApiError.Network) } }
        }
    }

    fun openProfile() {
        val peer = state.value.conversation?.peer?.id ?: return
        if (state.value.profileLoading) return
        ui.update { it.copy(profileLoading = true) }
        viewModelScope.launch {
            val card = runCatching { profiles(peer) }
            ui.update { it.copy(profileLoading = false, profile = card.getOrNull()) }
            card.onFailure { e -> notify { id -> ChatNotice.ActionFailed(id, offline = e is ApiError.Network) } }
        }
    }

    fun closeProfile() = ui.update { it.copy(profile = null) }

    fun noticeShown(id: Long) = ui.update { if (it.notice?.id == id) it.copy(notice = null) else it }

    private fun act(leaves: Boolean = false, block: suspend () -> Result<Unit>) {
        if (ui.value.busy) return
        ui.update { it.copy(busy = true) }
        viewModelScope.launch {
            val result = block()
            ui.update { it.copy(busy = false, left = leaves && result.isSuccess) }
            result.onFailure { e -> notify { id -> ChatNotice.ActionFailed(id, offline = e is ApiError.Network) } }
        }
    }

    private fun notify(make: (Long) -> ChatNotice) {
        val notice = make(++noticeIds)
        ui.update { it.copy(notice = notice) }
    }

    private companion object {
        const val WINDOW = 60
        const val WINDOW_STEP = 50
        const val MAX_EVIDENCE = 20
    }
}

/**
 * The transcript, newest first (the list is drawn bottom-up), from the rows
 * of a thread ([rows], newest first) and the marks on them ([marks]:
 * reactions and unsends).
 *
 * The read mark is shown only with [readReceipts] (the plan's feature):
 * without it a message read by the other person reads "delivered" at most,
 * whatever pointer the phone holds. A day separator follows the oldest
 * message of each day; the introduction closes the top only once nothing
 * older exists ([atTop]).
 */
internal fun buildTranscript(
    rows: List<ChatMessage>,
    marks: List<ChatMessage>,
    conversation: Conversation?,
    readReceipts: Boolean,
    atTop: Boolean,
    me: PublicUid?,
    zone: ZoneId = ZoneId.systemDefault(),
): List<ChatItem> {
    val reactions = HashMap<Long, LinkedHashMap<String, String>>()
    val unsent = HashMap<Long, Unsent>()
    val senderOf = rows.mapNotNull { m -> m.serverId?.let { it to m.senderId } }.toMap()
    for (mark in marks) {
        if (mark.state == SendState.FAILED) continue
        val target = mark.refId ?: continue
        when (mark.kind) {
            MessageKind.Reaction -> {
                val byPerson = reactions.getOrPut(target) { LinkedHashMap() }
                val emoji = mark.body.orEmpty()
                if (emoji.isEmpty()) byPerson.remove(mark.senderId) else byPerson[mark.senderId] = emoji
            }
            MessageKind.Unsend -> {
                val sender = senderOf[target]
                unsent[target] = if (sender == null || sender == mark.senderId) Unsent.BySender else Unsent.Removed
            }
            else -> Unit
        }
    }
    val peerRead = ChatMapping.idOf(conversation?.peerReadId)?.takeIf { readReceipts } ?: 0
    val peerDelivered = maxOf(ChatMapping.idOf(conversation?.peerDeliveredId) ?: 0, peerRead)
    val out = ArrayList<ChatItem>(rows.size + 8)
    for ((i, m) in rows.withIndex()) {
        val older = rows.getOrNull(i + 1)
        val newer = rows.getOrNull(i - 1)
        val day = m.at.atZone(zone).toLocalDate()
        if (m.kind == MessageKind.Call) {
            out += ChatItem.Call(m)
        } else {
            val id = m.serverId
            val delivery = if (!m.mine) null else when (m.state) {
                SendState.PENDING -> Delivery.Pending
                SendState.FAILED -> Delivery.Failed
                SendState.CONFIRM -> Delivery.Confirm
                SendState.SENT -> when {
                    id != null && id <= peerRead -> Delivery.Read
                    id != null && id <= peerDelivered -> Delivery.Delivered
                    else -> Delivery.Sent
                }
            }
            val people = id?.let { reactions[it] }.orEmpty()
            out += ChatItem.Bubble(
                message = m,
                delivery = delivery,
                reactions = people.values.toList(),
                mine = me?.let { people[it] },
                unsent = id?.let { unsent[it] },
                joinsOlder = older != null && joins(m, older, zone),
                joinsNewer = newer != null && joins(newer, m, zone),
            )
        }
        val olderDay = older?.at?.atZone(zone)?.toLocalDate()
        if (olderDay != day) out += ChatItem.Day(day)
    }
    if (atTop && conversation != null) {
        val oldestDay = (out.lastOrNull { it is ChatItem.Day } as? ChatItem.Day)?.date
        out += ChatItem.Intro(
            conversation,
            showDate = oldestDay != conversation.createdAt.atZone(zone).toLocalDate(),
            hint = rows.none { it.kind != MessageKind.Reaction && it.kind != MessageKind.Unsend },
        )
    }
    return out
}

/** Two neighbours drawn as one run: same person, same kind of bubble, within a few minutes of the same day. */
private fun joins(newer: ChatMessage, older: ChatMessage, zone: ZoneId): Boolean =
    newer.senderId == older.senderId &&
        older.kind != MessageKind.Call && newer.kind != MessageKind.Call &&
        Duration.between(older.at, newer.at).abs().toMinutes() < RUN_MINUTES &&
        older.at.atZone(zone).toLocalDate() == newer.at.atZone(zone).toLocalDate()

private const val RUN_MINUTES = 5L
