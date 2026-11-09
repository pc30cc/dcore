@file:UseSerializers(InstantSerializer::class)

package app.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.UseSerializers
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.time.Instant

// What arrives on the account's personal realtime channel (`u:#<publicUid>`).
//
// Every publication is one envelope:
//
//     { "t": "message", "v": 1, "id": "1287390234923417600", "at": "…", "d": { … } }
//
// `id` is the event's own id (the message id for `message`): the client's
// dedupe key. The payload carries the change itself, so the receiver writes it
// locally and asks the server for nothing.

/** One publication as it travels; [d] is decoded by [RealtimeEvents.decode] according to [t]. */
@Serializable
data class RealtimeEnvelope(
    val t: String,
    val v: Int = 1,
    val id: Id,
    val at: Instant? = null,
    val d: JsonElement? = null,
)

/** `receipt`: a read or delivered pointer moved, the reader's own (another phone) or the peer's. */
@Serializable
data class ReceiptEvent(
    val conversationId: Id,
    val by: PublicUid,
    val readUpTo: Id? = null,
    val deliveredUpTo: Id? = null,
)

/** `typing`: the peer is writing in [conversationId]. Shown for a few seconds, never stored. */
@Serializable
data class TypingEvent(
    val conversationId: Id,
    val by: PublicUid,
)

@Serializable(with = ConversationChange.Serializer::class)
enum class ConversationChange(override val wire: String) : WireEnum {
    Matched("matched"), Accepted("accepted"), Updated("updated"), Unknown("");

    internal object Serializer : WireEnumSerializer<ConversationChange>("ConversationChange", entries.toTypedArray(), Unknown)
}

/** `conversation`: a new match, an accepted request, or a call consent or mute change. */
@Serializable
data class ConversationEvent(
    val conversation: Conversation,
    val reason: ConversationChange = ConversationChange.Unknown,
)

/** `conversation_end`: unmatch, block, ban and deletion all look the same. */
@Serializable
data class ConversationEndEvent(val conversationId: Id)

/** `like`: someone liked the account. [from] only with see-likes, or for a super like. */
@Serializable
data class LikeEvent(
    val total: Int = 0,
    val kind: LikeKind = LikeKind.Unknown,
    val from: PeerSummary? = null,
)

/** A message request as the recipient first hears of it. */
@Serializable
data class IncomingRequest(
    val id: Id,
    val from: PeerSummary,
    val body: String,
    val at: Instant,
)

@Serializable
data class RequestEvent(val request: IncomingRequest)

@Serializable
data class PhotoModeration(
    val id: Id,
    val status: PhotoStatus = PhotoStatus.Unknown,
    val rejectReason: String? = null,
)

@Serializable
data class PromptModeration(
    val position: Int,
    val status: TextState = TextState.Unknown,
)

/** `profile`: moderation results for the account's own profile. */
@Serializable
data class ProfileEvent(
    val photo: PhotoModeration? = null,
    val textState: TextState? = null,
    val prompts: List<PromptModeration>? = null,
    val verification: VerificationStatus? = null,
)

@Serializable
data class ExportReady(val url: String, val expiresAt: Instant)

/** `account`: the account's state moved; the client reads `GET /v1/me` again. */
@Serializable
data class AccountEvent(
    val status: AccountStatus = AccountStatus.Unknown,
    val moderation: ModerationAction? = null,
    val export: ExportReady? = null,
)

@Serializable
data class SupportEvent(val ticketId: Id, val at: Instant? = null)

@Serializable
data class ConfigEvent(val v: Long = 0)

/**
 * `entitlement`: [entitlements] as a session of [store]'s build sees them
 * (each build counts its own store's purchases); [store] is null for a view
 * of no store. On the wire it is one more key of the entitlements object.
 */
@Serializable(with = EntitlementEvent.Serializer::class)
data class EntitlementEvent(
    val entitlements: Entitlements,
    val store: StoreName? = null,
) {
    internal object Serializer : KSerializer<EntitlementEvent> {
        private const val STORE = "store"

        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("app.core.model.EntitlementEvent")

        override fun deserialize(decoder: Decoder): EntitlementEvent {
            val input = decoder as? JsonDecoder ?: throw SerializationException("EntitlementEvent is JSON only")
            val body = input.decodeJsonElement().jsonObject
            val store = body[STORE]?.takeUnless { it is JsonNull }?.let { input.json.decodeFromJsonElement(StoreName.serializer(), it) }
            return EntitlementEvent(input.json.decodeFromJsonElement(Entitlements.serializer(), JsonObject(body - STORE)), store)
        }

        override fun serialize(encoder: Encoder, value: EntitlementEvent) {
            val output = encoder as? JsonEncoder ?: throw SerializationException("EntitlementEvent is JSON only")
            val body = output.json.encodeToJsonElement(Entitlements.serializer(), value.entitlements).jsonObject
            val store = value.store
            output.encodeJsonElement(
                if (store == null) body else JsonObject(body + (STORE to output.json.encodeToJsonElement(StoreName.serializer(), store))),
            )
        }
    }
}

/**
 * A decoded publication. [id] is the envelope's (the dedupe key), [at] when
 * the server published it.
 */
