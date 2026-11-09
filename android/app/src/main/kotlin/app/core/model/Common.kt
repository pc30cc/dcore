@file:UseSerializers(InstantSerializer::class, LocalDateSerializer::class)

package app.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers
import java.time.Instant
import java.time.LocalDate

// The objects many routes share. Response models give every optional field a
// default, so an absent key or a `null` never fails a response; the keys the
// contract marks as always present have none, so a response missing one is a
// decoding error rather than a screen built from guesses.

/** A processed, approved photo: signed CDN URL (24 h), size and a blurhash for the placeholder. */
@Serializable
data class Photo(
    val id: Id,
    val w: Int = 0,
    val h: Int = 0,
    val blurhash: String = "",
    val url: String,
)

/** Someone shown in a list: name, first photo, verified badge. */
@Serializable
data class PeerSummary(
    val id: PublicUid,
    val name: String,
    val photo: Photo? = null,
    val verified: Boolean = false,
)

/** A city by its id in the server's bundled table. */
@Serializable
data class City(
    val id: Int,
    val name: String,
    /** ISO 3166-1 alpha-2, when the answer carries it (city search does). */
    val country: String? = null,
)

/** A rounded distance from cell centres; `lessThan` marks the floor ("< 2 km"). */
@Serializable
data class Distance(
    val km: Int,
    val lessThan: Boolean = false,
)

@Serializable
data class ProfilePrompt(
    val promptId: Int,
    val answer: String? = null,
    val audioMs: Int? = null,
    val audioUrl: String? = null,
)

/** One answered profile field: one of `option`, `options`, `number` or `text` is set, by the field's kind. */
@Serializable
data class ProfileFieldValue(
    val fieldId: Int,
    val option: Int? = null,
    val options: List<Int>? = null,
    val number: Int? = null,
    val text: String? = null,
)

/**
 * Someone else's profile as the deck, likes and chat show it.
 *
 * Never carries a birth date, a location cell, coordinates, a phone number or
 * anything a moderator has not approved. [v] is the card version: a newer one
 * replaces a cached card.
 */
@Serializable
data class ProfileCard(
    val id: PublicUid,
    val v: Long = 0,
    val name: String,
    val age: Int? = null,
    val gender: Gender = Gender.Unknown,
    val verified: Boolean = false,
    val intention: Intention? = null,
    val job: String? = null,
    val about: String? = null,
    val city: City? = null,
    val traveling: Boolean = false,
    val distance: Distance? = null,
    val activeRecently: Boolean = false,
    /** Only with the see-likes feature, or when it was a super like. */
    val likesYou: Boolean = false,
    val superliked: Boolean = false,
    val photos: List<Photo> = emptyList(),
    val prompts: List<ProfilePrompt> = emptyList(),
    val fields: List<ProfileFieldValue> = emptyList(),
)

/** One of the account's own photos, in any moderation state. */
@Serializable
data class OwnPhoto(
    val id: Id,
    val position: Int,
    val status: PhotoStatus = PhotoStatus.Unknown,
    val rejectReason: String? = null,
    val w: Int = 0,
    val h: Int = 0,
    val blurhash: String = "",
    /** Absent while the photo is still being processed. */
    val url: String? = null,
)

@Serializable
data class OwnPrompt(
    val promptId: Int,
    val position: Int? = null,
    val answer: String? = null,
    val audioMs: Int? = null,
    val audioUrl: String? = null,
    val status: TextState = TextState.Unknown,
)

/** The account's privacy and visibility switches. */
@Serializable
data class Settings(
    val incognito: Boolean = false,
    val hideAge: Boolean = false,
    val hideDistance: Boolean = false,
    val showOnline: Boolean = true,
    val acceptCalls: Boolean = false,
    /** Shown to people looking for a partner; off keeps only the social side. */
    val modeRomance: Boolean = true,
    val snoozed: Boolean = false,
)

/** The account's own profile: the card plus everything only its holder sees. */
@Serializable
data class OwnProfile(
    val id: PublicUid,
    val v: Long = 0,
    val name: String = "",
    val age: Int? = null,
    val gender: Gender = Gender.Unknown,
    val verified: Boolean = false,
    val intention: Intention? = null,
    val job: String? = null,
    val about: String? = null,
    val city: City? = null,
    val traveling: Boolean = false,
    val activeRecently: Boolean = false,
    val photos: List<OwnPhoto> = emptyList(),
    val textState: TextState = TextState.Unknown,
    val prompts: List<OwnPrompt> = emptyList(),
    /** Private fields included. */
    val fields: List<ProfileFieldValue> = emptyList(),
    /** 0-100. */
    val completeness: Int = 0,
    val birthDate: LocalDate? = null,
    val settings: Settings = Settings(),
)

/** Who the deck shows. `filters` (advanced filters) maps a field key to option ids or a `[min, max]` range. */
@Serializable
data class DiscoveryPreferences(
    val interestedIn: List<Gender> = emptyList(),
    val ageMin: Int = 18,
    val ageMax: Int = 99,
    val maxDistanceKm: Int = 50,
    val wholeCountry: Boolean = false,
    val verifiedOnly: Boolean = false,
    val intents: List<Intention> = emptyList(),
    val filters: Map<String, List<Int>> = emptyMap(),
)

@Serializable
data class NotificationPrefs(
    val messages: Boolean = true,
    val matches: Boolean = true,
    val likes: Boolean = true,
    val calls: Boolean = true,
    val offers: Boolean = false,
    /** Message text and names in notifications; off shows generic texts. */
    val previews: Boolean = false,
)

@Serializable
data class MessageMedia(
    val url: String,
    val mime: String,
    val w: Int? = null,
    val h: Int? = null,
    val durationMs: Long? = null,
    val blurhash: String? = null,
)

