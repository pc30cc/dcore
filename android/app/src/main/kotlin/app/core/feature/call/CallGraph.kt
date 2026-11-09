package app.core.feature.call

import android.app.Application
import app.core.common.Clock
import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.model.Call
import app.core.model.CallKind
import app.core.model.Conversation
import app.core.model.Id
import app.core.model.Photo
import app.core.model.RealtimeEvent
import app.core.net.ServerApi
import app.core.realtime.RealtimeCoordinator
import app.core.realtime.RealtimeHealth
import app.core.push.CallNotifications
import app.core.push.CallPushHandler
import app.core.push.CallRangReporter
import app.core.push.CallerFace
import app.core.push.IncomingCallRouter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Everything calls need, built once for the process ([app.core.AppGraph.calls]).
 *
 * What the rest of the app talks to:
 *  - the realtime socket ([listenTo]): every `call` event, and whether the
 *    socket is up;
 *  - the push router ([pushHandler]): rings and their stops, from FCM;
 *  - the chat: [controller]`.requestCall(...)` from its call buttons,
 *    [remember] with the conversation it shows, and [consent] for the
 *    match's call switch.
 *
 * Nothing here opens a socket or polls: the ring and the calls react to push
 * and realtime alone (a call reads its own state only while the socket is down).
 */
class CallGraph(
    private val app: Application,
    private val apiOf: () -> ServerApi,
    val scope: CoroutineScope,
    private val clock: Clock,
    val diag: Diag,
    /** The match's photo as the chat's cache stores it for a conversation (the ring screen's face). */
    private val cachedFace: suspend (conversationId: Id) -> Photo? = { null },
) {
    fun api(): ServerApi = apiOf()

    val signals = CallSignals()

    val rang = CallRangReporter(send = { id -> api().callRang(id) }, scope = scope, diag = diag)

    /** The matches this process has seen, for a ring that arrives over the socket with ids only. */
    private val peers = ConcurrentHashMap<Id, IncomingCallRouter.RingPeer>()

    /** A conversation the app has on screen or in a list: its match's first name and photo, for a ring. */
    fun remember(conversation: Conversation) {
        peers[conversation.id] = IncomingCallRouter.RingPeer(conversation.peer.name, conversation.peer.photo?.url)
    }

    private suspend fun peerOf(conversationId: Id): IncomingCallRouter.RingPeer? {
        peers[conversationId]?.let { return it }
        // Not seen yet in this process: the first page of the list, which
        // normally answers "unchanged" from the stored copy.
        val page = withTimeoutOrNull(PEER_LOOKUP_MS) {
            runCatchingUnlessCancelled { api().conversations() }.getOrNull()
        } ?: return null
        page.value.items.forEach(::remember)
        return peers[conversationId]
    }

    val incoming = IncomingCallRouter(
        signedIn = { api().hasSession() },
        ring = { ring -> CallNotifications.showRing(app, ring, CallerFace.photo(app, ring.peerPhotoUrl), clock.now()) },
        stop = { callId, missed, reason ->
            CallNotifications.stopRing(app, callId, missed)
            signals.ringStopped(callId, reason)
        },
        peerOf = ::peerOf,
        rang = rang::report,
        clock = clock,
        diag = diag,
    )

    val controller = CallController(
        newSession = ::newSession,
        scope = scope,
        onRingEnded = { callId, end ->
            incoming.dealtWith(callId)
            CallNotifications.stopRing(app, callId, missed = end == CallEnd.MISSED || end == CallEnd.CANCELLED)
        },
        cachedFace = cachedFace,
    )

    /** The match's call switch. */
    val consent = CallConsent(apiOf = ::api, scope = scope, onChanged = ::remember)

    init {
        signals.ringListener = { call -> scope.launch { incoming.onRealtimeCall(call) } }
    }

    /** What the push router hands rings and their stops to (the missed-call push stays the router's to draw). */
    val pushHandler = CallPushHandler { _, data, sentTimeMillis -> incoming.onMessage(data, sentTimeMillis) }

    private val listening = AtomicBoolean(false)

    /**
     * Follows the realtime socket: every `call` event goes to the calls and
     * the ring, and whether it is connected decides if a call reads its own
     * state (only while it is not). Once per process; the socket itself exists
     * only while the app is in front.
     */
    fun listenTo(realtime: RealtimeCoordinator) {
        if (!listening.compareAndSet(false, true)) return
        scope.launch {
            realtime.events.collect { event -> if (event is RealtimeEvent.CallChanged) onRealtimeCall(event.call) }
        }
        scope.launch {
            realtime.health.collect { health -> setRealtimeConnected(health == RealtimeHealth.CONNECTED) }
        }
    }

    /** A `call` event from the realtime socket (the envelope's `d`). */
    fun onRealtimeCall(call: Call) = signals.onRealtimeCall(call)

    fun setRealtimeConnected(connected: Boolean) = signals.setRealtimeConnected(connected)

    /** This phone dealt with its ring here (Answer on the ring screen): the ring comes down, not as a missed call. */
    fun silenceRing(callId: Id) {
        incoming.dealtWith(callId)
        CallNotifications.stopRing(app, callId, missed = false)
        CallNotifications.forget(callId)
    }

    private fun newSession(kind: CallKind): MatchCallSession = MatchCallSession(
        api = CallApi.of(api()),
        room = CallRooms.create(app, api()),
        signals = signals,
        ringback = ToneRingback(video = kind == CallKind.Video),
        foreground = ServiceCallForeground(app),
        rang = rang::report,
        clock = clock,
        diag = diag,
    )

    private companion object {
        const val PEER_LOOKUP_MS = 1_500L
    }
}
