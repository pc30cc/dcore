package app.core.sync

import app.core.cache.CacheDatabase
import app.core.cache.ChatMapping
import app.core.cache.ChatStore
import app.core.cache.ConversationEntity
import app.core.cache.SyncKeys
import app.core.cache.SyncStateEntity
import app.core.common.Clock
import app.core.common.Diag
import app.core.model.Conversation
import app.core.model.ConversationState
import app.core.model.Id
import app.core.model.Message
import app.core.model.MessageKind
import app.core.model.PublicUid
import app.core.model.ReceiptEvent
import app.core.net.ApiError
import app.core.net.ServerApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** How a list read went. */
sealed interface ListRefresh {
    /** The server said 304: nothing moved. */
    data object Unchanged : ListRefresh

    /** Read and merged; [moved] are the conversations whose last message is newer than what the phone had. */
    data class Changed(val moved: Set<Id>) : ListRefresh

    data class Failed(val offline: Boolean, val error: ApiError?) : ListRefresh
}

/**
 * The conversation list (one row per match), local-first.
 *
 * The first page is revalidated with its ETag: the server answers 304 from a
 * version counter, without its database, whenever nothing moved, which is
 * almost always. Between reads, realtime keeps the rows current: a message
 * moves its conversation's preview, time and unread count; a receipt moves
 * the pointers; `conversation` and `conversation_end` add and remove rows.
 *
 * The unread count follows the server's rule: it is 0 once the reader's
 * pointer reaches the newest message counted for them, whatever came after
 * it (their own reply, an unsend, a call line of theirs). The phone compares
 * with the newest such message it knows of ([newestCounted]); when it cannot
 * know it, it keeps the count until the server's list says otherwise.
 */
