package app.core.cache

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

// The chat's tables: a replica of what the server said, scoped to one account
// per row, plus the outbox (messages typed here and not yet confirmed). Every
// query names the account: a query that could return another account's rows
// eventually will. `IN (:ids)` lists are chunked by the callers ([SQL_CHUNK]):
// API 24's SQLite allows 999 bound variables per statement.
//
// No credentials and no binary: media bytes live in Coil's disk cache.

internal const val SQL_CHUNK = 500

/**
 * One conversation (one match) as the list last described it, with what
 * realtime moved since: the last message, the unread count, the pointers.
 * [peerPhotoJson] and [lastMessageJson] keep the server's JSON, read back into
 * the same types, so a field this build does not know is not lost between a
 * write and a read.
 */
@Entity(
    tableName = "conversations",
    primaryKeys = ["account_id", "conversation_id"],
    indices = [
        // The list's order: newest activity first.
        Index(value = ["account_id", "last_activity_at"]),
        Index(value = ["account_id", "peer_id"]),
    ],
)
data class ConversationEntity(
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "conversation_id") val conversationId: String,
    @ColumnInfo(name = "peer_id") val peerId: String,
    @ColumnInfo(name = "peer_name") val peerName: String,
    @ColumnInfo(name = "peer_photo_json") val peerPhotoJson: String?,
    @ColumnInfo(name = "peer_verified") val peerVerified: Boolean,
    @ColumnInfo(name = "peer_online") val peerOnline: Boolean,
    @ColumnInfo(name = "peer_active_recently") val peerActiveRecently: Boolean,
    /** `active` or `ended` (the wire value). An ended one leaves the list but its open thread can still read. */
    val state: String,
    val source: String,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "last_message_json") val lastMessageJson: String?,
    @ColumnInfo(name = "last_message_id") val lastMessageId: Long?,
    /** The last message's time, else the match's; epoch ms. */
    @ColumnInfo(name = "last_activity_at") val lastActivityAt: Long,
    val unread: Int,
    @ColumnInfo(name = "my_read_id") val myReadId: Long?,
    @ColumnInfo(name = "peer_read_id") val peerReadId: Long?,
    @ColumnInfo(name = "peer_delivered_id") val peerDeliveredId: Long?,
    @ColumnInfo(name = "calls_me") val callsMe: Boolean,
    @ColumnInfo(name = "calls_peer") val callsPeer: Boolean,
    val muted: Boolean,
    @ColumnInfo(name = "cached_at") val cachedAt: Long,
)

/**
 * One message of a thread.
 *
 * [localId] is the row's identity on the phone, and it never changes: a
 * message typed here gets one before it has a server id and keeps it after
 * the server confirms, so the transcript's list key does not change under a
 * bubble on screen. A row that only ever came from the server is `s:<id>`.
 *
 * The merge order is [serverId], then [clientId]; both are unique within a
 * conversation (SQLite lets NULLs repeat, which is what a pending row's
 * missing server id needs).
 *
 * [sortKey] is the server id once known (ids are minted in time order), and
 * for a row still on its way [PENDING_SORT_FLOOR] plus the time it was
 * written, so it sits after everything the server has.
 */
@Entity(
    tableName = "messages",
    primaryKeys = ["account_id", "local_id"],
    indices = [
        Index(value = ["account_id", "conversation_id", "sort_key"]),
        Index(value = ["account_id", "conversation_id", "server_id"], unique = true),
        Index(value = ["account_id", "conversation_id", "client_id"], unique = true),
        // The outbox.
        Index(value = ["account_id", "send_state"]),
    ],
)
data class MessageEntity(
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "local_id") val localId: String,
    @ColumnInfo(name = "conversation_id") val conversationId: String,
    @ColumnInfo(name = "server_id") val serverId: Long?,
    @ColumnInfo(name = "client_id") val clientId: String?,
    @ColumnInfo(name = "sender_id") val senderId: String,
    /** The wire value (`text`, `reaction`, `unsend`, `call`, …). */
    val kind: String,
    val body: String?,
    @ColumnInfo(name = "ref_id") val refId: Long?,
    @ColumnInfo(name = "media_json") val mediaJson: String?,
    @ColumnInfo(name = "call_json") val callJson: String?,
    /** The server's time; for a row not yet on the server, when it was written here. Epoch ms. */
    val at: Long,
    @ColumnInfo(name = "sort_key") val sortKey: Long,
    /** [SendState] as its stable code. */
    @ColumnInfo(name = "send_state") val sendState: Int,
    /** Why the last attempt failed: the server's problem code, or `network`. */
    @ColumnInfo(name = "error_code") val errorCode: String?,
    /** For a `confirm_required` answer: the token that sends it anyway. */
    @ColumnInfo(name = "confirm_token") val confirmToken: String?,
    /**
     * When the row was stored. For a row typed here and not yet confirmed:
     * when its client id was minted, so no attempt with that id is older.
     */
    @ColumnInfo(name = "cached_at") val cachedAt: Long,
) {
    companion object {
        /** Above any server id for a very long time, below `Long.MAX_VALUE` by more than a century of milliseconds. */
        const val PENDING_SORT_FLOOR: Long = Long.MAX_VALUE - (1L shl 42)
    }
}

