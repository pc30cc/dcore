package app.core.sync

import app.core.cache.ChatMapping
import app.core.cache.MessageEntity
import app.core.cache.SendState
import app.core.model.CallLine
import app.core.model.Id
import app.core.model.MessageKind
import app.core.model.MessageMedia
import app.core.model.MessagesPage
import app.core.model.PublicUid
import java.time.Instant

/**
 * One message as a thread shows it: the server's row, or one of this
 * phone's on its way. [localId] is stable for the bubble's whole life.
 */
data class ChatMessage(
    val localId: String,
    val serverId: Long?,
    val clientId: String?,
    val conversationId: Id,
    val senderId: PublicUid,
    val mine: Boolean,
    val kind: MessageKind,
    val body: String?,
    val refId: Long?,
    val media: MessageMedia?,
    val call: CallLine?,
    val at: Instant,
    val state: SendState,
    /** Why the last attempt failed (a problem code, or [ChatErrors.NETWORK]). */
    val errorCode: String?,
) {
    val sent: Boolean get() = state == SendState.SENT && serverId != null

    companion object {
        fun of(row: MessageEntity, me: PublicUid): ChatMessage = ChatMessage(
            localId = row.localId,
            serverId = row.serverId,
            clientId = row.clientId,
            conversationId = row.conversationId,
            senderId = row.senderId,
            mine = row.senderId == me,
            kind = ChatMapping.kind(row),
            body = row.body,
            refId = row.refId,
            media = ChatMapping.media(row),
            call = ChatMapping.call(row),
            at = Instant.ofEpochMilli(row.at),
            state = SendState.of(row.sendState),
            errorCode = row.errorCode,
        )
    }
}

/** What happened to a message the server refused or could not be asked about. */
object ChatErrors {
    /** No answer: the phone is offline or the server unreachable; the outbox tries again. */
    const val NETWORK = "network"

    /** Older than the outbox's resume window: not sent on the person's behalf without asking. */
    const val EXPIRED = "expired"

    /** Anything else the server said no to. */
    const val OTHER = "other"
}

/** How one read of a thread went. */
sealed interface ThreadRead {
    /** Read [count] rows; [pointers] are the read and delivered pointers the last page carried. */
    data class Read(val count: Int, val pointers: ReadPointers?) : ThreadRead

    /** Nothing to ask: the phone has everything the server would send. */
    data object UpToDate : ThreadRead

    /** The conversation is gone (unmatched, blocked, deleted: the server never says which). */
    data object Gone : ThreadRead

    /** The conversation ended; what is here can still be read. */
    data object Ended : ThreadRead

    data class Failed(val offline: Boolean) : ThreadRead
}

/** How paging back went. */
sealed interface OlderRead {
    data class Read(val count: Int, val hasMore: Boolean) : OlderRead
    data object NothingMore : OlderRead
    data class Failed(val offline: Boolean) : OlderRead
}

/** How one delivery attempt of an outbox row went. */
sealed interface SendOutcome {
    /** On the server; [message] is the server's copy. */
    data class Sent(val message: app.core.model.Message?) : SendOutcome

    /** Not this time (no network, the server busy or rate-limiting): try again after [afterMs]. */
    data class RetryLater(val afterMs: Long?) : SendOutcome

    /** The server asks "are you sure?" ([category]: money, contact details, …). */
    data class NeedsConfirm(val category: String?) : SendOutcome

    /** Refused for good ([code]); the person may edit and send again, or delete it. */
    data class Refused(val code: String) : SendOutcome

    /** The conversation is gone or ended: nothing more can be sent in it. */
    data object Closed : SendOutcome

    /** The row is no longer in the outbox. */
    data object Missing : SendOutcome
}

/** The read and delivered pointers a page of messages carries. */
data class ReadPointers(val mine: Long?, val peerRead: Long?, val peerDelivered: Long?) {
    companion object {
        fun of(page: MessagesPage): ReadPointers = ReadPointers(
            mine = ChatMapping.idOf(page.readCursors.me),
            peerRead = ChatMapping.idOf(page.readCursors.peer),
            peerDelivered = ChatMapping.idOf(page.peerDeliveredId),
        )
    }
}
