package app.core.sync

import app.core.cache.CacheDatabase
import app.core.cache.ChatMapping
import app.core.cache.ChatStore
import app.core.cache.MessageEntity
import app.core.cache.MessageKey
import app.core.cache.SQL_CHUNK
import app.core.cache.SendState
import app.core.cache.SyncKeys
import app.core.cache.SyncStateEntity
import app.core.common.Clock
import app.core.common.Diag
import app.core.model.Id
import app.core.model.Message
import app.core.model.MessageKind
import app.core.model.MessagesPage
import app.core.model.ProblemCodes
import app.core.model.PublicUid
import app.core.model.SendMessageRequest
import app.core.net.ApiError
import app.core.net.ServerApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Threads, local-first, and the outbox.
 *
 * ## Reading
 *
 * A thread opened for the first time reads its newest 50 messages
 * (`GET …/messages?limit=50`); older ones come a page at a time as the
 * person scrolls back (`?before=<oldest>`). After that, a thread is read
 * again only when something may be missing ([ThreadRead.UpToDate] costs
 * nothing): the conversation's last message is not here, a reconnect could
 * not be recovered, or the last read came back while the server's
 * write-behind lagged. Then one catch-up (`?after=<syncCursor>`) fills it.
 *
 * The catch-up starts from the server's `syncCursor`, never from the newest
 * id this phone saw: a message held back by the server's write-behind has a
 * smaller id than one already returned, and would otherwise be skipped for
 * good. Repeats are dropped by id.
 *
 * There is no periodic full re-read: messages never change on the server.
 * An unsend, a moderation hide and a reaction are rows of their own that
 * point at the message they change ([ChatMapping], `refId`).
 *
 * ## One message, however many times it arrives
 *
 * The same message can reach this class four ways: the pending copy written
 * when Send was tapped, the send's own answer, the realtime publication, and
 * the next read. They are one row because they are matched in a fixed order,
 * **server id, then client id**, and a row keeps its local id for life.
 *
 * ## Sending
 *
 * A message is written first, PENDING, with a client id minted ONCE for it.
 * Every attempt to deliver it (the first, a retry, a resume after the process
 * was killed) sends that same id, and the server answers a replay with the
 * message it already made. A pending row older than [RESUME_WINDOW_MS] is not
 * sent on the person's behalf: it becomes FAILED and waits for a tap.
 */
