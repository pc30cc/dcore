package app.core.feature.call

import app.core.model.CallToken
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * A room for the debug build's sample backend: no media server, no WebRTC,
 * no sound. It "joins" after a short wait and the other person "arrives" a
 * moment later, so a call placed against the sample walks through every
 * phase. Debug only ([CallRooms]); calls cannot connect for real without a
 * media server.
 */
class SimulatedCallRoom(
    private val joinDelayMs: Long = 600,
    private val peerDelayMs: Long = 900,
) : CallRoom {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val _events = MutableSharedFlow<CallRoom.Event>(extraBufferCapacity = 16)
    override val events: Flow<CallRoom.Event> = _events.asSharedFlow()

    private val _audioRoutes = MutableStateFlow(AudioRoutes(selected = AudioRoute.Earpiece))
    override val audioRoutes: StateFlow<AudioRoutes> = _audioRoutes.asStateFlow()

    private var joined = false
    private var peer = false
    private var arriving: Job? = null

    override suspend fun connect(credentials: CallToken, wantsVideo: Boolean): CallRoom.Result {
        delay(joinDelayMs)
        joined = true
        arriving = scope.launch {
            delay(peerDelayMs)
            peer = true
            _events.tryEmit(CallRoom.Event.PeerPresence(present = true))
        }
        return CallRoom.Result.Joined(microphone = true, camera = wantsVideo)
    }

    override suspend fun setMicrophone(enabled: Boolean): Boolean = joined
    override suspend fun setCamera(enabled: Boolean): Boolean = joined

    override fun setSpeaker(on: Boolean) {
        _audioRoutes.value = _audioRoutes.value.copy(selected = if (on) AudioRoute.Speaker else AudioRoute.Earpiece)
    }

    override fun selectRoute(route: AudioRoute) {
        _audioRoutes.value = _audioRoutes.value.copy(selected = route)
    }

    override suspend fun switchCamera(front: Boolean): Boolean = joined

    override val hasRemoteParticipant: Boolean get() = peer

    override suspend fun disconnect() {
        arriving?.cancel()
        joined = false
        peer = false
    }

    override fun release() {
        scope.cancel()
    }
}
