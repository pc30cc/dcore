package app.core.feature.call

import android.annotation.SuppressLint
import android.content.pm.ServiceInfo
import android.os.Build
import app.core.model.Id
import java.time.Instant

/** What a call in progress shows in its ongoing notification. */
data class OngoingCall(
    val callId: Id,
    /** The match's first name, for the notification (its lock-screen version leaves it out). */
    val peerName: String,
    val peerPhotoUrl: String?,
    /** The camera is on: the service holds it as well as the microphone. */
    val video: Boolean,
    /** When both came into the room: the notification's timer counts from it. Null until then. */
    val since: Instant? = null,
)

/**
 * Keeps a call alive while the screen is off or the app is behind another,
 * and says so: [show] when the call starts, again once it is live and when the
 * camera turns on or off, [stop] at its end. Behind an interface so the
 * session that decides when is tested on a JVM.
 */
interface CallForeground {
    fun show(call: OngoingCall)
    fun stop()
}

/** No service (tests). */
object NoCallForeground : CallForeground {
    override fun show(call: OngoingCall) = Unit
    override fun stop() = Unit
}

/**
 * Which foreground-service types a call's service takes: the microphone
 * whenever it is granted, the camera too while it is on and granted. Android
 * 14 refuses a type whose permission is missing, so a refused camera leaves a
 * voice-only service rather than none. Before Android 10 a service names no
 * type (0); from then on a call that could use nothing gets no service ([NONE]).
 */
object OngoingCallTypes {
    const val NONE = -1

    // Plain ints, read on the device it runs on: the manifest declares the
    // same bits, which is all Android 10 checks a service's types against.
    @SuppressLint("InlinedApi")
    fun of(sdk: Int, video: Boolean, microphoneGranted: Boolean, cameraGranted: Boolean): Int {
        if (sdk < Build.VERSION_CODES.Q) return 0
        var types = 0
        if (microphoneGranted) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (video && cameraGranted) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        return if (types == 0) NONE else types
    }
}
