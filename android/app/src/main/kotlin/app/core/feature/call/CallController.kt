package app.core.feature.call

import android.Manifest
import android.os.Build
import app.core.common.runCatchingUnlessCancelled
import app.core.model.ConversationPeer
import app.core.model.CallKind
import app.core.model.Id
import app.core.push.IncomingCallLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** A call the person asked for that waits on the permission dialog ([CallHost] runs it). */
sealed interface CallRequest {
    data class Place(val peer: CallPeer, val kind: CallKind) : CallRequest

    /** Answer the call ringing on screen; [withVideo] false answers a video call with the camera off. */
    data class Answer(val withVideo: Boolean) : CallRequest
}

/**
 * The one call on this phone, for the whole app: a person is in at most one
 * call at a time (the server refuses a second with `caller_busy`, and never
 * rings a busy account).
 *
 * The call is not a screen on the navigation stack: it lives here, app-wide,
 * and [CallHost] draws it over whatever the app shows, full screen or as a
 * small bubble ([minimise]). So a call survives every navigation, and the
 * rest of the app needs to know nothing about it but [requestCall].
 */
class CallController(
    private val newSession: (CallKind) -> MatchCallSession,
    private val scope: CoroutineScope,
    /** An incoming call ended on this phone: its ring comes down, as a missed call when it was one. */
    private val onRingEnded: (callId: Id, end: CallEnd) -> Unit = { _, _ -> },
    private val lingerMs: Long = END_LINGER_MS,
    /** The match's photo as the chat's cache has it for a conversation, or null (signed out, not stored). */
    private val cachedFace: suspend (conversationId: Id) -> ConversationPeer? = { null },
) {
    private val _session = MutableStateFlow<MatchCallSession?>(null)

    /** The call on screen (live, or over and still showing how it ended), or null. */
    val session: StateFlow<MatchCallSession?> = _session.asStateFlow()

    private val _minimised = MutableStateFlow(false)
    val minimised: StateFlow<Boolean> = _minimised.asStateFlow()

    private val _pending = MutableStateFlow<CallRequest?>(null)
    val pending: StateFlow<CallRequest?> = _pending.asStateFlow()

    private var lingering: Job? = null

    /** The session while its call is still on. */
    val liveSession: MatchCallSession? get() = _session.value?.takeIf { !it.phase.value.isOver }

    /**
     * The call button: asks for the permissions a call needs, then places it.
     * Already in a call: that call comes back to the front instead, and false.
     */
    fun requestCall(peer: CallPeer, kind: CallKind): Boolean {
        if (liveSession != null) {
            expand()
            return false
        }
        _pending.value = CallRequest.Place(peer, kind)
        return true
    }

    /** Answer (or "voice only") on the ring screen: asks for the permissions first. */
    fun requestAnswer(withVideo: Boolean) {
        val live = liveSession ?: return
        if (live.direction != MatchCallSession.Direction.INCOMING || live.phase.value != CallPhase.Ringing) return
        _pending.value = CallRequest.Answer(withVideo)
    }

    fun clearPending() {
        _pending.value = null
    }

    /**
     * Places the call once the permission dialog is answered. Without the
     * microphone nobody is rung, and the screen says why. [camera] false
     * places a video call with the camera off.
     */
    fun place(peer: CallPeer, kind: CallKind, microphone: Boolean, camera: Boolean) {
        _pending.value = null
        if (liveSession != null) return
        val session = start(kind)
        if (!microphone) {
            session.refuseWithoutMicrophone(peer, kind)
            return
        }
        session.place(peer, kind, cameraAllowed = camera)
    }

    /** Answers once the permission dialog is answered; without the microphone the call goes ahead muted. */
    fun answer(withVideo: Boolean) {
        _pending.value = null
        liveSession?.answer(withVideo)
    }

    /**
     * The ring's notification tapped, or its Answer pressed: the ring screen
     * for that call (a second tap brings the same one back). False when
     * another call is on here.
     */
    fun openRing(link: IncomingCallLink): Boolean {
        val current = _session.value
        if (current != null && current.callId == link.callId) {
            expand()
            return true
        }
        if (liveSession != null) return false
        val session = start(link.kind)
        session.ring(link.callId, CallPeer(link.conversationId, link.peerName, link.peerPhotoUrl), link.kind, link.expiresAt)
        // The ring carries a photo URL at most: the blurhash (and the photo, if
        // the ring had none) come from the conversation the phone has stored.
        scope.launch {
            val face = runCatchingUnlessCancelled { cachedFace(link.conversationId) }.getOrNull() ?: return@launch
            session.knowFace(link.conversationId, face.photo?.url, face.photo?.blurhash, face.verified)
        }
        return true
    }

    private fun start(kind: CallKind): MatchCallSession {
        lingering?.cancel()
        _session.value?.close()
        val session = newSession(kind)
        _session.value = session
        _minimised.value = false
        scope.launch {
            val ended = session.phase.first { it.isOver } as CallPhase.Ended
            val callId = session.callId
            if (session.direction == MatchCallSession.Direction.INCOMING && callId != null) onRingEnded(callId, ended.end)
            if (ended.end in CLOSES_BY_ITSELF || _minimised.value) {
                lingering = scope.launch {
                    delay(lingerMs)
                    if (_session.value === session) dismiss()
                }
            }
        }
        return session
    }

    /** Back on a call placed or answered: it goes on in a bubble over the rest of the app. */
    fun minimise() {
        val live = liveSession ?: return
        if (live.direction == MatchCallSession.Direction.INCOMING && live.phase.value == CallPhase.Ringing) return
        _minimised.value = true
    }

    fun expand() {
        _minimised.value = false
    }

    /** Closes the call screen; a call still on is hung up first. */
    fun dismiss() {
        val session = _session.value ?: return
        lingering?.cancel()
        _session.value = null
        _minimised.value = false
        _pending.value = null
        session.close()
    }

    /** "Call again" on a call that did not go through. */
    fun retry() {
        val session = _session.value ?: return
        val peer = session.peer.value
        val kind = session.kind
        dismiss()
        requestCall(peer, kind)
    }

    /** End on the ongoing notification: true when the call on screen took it. */
    fun hangUpFromNotification(callId: Id): Boolean {
        val live = liveSession ?: return false
        if (live.callId != callId) return false
        live.hangUp()
        return true
    }

    internal companion object {
        /** How long "Call ended" stays before the screen closes by itself. */
        const val END_LINGER_MS = 2_200L

        /** Ends with nothing to do about them: the screen says so briefly and closes. */
        val CLOSES_BY_ITSELF = setOf(
            CallEnd.HUNG_UP,
            CallEnd.PEER_ENDED,
            CallEnd.DECLINED,
            CallEnd.DECLINED_ELSEWHERE,
            CallEnd.CANCELLED,
            CallEnd.MISSED,
            CallEnd.ANSWERED_ELSEWHERE,
        )
    }
}

