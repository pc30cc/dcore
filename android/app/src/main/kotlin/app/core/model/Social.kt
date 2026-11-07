@file:UseSerializers(InstantSerializer::class)

package app.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.UseSerializers
import java.time.Instant

// Deck, swipes, likes, conversations, messages and message requests.

@Serializable
data class DeckPage(
    val cards: List<ProfileCard> = emptyList(),
    val remaining: Int = 0,
    val exhausted: Boolean = false,
    val suggestions: List<DeckSuggestion> = emptyList(),
)

/** The photo or prompt a like points at. */
@Serializable
data class LikedItem(
    val kind: ItemKind,
    val ref: Id,
)

@Serializable
data class Swipe(
    val target: PublicUid,
    val action: SwipeAction,
    val item: LikedItem? = null,
    /** At most 300 characters; only with a like. */
    val comment: String? = null,
)

@Serializable
data class SwipesRequest(
    /** 1-20. Passes are batched by the caller; likes go at once. */
    val swipes: List<Swipe>,
)

@Serializable
data class SwipeResult(
    val target: PublicUid,
    val result: SwipeOutcome = SwipeOutcome.Unknown,
    /** On `matched`: the new conversation. */
    val conversation: Conversation? = null,
)

@Serializable
data class SwipesResult(
    val results: List<SwipeResult> = emptyList(),
    val quotas: Quotas = Quotas(),
)

/**
 * Someone who liked the account. On the free plan only [blurhash] is set
 * (except the day's reveal and super likes); with see-likes, the card and the
 * comment.
 */
@Serializable
data class LikeItem(
    val liker: ProfileCard? = null,
    val blurhash: String? = null,
    val kind: LikeKind = LikeKind.Unknown,
    val item: LikedItem? = null,
    val comment: String? = null,
)

@Serializable
data class LikesPage(
    val total: Int = 0,
    /** A like bucket is at its cap: show [total] as "N+". */
    val totalPlus: Boolean = false,
    val items: List<LikeItem> = emptyList(),
    val nextCursor: String? = null,
)

@Serializable
data class ConversationsPage(
    /** Newest activity first. */
    val items: List<Conversation> = emptyList(),
    val nextCursor: String? = null,
)

@Serializable
data class ReadCursors(
    val me: Id? = null,
    val peer: Id? = null,
)

/**
 * One page of a conversation, oldest first.
 *
 * [syncCursor] is the position below which every message is durable on the
 * server (`min(newest id returned, write-behind watermark - 1)`). A reader
 * stores it, not the newest id it saw, and asks `after=<syncCursor>` next
 * time: rows that reach the server's database late are then still fetched,
 * and the repeats are dropped by id. Null from a server that does not send
 * it: the newest id returned stands in.
 *
 * [writeLagMs] comes from the `X-Write-Lag-Ms` header, not the body: how far
 * the server's write-behind is behind. Above 2000 a reader asks for `after`
 * again a little later, because a message sent in that window may not be in
 * this page yet.
 */
@Serializable
data class MessagesPage(
    val items: List<Message> = emptyList(),
    val hasMore: Boolean = false,
    val syncCursor: Id? = null,
    val readCursors: ReadCursors = ReadCursors(),
    val peerDeliveredId: Id? = null,
    @Transient val writeLagMs: Long? = null,
) {
    val lagging: Boolean get() = (writeLagMs ?: 0L) > LAGGING_MS

    companion object {
        const val LAGGING_MS = 2_000L
    }
}

@Serializable
data class SendMessageRequest(
    /** A UUID for this message's whole life: a resend with the same one never makes a second message. */
    val clientId: String,
    val kind: MessageKind,
    val body: String? = null,
    val refId: Id? = null,
    val mediaId: Id? = null,
    /** The confirm token of a `confirm_required` answer, to send anyway. */
    val confirm: String? = null,
)

@Serializable
data class SentMessageBody(val message: Message)

/** A sent message. [replayed] is true when the server already had it (the same client id). */
data class SentMessage(val message: Message, val replayed: Boolean)

@Serializable
data class ReceiptsRequest(
    val readUpTo: Id? = null,
    val deliveredUpTo: Id? = null,
)

@Serializable
data class ConversationPatch(
    val allowCalls: Boolean? = null,
    val muted: Boolean? = null,
)

@Serializable
data class MessageRequestCreate(
    val to: PublicUid,
    val body: String,
    val clientId: String,
)

/** A request the account sent, as the create call returns it. */
@Serializable
data class SentRequest(
    val id: Id,
    val to: PeerSummary,
    val body: String,
    val status: RequestStatus = RequestStatus.Unknown,
    val at: Instant,
)

@Serializable
data class SentRequestBody(val request: SentRequest)

/** A request in a list: [peer] is the other side (the sender in the inbox, the recipient in sent). */
@Serializable
data class MessageRequest(
    val id: Id,
    val peer: PeerSummary,
    val body: String,
    val status: RequestStatus = RequestStatus.Unknown,
    val at: Instant,
)

@Serializable
data class MessageRequestsPage(
    val items: List<MessageRequest> = emptyList(),
    val nextCursor: String? = null,
)

@Serializable
data class ConversationBody(val conversation: Conversation)
