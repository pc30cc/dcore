package app.core.push

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.core.MainActivity
import app.core.R
import app.core.i18n.brandString
import app.core.i18n.brandText
import app.core.model.PushData

/**
 * The notification channels, one per kind of news so a person can silence
 * likes and keep messages, and the notifications the app draws itself.
 *
 * Channel ids are fixed neutral constants, never derived from the brand: a
 * renamed channel id would orphan the person's settings for it. Their names
 * follow the app's language, renamed at each start.
 *
 * Background notifications are drawn by the system from the server's text
 * (FCM notification messages, with the channel and tag the server sets). The
 * app draws the same ones itself when it is in front, under the same tag and
 * id 0, so the two replace each other and opening the conversation removes
 * either. Every one of them is private on the lock screen: the public version
 * says only that something arrived, never who or what.
 */
object PushChannels {
    const val MESSAGES = "messages"
    const val MATCHES = "matches"
    const val LIKES = "likes"

    /** Rings: high importance, the ringtone, a ring vibration; private on the lock screen. */
    const val CALLS = "calls"

    /** An ongoing call's own notification: silent. */
    const val CALLS_ONGOING = "calls.ongoing"
    const val ACCOUNT = "account"
    const val OFFERS = "offers"

    val ALL = listOf(MESSAGES, MATCHES, LIKES, CALLS, CALLS_ONGOING, ACCOUNT, OFFERS)

    /**
     * Creates the channels (Android 8+), or renames them into the app's
     * language. Run at every process start, before a push can need one.
     * Importance, sound and vibration are fixed at creation; afterwards they
     * are the person's to change.
     */
    fun ensure(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        fun channel(id: String, name: Int, description: Int, importance: Int) =
            NotificationChannel(id, context.brandString(name), importance).apply {
                this.description = context.brandString(description)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            }
        val ringtone = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val channels = listOf(
            channel(MESSAGES, R.string.push_channel_messages, R.string.push_channel_messages_about, NotificationManager.IMPORTANCE_HIGH),
            channel(MATCHES, R.string.push_channel_matches, R.string.push_channel_matches_about, NotificationManager.IMPORTANCE_DEFAULT),
            channel(LIKES, R.string.push_channel_likes, R.string.push_channel_likes_about, NotificationManager.IMPORTANCE_DEFAULT),
            channel(CALLS, R.string.push_channel_calls, R.string.push_channel_calls_about, NotificationManager.IMPORTANCE_HIGH).apply {
                setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), ringtone)
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 1_000, 1_000)
            },
            channel(CALLS_ONGOING, R.string.push_channel_calls_ongoing, R.string.push_channel_calls_ongoing_about, NotificationManager.IMPORTANCE_LOW).apply {
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            },
            channel(ACCOUNT, R.string.push_channel_account, R.string.push_channel_account_about, NotificationManager.IMPORTANCE_DEFAULT),
            channel(OFFERS, R.string.push_channel_offers, R.string.push_channel_offers_about, NotificationManager.IMPORTANCE_LOW),
        )
        runCatching { manager.createNotificationChannels(channels) }
    }
}

/** What the push router asks of the notification shade; a fake in tests. */
interface NotificationSink {
    fun show(push: PushData, title: String?, body: String?)

    /** The conversation is on screen: its message and match notifications go. */
    fun clearConversation(conversationId: String)

    fun clearLikes()
}

/** One notification's place in the shade: the server's tag scheme, id 0 (so FCM's own and the app's replace each other). */
object NotificationTags {
    fun of(push: PushData): String? = when (push) {
        is PushData.NewMessage -> "c:${push.conversationId}"
        is PushData.NewMatch -> "m:${push.conversationId}"
        is PushData.NewLike -> "likes"
        is PushData.NewRequest -> "r:${push.requestId}"
        is PushData.CallMissed -> "call:${push.callId}"
        is PushData.AccountNotice -> "account"
        is PushData.SupportReply -> "support:${push.ticketId}"
        is PushData.Offer -> "offer:${push.campaignId}"
        else -> null
    }

