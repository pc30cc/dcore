package app.core.feature.call

import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Rect
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.annotation.RequiresApi
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import app.core.R
import app.core.i18n.brandString

/**
 * A video call in the system's picture-in-picture window while the person is
 * in another app (Home, Recents, a notification that opens one).
 *
 * The app is one activity, so the window is offered only while a video call
 * is placed or answered and not over, and never for anything else: leaving
 * a chat with no call on just leaves. Android 12+ enters on its own as the app
 * goes ([PictureInPictureParams.Builder.setAutoEnterEnabled]); before that
 * the app asks as the person leaves ([onUserLeaveHint]). The window takes the
 * shape of the other person's picture. Its two buttons are the system's
 * ([RemoteAction]): mute or unmute, and end. The foreground service keeps the
 * microphone and the camera; this only keeps the call in view.
 */
class CallPictureInPicture(private val activity: ComponentActivity) {

    /** What the window would show; null with no video call on. */
    data class Spec(val aspect: Rational, val muted: Boolean, val live: Boolean)

    var inWindow by mutableStateOf(false)
        private set

    private var spec: Spec? = null

    /** A permission dialog over the call: leaving for it is not leaving the app. */
    private var heldForPermission = false

    /** The window's buttons, handed to the call on screen. */
    var onMute: () -> Unit = {}
    var onHangUp: () -> Unit = {}

    /** Tapped back to full size: the call's screen comes back. */
    var onRestored: () -> Unit = {}

    private var skipNextRestore = false

    private val supported: Boolean =
        activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_MUTE -> if (spec?.live == true) onMute()
                ACTION_HANG_UP -> onHangUp()
            }
        }
    }

    fun attach() {
        inWindow = activity.isInPictureInPictureMode
        ContextCompat.registerReceiver(
            activity,
            receiver,
            IntentFilter().apply {
                addAction(ACTION_MUTE)
                addAction(ACTION_HANG_UP)
            },
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        activity.lifecycle.addObserver(
            LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_RESUME && heldForPermission) {
                    heldForPermission = false
                    update(spec)
                }
            },
        )
        activity.addOnPictureInPictureModeChangedListener { info ->
            val was = inWindow
            inWindow = info.isInPictureInPictureMode
            if (was && !inWindow) {
                val skip = skipNextRestore
                skipNextRestore = false
                if (!skip && activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) onRestored()
            }
        }
    }

    fun detach() {
        runCatching { activity.unregisterReceiver(receiver) }
    }

    /** A permission dialog is about to open over the call. */
    fun holdForPermission() {
        if (heldForPermission) return
        heldForPermission = true
        update(spec)
    }

    /** A notification tap is navigating while in the window: coming back must not cover it with the call. */
    fun notificationOpened() {
        if (inWindow) skipNextRestore = true
    }

    fun update(next: Spec?) {
        spec = next
        if (!supported || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        runCatching { activity.setPictureInPictureParams(params(next)) }
    }

    /** The person is leaving the app: before Android 12, into the window with the call. */
    fun onUserLeaveHint() {
        val current = spec ?: return
        if (!supported || heldForPermission || activity.isInPictureInPictureMode) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return // Entered on its own.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) runCatching { activity.enterPictureInPictureMode(params(current)) }
    }

    /** The call ended in the window: the window goes, with the app behind it. */
    fun close() {
        if (inWindow) activity.moveTaskToBack(false)
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun params(spec: Spec?): PictureInPictureParams {
        val builder = PictureInPictureParams.Builder()
        if (spec != null) {
            builder.setAspectRatio(spec.aspect)
            builder.setActions(actions(spec))
            sourceRect(spec.aspect)?.let { builder.setSourceRectHint(it) }
        } else {
            builder.setActions(emptyList())
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setAutoEnterEnabled(spec != null && !heldForPermission)
            builder.setSeamlessResizeEnabled(true)
        }
        return builder.build()
    }

    /**
     * Where the window's picture is on the full screen: the largest rect of
     * the window's shape centred in it, which is what the full-screen picture
     * shows. The system grows the window out of it, and back into it, rather
     * than cutting from one to the other. Null before the screen is laid out.
     */
    private fun sourceRect(aspect: Rational): Rect? {
        val view = activity.window?.decorView ?: return null
        val width = view.width
        val height = view.height
        if (width <= 0 || height <= 0 || aspect.numerator <= 0 || aspect.denominator <= 0) return null
        val ratio = aspect.toFloat()
        val (w, h) = if (width.toFloat() / height > ratio) (height * ratio).toInt() to height else width to (width / ratio).toInt()
        val left = (width - w) / 2
        val top = (height - h) / 2
        return Rect(left, top, left + w, top + h)
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun actions(spec: Spec): List<RemoteAction> {
        val end = activity.brandString(R.string.call_action_hang_up_full)
        val hangUp = RemoteAction(Icon.createWithResource(activity, R.drawable.ic_call_end), end, end, broadcast(ACTION_HANG_UP, REQUEST_HANG_UP))
        // Mute only once both are on the line, as on the full screen.
        if (!spec.live) return listOf(hangUp)
        val muteTitle = activity.brandString(if (spec.muted) R.string.call_action_unmute else R.string.call_action_mute)
        val mute = RemoteAction(
            Icon.createWithResource(activity, if (spec.muted) R.drawable.ic_call_mic_off else R.drawable.ic_call_mic),
            muteTitle,
            muteTitle,
            broadcast(ACTION_MUTE, REQUEST_MUTE),
        )
        return listOf(mute, hangUp)
    }

    private fun broadcast(action: String, request: Int): PendingIntent =
        PendingIntent.getBroadcast(
            activity,
            request,
            // This app's own package only: nothing outside it reaches the receiver.
            Intent(action).setPackage(activity.packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    private companion object {
        const val ACTION_MUTE = "app.core.call.PIP_MUTE"
        const val ACTION_HANG_UP = "app.core.call.PIP_HANG_UP"
        const val REQUEST_MUTE = 7101
        const val REQUEST_HANG_UP = 7102
    }
}