class ConversationRepository(
    private val api: ServerApi,
    private val store: ChatStore,
    private val clock: Clock = Clock.System,
    private val diag: Diag = Diag.Android,
) {
    private val lock = Mutex()

    fun observeList(account: PublicUid): Flow<List<Conversation>> =
        store.observe(emptyList()) { it.conversations().observeList(account) }.map { rows -> rows.map(ChatMapping::conversation) }

    fun observe(account: PublicUid, conversationId: Id): Flow<Conversation?> =
        store.observe<ConversationEntity?>(null) { it.conversations().observe(account, conversationId) }
            .map { row -> row?.let(ChatMapping::conversation) }

    suspend fun get(account: PublicUid, conversationId: Id): ConversationEntity? =
        store.read("conversation") { it.conversations().get(account, conversationId) }

    /** Whether there is a next page to read ([loadMore]). */
    suspend fun hasMore(account: PublicUid): Boolean =
        store.read("list cursor") { it.syncState().get(account, SyncKeys.LIST)?.cursor } != null

    /**
     * Revalidates the first page. When the server's answer is the whole list
     * (no next page), a conversation the phone has and the answer does not is
     * gone and is removed, unless it was written after the read began.
     */
    suspend fun refresh(account: PublicUid): ListRefresh = lock.withLock {
        val started = clock.nowMillis()
        val answer = try {
            api.conversations(cursor = null, limit = PAGE)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            diag.info(AREA, "list read failed: ${e.code ?: e.javaClass.simpleName}")
            return@withLock ListRefresh.Failed(offline = e is ApiError.Network, error = e)
        }
        if (!answer.changed) {
            // A 304 confirms what is stored; still apply it once if the store
            // lost it (a rebuilt database) so the list is not empty.
            val empty = store.read("list empty") { it.conversations().ids(account).isEmpty() } ?: true
            if (!empty || answer.value.items.isEmpty()) return@withLock ListRefresh.Unchanged
        }
        val page = answer.value
        val moved = store.write("list merge") { db ->
            val dao = db.conversations()
            val ids = page.items.map { it.id }
            val existing = ids.chunked(app.core.cache.SQL_CHUNK).flatMap { dao.getAll(account, it) }.associateBy { it.conversationId }
            val now = clock.nowMillis()
            val moved = HashSet<Id>()
            val rows = page.items.map { conversation ->
                val before = existing[conversation.id]
                val fresh = ChatMapping.conversation(account, conversation, now)
                val newer = (fresh.lastMessageId ?: 0) > (before?.lastMessageId ?: 0)
                if (newer) moved += conversation.id
                merged(db, account, before, fresh)
            }
            dao.upsert(rows)
            if (page.nextCursor == null) {
                val keep = ids.toSet()
                dao.ids(account).filter { it !in keep }.forEach { id ->
                    val row = dao.get(account, id) ?: return@forEach
                    if (row.cachedAt <= started) {
                        dao.delete(account, id)
                        db.messages().deleteThread(account, id)
                        db.syncState().delete(account, SyncKeys.thread(id))
                    }
                }
            }
            db.syncState().upsert(
                SyncStateEntity(account, SyncKeys.LIST, page.nextCursor, null, page.nextCursor != null, false, now),
            )
            moved
        } ?: emptySet()
        diag.info(AREA, "list: ${page.items.size} rows, ${moved.size} moved")
        ListRefresh.Changed(moved)
    }

    /** The next page of older conversations, when the person scrolls to the end. */
    suspend fun loadMore(account: PublicUid): Boolean = lock.withLock {
        val cursor = store.read("list cursor") { it.syncState().get(account, SyncKeys.LIST)?.cursor } ?: return@withLock false
        val page = try {
            api.conversations(cursor = cursor, limit = PAGE).value
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            return@withLock false
        }
        store.write("list page") { db ->
            val dao = db.conversations()
            val now = clock.nowMillis()
            val existing = page.items.map { it.id }.chunked(app.core.cache.SQL_CHUNK)
                .flatMap { dao.getAll(account, it) }.associateBy { it.conversationId }
            dao.upsert(page.items.map { merged(db, account, existing[it.id], ChatMapping.conversation(account, it, now)) })
            db.syncState().upsert(SyncStateEntity(account, SyncKeys.LIST, page.nextCursor, null, page.nextCursor != null, false, now))
        }
        true
    }

    /**
     * The server's row, with what this phone knows better: its own read
     * pointer when it is ahead (a receipt the answer was made before). The
     * unread count is the server's, unless that pointer already reaches the
     * newest message counted for this account (then 0, as the server will
     * say once it has the receipt).
     */
    private suspend fun merged(db: CacheDatabase, account: PublicUid, before: ConversationEntity?, fresh: ConversationEntity): ConversationEntity {
        if (before == null) return fresh
        val myRead = maxOf(before.myReadId ?: 0, fresh.myReadId ?: 0).takeIf { it > 0 }
        val readAll = myRead != null && fresh.lastMessageId != null && myRead >= fresh.lastMessageId
        val ahead = myRead != null && myRead > (fresh.myReadId ?: 0)
        val next = fresh.copy(
            myReadId = myRead,
            peerReadId = maxOf(before.peerReadId ?: 0, fresh.peerReadId ?: 0).takeIf { it > 0 },
            peerDeliveredId = maxOf(before.peerDeliveredId ?: 0, fresh.peerDeliveredId ?: 0).takeIf { it > 0 },
        )
        val settled = readAll || (ahead && fresh.unread > 0 && readUpToCounted(myRead, newestCounted(db, account, next)))
        return if (settled) next.copy(unread = 0) else next
    }

    /**
     * A conversation the server just described (a match, an accepted request,
     * a settings change). An answer that names no last message (an accept
     * repeated after it worked) never erases the one this phone shows.
     */
    suspend fun upsert(account: PublicUid, conversation: Conversation) {
        store.write("conversation") { db ->
            val dao = db.conversations()
            val before = dao.get(account, conversation.id)
            var fresh = ChatMapping.conversation(account, conversation, clock.nowMillis())
            if (before?.lastMessageId != null && fresh.lastMessageId == null) {
                fresh = fresh.copy(
                    lastMessageJson = before.lastMessageJson,
                    lastMessageId = before.lastMessageId,
                    lastActivityAt = maxOf(before.lastActivityAt, fresh.lastActivityAt),
                )
            }
            dao.upsert(listOf(merged(db, account, before, fresh)))
        }
    }

    /**
     * The newest message this phone knows of that the server may count as
     * unread for [account]: the peer's, neither a reaction nor an unsend.
     * The list row's last message when it is that (or the thread's newest
     * such row, when a read put a newer one there); otherwise the thread's,
     * but only from a thread complete up to that last message (read here,
     * not stale, holding it), since a gap could hide a newer one. 0: the peer
     * has written nothing that counts. Null: this phone cannot tell.
     */
    private suspend fun newestCounted(db: CacheDatabase, account: PublicUid, row: ConversationEntity): Long? {
        val messages = db.messages()
        val newest = messages.newestServerRows(account, row.conversationId, COUNTED_SCAN)
        val inThread = newest.firstOrNull { it.senderId != account && counts(ChatMapping.kind(it)) }?.serverId
        val last = ChatMapping.lastMessage(row)
        val lastId = row.lastMessageId
        if (last != null && lastId != null && last.senderId != account && counts(last.kind)) return maxOf(lastId, inThread ?: 0)
        val state = db.syncState().get(account, SyncKeys.thread(row.conversationId)) ?: return null
        if (state.stale) return null
        if (lastId != null && messages.countServerId(account, row.conversationId, lastId) == 0) return null
        if (inThread != null) return inThread
        // Nothing of theirs among the rows looked at: none at all only if those were the whole thread.
        return if (newest.size < COUNTED_SCAN && !state.hasMoreBefore) 0 else null
    }

    private fun counts(kind: MessageKind): Boolean = kind != MessageKind.Reaction && kind != MessageKind.Unsend

    private fun readUpToCounted(myRead: Long?, counted: Long?): Boolean = counted != null && (myRead ?: 0) >= counted

    /**
     * A message reached the phone (realtime, a send, a read): the preview,
     * the time and, for the peer's messages when nobody is looking, the
     * unread count move. False when the conversation is not here (the list
     * needs a read).
     */
    suspend fun onMessage(account: PublicUid, message: Message, viewing: Boolean): Boolean =
        store.write("conversation message") { db ->
            val dao = db.conversations()
            val row = dao.get(account, message.conversationId) ?: return@write false
            val id = ChatMapping.idOf(message.id) ?: return@write true
            if (id <= (row.lastMessageId ?: 0)) return@write true
            // A reaction is not the conversation's news; an unsend of the
            // preview is (the preview becomes "unsent").
            if (message.kind == MessageKind.Reaction) return@write true
            if (message.kind == MessageKind.Unsend && ChatMapping.idOf(message.refId) != row.lastMessageId) return@write true
            val fromPeer = message.senderId != account
            dao.upsert(
                listOf(
                    row.copy(
                        lastMessageJson = ChatMapping.encodeMessage(message),
                        lastMessageId = id,
                        lastActivityAt = maxOf(row.lastActivityAt, message.at.toEpochMilli()),
                        unread = if (fromPeer && !viewing && message.kind != MessageKind.Unsend) row.unread + 1 else row.unread,
                        cachedAt = clock.nowMillis(),
                    ),
                ),
            )
            true
        } ?: true

    /**
     * A pointer moved: the reader's own (another phone of theirs), or the
     * peer's. True when the reader's count is left standing only because
     * this phone cannot tell whether the pointer reached the newest message
     * counted for them (it does not hold the thread): the server's list
     * knows, and its version moved with the receipt.
     */
    suspend fun applyReceipt(account: PublicUid, receipt: ReceiptEvent): Boolean =
        store.write("receipt") { db ->
            val dao = db.conversations()
            val row = dao.get(account, receipt.conversationId) ?: return@write false
            val read = ChatMapping.idOf(receipt.readUpTo)
            val delivered = ChatMapping.idOf(receipt.deliveredUpTo)
            var unknown = false
            val next = if (receipt.by == account) {
                val mine = maxOf(row.myReadId ?: 0, read ?: 0).takeIf { it > 0 }
                val moved = row.copy(myReadId = mine)
                if (row.unread == 0 || read == null) {
                    moved
                } else {
                    // Not known here: past the last message nothing can be unread; short of it, the list decides.
                    val counted = newestCounted(db, account, moved)
                    unknown = counted == null && (mine ?: 0) < (row.lastMessageId ?: 0)
                    if (readUpToCounted(mine, counted ?: row.lastMessageId ?: 0)) moved.copy(unread = 0) else moved
                }
            } else {
                row.copy(
                    peerReadId = maxOf(row.peerReadId ?: 0, read ?: 0).takeIf { it > 0 },
                    peerDeliveredId = maxOf(row.peerDeliveredId ?: 0, delivered ?: 0, read ?: 0).takeIf { it > 0 },
                )
            }
            if (next != row) dao.upsert(listOf(next))
            unknown
        } ?: false

    /** The pointers a thread read carried. */
    suspend fun applyPointers(account: PublicUid, conversationId: Id, pointers: ReadPointers) {
        store.write("pointers") { db ->
            val dao = db.conversations()
            val row = dao.get(account, conversationId) ?: return@write
            val mine = maxOf(row.myReadId ?: 0, pointers.mine ?: 0).takeIf { it > 0 }
            val moved = row.copy(
                myReadId = mine,
                peerReadId = maxOf(row.peerReadId ?: 0, pointers.peerRead ?: 0).takeIf { it > 0 },
                peerDeliveredId = maxOf(row.peerDeliveredId ?: 0, pointers.peerDelivered ?: 0, pointers.peerRead ?: 0).takeIf { it > 0 },
            )
            val next = if (moved.unread > 0 && readUpToCounted(mine, newestCountedOrLast(db, account, moved))) moved.copy(unread = 0) else moved
            if (next != row) dao.upsert(listOf(next))
        }
    }

    /** The person is looking at the thread: no unread count, whatever the server has heard yet. */
    suspend fun clearUnread(account: PublicUid, conversationId: Id) {
        store.write("clear unread") { db ->
            val dao = db.conversations()
            val row = dao.get(account, conversationId) ?: return@write
            if (row.unread != 0) dao.upsert(listOf(row.copy(unread = 0)))
        }
    }

    /** The server has this phone's read pointer at [upTo]: no unread count left for what it covers. */
    suspend fun markRead(account: PublicUid, conversationId: Id, upTo: Long) {
        store.write("mark read") { db ->
            val dao = db.conversations()
            val row = dao.get(account, conversationId) ?: return@write
            val moved = row.copy(myReadId = maxOf(row.myReadId ?: 0, upTo))
            val next = if (moved.unread > 0 && readUpToCounted(moved.myReadId, newestCountedOrLast(db, account, moved))) moved.copy(unread = 0) else moved
            if (next != row) dao.upsert(listOf(next))
        }
    }

    /** [newestCounted], else the last message itself (nothing after it can be unread). */
    private suspend fun newestCountedOrLast(db: CacheDatabase, account: PublicUid, row: ConversationEntity): Long =
        newestCounted(db, account, row) ?: row.lastMessageId ?: 0

    /**
     * The conversation ended (unmatch, block, ban or deletion; the server
     * never says which). It leaves the list; an open thread can still read
     * what it has until it is closed ([remove]).
     */
    suspend fun end(account: PublicUid, conversationId: Id) {
        store.write("end") { db ->
            val dao = db.conversations()
            val row = dao.get(account, conversationId) ?: return@write
            if (row.state != ConversationState.Ended.wire) dao.upsert(listOf(row.copy(state = ConversationState.Ended.wire)))
        }
    }

    /** Gone from the phone: the conversation, its messages and its cursor. */
    suspend fun remove(account: PublicUid, conversationId: Id) {
        store.write("remove") { db ->
            db.conversations().delete(account, conversationId)
            db.messages().deleteThread(account, conversationId)
            db.syncState().delete(account, SyncKeys.thread(conversationId))
        }
    }

    /** Conversations that ended while open, cleaned up once nothing shows them. */
    suspend fun removeEnded(account: PublicUid, except: Id?) {
        store.write("remove ended") { db ->
            val dao = db.conversations()
            dao.ids(account).forEach { id ->
                if (id == except) return@forEach
                val row = dao.get(account, id) ?: return@forEach
                if (row.state == ConversationState.Ended.wire) {
                    dao.delete(account, id)
                    db.messages().deleteThread(account, id)
                    db.syncState().delete(account, SyncKeys.thread(id))
                }
            }
        }
    }

    /** The conversation with [peer], if the phone has one: blocking a person ends it. */
    suspend fun byPeer(account: PublicUid, peer: PublicUid): List<Id> =
        store.read("by peer") { db -> db.conversations().byPeer(account, peer).map { it.conversationId } }.orEmpty()

    companion object {
        private const val AREA = "Sync"
        const val PAGE = 50

        /** Thread rows looked at for the peer's newest counted message. */
        private const val COUNTED_SCAN = 100
    }
}
