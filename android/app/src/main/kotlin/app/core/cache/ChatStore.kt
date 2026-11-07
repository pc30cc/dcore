package app.core.cache

import androidx.room.withTransaction
import app.core.common.Diag
import app.core.model.CallLine
import app.core.model.CallsAllowed
import app.core.model.Conversation
import app.core.model.ConversationPeer
import app.core.model.ConversationSource
import app.core.model.ConversationState
import app.core.model.Message
import app.core.model.MessageKind
import app.core.model.MessageMedia
import app.core.model.Photo
import app.core.model.Wire
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.KSerializer
import java.time.Instant

/**
 * The chat tables behind one door: transactions, and flows that outlive a
 * rebuilt database.
 *
 * A damaged file found mid-session resets the database (the server fills it
 * again) and reads as empty; open screens resubscribe through the holder's
 * generation. A write that fails is logged and reported as not done (null),
 * never thrown at a screen.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatStore(
    private val holder: CacheDatabaseHolder,
    private val diag: Diag = Diag.Android,
) {
    /** Runs [block] in one transaction. Null when the database failed (it is reset on corruption). */
    suspend fun <T> write(what: String, block: suspend (CacheDatabase) -> T): T? = guarded(what) { db ->
        db.withTransaction { block(db) }
    }

    /** A read outside a transaction. Null when the database failed. */
    suspend fun <T> read(what: String, block: suspend (CacheDatabase) -> T): T? = guarded(what, block)

    private suspend fun <T> guarded(what: String, block: suspend (CacheDatabase) -> T): T? =
        try {
            block(holder.get())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e.isCacheCorruption()) holder.reset("corruption during $what") else diag.warn(AREA, "$what failed: ${e.javaClass.simpleName}")
            null
        }

    /** A query's flow, re-made on every database rebuild; a failure reads as [empty]. */
    fun <T> observe(empty: T, query: (CacheDatabase) -> Flow<T>): Flow<T> =
        holder.generation.flatMapLatest {
            flow { emitAll(query(holder.get())) }
                .catch { e ->
                    if (e is Exception && e.isCacheCorruption()) holder.reset("corruption while observing")
                    else diag.warn(AREA, "observe failed: ${e.javaClass.simpleName}")
                    emit(empty)
                }
        }

    /** Every chat row of every account: a sign-out, or another account signing in. */
    suspend fun clearAll() {
        write("clear") { db ->
            db.messages().clearAll()
            db.conversations().clearAll()
            db.syncState().clearAll()
        }
    }

    /** Keeps only [account]'s rows. */
    suspend fun keepOnly(account: String) {
        write("keep only") { db ->
            db.messages().clearExcept(account)
            db.conversations().clearExcept(account)
            db.syncState().clearExcept(account)
        }
    }

    private companion object {
        const val AREA = "Cache"
    }
}

/** Server model <-> table rows. Nested parts are kept as the server's JSON. */
object ChatMapping {

    private fun <T> encode(serializer: KSerializer<T>, value: T?): String? =
        value?.let { Wire.json.encodeToString(serializer, it) }

    private fun <T> decode(serializer: KSerializer<T>, text: String?): T? =
        text?.let { runCatching { Wire.json.decodeFromString(serializer, it) }.getOrNull() }

    fun idOf(id: String?): Long? = id?.toLongOrNull()?.takeIf { it > 0 }

    fun conversation(account: String, c: Conversation, now: Long): ConversationEntity = ConversationEntity(
        accountId = account,
        conversationId = c.id,
        peerId = c.peer.id,
        peerName = c.peer.name,
        peerPhotoJson = encode(Photo.serializer(), c.peer.photo),
        peerVerified = c.peer.verified,
        peerOnline = c.peer.online,
        peerActiveRecently = c.peer.activeRecently,
        state = if (c.state == ConversationState.Ended) ConversationState.Ended.wire else ConversationState.Active.wire,
        source = c.source.wire,
        createdAt = c.createdAt.toEpochMilli(),
        lastMessageJson = encode(Message.serializer(), c.lastMessage),
        lastMessageId = idOf(c.lastMessage?.id),
        lastActivityAt = (c.lastMessage?.at ?: c.createdAt).toEpochMilli(),
        unread = c.unread.coerceAtLeast(0),
        myReadId = idOf(c.myReadId),
        peerReadId = idOf(c.peerReadId),
        peerDeliveredId = idOf(c.peerDeliveredId),
        callsMe = c.callsAllowed.me,
        callsPeer = c.callsAllowed.peer,
        muted = c.muted,
        cachedAt = now,
    )

    fun conversation(row: ConversationEntity): Conversation = Conversation(
        id = row.conversationId,
        peer = ConversationPeer(
            id = row.peerId,
            name = row.peerName,
            photo = decode(Photo.serializer(), row.peerPhotoJson),
            verified = row.peerVerified,
            online = row.peerOnline,
            activeRecently = row.peerActiveRecently,
        ),
        state = if (row.state == ConversationState.Ended.wire) ConversationState.Ended else ConversationState.Active,
        source = ConversationSource.entries.firstOrNull { it.wire == row.source && it != ConversationSource.Unknown }
            ?: ConversationSource.Unknown,
        createdAt = Instant.ofEpochMilli(row.createdAt),
        lastMessage = lastMessage(row),
        unread = row.unread,
        myReadId = row.myReadId?.toString(),
        peerReadId = row.peerReadId?.toString(),
        peerDeliveredId = row.peerDeliveredId?.toString(),
        callsAllowed = CallsAllowed(me = row.callsMe, peer = row.callsPeer),
        muted = row.muted,
    )

    fun lastMessage(row: ConversationEntity): Message? = decode(Message.serializer(), row.lastMessageJson)

    fun encodeMessage(message: Message?): String? = encode(Message.serializer(), message)

    /** A server row. [existing] keeps the local id the phone already shows it under. */
    fun message(account: String, m: Message, existingLocalId: String?, now: Long): MessageEntity? {
        val serverId = idOf(m.id) ?: return null
        return MessageEntity(
            accountId = account,
            localId = existingLocalId ?: "s:$serverId",
            conversationId = m.conversationId,
            serverId = serverId,
            clientId = m.clientId,
            senderId = m.senderId,
            kind = m.kind.wire.ifEmpty { UNKNOWN_KIND },
            body = m.body,
            refId = idOf(m.refId),
            mediaJson = encode(MessageMedia.serializer(), m.media),
            callJson = encode(CallLine.serializer(), m.call),
            at = m.at.toEpochMilli(),
            sortKey = serverId,
            sendState = SendState.SENT.code,
            errorCode = null,
            confirmToken = null,
            cachedAt = now,
        )
    }

    fun media(row: MessageEntity): MessageMedia? = decode(MessageMedia.serializer(), row.mediaJson)

    fun call(row: MessageEntity): CallLine? = decode(CallLine.serializer(), row.callJson)

    fun kind(row: MessageEntity): MessageKind =
        MessageKind.entries.firstOrNull { it != MessageKind.Unknown && it.wire == row.kind } ?: MessageKind.Unknown

    /** A kind a newer server may send that this build cannot name. Stored so it is shown as such, not lost. */
    const val UNKNOWN_KIND = "unknown"
}
