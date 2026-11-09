@file:UseSerializers(InstantSerializer::class)

package app.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers
import kotlinx.serialization.json.JsonObject
import java.time.Instant

// Realtime token, deletion and restore, support, data export and events.

/** `POST /v1/realtime/token`: a connection token for the one personal channel. */
@Serializable
data class RealtimeToken(
    val wsUrl: String,
    val token: String,
    val expiresAt: Instant,
    /** `u:#<publicUid>`. */
    val channel: String,
)

@Serializable
data class StoreSubscriptionNotice(
    val store: StoreName = StoreName.Unknown,
    val active: Boolean = true,
    val manageUrl: String? = null,
)

/** Before deleting: a live store subscription that deleting does not cancel. */
@Serializable
data class DeletionPreflight(val subscription: StoreSubscriptionNotice? = null)

@Serializable
data class DeletionRequest(val reason: String? = null)

@Serializable
data class DeletionScheduled(val purgeAt: Instant)

@Serializable
data class RestoredAccount(val user: AuthUser)

@Serializable
data class PublicDeletionStart(
    val phone: String,
    val locale: String,
)

/** The same whether or not an account exists for the number. */
@Serializable
data class PublicDeletionChallenge(
    val requestToken: String,
    val codeLength: Int = 6,
)

@Serializable
data class PublicDeletionConfirm(
    val requestToken: String,
    val code: String,
)

@Serializable
data class PublicDeletionGoogle(val idToken: String)

@Serializable
data class SupportTicket(
    val id: Id,
    val category: String = "",
    val subject: String? = null,
    val status: TicketStatus = TicketStatus.Unknown,
    val createdAt: Instant,
    val updatedAt: Instant? = null,
    val unread: Int = 0,
)

@Serializable
data class SupportTickets(
    val items: List<SupportTicket> = emptyList(),
    val nextCursor: String? = null,
)

@Serializable
data class SupportTicketCreate(
    val category: String,
    val body: String,
    val subject: String? = null,
)

@Serializable
data class SupportTicketBody(val ticket: SupportTicket)

@Serializable
data class SupportMessage(
    val id: Id,
    val author: TicketAuthor = TicketAuthor.Unknown,
    val body: String,
    val at: Instant,
)

@Serializable
data class SupportMessages(
    val items: List<SupportMessage> = emptyList(),
    val nextCursor: String? = null,
)

@Serializable
data class SupportMessageCreate(val body: String)

@Serializable
data class SupportMessageBody(val message: SupportMessage)

/** `POST /v1/me/export` (202): the export the request started, or the same one again for a repeat within minutes. */
@Serializable
data class ExportStarted(val exportId: Id)

/** Where the account's data export stands. */
@Serializable(with = ExportState.Serializer::class)
enum class ExportState(override val wire: String) : WireEnum {
    /** No export this week, or the last one's link ran out. */
    None("none"),

    /** Asked for; the archive is being built. */
    Pending("pending"),

    /** Built: the link opens until its expiry. */
    Ready("ready"),
    Unknown(""),
    ;

    internal object Serializer : WireEnumSerializer<ExportState>("ExportState", entries.toTypedArray(), Unknown)
}

/**
 * `GET /v1/me/export`: the export's state, from the server's own record of
 * it, so a link announced over realtime while the phone was offline is not
 * lost. [url] and [expiresAt] come only while the link is valid.
 */
@Serializable
data class ExportStatus(
    val status: ExportState = ExportState.Unknown,
    val url: String? = null,
    val expiresAt: Instant? = null,
) {
    /**
     * The link to open now: only for a ready export, a web address (https;
     * http only from a local development store), and not past its expiry.
     */
    fun link(now: Instant): String? {
        if (status != ExportState.Ready) return null
        val href = url?.trim()?.takeIf { it.startsWith("https://") || it.startsWith("http://") } ?: return null
        val until = expiresAt
        return href.takeIf { until == null || now.isBefore(until) }
    }

    companion object {
        /** The `account` realtime event's `export`: the same as a read that says ready. */
        fun of(ready: ExportReady): ExportStatus = ExportStatus(ExportState.Ready, ready.url, ready.expiresAt)
    }
}

/** One first-party analytics event; names come from the server's whitelist. */
@Serializable
data class AppEvent(
    val name: String,
    val at: Instant,
    val props: JsonObject? = null,
)

@Serializable
data class EventsRequest(
    /** At most 100. */
    val events: List<AppEvent>,
)
