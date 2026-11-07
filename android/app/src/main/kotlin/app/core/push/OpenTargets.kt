package app.core.push

import android.content.Intent
import app.core.model.Id
import app.core.model.PushData
import app.core.model.PushTypes
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** A place in the app a notification (or a link) opens. */
sealed interface OpenTarget {
    data class Thread(val conversationId: Id) : OpenTarget
    data object Requests : OpenTarget
    data object Chats : OpenTarget
    data object Likes : OpenTarget
    data object Account : OpenTarget
    data class Support(val ticketId: Id?) : OpenTarget

    /** A campaign's in-app path ([deeplink] is never a web address). */
    data class Offer(val deeplink: String) : OpenTarget
}

/**
 * Notification taps, read back into places. A tap on a notification the
 * system drew carries the push's data as intent extras; one the app drew
 * carries the same keys ([extras]), so both open the same screen.
 *
 * The activity is exported (it is the launcher), so anything could send it
 * these extras: they only ever choose a screen of the signed-in account, and
 * the screen checks with the account's own data. A conversation id that is
 * not this account's opens nothing.
 */
object OpenTargets {
    const val ACTION_OPEN = "app.core.action.OPEN"

    fun extras(push: PushData): Map<String, String> = buildMap {
        put("type", push.type)
        when (push) {
            is PushData.NewMessage -> {
                put("conversationId", push.conversationId)
                put("messageId", push.messageId)
            }
            is PushData.NewMatch -> put("conversationId", push.conversationId)
            is PushData.CallMissed -> {
                put("conversationId", push.conversationId)
                put("callId", push.callId)
            }
            is PushData.NewRequest -> put("requestId", push.requestId)
            is PushData.SupportReply -> put("ticketId", push.ticketId)
            is PushData.Offer -> {
                put("campaignId", push.campaignId)
                put("deeplink", push.deeplink)
            }
            else -> Unit
        }
    }

    /** Where [push] opens. Rings are the call layer's; nothing here. */
    fun of(push: PushData): OpenTarget? = when (push) {
        is PushData.NewMessage -> OpenTarget.Thread(push.conversationId)
        is PushData.NewMatch -> OpenTarget.Thread(push.conversationId)
        is PushData.CallMissed -> OpenTarget.Thread(push.conversationId)
        is PushData.NewRequest -> OpenTarget.Requests
        is PushData.NewLike -> OpenTarget.Likes
        is PushData.AccountNotice -> OpenTarget.Account
        is PushData.SupportReply -> OpenTarget.Support(push.ticketId)
        is PushData.Offer -> OpenTarget.Offer(push.deeplink)
        else -> null
    }

    /** The place an activity intent asks for, or null when it carries no push. */
    fun fromIntent(intent: Intent?): OpenTarget? {
        val extras = intent?.extras ?: return null
        val type = extras.getString("type") ?: return null
        if (type == PushTypes.CALL_INCOMING || type == PushTypes.CALL_CANCEL) return null
        val data = extras.keySet().mapNotNull { key -> extras.getString(key)?.let { key to it } }.toMap()
        return PushData.parse(data)?.let(::of)
    }
}

/**
 * Places the app was asked to open (a notification tap), waiting for the
 * navigation to take them. One at a time: a newer tap replaces an older one
 * nobody took yet.
 */
class AppLinks {
    private val _pending = MutableStateFlow<OpenTarget?>(null)
    val pending: StateFlow<OpenTarget?> = _pending.asStateFlow()

    fun open(target: OpenTarget) {
        _pending.value = target
    }

    /** The navigation took [target]. */
    fun taken(target: OpenTarget) {
        _pending.compareAndSet(target, null)
    }
}
