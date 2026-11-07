package app.core.push

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.media.AudioManager
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
import app.core.MainActivity
import app.core.R
import app.core.i18n.AppLocales
import app.core.i18n.brandString
import app.core.model.CallKind
import app.core.model.Id
import app.core.model.PushData
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * A call ringing this phone, and what it leaves behind.
 *
 * Its own channel ([CHANNEL_CALLS]), apart from messages: it rings with the
 * phone's ringtone, and silencing one of the two does not silence the other.
 * The notification is the platform's incoming-call one (the match's first
 * name and face, Answer, Decline) and, where the system allows it, full screen
 * over the lock screen, as a phone call rings. Where it does not (Android 14+
 * without the full-screen permission) it is a heads-up notification with the
 * same two buttons.
 *
 * On a locked screen the notification shows only its public version: "Incoming
 * call on {appName}", with no name and no photo. Who is calling is for the
 * person who unlocks the phone.
 *
 * It rings until it is answered, declined or stopped by the server, and stops
 * by itself at the ring's expiry, because a ring whose stop never arrived must
 * not go on for ever. A ring the caller gave up on, or nobody answered, leaves
 * a missed call under the same key as the server's own missed-call push, so
 * the two are one notification whichever arrives last.
 */
object CallNotifications {
    /** The channels are the push layer's ([PushChannels]): one set, one name each, created at every start. */
    const val CHANNEL_CALLS = PushChannels.CALLS
    const val CHANNEL_ONGOING = PushChannels.CALLS_ONGOING

    /** Where a missed call goes: the messages channel, like the server's own missed-call push. */
    const val CHANNEL_MESSAGES = PushChannels.MESSAGES

    private const val ACTION_PREFIX = "app.core.call"
    const val ACTION_ANSWER = "$ACTION_PREFIX.ANSWER"
    const val ACTION_SHOW = "$ACTION_PREFIX.SHOW"
    const val ACTION_DECLINE = "$ACTION_PREFIX.DECLINE"
    const val ACTION_HANG_UP = "$ACTION_PREFIX.HANG_UP"

    const val EXTRA_CALL = "callId"
    const val EXTRA_CONVERSATION = "conversationId"
    const val EXTRA_KIND = "kind"
    const val EXTRA_PEER = "peerName"
    const val EXTRA_PHOTO = "peerPhotoUrl"
    const val EXTRA_EXPIRES = "expiresAt"

    private const val TYPE_MISSED = "call_missed"

    /** The call channels (and every other), in the app's language: created at every start, renamed when the language changes. */
    fun ensureChannels(context: Context) = PushChannels.ensure(context)

