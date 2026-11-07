package app.core.feature.call

import android.Manifest
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
import app.core.MainActivity
import app.core.R
import app.core.i18n.AppLocales
import app.core.i18n.brandString
import app.core.push.CallActionReceiver
import app.core.push.CallNotifications
import app.core.push.CallRing
import app.core.push.CallerFace
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * [CallForeground] as [OngoingCallService], for one session. A stop names the
 * call this session showed, so a session that only rang and never showed
 * anything leaves the service alone.
 */
class ServiceCallForeground(private val context: Context) : CallForeground {
    private var shown: String? = null

    override fun show(call: OngoingCall) {
        shown = call.callId
        OngoingCallService.start(context, call)
    }

    override fun stop() {
        shown?.let { OngoingCallService.stop(context, it) }
        shown = null
    }
}

/**
 * The foreground service a call in progress runs under.
 *
 * Without one, Android hands an app that is not on screen silence for a
 * microphone and no camera, and stops its process when it likes: the person
 * presses Home, or the screen turns off at the ear, and the other side goes on
 * talking to a phone that has stopped sending. Typed `microphone`, and
 * `camera` while the camera is on, as Android 14 asks a service that uses
 * them, and only with the permission already granted ([OngoingCallTypes]).
 *
 * Its notification is the platform's ongoing-call one: the match's first name
 * and face, the call's timer once both are in, End, and a tap that returns to
 * the call. On a locked screen it shows only "Call in progress". End goes to
 * [CallActionReceiver]. In a quiet channel of its own.
 *
 * Started with `startService` from the call while the app is in front, never
 * `startForegroundService` from the background, which Android 12+ refuses
 * for these types. Not sticky: a process that died has no call to come back to.
 */
class OngoingCallService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private var shown: OngoingCall? = null
    private var photo: Bitmap? = null
    private var photoFor: String? = null
    private var photoJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // Only the call it is for: a stop that crossed a newer call's start leaves that one.
            if (intent.getStringExtra(CallNotifications.EXTRA_CALL) == shown?.callId) {
                shown = null
                stopSelf(startId)
            }
            return START_NOT_STICKY
        }
        val call = intent?.let(::callOf)
        if (call == null) {
            if (shown == null) stopSelf()
            return START_NOT_STICKY
        }
        if (!display(call)) {
            // An update Android would not take (the camera turned on with the
            // app behind) leaves the call as it was shown; a new call it
            // refused gets no service.
            if (shown == null) stopSelf(startId)
        }
        return START_NOT_STICKY
    }

    private fun display(call: OngoingCall): Boolean {
        val face = if (call.peerPhotoUrl == photoFor) photo else null
        if (!promote(call, face)) return false
        shown = call
        if (call.peerPhotoUrl != photoFor) {
            photo = null
            photoFor = call.peerPhotoUrl
            photoJob?.cancel()
            val url = call.peerPhotoUrl ?: return true
            photoJob = scope.launch {
                val fetched = CallerFace.photo(applicationContext, url) ?: return@launch
                val now = shown?.takeIf { it.peerPhotoUrl == url } ?: return@launch
                photo = fetched
                promote(now, fetched)
            }
        }
        return true
    }

    override fun onDestroy() {
        scope.cancel()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun promote(call: OngoingCall, face: Bitmap?): Boolean {
        val types = OngoingCallTypes.of(
            sdk = Build.VERSION.SDK_INT,
            video = call.video,
            microphoneGranted = granted(Manifest.permission.RECORD_AUDIO),
            cameraGranted = granted(Manifest.permission.CAMERA),
        )
        if (types == OngoingCallTypes.NONE) return false
        CallNotifications.ensureChannels(this)
        return runCatching { ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(call, face), types) }.isSuccess
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun notification(call: OngoingCall, face: Bitmap?): android.app.Notification {
        val text = AppLocales.wrap(this)
        val name = call.peerName.ifBlank { text.brandString(R.string.call_peer_fallback) }
        val person = Person.Builder()
            .setName(name)
            .setIcon(IconCompat.createWithBitmap(CallerFace.face(face)))
            .setImportant(true)
            .build()
        val back = PendingIntent.getActivity(
            this,
            call.callId.hashCode(),
            Intent(this, MainActivity::class.java).apply {
                action = Intent.ACTION_MAIN
                addCategory(Intent.CATEGORY_LAUNCHER)
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val hangUp = PendingIntent.getBroadcast(
            this,
            (call.callId + CallNotifications.ACTION_HANG_UP).hashCode(),
            Intent(this, CallActionReceiver::class.java).apply {
                action = CallNotifications.ACTION_HANG_UP
                putExtra(CallNotifications.EXTRA_CALL, call.callId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val color = ContextCompat.getColor(this, R.color.brand_primary)
        val public = NotificationCompat.Builder(this, CallNotifications.CHANNEL_ONGOING)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(color)
            .setContentTitle(text.brandString(R.string.call_notify_ongoing_public))
            .build()
        return NotificationCompat.Builder(this, CallNotifications.CHANNEL_ONGOING)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(color)
            .setContentTitle(name)
            .setContentText(text.brandString(if (call.video) R.string.call_notify_ongoing_video else R.string.call_notify_ongoing_audio))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(back)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, hangUp).setIsVideo(call.video))
            .addPerson(person)
            .apply {
                call.since?.let { since ->
                    setWhen(since.toEpochMilli())
                    setShowWhen(true)
                    setUsesChronometer(true)
                }
            }
            .build()
    }

    companion object {
        private const val ACTION_STOP = "app.core.call.STOP"
        private const val NOTIFICATION_ID = 0x7ea3

        private const val EXTRA_VIDEO = "video"
        private const val EXTRA_SINCE = "since"

        /**
         * Starts the service for [call], or brings its notification up to
         * date. Swallowed when Android refuses it (an app it counts as in the
         * background): the call goes on regardless; only its hold on the
         * microphone with the screen off is lost.
         */
        fun start(context: Context, call: OngoingCall) {
            val intent = Intent(context, OngoingCallService::class.java).apply {
                putExtra(CallNotifications.EXTRA_CALL, call.callId)
                putExtra(CallNotifications.EXTRA_PEER, call.peerName)
                call.peerPhotoUrl?.let { putExtra(CallNotifications.EXTRA_PHOTO, it) }
                putExtra(EXTRA_VIDEO, call.video)
                call.since?.let { putExtra(EXTRA_SINCE, it.toEpochMilli()) }
            }
            runCatching { context.startService(intent) }
        }

        /** [callId] is over: through the service's own queue, behind every start sent before it. */
        fun stop(context: Context, callId: String) {
            val intent = Intent(context, OngoingCallService::class.java).apply {
                action = ACTION_STOP
                putExtra(CallNotifications.EXTRA_CALL, callId)
            }
            runCatching { context.startService(intent) }
        }

        private fun callOf(intent: Intent): OngoingCall? {
            val callId = intent.getStringExtra(CallNotifications.EXTRA_CALL)?.takeIf { it.isNotEmpty() } ?: return null
            return OngoingCall(
                callId = callId,
                peerName = intent.getStringExtra(CallNotifications.EXTRA_PEER)?.take(40).orEmpty(),
                peerPhotoUrl = CallRing.photoUrl(intent.getStringExtra(CallNotifications.EXTRA_PHOTO)),
                video = intent.getBooleanExtra(EXTRA_VIDEO, false),
                since = intent.getLongExtra(EXTRA_SINCE, 0L).takeIf { it > 0 }?.let(Instant::ofEpochMilli),
            )
        }
    }
}