sealed interface RealtimeEvent {
    val id: Id
    val at: Instant?

    data class MessageArrived(override val id: Id, override val at: Instant?, val message: Message) : RealtimeEvent
    data class ReceiptMoved(override val id: Id, override val at: Instant?, val receipt: ReceiptEvent) : RealtimeEvent
    data class PeerTyping(override val id: Id, override val at: Instant?, val typing: TypingEvent) : RealtimeEvent
    data class ConversationChanged(override val id: Id, override val at: Instant?, val change: ConversationEvent) : RealtimeEvent
    data class ConversationEnded(override val id: Id, override val at: Instant?, val conversationId: Id) : RealtimeEvent
    data class LikeReceived(override val id: Id, override val at: Instant?, val like: LikeEvent) : RealtimeEvent
    data class RequestReceived(override val id: Id, override val at: Instant?, val request: IncomingRequest) : RealtimeEvent
    data class CallChanged(override val id: Id, override val at: Instant?, val call: Call) : RealtimeEvent
    /** [store]: the store build that [entitlements] are the view of; null for a view of no store ([EntitlementEvent]). */
    data class EntitlementsChanged(
        override val id: Id,
        override val at: Instant?,
        val entitlements: Entitlements,
        val store: StoreName? = null,
    ) : RealtimeEvent
    data class ProfileModerated(override val id: Id, override val at: Instant?, val profile: ProfileEvent) : RealtimeEvent
    data class AccountChanged(override val id: Id, override val at: Instant?, val account: AccountEvent) : RealtimeEvent
    data class SupportReplied(override val id: Id, override val at: Instant?, val support: SupportEvent) : RealtimeEvent
    data class ConfigChanged(override val id: Id, override val at: Instant?, val config: ConfigEvent) : RealtimeEvent
}

/** Envelope type names, as the server writes them. */
object RealtimeTypes {
    const val MESSAGE = "message"
    const val RECEIPT = "receipt"
    const val TYPING = "typing"
    const val CONVERSATION = "conversation"
    const val CONVERSATION_END = "conversation_end"
    const val LIKE = "like"
    const val REQUEST = "request"
    const val CALL = "call"
    const val ENTITLEMENT = "entitlement"
    const val PROFILE = "profile"
    const val ACCOUNT = "account"
    const val SUPPORT = "support"
    const val CONFIG = "config"
}

object RealtimeEvents {

    /**
     * The event in [element], or null when it is not one this build knows,
     * or its payload does not decode. Never throws: one odd publication must
     * not end the connection that carries all the others.
     */
    fun decode(element: JsonElement): RealtimeEvent? {
        val envelope = runCatching { Wire.json.decodeFromJsonElement(RealtimeEnvelope.serializer(), element) }.getOrNull()
            ?: return null
        return decode(envelope)
    }

    fun decode(envelope: RealtimeEnvelope): RealtimeEvent? {
        val d = envelope.d as? JsonObject ?: return null
        val id = envelope.id
        val at = envelope.at
        return runCatching {
            when (envelope.t) {
                RealtimeTypes.MESSAGE -> RealtimeEvent.MessageArrived(id, at, read(Message.serializer(), d))
                RealtimeTypes.RECEIPT -> RealtimeEvent.ReceiptMoved(id, at, read(ReceiptEvent.serializer(), d))
                RealtimeTypes.TYPING -> RealtimeEvent.PeerTyping(id, at, read(TypingEvent.serializer(), d))
                RealtimeTypes.CONVERSATION -> RealtimeEvent.ConversationChanged(id, at, read(ConversationEvent.serializer(), d))
                RealtimeTypes.CONVERSATION_END ->
                    RealtimeEvent.ConversationEnded(id, at, read(ConversationEndEvent.serializer(), d).conversationId)
                RealtimeTypes.LIKE -> RealtimeEvent.LikeReceived(id, at, read(LikeEvent.serializer(), d))
                RealtimeTypes.REQUEST -> RealtimeEvent.RequestReceived(id, at, read(RequestEvent.serializer(), d).request)
                RealtimeTypes.CALL -> RealtimeEvent.CallChanged(id, at, read(Call.serializer(), d))
                RealtimeTypes.ENTITLEMENT -> read(EntitlementEvent.serializer(), d).let { event ->
                    RealtimeEvent.EntitlementsChanged(id, at, event.entitlements, event.store)
                }
                RealtimeTypes.PROFILE -> RealtimeEvent.ProfileModerated(id, at, read(ProfileEvent.serializer(), d))
                RealtimeTypes.ACCOUNT -> RealtimeEvent.AccountChanged(id, at, read(AccountEvent.serializer(), d))
                RealtimeTypes.SUPPORT -> RealtimeEvent.SupportReplied(id, at, read(SupportEvent.serializer(), d))
                RealtimeTypes.CONFIG -> RealtimeEvent.ConfigChanged(id, at, read(ConfigEvent.serializer(), d))
                else -> null
            }
        }.getOrNull()
    }

    private fun <T> read(serializer: KSerializer<T>, element: JsonElement): T = Wire.json.decodeFromJsonElement(serializer, element)
}
