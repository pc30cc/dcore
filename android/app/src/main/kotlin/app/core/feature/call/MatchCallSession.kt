package app.core.feature.call

import app.core.common.Clock
import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.model.Call
import app.core.model.CallAcceptance
import app.core.model.CallKind
import app.core.model.CallState
import app.core.model.CallToken
import app.core.model.Id
import app.core.model.ProblemCodes
import app.core.net.ApiError
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.time.Instant

/**
 * One call between two matched people on this phone, from the tap on the call
 * button (or the ring) to the room closing.
 *
 *  - **Outgoing** ([place]): `POST /v1/calls` rings the other person's phones;
 *    "Calling…" with the ringback until their phone says it rings (`rangAt`,
 *    only when they show they are online), "Ringing…" from then; once they
 *    answer, `POST /token` and the room.
 *  - **Incoming** ([ring], then [answer]): `POST accept` (the first phone to
 *    answer wins) returns the token, and the room. Declining is
 *    `POST decline`, which ends the call for the caller.
 *
 * The server is the authority on where the call is, and it says so over the
 * realtime socket with the whole call ([CallNudge.Update]), so nothing is
 * read again. While the socket is connected the session sends no request on
 * a timer; only while it is down does it read the call itself, every 3 s while
 * it rings and every 15 s once answered, and once when the socket comes back.
 * The phone's own deadlines (a ring that outlived its expiry, an answer that
 * never brought the two together) are kept without any request. Whatever it
 * hears only moves the call forward: a late "ringing" never takes an answered
 * call back.
 *
 * The media is [CallRoom], so the waiting, the outcomes and the races between
 * a hang-up and an answer are tested on a JVM. Anybody in the room but this
 * phone is the other person. Nothing here puts an id, a phone number or an
 * e-mail address anywhere near the room: the room's identity, name and
 * metadata come from the server's token, and this phone adds none.
 */
