package app.core.sync

import app.core.common.Clock
import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.model.Conversation
import app.core.model.ConversationChange
import app.core.model.ConversationPatch
import app.core.model.Id
import app.core.model.MessageKind
import app.core.model.PublicUid
import app.core.model.RealtimeEvent
import app.core.model.ReceiptsRequest
import app.core.model.ReportContext
import app.core.model.ReportReason
import app.core.model.ReportRequest
import app.core.model.SwipesResult
import app.core.net.ApiError
import app.core.net.ServerApi
import app.core.realtime.RealtimeHealth
import app.core.realtime.RealtimeListener
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap

/** The timings the chat's sync runs on; tests shrink them. */
data class ChatTiming(
    /** While connected: one conditional list read (normally a 304) this often, and nothing else. */
    val safetyReconcileMs: Long = 30 * 60_000L,
    /** While realtime is failing and the app is in front: the first fallback read, doubling to [fallbackMaxMs]. */
    val fallbackFirstMs: Long = 60_000L,
    val fallbackMaxMs: Long = 5 * 60_000L,
    val readDebounceMs: Long = 700,
    /** The server takes one read pointer per conversation every 2 s (more answer 429): a later move waits its turn. */
    val receiptSpacingMs: Long = 2_000,
    val deliveredDebounceMs: Long = 3_000,
    /** The server takes one typing signal per person every 3 s, whichever conversation. */
    val typingThrottleMs: Long = 3_000,
    val typingShownMs: Long = 5_000,
    /** Waits between delivery attempts of one outbox row (then the last, until it expires). */
    val retryStepsMs: List<Long> = listOf(2_000, 4_000, 8_000, 16_000, 30_000, 60_000),
    /** A message for a conversation the phone does not have: one list read, this soon. */
    val missingConversationReadMs: Long = 500,
)

/** Where the conversation list's last read stands, for the list screen's states. */
data class ListSyncState(
    val refreshing: Boolean = false,
    val failed: Boolean = false,
    val offline: Boolean = false,
    /** A read answered (fresh or 304) at least once in this process. */
    val readOnce: Boolean = false,
)

