package app.core.push

import app.core.common.Diag
import app.core.model.Id
import app.core.model.PublicUid
import app.core.model.PushData

/**
 * Who draws rings and stops them: the call layer, which sets itself here.
 * Returns true when it took the push.
 */
fun interface CallPushHandler {
    suspend fun onCallPush(push: PushData, data: Map<String, String>, sentTimeMillis: Long): Boolean
}

/** What a push means for the chat, while the app is running. */
interface PushChatHooks {
    /** The account signed in on this phone, as stored (no request): a push for nobody is dropped. */
    suspend fun signedInAccount(): PublicUid?

    /** Whether that conversation is on screen right now (its message pushes are not shown). */
    fun isViewing(conversationId: Id): Boolean

    /** A message the phone may not have yet: its thread is read when next opened. */
    suspend fun messageArrived(conversationId: Id)

    /** A new match or request: the list (and the requests) are read again. */
    suspend fun listChanged()
}

/**
 * The one place a push is decided on, whichever way it arrives.
 *
 * With the app in the background the system draws notification pushes
 * itself and nothing here runs; rings are data-only and always come here.
 * With the app in front, every push comes here: the router updates the chat
 * (a message push marks its thread to be read) and draws the notification
 * itself, unless that conversation is on screen.
 */
class PushRouter(
    private val notifications: NotificationSink,
    private val chat: PushChatHooks,
    private val diag: Diag = Diag.Android,
) {
    /** Set by the call layer; rings arriving while it is not set are dropped (and logged). */
    @Volatile var calls: CallPushHandler? = null

    /**
     * Handles one push. [title] and [body] are the server's notification
     * text (absent for data-only pushes). Returns what was done, for the log
     * and the tests.
     */
    suspend fun onMessage(data: Map<String, String>, title: String?, body: String?, sentTimeMillis: Long): PushHandled {
        val push = PushData.parse(data) ?: return PushHandled.Ignored
        if (push.isRing || push is PushData.CallMissed) {
            val handler = calls
            if (handler != null && handler.onCallPush(push, data, sentTimeMillis)) return PushHandled.ToCalls
            if (push.isRing) {
                diag.info(AREA, "ring dropped: no call handler")
                return PushHandled.Ignored
            }
        }
        if (chat.signedInAccount() == null) {
            diag.info(AREA, "${push.type} push for nobody signed in: dropped")
            return PushHandled.Ignored
        }
        return when (push) {
            is PushData.NewMessage -> {
                chat.messageArrived(push.conversationId)
                if (chat.isViewing(push.conversationId)) {
                    PushHandled.OnScreen
                } else {
                    notifications.show(push, title, body)
                    PushHandled.Shown
                }
            }
            is PushData.NewMatch, is PushData.NewRequest -> {
                chat.listChanged()
                notifications.show(push, title, body)
                PushHandled.Shown
            }
            is PushData.CallMissed -> {
                chat.messageArrived(push.conversationId)
                notifications.show(push, title, body)
                PushHandled.Shown
            }
            is PushData.NewLike, PushData.AccountNotice, is PushData.SupportReply, is PushData.Offer -> {
                notifications.show(push, title, body)
                PushHandled.Shown
            }
            else -> PushHandled.Ignored
        }
    }

    private companion object {
        const val AREA = "Push"
    }
}

enum class PushHandled { Shown, OnScreen, ToCalls, Ignored }