/**
 * The runtime permissions a call asks for, at the moment of the call and
 * never at launch: the microphone always, the camera for a video call that
 * will use it, and (Android 12+) `BLUETOOTH_CONNECT`, without which the audio
 * router cannot offer a Bluetooth headset. Pure, so the flow is tested on a JVM.
 */
object CallPermissions {
    const val MICROPHONE = Manifest.permission.RECORD_AUDIO
    const val CAMERA = Manifest.permission.CAMERA
    const val BLUETOOTH = "android.permission.BLUETOOTH_CONNECT"

    fun needed(kind: CallKind, withVideo: Boolean, sdk: Int = Build.VERSION.SDK_INT): List<String> = buildList {
        add(MICROPHONE)
        if (kind == CallKind.Video && withVideo) add(CAMERA)
        if (sdk >= Build.VERSION_CODES.S) add(BLUETOOTH)
    }

    /** What still has to be asked: [needed] less what is granted. */
    fun missing(needed: List<String>, granted: (String) -> Boolean): List<String> = needed.filterNot(granted)

    /**
     * What the call goes ahead with once the dialog is answered (or without
     * one, when nothing was missing): [results] are the dialog's answers,
     * [granted] what the phone already had.
     */
    fun outcome(results: Map<String, Boolean>, granted: (String) -> Boolean): Granted {
        fun has(permission: String) = results[permission] ?: granted(permission)
        return Granted(microphone = has(MICROPHONE), camera = has(CAMERA), bluetooth = has(BLUETOOTH))
    }

    data class Granted(val microphone: Boolean, val camera: Boolean, val bluetooth: Boolean)
}