/** The record of a finished call, as a line in the chat. */
@Serializable
data class CallLine(
    val callId: Id,
    val kind: CallKind = CallKind.Unknown,
    val outcome: CallOutcome = CallOutcome.Unknown,
    val placedAt: Instant,
    val durationSeconds: Long = 0,
    val caller: PublicUid,
)

/**
 * One message. Unsend and moderation arrive as their own rows
 * ([MessageKind.Unsend] with [refId]); a reaction is a row too, with an emoji
 * body (empty removes it). [clientId] lets the sender's outbox match its own
 * message whichever way it arrives first.
 */
@Serializable
data class Message(
    val id: Id,
    val conversationId: Id,
    val senderId: PublicUid,
    val clientId: String? = null,
    val kind: MessageKind = MessageKind.Unknown,
    val body: String? = null,
    val refId: Id? = null,
    val media: MessageMedia? = null,
    val call: CallLine? = null,
    val at: Instant,
)

@Serializable
data class ConversationPeer(
    val id: PublicUid,
    val name: String,
    val photo: Photo? = null,
    val verified: Boolean = false,
    val online: Boolean = false,
    val activeRecently: Boolean = false,
)

/** Whether each side allows calls in this conversation (both must). */
@Serializable
data class CallsAllowed(
    val me: Boolean = false,
    val peer: Boolean = false,
) {
    val both: Boolean get() = me && peer
}

/** A match, seen as a conversation. Its id is the match id. */
@Serializable
data class Conversation(
    val id: Id,
    val peer: ConversationPeer,
    val state: ConversationState = ConversationState.Unknown,
    val source: ConversationSource = ConversationSource.Unknown,
    val createdAt: Instant,
    /** Null for a new match nobody has written in yet. */
    val lastMessage: Message? = null,
    val unread: Int = 0,
    val myReadId: Id? = null,
    /** Only when the viewer has read receipts. */
    val peerReadId: Id? = null,
    val peerDeliveredId: Id? = null,
    val callsAllowed: CallsAllowed = CallsAllowed(),
    val muted: Boolean = false,
)

@Serializable
data class Call(
    val id: Id,
    val conversationId: Id,
    val kind: CallKind = CallKind.Unknown,
    val role: CallRole = CallRole.Unknown,
    val state: CallState = CallState.Unknown,
    val outcome: CallOutcome? = null,
    val placedAt: Instant,
    val ringExpiresAt: Instant? = null,
    val rangAt: Instant? = null,
    val answeredAt: Instant? = null,
    val endedAt: Instant? = null,
    val durationSeconds: Long? = null,
    val endReason: String? = null,
)

@Serializable
data class TurnServer(
    val urls: List<String>,
    val username: String,
    val credential: String,
)

/**
 * What joining a call's room takes. [turn] is the in-country relay, present
 * only when the caller's network calls for it; null keeps the media server's
 * own ICE servers.
 */
@Serializable
data class CallToken(
    val token: String,
    val expiresAt: Instant,
    val wsUrl: String,
    val turn: TurnServer? = null,
    val icePolicy: IcePolicy = IcePolicy.All,
    val warnings: List<String> = emptyList(),
)

@Serializable
data class Quota(
    /** -1 is unlimited. */
    val limit: Int,
    val used: Int = 0,
    val resetsAt: Instant? = null,
) {
    val unlimited: Boolean get() = limit < 0
    val left: Int get() = if (unlimited) Int.MAX_VALUE else (limit - used).coerceAtLeast(0)
}

@Serializable
data class Quotas(
    val likes: Quota? = null,
    val superlikes: Quota? = null,
    val dm: Quota? = null,
    val boosts: Quota? = null,
)

/** The paid features, by the server's feature keys. */
@Serializable
data class Features(
    @SerialName("see_likes") val seeLikes: Boolean = false,
    val rewind: Boolean = false,
    @SerialName("read_receipts") val readReceipts: Boolean = false,
    val incognito: Boolean = false,
    @SerialName("travel_mode") val travelMode: Boolean = false,
    @SerialName("advanced_filters") val advancedFilters: Boolean = false,
    @SerialName("profile_views") val profileViews: Boolean = false,
    @SerialName("second_look") val secondLook: Boolean = false,
    @SerialName("priority_likes") val priorityLikes: Boolean = false,
)

@Serializable
data class Wallet(
    val superlike: Int = 0,
    val boost: Int = 0,
    val spotlight: Int = 0,
    val dm: Int = 0,
)

/** What the account may use right now: plan, features, quotas and wallet. */
@Serializable
data class Entitlements(
    val plan: Plan = Plan.Free,
    val planExpiresAt: Instant? = null,
    val autoRenew: Boolean? = null,
    val source: EntitlementSource? = null,
    /** The store's subscription page, to cancel or change. */
    val manageUrl: String? = null,
    /**
     * The store product of the subscription that gives [plan], only when it
     * is of this session's store (never another store's, a grant's or a free
     * plan's).
     */
    val productId: String? = null,
    /** Play only: the base plan of [productId] the person is on. */
    val basePlanId: String? = null,
    val features: Features = Features(),
    val quotas: Quotas = Quotas(),
    val wallet: Wallet = Wallet(),
    val boostEndsAt: Instant? = null,
)

@Serializable
data class Appeal(
    val id: Id,
    val status: AppealStatus = AppealStatus.Unknown,
    val decisionText: String? = null,
)

/**
 * A warning, suspension or ban the account received, with the reason its
 * holder reads and its appeal, if one was filed.
 */
@Serializable
data class ModerationAction(
    val id: Id,
    val kind: ModerationKind = ModerationKind.Unknown,
    val reasonText: String = "",
    val startsAt: Instant,
    val endsAt: Instant? = null,
    val appeal: Appeal? = null,
)