/** Where a row is between the composer and the server. Codes are stored: never renumber. */
enum class SendState(val code: Int) {
    SENT(0),

    /** Written here, on its way (or waiting for a network) with its one client id. */
    PENDING(1),

    /** Not sent: the person decides (retry or delete). */
    FAILED(2),

    /** The server asked "are you sure?" (`confirm_required`); waits for the answer. */
    CONFIRM(3),
    ;

    companion object {
        fun of(code: Int): SendState = entries.firstOrNull { it.code == code } ?: SENT
    }
}

/**
 * How far this phone has read a thread, written in the SAME transaction as
 * the rows it covers, so a crash between the two can only make the next read
 * repeat itself, never skip.
 *
 * - [cursor]: the server's `syncCursor` from the last read: the next catch-up
 *   asks `after=` this, never the newest id seen.
 * - [oldestId] and [hasMoreBefore]: the bottom of what is loaded, for paging
 *   back.
 * - [stale]: something may be missing above [cursor] (a read that came back
 *   lagging, a reconnect the server could not recover, a push): the next
 *   open asks.
 */
@Entity(tableName = "sync_state", primaryKeys = ["account_id", "sync_key"])
data class SyncStateEntity(
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "sync_key") val key: String,
    val cursor: String?,
    @ColumnInfo(name = "oldest_id") val oldestId: Long?,
    @ColumnInfo(name = "has_more_before") val hasMoreBefore: Boolean,
    val stale: Boolean,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

object SyncKeys {
    fun thread(conversationId: String): String = "thread:$conversationId"

    /** The conversation list's next page cursor (the first page is revalidated by its ETag). */
    const val LIST = "list:conversations"
}

@Dao
interface ConversationDao {
    /** The list: active conversations, newest activity first. */
    @Query(
        """
        SELECT * FROM conversations WHERE account_id = :accountId AND state != 'ended'
        ORDER BY last_activity_at DESC, conversation_id DESC
        """,
    )
    fun observeList(accountId: String): Flow<List<ConversationEntity>>

    @Query("SELECT * FROM conversations WHERE account_id = :accountId AND conversation_id = :conversationId")
    fun observe(accountId: String, conversationId: String): Flow<ConversationEntity?>

    @Query("SELECT * FROM conversations WHERE account_id = :accountId AND conversation_id = :conversationId")
    suspend fun get(accountId: String, conversationId: String): ConversationEntity?

    @Query("SELECT * FROM conversations WHERE account_id = :accountId AND conversation_id IN (:ids)")
    suspend fun getAll(accountId: String, ids: List<String>): List<ConversationEntity>

    @Query("SELECT conversation_id FROM conversations WHERE account_id = :accountId")
    suspend fun ids(accountId: String): List<String>

    @Query("SELECT * FROM conversations WHERE account_id = :accountId AND peer_id = :peerId")
    suspend fun byPeer(accountId: String, peerId: String): List<ConversationEntity>

    @Upsert
    suspend fun upsert(rows: List<ConversationEntity>)

    @Query("DELETE FROM conversations WHERE account_id = :accountId AND conversation_id = :conversationId")
    suspend fun delete(accountId: String, conversationId: String)

    @Query("DELETE FROM conversations WHERE account_id = :accountId")
    suspend fun clear(accountId: String)

    @Query("DELETE FROM conversations")
    suspend fun clearAll()

    /** Rows another account left behind (a sign-out the process did not live to finish). */
    @Query("DELETE FROM conversations WHERE account_id != :accountId")
    suspend fun clearExcept(accountId: String)
}

/** The columns a merge needs to match an incoming message to a stored one. */
data class MessageKey(
    @ColumnInfo(name = "local_id") val localId: String,
    @ColumnInfo(name = "server_id") val serverId: Long?,
    @ColumnInfo(name = "client_id") val clientId: String?,
    @ColumnInfo(name = "send_state") val sendState: Int,
)

@Dao
interface MessageDao {
    /**
     * The newest [limit] rows of a thread, newest first (the screen reverses
     * them). The window grows as the person scrolls back; it never reads the
     * whole thread to show its end.
     */
    @Query(
        """
        SELECT * FROM messages WHERE account_id = :accountId AND conversation_id = :conversationId
        AND kind NOT IN ('reaction', 'unsend')
        ORDER BY sort_key DESC LIMIT :limit
        """,
    )
    fun observeNewest(accountId: String, conversationId: String, limit: Int): Flow<List<MessageEntity>>

    /** Reactions and unsends of a thread: few rows, folded onto the messages they point at. */
    @Query(
        """
        SELECT * FROM messages WHERE account_id = :accountId AND conversation_id = :conversationId
        AND kind IN ('reaction', 'unsend') ORDER BY sort_key ASC
        """,
    )
    fun observeMarks(accountId: String, conversationId: String): Flow<List<MessageEntity>>

    @Query("SELECT * FROM messages WHERE account_id = :accountId AND local_id = :localId")
    suspend fun get(accountId: String, localId: String): MessageEntity?