    fun channel(push: PushData): String = when (push) {
        is PushData.NewMessage, is PushData.NewRequest, is PushData.CallMissed -> PushChannels.MESSAGES
        is PushData.NewMatch -> PushChannels.MATCHES
        is PushData.NewLike -> PushChannels.LIKES
        is PushData.Offer -> PushChannels.OFFERS
        else -> PushChannels.ACCOUNT
    }
}

/** The shade, on a real phone. */
class Notifications(private val context: Context) : NotificationSink {

    private val manager get() = NotificationManagerCompat.from(context)

    private fun allowed(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    override fun show(push: PushData, title: String?, body: String?) {
        val tag = NotificationTags.of(push) ?: return
        if (!allowed() || !manager.areNotificationsEnabled()) return
        val fallback = fallbackText(push)
        val shownTitle = title?.takeIf { it.isNotBlank() } ?: fallback.first
        val shownBody = body?.takeIf { it.isNotBlank() } ?: fallback.second
        val open = openIntent(push, tag)
        val public = builder(push, open)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(fallback.first)
            .build()
        val notification = builder(push, open)
            .setContentTitle(shownTitle)
            .setContentText(shownBody)
            .setStyle(NotificationCompat.BigTextStyle().bigText(shownBody))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .build()
        runCatching { manager.notify(tag, ID, notification) }
    }

    private fun builder(push: PushData, open: PendingIntent): NotificationCompat.Builder =
        NotificationCompat.Builder(context, NotificationTags.channel(push))
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setColor(ContextCompat.getColor(context, R.color.brand_primary))
            .setAutoCancel(true)
            .setContentIntent(open)
            .setCategory(
                when (push) {
                    is PushData.NewMessage, is PushData.NewRequest -> NotificationCompat.CATEGORY_MESSAGE
                    is PushData.CallMissed -> NotificationCompat.CATEGORY_MISSED_CALL
                    is PushData.Offer -> NotificationCompat.CATEGORY_PROMO
                    is PushData.AccountNotice, is PushData.SupportReply -> NotificationCompat.CATEGORY_STATUS
                    else -> NotificationCompat.CATEGORY_SOCIAL
                },
            )
            .setPriority(if (push is PushData.NewMessage) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)

    /** The generic text, in the app's language: the public version, and what is shown if the server sent none. */
    private fun fallbackText(push: PushData): Pair<String, String> {
        val (title, body) = when (push) {
            is PushData.NewMessage -> R.string.push_message_title to R.string.push_message_body
            is PushData.NewMatch -> R.string.push_match_title to R.string.push_match_body
            is PushData.NewLike -> R.string.push_like_title to R.string.push_like_body
            is PushData.NewRequest -> R.string.push_request_title to R.string.push_request_body
            is PushData.CallMissed -> R.string.push_call_missed_title to R.string.push_call_missed_body
            is PushData.SupportReply -> R.string.push_support_title to R.string.push_support_body
            is PushData.Offer -> R.string.push_offer_title to R.string.push_offer_body
            else -> R.string.push_account_title to R.string.push_account_body
        }
        return brandText(context.getString(title)) to brandText(context.getString(body))
    }

    /** Opens the app on what the notification is about, with the same extras FCM puts on its own. */
    private fun openIntent(push: PushData, tag: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(OpenTargets.ACTION_OPEN)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        OpenTargets.extras(push).forEach { (key, value) -> intent.putExtra(key, value) }
        return PendingIntent.getActivity(
            context,
            tag.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    override fun clearConversation(conversationId: String) {
        runCatching {
            manager.cancel("c:$conversationId", ID)
            manager.cancel("m:$conversationId", ID)
        }
    }

    override fun clearLikes() {
        runCatching { manager.cancel("likes", ID) }
    }

    /** Every notification of this app (a sign-out). */
    fun clearAll() {
        runCatching { manager.cancelAll() }
    }

    private companion object {
        const val ID = 0
    }
}
