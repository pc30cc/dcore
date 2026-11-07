package app.core.feature.call

import app.core.model.Call
import app.core.model.CallAcceptance
import app.core.model.CallKind
import app.core.model.CallOutcome
import app.core.model.CallRole
import app.core.model.CallState
import app.core.model.CallToken
import app.core.model.Id
import app.core.model.IcePolicy
import app.core.model.Problem
import app.core.model.TurnServer
import app.core.net.ApiError
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.IOException
import java.time.Instant

/** The epoch the tests' clocks start at. */
const val T0 = 1_762_420_443_000L

fun at(ms: Long): Instant = Instant.ofEpochMilli(T0 + ms)

fun testCall(
    id: Id = "9001",
    role: CallRole = CallRole.Caller,
    state: CallState = CallState.Ringing,
    kind: CallKind = CallKind.Audio,
    outcome: CallOutcome? = null,
    rangAt: Instant? = null,
    conversationId: Id = "500",
    placedAt: Instant = at(0),
) = Call(
    id = id,
    conversationId = conversationId,
    kind = kind,
    role = role,
    state = state,
    outcome = outcome,
    placedAt = placedAt,
    ringExpiresAt = placedAt.plusSeconds(45),
    rangAt = rangAt,
)

fun testToken(turn: Boolean = false, warnings: List<String> = emptyList()) = CallToken(
    token = "room-token",
    expiresAt = at(600_000),
    wsUrl = "wss://rtc.example.test",
    turn = if (turn) TurnServer(listOf("turns:relay.example.test:443"), "u1", "c1") else null,
    icePolicy = if (turn) IcePolicy.Relay else IcePolicy.All,
    warnings = warnings,
)

fun http(status: Int, code: String, vararg members: Pair<String, Any?>) = ApiError.Http(status, Problem.of(status, code, *members))

fun offline() = ApiError.Network(IOException("offline"))

/** The call routes, scripted per test; every request is logged by route name. */
class ScriptedCallApi : CallApi {
    val log = mutableListOf<String>()
    fun count(route: String) = log.count { it == route }

    var place: suspend (Id, CallKind) -> Call = { conversation, kind -> testCall(conversationId = conversation, kind = kind) }
    var get: suspend (Id) -> Call = { id -> testCall(id = id) }
    var accept: suspend (Id) -> CallAcceptance = { id -> CallAcceptance(testCall(id = id, role = CallRole.Callee, state = CallState.Connecting), testToken()) }
    var decline: suspend (Id) -> Call = { id -> testCall(id = id, role = CallRole.Callee, state = CallState.Ended, outcome = CallOutcome.Declined) }
    var end: suspend (Id) -> Call = { id -> testCall(id = id, state = CallState.Ended, outcome = CallOutcome.Completed) }
    var token: suspend (Id) -> CallToken = { testToken() }

    override suspend fun place(conversationId: Id, kind: CallKind): Call { log += "place"; return place.invoke(conversationId, kind) }
    override suspend fun call(callId: Id): Call { log += "get"; return get(callId) }
    override suspend fun accept(callId: Id): CallAcceptance { log += "accept"; return accept.invoke(callId) }
    override suspend fun decline(callId: Id): Call { log += "decline"; return decline.invoke(callId) }
    override suspend fun end(callId: Id): Call { log += "end"; return end.invoke(callId) }
    override suspend fun token(callId: Id): CallToken { log += "token"; return token.invoke(callId) }

    /** A request that waits for the test to answer it. */
    class Gate<T> {
        val reply = CompletableDeferred<Result<T>>()
        suspend fun await(): T = reply.await().getOrThrow()
    }
}

/** A room with no media: joins when told, and lets the test say who is there and what the network does. */
class FakeCallRoom(
    var joinResult: CallRoom.Result = CallRoom.Result.Joined(microphone = true, camera = true),
) : CallRoom {
    val emitted = MutableSharedFlow<CallRoom.Event>(extraBufferCapacity = 16)
    override val events: Flow<CallRoom.Event> = emitted

    private val _routes = MutableStateFlow(AudioRoutes(selected = AudioRoute.Earpiece))
    override val audioRoutes: StateFlow<AudioRoutes> = _routes

    val log = mutableListOf<String>()
    var joined: CallToken? = null
    var wantedVideo: Boolean? = null
    var peerHere = false
    var microphone: Boolean? = null
    var speaker: Boolean? = null
    var released = false
    /** A join that waits for the test (null joins at once). */
    var joinGate: CompletableDeferred<Unit>? = null

    override suspend fun connect(credentials: CallToken, wantsVideo: Boolean): CallRoom.Result {
        log += "connect"
        joinGate?.await()
        joined = credentials
        wantedVideo = wantsVideo
        return joinResult
    }

    override suspend fun setMicrophone(enabled: Boolean): Boolean {
        log += "mic:$enabled"
        microphone = enabled
        return true
    }

    override suspend fun setCamera(enabled: Boolean): Boolean {
        log += "camera:$enabled"
        return true
    }

    override fun setSpeaker(on: Boolean) {
        speaker = on
    }

    override fun selectRoute(route: AudioRoute) {
        log += "route:$route"
    }

    override suspend fun switchCamera(front: Boolean): Boolean = true

    override val hasRemoteParticipant: Boolean get() = peerHere

    override suspend fun disconnect() {
        log += "disconnect"
    }

    override fun release() {
        released = true
    }

    fun headsets(vararg routes: AudioRoute) {
        _routes.value = AudioRoutes(available = listOf(AudioRoute.Earpiece, AudioRoute.Speaker) + routes, selected = routes.firstOrNull())
    }
}

class RecordingRingback : Ringback {
    var playing = false
    var starts = 0
    override fun start() {
        if (!playing) starts++
        playing = true
    }
    override fun stop() {
        playing = false
    }
}

class RecordingForeground : CallForeground {
    val shown = mutableListOf<OngoingCall>()
    var stopped = 0
    override fun show(call: OngoingCall) {
        shown += call
    }
    override fun stop() {
        stopped++
    }
}