/**
 * The one door every chat change goes through: realtime events, reads,
 * sends, receipts and typing. Screens read Room through the repositories and
 * call in here; nothing that arrives over the network goes to a screen
 * directly.
 *
 * What it costs the server is the point of its rules:
 *
 *  - **No timer requests while realtime is connected**, except one
 *    conditional `GET /v1/conversations` every 30 minutes (a 304 from a
 *    version counter).
 *  - **A reconnect the server recovered costs nothing.** One it could not
 *    recover costs one list read; every thread is marked stale, and each is
 *    caught up (`after=`) only when it is next opened.
 *  - **While realtime fails** and the app is in front, the list is read on a
 *    fallback timer from 60 s doubling to 5 minutes, and the open thread
 *    with it. Never in the background.
 *  - **Read receipts** are debounced (700 ms), at most one per conversation
 *    every 2 s (the server's limit; a refused one is sent again after its
 *    `Retry-After`), sent only when the pointer moves, and only while the
 *    thread is on screen with the app in front.
 *    Delivered pointers go out for the peer's messages that arrive while
 *    another screen is in front, debounced per conversation.
 *  - **Typing** goes out at most once every 3 s while composing (per person,
 *    as the server counts it), and only while the socket is up (the peer's
 *    arrives over it).
 *  - **Sends** run in the app's scope (leaving the screen does not strand a
 *    bubble), retried with backoff while the network is away and for no
 *    longer than the outbox's 10-minute window.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatSync(
    private val api: ServerApi,
    val conversations: ConversationRepository,
    val messages: MessageRepository,
    val requests: MessageRequestsRepository,
    private val scope: CoroutineScope,
    /** Clears every chat row (another account signed in, or nobody). */
    private val clearStore: suspend () -> Unit,
    /** Drops the rows of every account but this one. */
    private val keepOnly: suspend (PublicUid) -> Unit,
    private val clock: Clock = Clock.System,
    private val diag: Diag = Diag.Android,
    private val timing: ChatTiming = ChatTiming(),
) : RealtimeListener {

    private val _account = MutableStateFlow<PublicUid?>(null)
    val account: StateFlow<PublicUid?> = _account.asStateFlow()

    private val _health = MutableStateFlow(RealtimeHealth.IDLE)
    val health: StateFlow<RealtimeHealth> = _health.asStateFlow()

    private val _list = MutableStateFlow(ListSyncState())
    val list: StateFlow<ListSyncState> = _list.asStateFlow()

    /** Conversations whose peer is typing, and until when (epoch ms). */
    private val _typing = MutableStateFlow<Map<Id, Long>>(emptyMap())
    val typing: StateFlow<Map<Id, Long>> = _typing.asStateFlow()

    private val foreground = MutableStateFlow(false)
    private val active = MutableStateFlow(false)

    /** The thread on screen, while the screen is resumed (null otherwise). */
    private val visible = MutableStateFlow<Id?>(null)

    private val events = Channel<RealtimeEvent>(Channel.UNLIMITED)
    private val networkBack = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    private val reconcileLock = Mutex()
    private var keptOnly = false

    private val readJobs = ConcurrentHashMap<Id, Job>()
    private val deliveredJobs = ConcurrentHashMap<Id, Job>()
    private val deliveredUpTo = ConcurrentHashMap<Id, Long>()
    private val readSent = ConcurrentHashMap<Id, Long>()
    /** When the last read receipt of each conversation went out, for the server's spacing. */
    private val readSentAt = ConcurrentHashMap<Id, Long>()
    @Volatile private var typingSentAt: Long? = null
    private val sendJobs = ConcurrentHashMap<String, Job>()
    private var missingRead: Job? = null
    private var owed = false

    init {
        // One consumer, so events are applied in the order they arrived: a
        // message before the receipt that reads it.
        scope.launch { for (event in events) runCatchingUnlessCancelled { apply(event) } }
        scope.launch { timers() }
    }

    // MARK: - Who and when

    /**
     * The account whose chat cache this is (signed in, whatever its state),
     * or null. Another account starts from an empty cache. [active]: the
     * account may chat now (not restricted, through sign-up); reads are made
     * only then.
     */
    fun setAccount(publicUid: PublicUid?, active: Boolean) {
        this.active.value = publicUid != null && active
        val previous = _account.value
        if (previous == publicUid) return
        _account.value = publicUid
        cancelAll()
        requests.clear()
        _typing.value = emptyMap()
        _list.value = ListSyncState()
        scope.launch {
            if (previous != null) clearStore()
            if (publicUid != null && !keptOnly) {
                keptOnly = true
                keepOnly(publicUid)
            }
            if (publicUid != null && foreground.value && this@ChatSync.active.value) resumeOutbox(publicUid)
        }
    }

    fun setForeground(value: Boolean) {
        if (foreground.value == value) return
        foreground.value = value
        val who = _account.value
        if (value && who != null && active.value) scope.launch { resumeOutbox(who) }
    }

    /** The thread [conversationId] is on screen ([shown]) or no longer. */
    fun setVisible(conversationId: Id, shown: Boolean) {
        if (shown) {
            visible.value = conversationId
            messages.watch(conversationId)
            scheduleRead(conversationId)
        } else if (visible.value == conversationId) {
            visible.value = null
        }
    }

    /** A thread screen closed: stop writing its realtime rows unless it was read, and drop it if it ended. */
    fun closed(conversationId: Id) {
        messages.unwatch(conversationId)
        if (visible.value == conversationId) visible.value = null
        val who = _account.value ?: return
        scope.launch { conversations.removeEnded(who, except = visible.value) }
    }

    /** Whether the person is looking at [conversationId] right now (a push for it is not shown). */
    fun isViewing(conversationId: Id): Boolean = foreground.value && visible.value == conversationId

    // MARK: - Realtime

    override fun onEvent(event: RealtimeEvent) {
        events.trySend(event)
    }

    override fun onHealth(health: RealtimeHealth) {
        _health.value = health
    }

    override fun onConnected(recovered: Boolean, first: Boolean) {
        if (recovered) {
            diag.info(AREA, "reconnected and recovered: nothing to read")
            return
        }
        val who = _account.value ?: return
        scope.launch {
            // Anything may have been published while nobody listened: every
            // thread is caught up when next opened, the list now.
            messages.markAllStale(who)
            reconcile(if (first) "connected" else "not recovered")
        }
    }

    override fun onNetworkAvailable() {
        networkBack.tryEmit(Unit)
        val who = _account.value ?: return
        if (!foreground.value) return
        scope.launch {
            visible.value?.let { scheduleRead(it) }
            if (owed || _health.value != RealtimeHealth.CONNECTED) reconcile("network back")
        }
    }

    private suspend fun apply(event: RealtimeEvent) {
        val who = _account.value ?: return
        when (event) {
            is RealtimeEvent.MessageArrived -> {
                val message = event.message
                val conversationId = message.conversationId
                val viewing = isViewing(conversationId)
                messages.applyRealtime(who, message)
                val known = conversations.onMessage(who, message, viewing)
                if (!known) readListSoon("unknown conversation")
                if (message.senderId != who && message.kind != MessageKind.Reaction && message.kind != MessageKind.Unsend) {
                    _typing.update { it - conversationId }
                    if (viewing) scheduleRead(conversationId) else scheduleDelivered(conversationId, message.id)
                }
            }
            // Read on another phone of this account, in a thread this one does not hold: the list says what is left.
            is RealtimeEvent.ReceiptMoved -> if (conversations.applyReceipt(who, event.receipt)) readListSoon("unread unknown")
            is RealtimeEvent.PeerTyping -> if (event.typing.by != who) showTyping(event.typing.conversationId)
            is RealtimeEvent.ConversationChanged -> {
                val change = event.change
                conversations.upsert(who, change.conversation)
                // An accepted request is a conversation now, on whichever side or phone it was accepted; its
                // first message (the request's text) says which of the two directions it was.
                if (change.reason == ConversationChange.Accepted) requests.onAccepted(change.conversation.peer.id, change.conversation.lastMessage)
            }
            is RealtimeEvent.ConversationEnded -> {
                val id = event.conversationId
                if (visible.value == id) conversations.end(who, id) else conversations.remove(who, id)
                _typing.update { it - id }
            }
            is RealtimeEvent.RequestReceived -> requests.onRealtime(event.request)
            else -> Unit
        }
    }

    private fun showTyping(conversationId: Id) {
        val until = clock.nowMillis() + timing.typingShownMs
        _typing.update { it + (conversationId to until) }
        scope.launch {
            delay(timing.typingShownMs)
            _typing.update { map -> if ((map[conversationId] ?: 0) <= clock.nowMillis()) map - conversationId else map }
        }
    }

    private fun readListSoon(reason: String) {
        if (missingRead?.isActive == true) return
        missingRead = scope.launch {
            delay(timing.missingConversationReadMs)
            reconcile(reason)
        }
    }

    // MARK: - Reads

    /**
     * One list read (a 304 when nothing moved), then a catch-up of the thread
     * on screen when it is behind. Only one runs at a time; a call while one
     * runs is that one.
     */
    suspend fun reconcile(reason: String): ListRefresh? {
        val who = _account.value ?: return null
        if (!active.value) return null
        if (!reconcileLock.tryLock()) return null
        try {
            _list.update { it.copy(refreshing = true) }
            val result = conversations.refresh(who)
            owed = result is ListRefresh.Failed
            _list.update {
                when (result) {
                    is ListRefresh.Failed -> it.copy(refreshing = false, failed = true, offline = result.offline)
                    else -> ListSyncState(refreshing = false, failed = false, offline = false, readOnce = true)
                }
            }
            diag.info(AREA, "reconcile ($reason): ${result.javaClass.simpleName}")
            visible.value?.let { open -> openThread(open) }
            return result
        } finally {
            reconcileLock.unlock()
        }
    }

    /** The list screen's pull to refresh. */
    suspend fun refreshList(): ListRefresh? = reconcile("pull")

    /** Brings a thread up to date for its screen (see [MessageRepository.open]). */
    suspend fun openThread(conversationId: Id): ThreadRead {
        val who = _account.value ?: return ThreadRead.Failed(offline = false)
        val row = conversations.get(who, conversationId)
        val result = messages.open(who, conversationId, row?.lastMessageId)
        when (result) {
            is ThreadRead.Read -> result.pointers?.let { conversations.applyPointers(who, conversationId, it) }
            ThreadRead.Gone -> conversations.remove(who, conversationId)
            ThreadRead.Ended -> conversations.end(who, conversationId)
            else -> Unit
        }
        if (result is ThreadRead.Read || result == ThreadRead.UpToDate) scheduleRead(conversationId)
        return result
    }

    suspend fun loadOlder(conversationId: Id): OlderRead {
        val who = _account.value ?: return OlderRead.NothingMore
        return messages.loadOlder(who, conversationId)
    }

    /**
     * The timers, only while the app is in front and someone is signed in:
     * the safety read while connected, the fallback reads while not.
     */
    private suspend fun timers() {
        combine(foreground, active, _health) { fg, chatting, health -> if (fg && chatting) health else null }
            .collectLatest { health ->
                when (health) {
                    RealtimeHealth.CONNECTED -> while (true) {
                        delay(timing.safetyReconcileMs)
                        reconcile("safety")
                    }
                    RealtimeHealth.DEGRADED -> {
                        var wait = timing.fallbackFirstMs
                        while (true) {
                            val result = reconcile("fallback")
                            wait = if (result is ListRefresh.Changed) timing.fallbackFirstMs else (wait * 2).coerceAtMost(timing.fallbackMaxMs)
                            withTimeoutOrNull(wait) { networkBack.first() }
                        }
                    }
                    else -> Unit
                }
            }
    }

    // MARK: - Receipts and typing

    /** The person sees the thread: tell the server how far they read, once it settles. */
    fun markSeen(conversationId: Id) = scheduleRead(conversationId)

    private fun scheduleRead(conversationId: Id, notBeforeMs: Long = 0) {
        readJobs[conversationId]?.cancel()
        readJobs[conversationId] = scope.launch {
            val since = readSentAt[conversationId]?.let { clock.nowMillis() - it }
            val spacing = if (since == null) 0L else (timing.receiptSpacingMs - since).coerceAtLeast(0)
            delay(maxOf(timing.readDebounceMs, spacing, notBeforeMs))
            if (isViewing(conversationId)) sendRead(conversationId)
        }
    }

    private suspend fun sendRead(conversationId: Id) {
        val who = _account.value ?: return
        val newest = messages.newestFromPeer(who, conversationId) ?: return
        val row = conversations.get(who, conversationId)
        conversations.clearUnread(who, conversationId)
        // The pointer only moves forward, and only what the server does not
        // have yet is sent.
        if ((row?.myReadId ?: 0) >= newest || newest <= (readSent[conversationId] ?: 0)) return
        try {
            api.sendReceipts(conversationId, ReceiptsRequest(readUpTo = newest.toString()))
            readSentAt[conversationId] = clock.nowMillis()
            readSent[conversationId] = newest
            deliveredUpTo.remove(conversationId)
            conversations.markRead(who, conversationId, newest)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            diag.info(AREA, "read receipt not sent: ${e.code ?: e.javaClass.simpleName}")
            val http = e as? ApiError.Http ?: return // Sent again the next time the thread is seen, or the network returns.
            when (http.status) {
                // Too soon after the last one: again once the server takes one.
                STATUS_TOO_MANY -> scheduleRead(
                    conversationId,
                    notBeforeMs = maxOf(timing.receiptSpacingMs, (http.problem.retryAfterSeconds ?: 0) * 1_000),
                )
                // The conversation ended (404 for a receipt, as for every action on it).
                STATUS_NOT_FOUND, STATUS_GONE -> conversations.end(who, conversationId)
            }
        }
    }

    private fun scheduleDelivered(conversationId: Id, messageId: Id) {
        val id = messageId.toLongOrNull() ?: return
        if (!foreground.value) return
        deliveredUpTo.merge(conversationId, id) { a, b -> maxOf(a, b) }
        if (deliveredJobs[conversationId]?.isActive == true) return
        deliveredJobs[conversationId] = scope.launch {
            delay(timing.deliveredDebounceMs)
            val upTo = deliveredUpTo.remove(conversationId) ?: return@launch
            if (upTo <= (readSent[conversationId] ?: 0)) return@launch
            runCatchingUnlessCancelled { api.sendReceipts(conversationId, ReceiptsRequest(deliveredUpTo = upTo.toString())) }
        }
    }

    /** The person is typing in [conversationId]. At most one signal every few seconds, and only while it can arrive. */
    fun typed(conversationId: Id) {
        if (_health.value != RealtimeHealth.CONNECTED) return
        val now = clock.nowMillis()
        val last = typingSentAt
        if (last != null && now - last < timing.typingThrottleMs) return
        typingSentAt = now
        scope.launch { runCatchingUnlessCancelled { api.sendTyping(conversationId) } }
    }

    // MARK: - Sending

    /** Writes [text] to the outbox and starts delivering it. Returns its local id. */
    suspend fun send(conversationId: Id, text: String): String? = sendKind(conversationId, MessageKind.Text, text.trim(), null)

    /** A reaction ([emoji]; empty removes this account's reaction) to the message [target]. */
    suspend fun react(conversationId: Id, target: Long, emoji: String): String? =
        sendKind(conversationId, MessageKind.Reaction, emoji, target)

    /** Takes back the account's own message [target]. */
    suspend fun unsend(conversationId: Id, target: Long): String? = sendKind(conversationId, MessageKind.Unsend, null, target)

    private suspend fun sendKind(conversationId: Id, kind: MessageKind, body: String?, refId: Long?): String? {
        val who = _account.value ?: return null
        val localId = messages.enqueue(who, conversationId, kind, body, refId) ?: return null
        deliver(who, localId)
        return localId
    }

    fun retry(localId: String) {
        val who = _account.value ?: return
        scope.launch { if (messages.retry(who, localId)) deliver(who, localId) }
    }

    /** "Send anyway" after the server's "are you sure?". */
    fun confirmSend(localId: String) {
        val who = _account.value ?: return
        scope.launch { if (messages.confirmSend(who, localId)) deliver(who, localId) }
    }

    fun discard(localId: String) {
        val who = _account.value ?: return
        sendJobs.remove(localId)?.cancel()
        scope.launch { messages.discard(who, localId) }
    }

    private suspend fun resumeOutbox(who: PublicUid) {
        messages.resumeOutbox(who).forEach { deliver(who, it) }
    }

    /** Delivers one outbox row in the app's scope, retrying with backoff while the outcome says so. */
    private fun deliver(who: PublicUid, localId: String) {
        if (sendJobs[localId]?.isActive == true) return
        sendJobs[localId] = scope.launch {
            var attempt = 0
            while (true) {
                when (val outcome = messages.deliver(who, localId)) {
                    is SendOutcome.Sent -> {
                        outcome.message?.let { conversations.onMessage(who, it, viewing = true) }
                        break
                    }
                    SendOutcome.Closed -> {
                        // 404 or 410: the conversation ended (the server never says how); nothing more goes in it.
                        messages.message(who, localId)?.let { conversations.end(who, it.conversationId) }
                        break
                    }
                    is SendOutcome.RetryLater -> {
                        val row = messages.message(who, localId) ?: break
                        if (messages.expired(row)) {
                            messages.expire(who, localId)
                            break
                        }
                        val steps = timing.retryStepsMs
                        val wait = outcome.afterMs ?: steps[attempt.coerceAtMost(steps.lastIndex)]
                        attempt++
                        withTimeoutOrNull(wait) { networkBack.first() }
                    }
                    else -> break
                }
            }
            sendJobs.remove(localId)
        }
    }

    // MARK: - Conversations

    /** A match a swipe answer carried: it is in the list (and its thread can open) before any read. */
    fun onSwipes(result: SwipesResult) {
        val who = _account.value ?: return
        val matched = result.results.mapNotNull { it.conversation }
        if (matched.isEmpty()) return
        scope.launch { matched.forEach { conversations.upsert(who, it) } }
    }

    /** A conversation the server just handed over (an accepted request). */
    suspend fun adopt(conversation: Conversation) {
        val who = _account.value ?: return
        conversations.upsert(who, conversation)
    }

    suspend fun setMuted(conversationId: Id, muted: Boolean): Result<Conversation> = conversationCall {
        api.updateConversation(conversationId, ConversationPatch(muted = muted)).also { adopt(it) }
    }

    /** Unmatch: the conversation and its messages leave this phone. */
    suspend fun unmatch(conversationId: Id): Result<Unit> = conversationCall {
        api.unmatch(conversationId)
        _account.value?.let { conversations.remove(it, conversationId) }
    }

    /** Blocks [peer]: every conversation with them ends here too (the server ends it there). */
    suspend fun block(peer: PublicUid): Result<Unit> = conversationCall {
        api.block(peer)
        removePeer(peer)
    }

    /**
     * Reports [peer] from a conversation, with the messages the person picked
     * (at most 20) as evidence, and a block when [block].
     */
    suspend fun report(
        peer: PublicUid,
        conversationId: Id?,
        reason: ReportReason,
        details: String?,
        messageIds: List<Long>,
        block: Boolean,
    ): Result<Id> = conversationCall {
        val id = api.report(
            ReportRequest(
                target = peer,
                context = ReportContext.Chat,
                reason = reason,
                details = details?.trim()?.takeIf { it.isNotEmpty() },
                conversationId = conversationId,
                messageIds = messageIds.takeLast(MAX_REPORTED).map { it.toString() }.takeIf { it.isNotEmpty() },
                block = block,
            ),
        )
        if (block) removePeer(peer)
        id
    }

    private suspend fun removePeer(peer: PublicUid) {
        val who = _account.value ?: return
        conversations.byPeer(who, peer).forEach { conversations.remove(who, it) }
    }

    private suspend fun <T> conversationCall(block: suspend () -> T): Result<T> =
        try {
            Result.success(block())
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            Result.failure(e)
        }

    private fun cancelAll() {
        readJobs.values.forEach { it.cancel() }
        readJobs.clear()
        deliveredJobs.values.forEach { it.cancel() }
        deliveredJobs.clear()
        deliveredUpTo.clear()
        readSent.clear()
        readSentAt.clear()
        typingSentAt = null
        sendJobs.values.forEach { it.cancel() }
        sendJobs.clear()
        missingRead?.cancel()
    }

    private companion object {
        const val AREA = "Sync"
        const val MAX_REPORTED = 20
        const val STATUS_NOT_FOUND = 404
        const val STATUS_GONE = 410
        const val STATUS_TOO_MANY = 429
    }
}