    /** Whether a notification may be posted at all: the permission (Android 13+) and the app's switch. */
    fun canPost(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()

    /**
     * Whether a ring can take the whole screen (Android 14+ asks the person;
     * before, always). Without it the ring is a heads-up notification.
     */
    fun canUseFullScreen(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
        val manager = ContextCompat.getSystemService(context, NotificationManager::class.java) ?: return false
        return runCatching { manager.canUseFullScreenIntent() }.getOrDefault(false)
    }

    /**
     * Rings: the match's name and face, "Incoming voice call" or "Incoming
     * video call", Answer and Decline, full screen where allowed. [photo] is
     * their picture, already fetched ([CallerFace.photo]); without one the
     * face is the silhouette. False when nothing was posted.
     */
    @SuppressLint("MissingPermission") // canPost() is the check, and it runs first.
    fun showRing(
        context: Context,
        ring: CallRing,
        photo: Bitmap?,
        now: Instant = Instant.now(),
        fullScreen: Boolean = canUseFullScreen(context),
    ): Boolean {
        if (!canPost(context)) return false
        val remaining = ring.expiresAt.toEpochMilli() - now.toEpochMilli()
        if (remaining <= 0) return false
        ensureChannels(context)
        val text = AppLocales.wrap(context)
        val name = ring.peerName.ifBlank { text.brandString(R.string.call_peer_fallback) }
        val video = ring.kind == CallKind.Video
        val caller = Person.Builder()
            .setName(name)
            .setIcon(IconCompat.createWithBitmap(CallerFace.face(photo)))
            .setImportant(true)
            .build()
        val extras: Intent.() -> Unit = {
            putExtra(EXTRA_CONVERSATION, ring.conversationId)
            putExtra(EXTRA_KIND, ring.kind.wire)
            putExtra(EXTRA_PEER, name)
            ring.peerPhotoUrl?.let { putExtra(EXTRA_PHOTO, it) }
            putExtra(EXTRA_EXPIRES, ring.expiresAt.toEpochMilli())
        }
        val answer = activityIntent(context, ring.callId, ACTION_ANSWER, extras)
        val show = activityIntent(context, ring.callId, ACTION_SHOW, extras)
        val decline = PendingIntent.getBroadcast(
            context,
            requestCode(ring.callId, ACTION_DECLINE),
            Intent(context, CallActionReceiver::class.java).apply {
                action = ACTION_DECLINE
                putExtra(EXTRA_CALL, ring.callId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val color = ContextCompat.getColor(context, R.color.brand_primary)
        // What a locked screen shows: no name, no photo, no buttons that say who.
        val public = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(color)
            .setContentTitle(text.brandString(R.string.call_notify_incoming_public))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build()
        val builder = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(color)
            .setContentTitle(name)
            .setContentText(text.brandString(if (video) R.string.call_notify_incoming_video else R.string.call_notify_incoming_audio))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(remaining)
            .setContentIntent(show)
            .addPerson(caller)
            .addExtras(
                Bundle().apply {
                    putString(EXTRA_CALL, ring.callId)
                    putString(EXTRA_CONVERSATION, ring.conversationId)
                    putString(EXTRA_KIND, ring.kind.wire)
                    putString(EXTRA_PEER, name)
                },
            )
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // No channels on Android 7: the ringtone and the buzz are the
            // notification's own to ask for. Once, not insistently: Android 7
            // has no expiry to stop an insistent ring whose stop never came.
            builder
                .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioManager.STREAM_RING)
                .setVibrate(RING_VIBRATION)
        }
        if (fullScreen) {
            builder
                .setFullScreenIntent(show, true)
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer).setIsVideo(video))
        } else {
            // A call style needs a full-screen intent or a foreground service;
            // without either, the same two buttons as a heads-up's actions.
            builder
                .addAction(R.drawable.ic_call_end, text.brandString(R.string.call_action_decline), decline)
                .addAction(R.drawable.ic_call_phone, text.brandString(R.string.call_action_answer), answer)
        }
        val notification = builder.build().apply {
            // Rings until something stops it, like a phone call; the expiry
            // above stops it if nothing else does.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) flags = flags or Notification.FLAG_INSISTENT
        }
        NotificationManagerCompat.from(context).notify(RING_TAG, ring.callId.hashCode(), notification)
        unanswered[ring.callId] = Missed(name, ring.conversationId, ring.kind)
        return true
    }

    /**
     * Whether [callId]'s ring is on screen now, posted for this very call.
     *
     * What the activity asks before it acts on a ring's Answer or tap. The
     * activity is exported (it is the launcher), so any app can hand it an
     * intent shaped like a ring's; only one that names a call ringing here
     * right now is the ring's own, and anything else is dropped rather than
     * answered with the microphone live over the lock screen.
     */
    fun isRinging(context: Context, callId: Id): Boolean {
        val active = ringing(context, callId) ?: return false
        return active.extras?.getString(EXTRA_CALL) == callId
    }

    /** Answered or declined on this phone: whatever happens next, nobody missed it here. */
    fun forget(callId: Id) {
        unanswered.remove(callId)
    }

    /**
     * Takes the ring down. When [missed], a missed call takes its place, only
     * for a call that rang here and was neither answered nor declined here.
     */
    @SuppressLint("MissingPermission")
    fun stopRing(context: Context, callId: Id, missed: Boolean) {
        val active = ringing(context, callId)
        val remembered = unanswered.remove(callId)
        runCatching { NotificationManagerCompat.from(context).cancel(RING_TAG, callId.hashCode()) }
        if (!missed || !canPost(context)) return
        val extras = active?.extras
        val conversationId = extras?.getString(EXTRA_CONVERSATION) ?: remembered?.conversationId ?: return
        val kind = extras?.getString(EXTRA_KIND)?.let(::kindOf) ?: remembered?.kind ?: CallKind.Audio
        val name = extras?.getString(EXTRA_PEER) ?: remembered?.name
        showMissed(context, callId, conversationId, kind, name)
    }