class MatchCallSession(
    private val api: CallApi,
    val room: CallRoom,
    private val signals: CallSignals,
    private val ringback: Ringback,
    private val foreground: CallForeground,
    /** Tells the server this phone shows the ring (`POST rang`), once per call however often asked. */
    private val rang: (callId: Id) -> Unit = {},
    private val clock: Clock = Clock.System,
    private val diag: Diag = Diag.Silent,
    dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
) {
    enum class Direction { OUTGOING, INCOMING }

    private val _phase = MutableStateFlow<CallPhase>(CallPhase.Placing)
    val phase: StateFlow<CallPhase> = _phase.asStateFlow()

    private val _peer = MutableStateFlow(CallPeer(conversationId = "", name = ""))
    val peer: StateFlow<CallPeer> = _peer.asStateFlow()

    private val _muted = MutableStateFlow(false)
    val muted: StateFlow<Boolean> = _muted.asStateFlow()

    private val _cameraOn = MutableStateFlow(false)
    val cameraOn: StateFlow<Boolean> = _cameraOn.asStateFlow()

    private val _frontCamera = MutableStateFlow(true)
    val frontCamera: StateFlow<Boolean> = _frontCamera.asStateFlow()

    /** A voice call starts on the earpiece, held to the ear; a video call on the loudspeaker. */
    private val _speakerOn = MutableStateFlow(false)
    val speakerOn: StateFlow<Boolean> = _speakerOn.asStateFlow()

    /** The server warned that no relay is configured where this phone needs one (`turn_missing`). */
    private val _relayWarning = MutableStateFlow(false)
    val relayWarning: StateFlow<Boolean> = _relayWarning.asStateFlow()

    /** Connected, but without everything it was meant to carry. */
    private val _degraded = MutableStateFlow<CallDegradation?>(null)
    val degraded: StateFlow<CallDegradation?> = _degraded.asStateFlow()

    /** The link is poor (either side): the screen says so, the call goes on. */
    private val _weakNetwork = MutableStateFlow(false)
    val weakNetwork: StateFlow<Boolean> = _weakNetwork.asStateFlow()

    /** Another app holds the audio (a cellular call): the microphone is not sent until it comes back. */
    private val _onHold = MutableStateFlow(false)
    val onHold: StateFlow<Boolean> = _onHold.asStateFlow()

    var direction: Direction = Direction.OUTGOING
        private set

    var kind: CallKind = CallKind.Audio
        private set

    /** The server's id for the call; null while an outgoing one is being placed. */
    var callId: Id? = null
        private set

    /** Whether [place], [ring] or [refuseWithoutMicrophone] has run: one session is one call. */
    var started: Boolean = false
        private set

    /** The call was answered, by the other person or by this phone. From here on, ending it is a hang-up. */
    private var answered = false

    /** This phone's accept, once Answer was pressed, and what the server said to it. */
    private var accepting: Deferred<Result<CallAcceptance>>? = null

    /** In the room, ready for the other person to be there. */
    private var joined = false

    /** The server said both are in the room. */
    private var serverActive = false

    private var ringStartedAt: Instant? = null
    private var expiresAt: Instant? = null
    private var answeredAt: Instant? = null
    private var reconnectingSince: Instant? = null
    private var peerAwaySince: Instant? = null

    /** What gets the call into the room (the create, the accept, the token, the join): cancelled by the end. */
    private var callJob: Job? = null
    private var watcher: Job? = null
    private var switching: Job? = null

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    /**
     * Where the create, the accept and the end are sent from: not [scope],
     * which closes with the session. A create cancelled by a closing screen
     * might still have reached the server and be ringing with nobody left to
     * stop it; one that always finishes here finds the call ended and ends it.
     */
    private val teardown = CoroutineScope(SupervisorJob() + dispatcher)

    // MARK: - Starting

    /**
     * Rings [peer] for a call of [kind]. Idempotent: one session is one call.
     * [cameraAllowed] false places a video call with the camera off (its
     * permission was refused); the button can still ask again.
     */
    fun place(peer: CallPeer, kind: CallKind, cameraAllowed: Boolean = true) {
        if (!begin(Direction.OUTGOING, peer, kind)) return
        if (!cameraAllowed) _cameraOn.value = false
        _phase.value = CallPhase.Placing
        listen()
        val creating = teardown.async {
            runCatchingUnlessCancelled { api.place(peer.conversationId, kind) }.onSuccess { call ->
                // From here on ending the call tells the server itself; a call
                // that ended before this line is withdrawn here.
                callId = call.id
                if (_phase.value.isOver) runCatchingUnlessCancelled { api.end(call.id) }
            }
        }
        callJob = scope.launch {
            creating.await()
                .onFailure { error ->
                    val end = CallEnd.refusal(error)
                    diag.info(AREA, "call not placed: ${end.name.lowercase()}")
                    finish(end, detail = (error as? ApiError)?.code?.takeIf { end == CallEnd.FAILED }, tell = false)
                }
                .onSuccess { call ->
                    if (_phase.value.isOver) return@onSuccess
                    ringStartedAt = clock.now()
                    // Ringing on the server: the ringback plays from now, whether
                    // or not their phone may say it rings.
                    ringback.start()
                    follow(call)
                    early.filter { it.id == call.id }.forEach(::follow)
                    early.clear()
                    if (!_phase.value.isOver) {
                        foreground.show(ongoing())
                        watch()
                    }
                }
        }
    }

    /**
     * This phone is being rung for [callId]: shown with Answer and Decline.
     * Nothing is sent but `rang` until one of them is pressed. Idempotent.
     */
    fun ring(callId: Id, peer: CallPeer, kind: CallKind, expiresAt: Instant?) {
        if (!begin(Direction.INCOMING, peer, kind)) return
        this.callId = callId
        this.expiresAt = expiresAt
        ringStartedAt = clock.now()
        _phase.value = CallPhase.Ringing
        rang(callId)
        listen()
        watch()
    }

    /**
     * The face the chat's cache knows for this call's conversation, for a
     * ring that brought only a photo URL ([CallPeer.withCachedFace]). Only
     * for this call's own conversation.
     */
    fun knowFace(conversationId: Id, photoUrl: String?, blurhash: String?) {
        _peer.update { peer -> if (peer.conversationId == conversationId) peer.withCachedFace(photoUrl, blurhash) else peer }
    }

    /** The microphone was refused before anybody was rung: nothing is placed. */
    fun refuseWithoutMicrophone(peer: CallPeer, kind: CallKind) {
        if (!begin(Direction.OUTGOING, peer, kind)) return
        _phase.value = CallPhase.Ended(CallEnd.NO_MICROPHONE)
    }

    private fun begin(direction: Direction, peer: CallPeer, kind: CallKind): Boolean {
        if (started) return false
        started = true
        this.direction = direction
        this.kind = kind
        _peer.value = peer
        _cameraOn.value = kind == CallKind.Video
        _speakerOn.value = kind == CallKind.Video
        return true
    }

    /**
     * Answers the call ringing this phone. The first phone to answer wins; a
     * later one hears that another phone did, or that the call is over, and
     * says exactly that. [withVideo] false answers a video call with the
     * camera off; its button can still turn it on.
     */
    fun answer(withVideo: Boolean = true) {
        if (direction != Direction.INCOMING || _phase.value != CallPhase.Ringing) return
        val id = callId ?: return
        if (kind == CallKind.Video && !withVideo) _cameraOn.value = false
        _phase.value = CallPhase.Connecting
        answeredAt = clock.now()
        foreground.show(ongoing())
        // The accept is the teardown's: once sent it may move the call to
        // `connecting` whatever this screen does next, so a hang-up while it
        // is on its way waits for its answer and ends what it did.
        val sending = teardown.async { runCatchingUnlessCancelled { api.accept(id) } }
        accepting = sending
        callJob = scope.launch {
            val acceptance = sending.await().getOrElse { error ->
                finish(acceptRefusal(id, error), detail = (error as? ApiError)?.code, tell = false)
                return@launch
            }
            answered = true
            join(id, acceptance.token)
        }
    }

    /** Why an accept did not answer the call, for the screen. */
    private suspend fun acceptRefusal(id: Id, error: Throwable): CallEnd {
        val http = error as? ApiError.Http ?: return CallEnd.refusal(error)
        return when {
            http.status == 409 && http.code == ProblemCodes.ANSWERED_ELSEWHERE -> CallEnd.ANSWERED_ELSEWHERE
            // No longer ringing: answered on another phone, or over (the caller
            // gave up, the ring ran out). One read says which.
            http.status == 409 -> runCatchingUnlessCancelled { api.call(id) }.getOrNull()
                ?.let { CallEnd.resolve(it, answeredHere = false) }
                ?: CallEnd.ANSWERED_ELSEWHERE
            // Gone for this account: the caller gave up and the call went with them.
            http.status == 404 -> CallEnd.CANCELLED
            else -> CallEnd.refusal(error)
        }
    }

    /** The red button, in every phase: cancels a call still ringing out, declines one ringing here, hangs up. */
    fun hangUp() = finish(CallEnd.HUNG_UP, tell = true)

    // MARK: - What the server says

    /**
     * Keeps the phone's own deadlines, and reads the call while (and only
     * while) the realtime socket is down. It sleeps until the next deadline or
     * poll, and wakes early when the socket goes up or down or the phase moves.
     */
    private fun watch() {
        if (watcher != null) return
        watcher = scope.launch {
            var lastRead = clock.nowMillis()
            var wasConnected = signals.realtimeConnected.value
            while (!_phase.value.isOver) {
                val connected = signals.realtimeConnected.value
                if (connected && !wasConnected) {
                    // Back after a drop: one read catches what the socket missed.
                    refresh()
                    lastRead = clock.nowMillis()
                }
                wasConnected = connected
                if (_phase.value.isOver || overdue()) break
                val now = clock.nowMillis()
                val pollAt = if (connected) Long.MAX_VALUE else lastRead + pollInterval()
                if (!connected && now >= pollAt) {
                    refresh()
                    lastRead = clock.nowMillis()
                    continue
                }
                val until = minOf(pollAt, nextDeadline() ?: Long.MAX_VALUE)
                val wait = if (until == Long.MAX_VALUE) Long.MAX_VALUE else (until - now).coerceAtLeast(1)
                val seen = connected to _phase.value
                val moved = combine(signals.realtimeConnected, _phase) { c, p -> c to p }
                // No deadline and nothing to poll: sleep until something moves.
                if (wait == Long.MAX_VALUE) moved.first { it != seen } else withTimeoutOrNull(wait) { moved.first { it != seen } }
            }
        }
    }

    private fun pollInterval(): Long = if (_phase.value.isRinging) RINGING_POLL_MS else ANSWERED_POLL_MS

    /** The next moment one of the phone's own deadlines falls due, in epoch milliseconds. */
    private fun nextDeadline(): Long? = when (val phase = _phase.value) {
        CallPhase.Placing, CallPhase.Ringing -> ringDeadline()?.toEpochMilli()
        CallPhase.Connecting -> answeredAt?.plusMillis(JOIN_TIMEOUT_MS)?.toEpochMilli()
        is CallPhase.Live -> listOfNotNull(
            reconnectingSince?.plusMillis(RECONNECT_TIMEOUT_MS)?.toEpochMilli(),
            peerAwaySince?.plusMillis(PEER_AWAY_TIMEOUT_MS)?.toEpochMilli(),
        ).minOrNull()?.takeIf { phase.reconnecting || phase.peerAway }
        is CallPhase.Ended -> null
    }

    /**
     * The server's expiry, but never more than one ring from when it started
     * here, plus the skew allowed between the two clocks: the server turns a
     * ring past its expiry into `missed` itself, so this is only the fallback.
     */
    private fun ringDeadline(): Instant? {
        val started = ringStartedAt ?: return null
        val ringEnd = started.plusSeconds(RING_SECONDS)
        val end = expiresAt?.takeIf { it.isBefore(ringEnd) } ?: ringEnd
        return end.plusMillis(CLOCK_SKEW_MS)
    }

    /** Ends a call whose deadline has passed; true when it did. */
    private fun overdue(): Boolean {
        val due = nextDeadline() ?: return false
        if (clock.nowMillis() < due) return false
        when (val phase = _phase.value) {
            CallPhase.Placing, CallPhase.Ringing ->
                if (direction == Direction.INCOMING) finish(CallEnd.MISSED, tell = false) else finish(CallEnd.NO_ANSWER, tell = true)
            CallPhase.Connecting -> finish(CallEnd.FAILED, detail = "join_timeout", tell = true)
            is CallPhase.Live -> finish(if (phase.reconnecting) CallEnd.CONNECTION_LOST else CallEnd.PEER_ENDED, tell = true)
            is CallPhase.Ended -> return false
        }
        return true
    }

    private suspend fun refresh() {
        val id = callId ?: return
        runCatchingUnlessCancelled { api.call(id) }
            .onSuccess(::follow)
            // Gone for this account: not a call to wait on. Any other failed
            // read is a blip; the next one, or a deadline, decides.
            .onFailure { error -> if ((error as? ApiError.Http)?.status == 404) finish(CallEnd.UNAVAILABLE, tell = false) }
    }

    /** The call as the server now has it. Only ever forward. */
    private fun follow(call: Call) {
        if (_phase.value.isOver) return
        call.ringExpiresAt?.let { expiresAt = it }
        CallEnd.resolve(call, answeredHere = answered || accepting != null)?.let { end ->
            finish(end, tell = false)
            return
        }
        when (call.state) {
            CallState.Ringing -> if (direction == Direction.OUTGOING && _phase.value == CallPhase.Placing && call.rangAt != null) {
                _phase.value = CallPhase.Ringing
            }
            CallState.Connecting, CallState.Active -> {
                if (call.state == CallState.Active) serverActive = true
                if (direction == Direction.OUTGOING && !answered) {
                    // They answered.
                    answered = true
                    answeredAt = clock.now()
                    ringback.stop()
                    _phase.value = CallPhase.Connecting
                    val id = callId ?: return
                    callJob = scope.launch {
                        val token = runCatchingUnlessCancelled { api.token(id) }.getOrElse { error ->
                            finish(if (error is ApiError.Network) CallEnd.OFFLINE else CallEnd.FAILED, detail = (error as? ApiError)?.code, tell = true)
                            return@launch
                        }
                        join(id, token)
                    }
                } else if (joined && serverActive) {
                    goLive()
                }
            }
            else -> Unit
        }
    }

    /**
     * Events about this call that arrived before its id did (the socket can
     * beat the create's own answer): kept until the id lands, then applied.
     */
    private val early = mutableListOf<Call>()

    private fun listen() {
        scope.launch {
            signals.nudges.collect { nudge ->
                val id = callId
                when {
                    id != null -> if (nudge.callId == id) onNudge(nudge)
                    nudge is CallNudge.Update && direction == Direction.OUTGOING &&
                        nudge.call.conversationId == _peer.value.conversationId && early.size < EARLY_MAX -> early += nudge.call
                }
            }
        }
        scope.launch {
            room.events.collect(::onRoomEvent)
        }
    }

    private fun onNudge(nudge: CallNudge) {
        val ringingHere = direction == Direction.INCOMING && _phase.value == CallPhase.Ringing
        when (nudge) {
            is CallNudge.Update -> follow(nudge.call)
            is CallNudge.RingStopped -> if (ringingHere) finish(CallEnd.of(nudge.reason), tell = false)
            // The notification's Decline has told the server already.
            is CallNudge.DeclinedHere -> if (ringingHere) finish(CallEnd.HUNG_UP, tell = false)
        }
    }

    // MARK: - The room

    private suspend fun join(id: Id, token: CallToken) {
        _phase.value = CallPhase.Connecting
        _relayWarning.value = TURN_MISSING in token.warnings
        if (token.wsUrl.isBlank()) {
            finish(CallEnd.FAILED, detail = "no_server_url", tell = true)
            return
        }
        // Where the sound starts, said before the room exists.
        room.setSpeaker(_speakerOn.value)
        val wantsVideo = kind == CallKind.Video && _cameraOn.value
        when (val result = room.connect(token, wantsVideo = wantsVideo)) {
            is CallRoom.Result.Failed -> finish(CallEnd.FAILED, detail = result.reason, tell = true)
            is CallRoom.Result.Joined -> {
                // A camera that will not start is a reason to carry on as voice,
                // not to drop a call the other person answered.
                if (!result.microphone) {
                    _muted.value = true
                    _degraded.value = CallDegradation.NO_MICROPHONE
                } else if (_muted.value || _onHold.value) {
                    // Muted before the room existed: applied now, never shown muted and sending.
                    room.setMicrophone(enabled = false)
                }
                if (wantsVideo && !result.camera) {
                    _cameraOn.value = false
                    if (_degraded.value == null) _degraded.value = CallDegradation.NO_CAMERA
                }
                joined = true
                diag.info(AREA, "joined ${Diag.id(id)}")
                // Whoever joins second finds the other already there, which no event says.
                if (room.hasRemoteParticipant || serverActive) goLive()
            }
        }
    }

    private fun goLive() {
        if (_phase.value != CallPhase.Connecting || !joined) return
        val since = clock.now()
        _phase.value = CallPhase.Live(since)
        foreground.show(ongoing(since))
    }

    private fun onRoomEvent(event: CallRoom.Event) {
        val phase = _phase.value
        when (event) {
            is CallRoom.Event.PeerPresence -> when {
                event.present && phase == CallPhase.Connecting -> goLive()
                event.present && phase is CallPhase.Live -> {
                    peerAwaySince = null
                    _phase.value = phase.copy(peerAway = false)
                }
                !event.present && phase is CallPhase.Live && !phase.peerAway -> {
                    // A hang-up reaches this phone as the server's `call` event a
                    // moment later; a dropped connection may come back. Shown as
                    // "connection lost" meanwhile, and read once while the socket
                    // is down so a hang-up is not left waiting for the deadline.
                    peerAwaySince = clock.now()
                    _phase.value = phase.copy(peerAway = true)
                    if (!signals.realtimeConnected.value) scope.launch { refresh() }
                }
            }
            CallRoom.Event.Reconnecting -> if (phase is CallPhase.Live && !phase.reconnecting) {
                reconnectingSince = clock.now()
                _phase.value = phase.copy(reconnecting = true)
            }
            CallRoom.Event.Reconnected -> if (phase is CallPhase.Live) {
                reconnectingSince = null
                _phase.value = phase.copy(reconnecting = false)
            }
            // Only once in the room: while connecting, the join says how it went.
            is CallRoom.Event.Disconnected -> if (phase is CallPhase.Live || (phase == CallPhase.Connecting && joined)) {
                finish(if (event.byServer) CallEnd.PEER_ENDED else CallEnd.CONNECTION_LOST, tell = true)
            }
            is CallRoom.Event.Quality -> _weakNetwork.value = event.weak
            is CallRoom.Event.AudioFocus -> onAudioFocus(event.held)
        }
    }

    /**
     * Another app took the audio (a cellular call comes in): the microphone
     * stops so the other person does not hear it, and comes back with the
     * focus unless the person muted it meanwhile.
     */
    private fun onAudioFocus(held: Boolean) {
        if (_phase.value.isOver || _onHold.value == !held) return
        _onHold.value = !held
        if (!joined || _muted.value) return
        scope.launch { room.setMicrophone(enabled = held) }
    }

    // MARK: - Controls

    /** The latest presses: a late answer from the room for an earlier press changes nothing. */
    private var micPress = 0
    private var cameraPress = 0

    fun toggleMute() {
        if (_phase.value.isOver) return
        val next = !_muted.value
        _muted.value = next
        val press = ++micPress
        if (!joined) return // Applied when the room is joined.
        scope.launch {
            val ok = room.setMicrophone(enabled = !next && !_onHold.value)
            if (press != micPress || next || _onHold.value) return@launch
            if (!ok) {
                // A microphone that would not start: shown muted, never live and silent.
                _muted.value = true
            } else {
                if (_degraded.value == CallDegradation.NO_MICROPHONE) _degraded.value = null
                // The service gains the microphone type it may not have had.
                (_phase.value as? CallPhase.Live)?.let { foreground.show(ongoing(it.since)) }
            }
        }
    }

    fun toggleCamera() {
        if (kind != CallKind.Video || _phase.value !is CallPhase.Live) return
        val next = !_cameraOn.value
        _cameraOn.value = next
        (_phase.value as? CallPhase.Live)?.let { foreground.show(ongoing(it.since)) }
        val press = ++cameraPress
        scope.launch {
            val ok = room.setCamera(enabled = next)
            if (press != cameraPress || _phase.value !is CallPhase.Live || !next) return@launch
            if (!ok) {
                _cameraOn.value = false
                (_phase.value as? CallPhase.Live)?.let { foreground.show(ongoing(it.since)) }
            } else if (_degraded.value == CallDegradation.NO_CAMERA) {
                _degraded.value = null
            }
        }
    }

    /** The other lens. A tap while the lens is still moving is ignored. */
    fun switchCamera() {
        if (kind != CallKind.Video || !_cameraOn.value || switching?.isActive == true) return
        val front = !_frontCamera.value
        switching = scope.launch { if (room.switchCamera(front)) _frontCamera.value = front }
    }

    fun toggleSpeaker() {
        if (_phase.value.isOver) return
        val next = !_speakerOn.value
        _speakerOn.value = next
        room.setSpeaker(next)
    }

    /** A route picked from the list a headset brings (Bluetooth, wired, the phone's own two). */
    fun selectRoute(route: AudioRoute) {
        if (_phase.value.isOver) return
        _speakerOn.value = route == AudioRoute.Speaker
        room.selectRoute(route)
    }

    // MARK: - The end

    /**
     * Ends the call on this phone for [end]. When [tell], the server hears it
     * as this phone's own move; otherwise it already knows, and telling it
     * again would be noise or, for a decline seen by the caller, wrong.
     */
    private fun finish(end: CallEnd, detail: String? = null, tell: Boolean) {
        if (_phase.value.isOver) return
        _phase.value = CallPhase.Ended(end, detail)
        diag.info(AREA, "ended ${Diag.id(callId)}: ${end.name.lowercase()}")
        ringback.stop()
        foreground.stop()
        callJob?.cancel()
        watcher?.cancel()
        val id = callId
        val wasAnswered = answered
        val outgoing = direction == Direction.OUTGOING
        val accept = accepting
        teardown.launch {
            room.disconnect()
            // An outgoing call still being placed has no id yet: the create
            // withdraws it as it lands (see [place]).
            if (!tell || id == null) return@launch
            runCatchingUnlessCancelled {
                when {
                    // `end` is the caller's cancel before an answer and a hang-up after it.
                    wasAnswered || outgoing -> api.end(id)
                    accept != null -> unanswer(id, accept)
                    // Never answered here: a decline, which the server ignores
                    // for a call another phone of this account answered meanwhile.
                    // An `end` would end that call.
                    else -> api.decline(id)
                }
            }.onFailure { diag.warn(AREA, "end not sent for ${Diag.id(id)}: ${it.javaClass.simpleName}") }
        }
    }

    /**
     * Ends a call this phone was answering when it ended here. The accept is
     * waited for, not abandoned, because it may already have moved the call:
     * an accept that won made this phone's call, and only an `end` ends that.
     * One that lost leaves the other phone's call alone. One that got no
     * answer at all is settled by the call as the server now has it.
     */
    private suspend fun unanswer(id: Id, accept: Deferred<Result<CallAcceptance>>) {
        val result = accept.await()
        if (result.isSuccess) {
            api.end(id)
            return
        }
        val error = result.exceptionOrNull()
        if (error is ApiError.Http) return // Refused: not this phone's call.
        val call = runCatchingUnlessCancelled { api.call(id) }.getOrNull()
        when (call?.state) {
            CallState.Ringing -> api.decline(id)
            CallState.Connecting, CallState.Active, null -> api.end(id)
            else -> Unit
        }
    }

    private fun ongoing(since: Instant? = null): OngoingCall = OngoingCall(
        callId = callId.orEmpty(),
        peerName = _peer.value.name,
        peerPhotoUrl = _peer.value.photoUrl,
        video = kind == CallKind.Video && _cameraOn.value,
        since = since,
    )

    /**
     * Lets go of everything: a call still on is hung up first (the server is
     * told), then the room and the session's work go.
     */
    fun close() {
        finish(CallEnd.HUNG_UP, tell = true)
        scope.cancel()
        room.release()
    }

    internal companion object {
        const val AREA = "Call"

        /** Read every 3 s while it rings, and only while the socket is down. */
        const val RINGING_POLL_MS = 3_000L

        /** Every 15 s once answered, and only while the socket is down. */
        const val ANSWERED_POLL_MS = 15_000L

        /** The server's ring. */
        const val RING_SECONDS = 45L

        /** How far the phone's clock may be from the server's before a ring is taken for over. */
        const val CLOCK_SKEW_MS = 15_000L

        /** Answered, and not together in the room by then: it is not going to happen. */
        const val JOIN_TIMEOUT_MS = 30_000L

        /** Reconnecting for longer than this: the call has dropped. */
        const val RECONNECT_TIMEOUT_MS = 45_000L

        /** The other person out of the room for longer than this: they are not coming back. */
        const val PEER_AWAY_TIMEOUT_MS = 30_000L

        const val TURN_MISSING = "turn_missing"

        const val EARLY_MAX = 8
    }
}
