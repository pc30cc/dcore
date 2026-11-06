@file:UseSerializers(InstantSerializer::class)

package app.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers
import java.time.Instant

// Reports, blocks, moderation actions and appeals.

@Serializable
data class ReportRequest(
    val target: PublicUid,
    val context: ReportContext,
    val reason: ReportReason,
    val details: String? = null,
    val conversationId: Id? = null,
    /** At most 20: the messages the report is about. */
    val messageIds: List<Id>? = null,
    val photoId: Id? = null,
    val callId: Id? = null,
    /** Also block the person. */
    val block: Boolean = false,
)

@Serializable
data class ReportReceipt(val reportId: Id)

@Serializable
data class BlockRequest(val target: PublicUid)

@Serializable
data class BlockedUser(
    val user: PeerSummary,
    val blockedAt: Instant,
)

@Serializable
data class BlockList(val items: List<BlockedUser> = emptyList())

@Serializable
data class ModerationHistory(
    val active: List<ModerationAction> = emptyList(),
    val history: List<ModerationAction> = emptyList(),
)

@Serializable
data class AppealRequest(
    /** The moderation action appealed against. */
    val actionId: Id,
    val body: String,
)

@Serializable
data class AppealBody(val appeal: Appeal)