    /**
     * "Missed voice call" or "Missed video call" with the match's name, which
     * opens their conversation. Posted under the key the server's own
     * missed-call push has (`call:<id>`, id 0), and only into the messages
     * channel when it exists: the server's push covers a phone without it.
     */
    @SuppressLint("MissingPermission")
    fun showMissed(context: Context, callId: Id, conversationId: Id, kind: CallKind, name: String?) {
        if (!canPost(context)) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = ContextCompat.getSystemService(context, NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL_MESSAGES) == null) return
        }
        val text = AppLocales.wrap(context)
        val title = text.brandString(if (kind == CallKind.Video) R.string.call_notify_missed_video else R.string.call_notify_missed_audio)
        val open = PendingIntent.getActivity(
            context,
            requestCode(callId, TYPE_MISSED),
            Intent(context, MainActivity::class.java).apply {
                // The keys the server's own missed-call push carries, so a tap on either opens the conversation.
                action = OpenTargets.ACTION_OPEN
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                OpenTargets.extras(PushData.CallMissed(callId = callId, conversationId = conversationId)).forEach { (key, value) -> putExtra(key, value) }
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val color = ContextCompat.getColor(context, R.color.brand_primary)
        val public = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(color)
            .setContentTitle(text.brandString(R.string.call_notify_missed_public))
            .build()
        val notification = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(color)
            .setContentTitle(title)
            .setContentText(name?.takeIf { it.isNotBlank() } ?: text.brandString(R.string.call_peer_fallback))
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        NotificationManagerCompat.from(context).notify(missedTag(callId), 0, notification)
    }

    /** The server's own missed-call push carries the same tag. */
    fun missedTag(callId: Id): String = "call:$callId"

    private fun ringing(context: Context, callId: Id): Notification? {
        val manager = ContextCompat.getSystemService(context, NotificationManager::class.java) ?: return null
        return runCatching {
            manager.activeNotifications.firstOrNull { it.tag == RING_TAG && it.id == callId.hashCode() }?.notification
        }.getOrNull()
    }

    private fun activityIntent(context: Context, callId: Id, action: String, extras: Intent.() -> Unit): PendingIntent =
        PendingIntent.getActivity(
            context,
            requestCode(callId, action),
            Intent(context, MainActivity::class.java).apply {
                this.action = action
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(EXTRA_CALL, callId)
                extras()
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    // One request code per (call, action): PendingIntents that differ only in
    // extras are the same PendingIntent, and Answer would open Decline's.
    private fun requestCode(callId: Id, action: String) = (callId + action).hashCode()

    internal fun kindOf(wire: String?): CallKind? = when (wire) {
        CallKind.Video.wire -> CallKind.Video
        CallKind.Audio.wire -> CallKind.Audio
        else -> null
    }

    /**
     * Calls that rang here and were not dealt with here, and what their missed
     * call needs. In memory only: a match's name is not written to disk for
     * this; a process that died in between finds it in the notification still
     * on screen, or leaves it to the server's missed-call push.
     */
    private val unanswered = ConcurrentHashMap<Id, Missed>()

    private data class Missed(val name: String, val conversationId: Id, val kind: CallKind)

    private const val RING_TAG = "call.ring"

    /** A phone's ring: the channel's from Android 8, the notification's own before. */
    private val RING_VIBRATION = longArrayOf(0, 800, 600, 800, 600)
}

/**
 * A ringing call the person asked to see (Answer pressed, or the ring itself
 * tapped or shown full screen over the lock screen), until the app opens it.
 */
data class IncomingCallLink(
    val callId: Id,
    val conversationId: Id,
    val kind: CallKind,
    val peerName: String,
    val peerPhotoUrl: String?,
    /** Answer was pressed: answer on arrival rather than show the ring. */
    val answer: Boolean,
    /** When the ring runs out, on this phone's clock; null when unknown. */
    val expiresAt: Instant?,
) {
    companion object {
        /** From a ring's Answer, or from the ring itself; null for any other intent. */
        fun from(intent: Intent?): IncomingCallLink? {
            intent ?: return null
            val answer = when (intent.action) {
                CallNotifications.ACTION_ANSWER -> true
                CallNotifications.ACTION_SHOW -> false
                else -> return null
            }
            val callId = intent.getStringExtra(CallNotifications.EXTRA_CALL)?.takeIf(CallRing::isId) ?: return null
            val conversationId = intent.getStringExtra(CallNotifications.EXTRA_CONVERSATION)?.takeIf(CallRing::isId) ?: return null
            val kind = CallNotifications.kindOf(intent.getStringExtra(CallNotifications.EXTRA_KIND)) ?: return null
            return IncomingCallLink(
                callId = callId,
                conversationId = conversationId,
                kind = kind,
                peerName = intent.getStringExtra(CallNotifications.EXTRA_PEER)?.take(40).orEmpty(),
                peerPhotoUrl = CallRing.photoUrl(intent.getStringExtra(CallNotifications.EXTRA_PHOTO)),
                answer = answer,
                expiresAt = intent.getLongExtra(CallNotifications.EXTRA_EXPIRES, 0L).takeIf { it > 0 }?.let(Instant::ofEpochMilli),
            )
        }
    }
}