class MessageRepository(
    private val api: ServerApi,
    private val store: ChatStore,
    private val clock: Clock = Clock.System,
    private val newClientId: () -> String = { UUID.randomUUID().toString() },
    private val diag: Diag = Diag.Android,
) {
    /** One read at a time per thread: two overlapping reads would each move the cursor. */
    private val locks = ConcurrentHashMap<String, Mutex>()

    /**
     * Threads on screen. A realtime message for one of these is written even
     * before its first read lands; for any other thread never read it is
     * not, because a transcript made of one message and a gap is worse than
     * none (the conversation's preview shows it, and the first open reads).
     */
    private val watched = ConcurrentHashMap.newKeySet<String>()

    private fun lockFor(conversationId: String): Mutex = locks.getOrPut(conversationId) { Mutex() }

    fun watch(conversationId: Id) {
        watched += conversationId
    }

    fun unwatch(conversationId: Id) {
        watched -= conversationId
    }

    fun observeNewest(account: PublicUid, conversationId: Id, limit: Int): Flow<List<MessageEntity>> =
        store.observe(emptyList()) { it.messages().observeNewest(account, conversationId, limit) }

    fun observeMarks(account: PublicUid, conversationId: Id): Flow<List<MessageEntity>> =
        store.observe(emptyList()) { it.messages().observeMarks(account, conversationId) }

    suspend fun syncState(account: PublicUid, conversationId: Id): SyncStateEntity? =
        store.read("sync state") { it.syncState().get(account, SyncKeys.thread(conversationId)) }

    // MARK: - Reading

    /**
     * Brings a thread up to date for a screen that opens it, asking the
     * server only when something may be missing. [lastMessageId] is the
     * conversation's last message as the list has it.
     */
    suspend fun open(account: PublicUid, conversationId: Id, lastMessageId: Long?): ThreadRead {
        val state = syncState(account, conversationId)
        if (state == null) {
            // Never read. A new match nobody has written in yet has nothing to read.
            if (lastMessageId == null) return ThreadRead.UpToDate
            return initial(account, conversationId)
        }
        val missingLast = lastMessageId != null && !has(account, conversationId, lastMessageId)
        return if (state.stale || missingLast) catchUp(account, conversationId) else ThreadRead.UpToDate
    }

    private suspend fun has(account: PublicUid, conversationId: Id, serverId: Long): Boolean =
        (store.read("has") { it.messages().countServerId(account, conversationId, serverId) } ?: 0) > 0

    /** The newest page, as for a thread never read (or one read again from its end). */
    suspend fun initial(account: PublicUid, conversationId: Id): ThreadRead = lockFor(conversationId).withLock {
        val page = fetch(conversationId) { api.messagesBefore(conversationId, before = null, limit = PAGE) }
            .getOrElse { return@withLock failure(account, conversationId, it) }
        store.write("initial read") { db ->
            merge(db, account, conversationId, page.items)
            val oldest = page.items.minOfOrNull { ChatMapping.idOf(it.id) ?: Long.MAX_VALUE }
            db.syncState().upsert(
                SyncStateEntity(
                    accountId = account,
                    key = SyncKeys.thread(conversationId),
                    cursor = cursorOf(page, previous = null),
                    oldestId = oldest?.takeIf { it != Long.MAX_VALUE },
                    hasMoreBefore = page.hasMore,
                    stale = isLagging(page),
                    updatedAt = clock.nowMillis(),
                ),
            )
        }
        diag.info(AREA, "thread ${Diag.id(conversationId)} first read: ${page.items.size} rows")
        ThreadRead.Read(page.items.size, ReadPointers.of(page))
    }

    /**
     * Everything after the stored `syncCursor`. A thread that fell more than
     * [MAX_CATCH_UP_PAGES] pages behind is read again from its end instead:
     * its older part stays reachable by paging back.
     */
    suspend fun catchUp(account: PublicUid, conversationId: Id): ThreadRead {
        val reset = lockFor(conversationId).withLock {
            var state = syncState(account, conversationId)
            val cursor = state?.cursor ?: return@withLock true
            var after = cursor
            var total = 0
            repeat(MAX_CATCH_UP_PAGES) {
                val page = fetch(conversationId) { api.messagesAfter(conversationId, after = after, limit = CATCH_UP_PAGE) }
                    .getOrElse { return failure(account, conversationId, it) }
                total += page.items.size
                val next = cursorOf(page, previous = after)
                store.write("catch-up") { db ->
                    merge(db, account, conversationId, page.items)
                    val current = db.syncState().get(account, SyncKeys.thread(conversationId)) ?: state
                    db.syncState().upsert(
                        (current ?: return@write).copy(
                            cursor = next,
                            stale = isLagging(page),
                            updatedAt = clock.nowMillis(),
                        ),
                    )
                }
                if (!page.hasMore) {
                    diag.info(AREA, "thread ${Diag.id(conversationId)} caught up: $total rows")
                    return ThreadRead.Read(total, ReadPointers.of(page))
                }
                after = next ?: after
                state = syncState(account, conversationId)
            }
            true
        }
        if (!reset) return ThreadRead.Read(0, null)
        diag.info(AREA, "thread ${Diag.id(conversationId)} too far behind; read again from its end")
        store.write("thread reset") { db ->
            db.messages().deleteConfirmed(account, conversationId)
            db.syncState().delete(account, SyncKeys.thread(conversationId))
        }
        return initial(account, conversationId)
    }

    /** One page further back. */
    suspend fun loadOlder(account: PublicUid, conversationId: Id): OlderRead = lockFor(conversationId).withLock {
        val state = syncState(account, conversationId) ?: return@withLock OlderRead.NothingMore
        val oldest = state.oldestId ?: return@withLock OlderRead.NothingMore
        if (!state.hasMoreBefore) return@withLock OlderRead.NothingMore
        val page = fetch(conversationId) { api.messagesBefore(conversationId, before = oldest.toString(), limit = PAGE) }
            .getOrElse { return@withLock OlderRead.Failed(offline = it is ApiError.Network) }
        store.write("older page") { db ->
            merge(db, account, conversationId, page.items)
            val newOldest = (page.items.mapNotNull { ChatMapping.idOf(it.id) } + oldest).min()
            val current = db.syncState().get(account, SyncKeys.thread(conversationId)) ?: state
            db.syncState().upsert(current.copy(oldestId = newOldest, hasMoreBefore = page.hasMore, updatedAt = clock.nowMillis()))
        }
        OlderRead.Read(page.items.size, page.hasMore)
    }

    private suspend fun fetch(conversationId: Id, read: suspend () -> MessagesPage): Result<MessagesPage> =
        try {
            Result.success(read())
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            Result.failure(e)
        }

    private suspend fun failure(account: PublicUid, conversationId: Id, error: Throwable): ThreadRead {
        val http = error as? ApiError.Http
        return when {
            http?.status == 404 -> {
                forget(account, conversationId)
                diag.info(AREA, "thread ${Diag.id(conversationId)} is gone (404); removed")
                ThreadRead.Gone
            }
            http?.status == 410 || http?.code == ProblemCodes.CONVERSATION_ENDED -> ThreadRead.Ended
            else -> {
                diag.warn(AREA, "thread ${Diag.id(conversationId)} read failed: ${error.javaClass.simpleName}")
                ThreadRead.Failed(offline = error is ApiError.Network)
            }
        }
    }

    /** The cursor a page leaves: the server's `syncCursor`, else the newest id it returned, else the one before. */
    private fun cursorOf(page: MessagesPage, previous: String?): String? {
        page.syncCursor?.takeIf { ChatMapping.idOf(it) != null }?.let { sync ->
            // Never backwards past what an earlier read already made durable.
            val before = ChatMapping.idOf(previous)
            return if (before != null && before > ChatMapping.idOf(sync)!!) previous else sync
        }
        return page.items.mapNotNull { ChatMapping.idOf(it.id) }.maxOrNull()?.toString() ?: previous
    }

    /** True when rows may still land below what this page returned: ask again on the next open. */
    private fun isLagging(page: MessagesPage): Boolean {
        if (page.lagging) return true
        val sync = ChatMapping.idOf(page.syncCursor) ?: return false
        val newest = page.items.mapNotNull { ChatMapping.idOf(it.id) }.maxOrNull() ?: return false
        return sync < newest
    }

    /**
     * Applies a message the server published over realtime. It only FILLS:
     * it confirms a pending row, adds a row that is missing, and leaves a row
     * already stored alone. It never moves the cursor (a realtime write
     * proves nothing about the rows around it).
     */
    suspend fun applyRealtime(account: PublicUid, message: Message): Boolean {
        val conversationId = message.conversationId
        val serverId = ChatMapping.idOf(message.id) ?: return false
        return lockFor(conversationId).withLock {
            val known = syncState(account, conversationId) != null
            store.write("realtime message") { db ->
                val existing = db.messages().keysByServerId(account, conversationId, listOf(serverId)).firstOrNull()
                    ?: message.clientId?.let { db.messages().keysByClientId(account, conversationId, listOf(it)).firstOrNull() }
                when {
                    existing == null && !known && conversationId !in watched -> false
                    existing != null && existing.serverId != null && existing.sendState == SendState.SENT.code -> false
                    else -> {
                        merge(db, account, conversationId, listOf(message))
                        true
                    }
                }
            } ?: false
        }
    }

    /**
     * Merges server rows into one thread, in the caller's transaction. A row
     * that names another conversation is not this thread's, however it got
     * into the answer.
     */
    private suspend fun merge(db: CacheDatabase, account: PublicUid, conversationId: Id, incoming: List<Message>) {
        val rows = incoming.filter { it.conversationId == conversationId && ChatMapping.idOf(it.id) != null }
        if (rows.isEmpty()) return
        val dao = db.messages()
        val byServer = HashMap<Long, MessageKey>()
        rows.mapNotNull { ChatMapping.idOf(it.id) }.chunked(SQL_CHUNK).forEach { chunk ->
            dao.keysByServerId(account, conversationId, chunk).forEach { key -> key.serverId?.let { byServer[it] = key } }
        }
        val byClient = HashMap<String, MessageKey>()
        rows.mapNotNull { it.clientId }.chunked(SQL_CHUNK).forEach { chunk ->
            dao.keysByClientId(account, conversationId, chunk).forEach { key -> key.clientId?.let { byClient[it] = key } }
        }
        val now = clock.nowMillis()
        val writes = LinkedHashMap<String, MessageEntity>()
        val doomed = HashSet<String>()
        val unsends = ArrayList<Long>()
        for (message in rows) {
            val serverId = ChatMapping.idOf(message.id) ?: continue
            val serverHit = byServer[serverId]
            val clientHit = message.clientId?.let { byClient[it] }
            if (serverHit != null && clientHit == null && serverHit.sendState == SendState.SENT.code) continue
            // Two local rows for one message: the one typed here keeps its
            // local id (it is the bubble on screen); the server's copy goes.
            if (serverHit != null && clientHit != null && serverHit.localId != clientHit.localId) doomed += serverHit.localId
            val localId = clientHit?.localId ?: serverHit?.localId
            val entity = ChatMapping.message(account, message, localId, now) ?: continue
            writes[entity.localId] = entity
            if (message.kind == MessageKind.Unsend) entity.refId?.let(unsends::add)
        }
        if (doomed.isNotEmpty()) dao.delete(account, doomed.toList())
        if (writes.isNotEmpty()) dao.upsert(writes.values.toList())
        if (unsends.isNotEmpty()) clearUnsent(db, account, conversationId, unsends)
    }

    /**
     * An unsent (or moderation-hidden) message keeps no text on the phone:
     * the server clears its own copy later, and this one goes now.
     */
    private suspend fun clearUnsent(db: CacheDatabase, account: PublicUid, conversationId: Id, targets: List<Long>) {
        val dao = db.messages()
        targets.chunked(SQL_CHUNK).forEach { chunk ->
            val keys = dao.keysByServerId(account, conversationId, chunk)
            val rows = keys.mapNotNull { dao.get(account, it.localId) }
            if (rows.isNotEmpty()) dao.upsert(rows.map { it.copy(body = null, mediaJson = null) })
        }
    }

    /** Every cached thread may have missed something (a reconnect the server could not recover). */
    suspend fun markAllStale(account: PublicUid) {
        store.write("mark stale") { it.syncState().markAllThreadsStale(account) }
    }

    /** A push named a message this thread does not have yet. */
    suspend fun markStale(account: PublicUid, conversationId: Id) {
        store.write("mark stale") { db ->
            db.syncState().get(account, SyncKeys.thread(conversationId))?.let {
                db.syncState().upsert(it.copy(stale = true, updatedAt = clock.nowMillis()))
            }
        }
    }

    /** The thread's rows and cursor, gone (unmatched, blocked, ended and left). */
    suspend fun forget(account: PublicUid, conversationId: Id) {
        store.write("forget thread") { db ->
            db.messages().deleteThread(account, conversationId)
            db.syncState().delete(account, SyncKeys.thread(conversationId))
        }
    }

    /** The newest message from the peer this phone has, for the read pointer. */
    suspend fun newestFromPeer(account: PublicUid, conversationId: Id): Long? =
        store.read("newest from peer") { db ->
            db.messages().newestServerRows(account, conversationId, NEWEST_SCAN)
                .firstOrNull { it.senderId != account && it.kind != MessageKind.Reaction.wire && it.kind != MessageKind.Unsend.wire }
                ?.serverId
        }

    // MARK: - Sending

    /**
     * Writes a message to the outbox, PENDING, and returns its local id.
     * Delivery is a separate step ([deliver]), so the bubble is on screen
     * before any request is made, and survives the process dying before one
     * is.
     */
    suspend fun enqueue(account: PublicUid, conversationId: Id, kind: MessageKind, body: String?, refId: Long? = null): String? {
        val clientId = newClientId()
        val localId = "l:$clientId"
        val now = clock.nowMillis()
        val row = MessageEntity(
            accountId = account,
            localId = localId,
            conversationId = conversationId,
            serverId = null,
            clientId = clientId,
            senderId = account,
            kind = kind.wire,
            body = body,
            refId = refId,
            mediaJson = null,
            callJson = null,
            at = now,
            sortKey = MessageEntity.PENDING_SORT_FLOOR + now,
            sendState = SendState.PENDING.code,
            errorCode = null,
            confirmToken = null,
            cachedAt = now,
        )
        store.write("enqueue") { it.messages().upsert(listOf(row)) } ?: return null
        diag.info(AREA, "outbox +1 (${kind.wire}) in ${Diag.id(conversationId)}")
        return localId
    }

    suspend fun message(account: PublicUid, localId: String): MessageEntity? =
        store.read("outbox row") { it.messages().get(account, localId) }

    /**
     * Sends one outbox row, with the client id it was minted with. Safe to
     * call again for the same row: the server answers a replay of the same
     * client id with the message it already has.
     */
    suspend fun deliver(account: PublicUid, localId: String): SendOutcome {
        val row = message(account, localId) ?: return SendOutcome.Missing
        if (row.sendState == SendState.SENT.code && row.serverId != null) return SendOutcome.Sent(null)
        if (row.sendState == SendState.CONFIRM.code) return SendOutcome.NeedsConfirm(row.errorCode)
        if (row.sendState == SendState.FAILED.code) return SendOutcome.Refused(row.errorCode ?: ChatErrors.OTHER)
        val clientId = row.clientId ?: return SendOutcome.Missing
        val kind = ChatMapping.kind(row)
        val request = SendMessageRequest(
            clientId = clientId,
            kind = kind,
            body = row.body,
            refId = row.refId?.toString(),
            confirm = row.confirmToken?.takeIf { row.sendState == SendState.PENDING.code },
        )
        val answer = try {
            api.sendMessage(row.conversationId, request)
        } catch (e: CancellationException) {
            // The request may or may not have reached the server. PENDING is
            // the truth, and a resume sends again with the same client id.
            throw e
        } catch (e: ApiError) {
            return refused(account, row, e)
        }
        confirm(account, row, answer.message)
        return SendOutcome.Sent(answer.message)
    }

    private suspend fun refused(account: PublicUid, row: MessageEntity, e: ApiError): SendOutcome {
        val http = e as? ApiError.Http
        val outcome = when {
            e is ApiError.Network -> SendOutcome.RetryLater(null)
            e is ApiError.Unauthorized -> SendOutcome.RetryLater(null)
            http == null -> SendOutcome.Refused(ChatErrors.OTHER)
            http.code == ProblemCodes.CONFIRM_REQUIRED -> SendOutcome.NeedsConfirm(http.problem.category)
            http.status == 404 || http.status == 410 -> SendOutcome.Closed
            http.status == 429 -> SendOutcome.RetryLater(http.problem.retryAfterSeconds?.times(1000))
            http.status >= 500 && !http.isMaintenance -> SendOutcome.RetryLater(null)
            http.isMaintenance -> SendOutcome.RetryLater(MAINTENANCE_RETRY_MS)
            else -> SendOutcome.Refused(http.code ?: ChatErrors.OTHER)
        }
        store.write("send failed") { db ->
            val current = row.clientId?.let { db.messages().byClientId(account, row.conversationId, it) } ?: return@write
            if (current.sendState == SendState.SENT.code) return@write
            val next = when (outcome) {
                is SendOutcome.NeedsConfirm -> current.copy(
                    sendState = SendState.CONFIRM.code,
                    errorCode = outcome.category ?: ProblemCodes.CONFIRM_REQUIRED,
                    confirmToken = http?.problem?.confirmToken,
                )
                is SendOutcome.RetryLater -> current.copy(sendState = SendState.PENDING.code, errorCode = ChatErrors.NETWORK)
                is SendOutcome.Refused -> current.copy(sendState = SendState.FAILED.code, errorCode = outcome.code)
                SendOutcome.Closed -> current.copy(sendState = SendState.FAILED.code, errorCode = ProblemCodes.CONVERSATION_ENDED)
                else -> current
            }
            db.messages().upsert(listOf(next))
        }
        diag.warn(AREA, "send not done in ${Diag.id(row.conversationId)}: ${e.code ?: e.javaClass.simpleName}")
        return outcome
    }

    /** The server has it: the row takes its server id and time, and any realtime twin goes. */
    private suspend fun confirm(account: PublicUid, row: MessageEntity, echo: Message) {
        lockFor(row.conversationId).withLock {
            store.write("confirm") { db ->
                val dao = db.messages()
                val current = row.clientId?.let { dao.byClientId(account, row.conversationId, it) } ?: return@write
                val serverId = ChatMapping.idOf(echo.id) ?: return@write
                val twins = dao.keysByServerId(account, row.conversationId, listOf(serverId)).filter { it.localId != current.localId }
                if (twins.isNotEmpty()) dao.delete(account, twins.map { it.localId })
                dao.upsert(
                    listOf(
                        current.copy(
                            serverId = serverId,
                            at = echo.at.toEpochMilli(),
                            sortKey = serverId,
                            sendState = SendState.SENT.code,
                            errorCode = null,
                            confirmToken = null,
                            cachedAt = clock.nowMillis(),
                        ),
                    ),
                )
                if (ChatMapping.kind(current) == MessageKind.Unsend) current.refId?.let { clearUnsent(db, account, row.conversationId, listOf(it)) }
            }
        }
    }

    /**
     * What is left in the outbox when the app comes back. A PENDING row
     * younger than [RESUME_WINDOW_MS] is sent again with its client id; an
     * older one is not sent on the person's behalf (a reply written an hour
     * ago may no longer be the right thing to say) and becomes FAILED.
     */
    suspend fun resumeOutbox(account: PublicUid): List<String> {
        val now = clock.nowMillis()
        val rows = store.read("outbox") { it.messages().outbox(account) }.orEmpty()
        val resend = mutableListOf<String>()
        val expired = mutableListOf<MessageEntity>()
        for (row in rows) {
            if (row.sendState != SendState.PENDING.code) continue
            if (now - row.at <= RESUME_WINDOW_MS) resend += row.localId else expired += row
        }
        if (expired.isNotEmpty()) {
            store.write("outbox expiry") { db ->
                db.messages().upsert(expired.map { it.copy(sendState = SendState.FAILED.code, errorCode = ChatErrors.EXPIRED) })
            }
        }
        if (rows.isNotEmpty()) diag.info(AREA, "outbox at resume: ${rows.size} rows, ${resend.size} sent again, ${expired.size} expired")
        return resend
    }

    /** Whether a pending row has been waiting longer than the outbox keeps trying on its own. */
    fun expired(row: MessageEntity): Boolean = clock.nowMillis() - row.at > RESUME_WINDOW_MS

    /** Gives up on a pending row that ran out of time while the network was away. */
    suspend fun expire(account: PublicUid, localId: String) {
        store.write("outbox expiry") { db ->
            val row = db.messages().get(account, localId) ?: return@write
            if (row.sendState == SendState.PENDING.code) {
                db.messages().upsert(listOf(row.copy(sendState = SendState.FAILED.code, errorCode = ChatErrors.EXPIRED)))
            }
        }
    }

    /**
     * Tap to retry: the same client id, a fresh time window, and the bubble
     * moves to the end of the thread. The one exception is a client id the
     * server refused as already spent (`409 conflict`: it named a message in
     * another conversation): no message was made with it here, so the retry
     * gets a new one rather than the same refusal for ever.
     */
    suspend fun retry(account: PublicUid, localId: String): Boolean = store.write("retry") { db ->
        val row = db.messages().get(account, localId) ?: return@write false
        if (row.sendState != SendState.FAILED.code) return@write false
        val now = clock.nowMillis()
        val clientId = if (row.errorCode == ProblemCodes.CONFLICT) newClientId() else row.clientId
        db.messages().upsert(
            listOf(
                row.copy(
                    clientId = clientId,
                    sendState = SendState.PENDING.code,
                    errorCode = null,
                    confirmToken = null,
                    at = now,
                    sortKey = MessageEntity.PENDING_SORT_FLOOR + now,
                ),
            ),
        )
        true
    } ?: false

    /** "Send anyway" after the server's "are you sure?": the next attempt carries its confirm token. */
    suspend fun confirmSend(account: PublicUid, localId: String): Boolean = store.write("confirm send") { db ->
        val row = db.messages().get(account, localId) ?: return@write false
        if (row.sendState != SendState.CONFIRM.code) return@write false
        db.messages().upsert(listOf(row.copy(sendState = SendState.PENDING.code, errorCode = null)))
        true
    } ?: false

    /** The person gave up on an unsent message. Only an unsent row can go. */
    suspend fun discard(account: PublicUid, localId: String) {
        store.write("discard") { db ->
            val row = db.messages().get(account, localId) ?: return@write
            if (row.sendState == SendState.SENT.code && row.serverId != null) return@write
            db.messages().delete(account, listOf(localId))
        }
    }

    companion object {
        private const val AREA = "Sync"

        /** The first read of a thread and every page back. */
        const val PAGE = 50

        /** One catch-up page; a thread further behind than [MAX_CATCH_UP_PAGES] of these is read again from its end. */
        const val CATCH_UP_PAGE = 200
        const val MAX_CATCH_UP_PAGES = 3

        /** How old a pending send can be and still be sent again without asking. */
        const val RESUME_WINDOW_MS = 10 * 60 * 1000L

        private const val MAINTENANCE_RETRY_MS = 60_000L
        private const val NEWEST_SCAN = 100
    }
}