    @Query(
        """
        SELECT local_id, server_id, client_id, send_state FROM messages
        WHERE account_id = :accountId AND conversation_id = :conversationId AND server_id IN (:serverIds)
        """,
    )
    suspend fun keysByServerId(accountId: String, conversationId: String, serverIds: List<Long>): List<MessageKey>

    @Query(
        """
        SELECT local_id, server_id, client_id, send_state FROM messages
        WHERE account_id = :accountId AND conversation_id = :conversationId AND client_id IN (:clientIds)
        """,
    )
    suspend fun keysByClientId(accountId: String, conversationId: String, clientIds: List<String>): List<MessageKey>

    @Query("SELECT * FROM messages WHERE account_id = :accountId AND conversation_id = :conversationId AND client_id = :clientId")
    suspend fun byClientId(accountId: String, conversationId: String, clientId: String): MessageEntity?

    @Query(
        """
        SELECT COUNT(*) FROM messages
        WHERE account_id = :accountId AND conversation_id = :conversationId AND server_id = :serverId
        """,
    )
    suspend fun countServerId(accountId: String, conversationId: String, serverId: Long): Int

    @Query("SELECT MAX(server_id) FROM messages WHERE account_id = :accountId AND conversation_id = :conversationId")
    suspend fun newestServerId(accountId: String, conversationId: String): Long?

    /** Server rows of a thread from [fromId] up, newest last: for the read receipt. */
    @Query(
        """
        SELECT * FROM messages WHERE account_id = :accountId AND conversation_id = :conversationId
        AND server_id IS NOT NULL ORDER BY sort_key DESC LIMIT :limit
        """,
    )
    suspend fun newestServerRows(accountId: String, conversationId: String, limit: Int): List<MessageEntity>

    /**
     * One sender's confirmed rows of one kind from [since] (epoch ms) on,
     * oldest first: where a message an earlier send attempt made would be.
     */
    @Query(
        """
        SELECT * FROM messages WHERE account_id = :accountId AND conversation_id = :conversationId
        AND server_id IS NOT NULL AND sender_id = :senderId AND kind = :kind AND at >= :since
        ORDER BY sort_key ASC LIMIT :limit
        """,
    )
    suspend fun sentSince(accountId: String, conversationId: String, senderId: String, kind: String, since: Long, limit: Int): List<MessageEntity>

    /** Everything not yet confirmed, oldest first. */
    @Query("SELECT * FROM messages WHERE account_id = :accountId AND send_state != 0 ORDER BY sort_key ASC")
    suspend fun outbox(accountId: String): List<MessageEntity>

    @Query("SELECT * FROM messages WHERE account_id = :accountId AND send_state != 0 ORDER BY sort_key ASC")
    fun observeOutbox(accountId: String): Flow<List<MessageEntity>>

    @Upsert
    suspend fun upsert(rows: List<MessageEntity>)

    @Query("DELETE FROM messages WHERE account_id = :accountId AND local_id IN (:localIds)")
    suspend fun delete(accountId: String, localIds: List<String>)

    /** The confirmed rows of a thread (the outbox stays): a thread read again from its end. */
    @Query("DELETE FROM messages WHERE account_id = :accountId AND conversation_id = :conversationId AND send_state = 0")
    suspend fun deleteConfirmed(accountId: String, conversationId: String)

    @Query("DELETE FROM messages WHERE account_id = :accountId AND conversation_id = :conversationId")
    suspend fun deleteThread(accountId: String, conversationId: String)

    @Query("DELETE FROM messages WHERE account_id = :accountId")
    suspend fun clear(accountId: String)

    @Query("DELETE FROM messages")
    suspend fun clearAll()

    /** Rows another account left behind (a sign-out the process did not live to finish). */
    @Query("DELETE FROM messages WHERE account_id != :accountId")
    suspend fun clearExcept(accountId: String)
}

@Dao
interface SyncStateDao {
    @Query("SELECT * FROM sync_state WHERE account_id = :accountId AND sync_key = :key")
    suspend fun get(accountId: String, key: String): SyncStateEntity?

    @Query("SELECT * FROM sync_state WHERE account_id = :accountId AND sync_key IN (:keys)")
    suspend fun getAll(accountId: String, keys: List<String>): List<SyncStateEntity>

    @Upsert
    suspend fun upsert(row: SyncStateEntity)

    @Query("UPDATE sync_state SET stale = 1 WHERE account_id = :accountId AND sync_key LIKE 'thread:%'")
    suspend fun markAllThreadsStale(accountId: String)

    @Query("DELETE FROM sync_state WHERE account_id = :accountId AND sync_key = :key")
    suspend fun delete(accountId: String, key: String)

    @Query("DELETE FROM sync_state WHERE account_id = :accountId")
    suspend fun clear(accountId: String)

    @Query("DELETE FROM sync_state")
    suspend fun clearAll()

    /** Rows another account left behind (a sign-out the process did not live to finish). */
    @Query("DELETE FROM sync_state WHERE account_id != :accountId")
    suspend fun clearExcept(accountId: String)
}
