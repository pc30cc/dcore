package app.core.model

import java.time.Instant

/**
 * A push message's data, as FCM hands it over: string keys and values, with
 * `type` first. The server decides every visible text; the data carries ids
 * and, for a ring, the first name and photo of the caller. Never an e-mail, a
 * phone number or a user id.
 *
 * [parse] is strict about ids (a value that is not a decimal id is the same
 * as a missing one) and lenient about everything else: an unknown type is
 * [Unknown], never an exception, so a newer server's push cannot crash an
 * older app in the background.
 */
sealed interface PushData {
    val type: String

    /** A ring (data-only, high priority): drawn by the call layer, not as a notification. */
    data class CallIncoming(
        val callId: Id,
        val conversationId: Id,
        val kind: CallKind,
        val peerName: String,
        val peerPhotoUrl: String?,
        val expiresAt: Instant?,
    ) : PushData {
        override val type: String get() = PushTypes.CALL_INCOMING
    }

    /** A ring stopped (answered elsewhere, declined, cancelled, missed, ended). */
    data class CallCancel(val callId: Id, val reason: String) : PushData {
        override val type: String get() = PushTypes.CALL_CANCEL
    }

    data class NewMessage(val conversationId: Id, val messageId: Id) : PushData {
        override val type: String get() = PushTypes.MESSAGE
    }

    data class NewMatch(val conversationId: Id) : PushData {
        override val type: String get() = PushTypes.MATCH
    }

    data class NewLike(val total: Int) : PushData {
        override val type: String get() = PushTypes.LIKE
    }

    data class NewRequest(val requestId: Id) : PushData {
        override val type: String get() = PushTypes.REQUEST
    }

    data class CallMissed(val callId: Id, val conversationId: Id) : PushData {
        override val type: String get() = PushTypes.CALL_MISSED
    }

    data object AccountNotice : PushData {
        override val type: String get() = PushTypes.ACCOUNT
    }

    data class SupportReply(val ticketId: Id) : PushData {
        override val type: String get() = PushTypes.SUPPORT
    }

    /** A campaign; [deeplink] is an in-app path (`/store?offer=…`), never a web address. */
    data class Offer(val campaignId: String, val deeplink: String) : PushData {
        override val type: String get() = PushTypes.OFFER
    }

    data class Unknown(override val type: String) : PushData

    /** The data-only types the call layer owns: rings and their stops. */
    val isRing: Boolean get() = this is CallIncoming || this is CallCancel

    companion object {
        private val ID = Regex("^[1-9][0-9]{0,18}$")
        private val DECIMAL = Regex("^(0|[1-9][0-9]{0,9})$")
        private val IN_APP_PATH = Regex("^/[A-Za-z0-9/_?=&.-]{0,200}$")

        /** The push in [data], or null when there is no `type` at all or a required id is missing or malformed. */
        fun parse(data: Map<String, String>): PushData? {
            val type = data["type"]?.trim().orEmpty()
            if (type.isEmpty()) return null
            fun id(key: String): Id? = data[key]?.trim()?.takeIf { ID.matches(it) }
            return when (type) {
                PushTypes.CALL_INCOMING -> {
                    val callId = id("callId") ?: return null
                    val conversationId = id("conversationId") ?: return null
                    CallIncoming(
                        callId = callId,
                        conversationId = conversationId,
                        kind = CallKind.entries.firstOrNull { it != CallKind.Unknown && it.wire == data["kind"] } ?: CallKind.Unknown,
                        peerName = data["peerName"]?.trim()?.take(PEER_NAME_MAX).orEmpty(),
                        peerPhotoUrl = data["peerPhotoUrl"]?.trim()?.takeIf { it.startsWith("https://") && it.length <= URL_MAX },
                        expiresAt = data["expiresAt"]?.let(InstantSerializer::parse),
                    )
                }
                PushTypes.CALL_CANCEL -> CallCancel(id("callId") ?: return null, data["reason"]?.trim().orEmpty())
                PushTypes.MESSAGE -> NewMessage(id("conversationId") ?: return null, id("messageId") ?: return null)
                PushTypes.MATCH -> NewMatch(id("conversationId") ?: return null)
                PushTypes.LIKE -> NewLike(data["total"]?.trim()?.takeIf { DECIMAL.matches(it) }?.toIntOrNull() ?: 0)
                PushTypes.REQUEST -> NewRequest(id("requestId") ?: return null)
                PushTypes.CALL_MISSED -> CallMissed(id("callId") ?: return null, id("conversationId") ?: return null)
                PushTypes.ACCOUNT -> AccountNotice
                PushTypes.SUPPORT -> SupportReply(id("ticketId") ?: return null)
                PushTypes.OFFER -> {
                    val campaign = data["campaignId"]?.trim()?.takeIf { DECIMAL.matches(it) } ?: return null
                    val link = data["deeplink"]?.trim()?.takeIf { IN_APP_PATH.matches(it) } ?: return null
                    Offer(campaign, link)
                }
                else -> Unknown(type)
            }
        }

        private const val PEER_NAME_MAX = 40
        private const val URL_MAX = 1_500
    }
}

/** Push `type` values, as the server writes them. */
object PushTypes {
    const val CALL_INCOMING = "call_incoming"
    const val CALL_CANCEL = "call_cancel"
    const val MESSAGE = "message"
    const val MATCH = "match"
    const val LIKE = "like"
    const val REQUEST = "request"
    const val CALL_MISSED = "call_missed"
    const val ACCOUNT = "account"
    const val SUPPORT = "support"
    const val OFFER = "offer"
}
