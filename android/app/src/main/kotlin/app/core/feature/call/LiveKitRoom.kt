package app.core.feature.call

import android.content.Context
import android.media.AudioManager
import app.core.common.runCatchingUnlessCancelled
import app.core.model.CallToken
import app.core.model.IcePolicy
import com.twilio.audioswitch.AudioDevice
import io.livekit.android.AudioOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.AudioSwitchHandler
import io.livekit.android.events.DisconnectReason
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.participant.ConnectionQuality
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.TrackPublication
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import livekit.org.webrtc.Camera1Enumerator
import livekit.org.webrtc.Camera2Enumerator
import livekit.org.webrtc.CameraEnumerator
import livekit.org.webrtc.PeerConnection

/**
 * The real room, on LiveKit's SDK.
 *
 * Everything in the app that knows what WebRTC is lives in this file, but
 * for the numbers the camera is sent at ([CallVideoEncoding]) and the
 * renderer ([VideoView]).
 *
 * The audio goes through the SDK's own [AudioSwitchHandler], which owns the
 * audio focus and the audio mode: changing the route behind its back is what
 * makes an audio engine tear itself down mid-call. Bluetooth headsets are
 * offered only when `BLUETOOTH_CONNECT` was granted (Android 12 and later);
 * the call screen asks for it with the microphone.
 */
class LiveKitRoom(private val context: Context) : CallRoom {

    private val _events = MutableSharedFlow<CallRoom.Event>(extraBufferCapacity = 16)
    override val events: Flow<CallRoom.Event> = _events.asSharedFlow()

    /**
     * The two pictures, held here rather than read out of the room whenever
     * a view redraws. `Room` is not a Compose state holder: a composable that
     * read `room.remoteParticipants` would only see what was true the last
     * time something else invalidated it. Kept in flows and refreshed from
     * the room's own events, the picture arrives when it arrives.
     */
    private val _remoteVideo = MutableStateFlow<VideoTrack?>(null)
    val remoteVideo: StateFlow<VideoTrack?> = _remoteVideo.asStateFlow()

    private val _localVideo = MutableStateFlow<VideoTrack?>(null)
    val localVideo: StateFlow<VideoTrack?> = _localVideo.asStateFlow()

    private val _audioRoutes = MutableStateFlow(AudioRoutes())
    override val audioRoutes: StateFlow<AudioRoutes> = _audioRoutes.asStateFlow()

    private var room: Room? = null
    private var listening: Job? = null

    /** Where the sound goes, as last asked ([setSpeaker]), before the room exists too. */
    private var speaker = false

    /** The last quality seen for this phone's link and the other person's. */
    private var localWeak = false
    private var remoteWeak = false

    /**
     * On the main thread, like every other caller of [refreshTracks]: with
     * the room's events collected on a pool thread, whichever wrote last
     * would win, sometimes with the older answer.
     */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val audio = AudioSwitchHandler(context.applicationContext)

    private val deviceListener: (List<AudioDevice>, AudioDevice?) -> Unit = { devices, selected ->
        _audioRoutes.value = AudioRoutes(
            available = devices.mapNotNull(::routeOf).distinct().ifEmpty { listOf(AudioRoute.Earpiece, AudioRoute.Speaker) },
            selected = selected?.let(::routeOf),
        )
    }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        val held = when (change) {
            AudioManager.AUDIOFOCUS_GAIN,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK,
            // A notification sound ducking the call is not another call.
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK,
            -> true
            else -> false
        }
        _events.tryEmit(CallRoom.Event.AudioFocus(held))
    }

    init {
        audio.registerAudioDeviceChangeListener(deviceListener)
        audio.registerOnAudioFocusChangeListener(focusListener)
    }

    /**
     * Hands a renderer the room's EGL context. A renderer initialised against
     * another EGL context draws nothing and says nothing about why.
     */
    fun initRenderer(view: TextureViewRenderer) {
        room?.initVideoRenderer(view)
    }

    override suspend fun connect(credentials: CallToken, wantsVideo: Boolean): CallRoom.Result {
        val room = LiveKit.create(
            appContext = context.applicationContext,
            options = RoomOptions(
                adaptiveStream = true,
                dynacast = true,
                // The capture and the layers the camera is sent at, as room
                // defaults: the camera is published by `setCameraEnabled`,
                // which takes no options.
                videoTrackCaptureDefaults = CallVideoEncoding.captureDefaults,
                videoTrackPublishDefaults = CallVideoEncoding.publishDefaults,
            ),
            overrides = LiveKitOverrides(audioOptions = AudioOptions(audioHandler = audio)),
        )
        this.room = room
        audio.preferredDeviceList = if (speaker) SPEAKER_FIRST else EARPIECE_FIRST
        listening = scope.launch { listen(room) }

        try {
            room.connect(url = credentials.wsUrl, token = credentials.token, options = connectOptions(credentials))
        } catch (e: CancellationException) {
            // Hung up while connecting: not a failure, and reporting it as one
            // would turn "Call ended" into "Couldn't connect".
            throw e
        } catch (e: Throwable) {
            return CallRoom.Result.Failed(e.javaClass.simpleName)
        }
        // A join can finish without looking at cancellation. Checked before
        // anything is published, so a call hung up mid-connect never turns
        // the microphone on for a moment afterwards.
        currentCoroutineContext().ensureActive()

        // Each on its own: a refused camera must not take the microphone with it.
        val micOk = runCatchingUnlessCancelled { room.localParticipant.setMicrophoneEnabled(true) }.getOrDefault(false)
        val cameraOk = wantsVideo &&
            runCatchingUnlessCancelled { room.localParticipant.setCameraEnabled(true) }.getOrDefault(false)

        withContext(Dispatchers.Main.immediate) { refreshTracks(room) }
        return CallRoom.Result.Joined(microphone = micOk, camera = cameraOk)
    }

    /**
     * The server's TURN relay (when the token carries one) and its ICE
     * policy.
     *
     * Always a configuration of our own, never null: the SDK reads
     * `ConnectOptions.iceServers` only while merging them into an
     * `rtcConfig` it is given; without one it builds its own from the media
     * server's list alone and the relay is dropped. With no relay the list is
     * empty and the SDK uses only the servers the media server sent.
     */
    private fun connectOptions(credentials: CallToken): ConnectOptions {
        val turn = credentials.turn
        val iceServers = turn?.urls?.filter { it.isNotBlank() }?.takeIf { it.isNotEmpty() }?.let { urls ->
            listOf(
                PeerConnection.IceServer.builder(urls)
                    .setUsername(turn.username)
                    .setPassword(turn.credential)
                    .createIceServer(),
            )
        }
        val rtcConfig = PeerConnection.RTCConfiguration(iceServers.orEmpty()).apply {
            // Relay-only when the server says so: offering host candidates
            // first on a network that only lets the relay through only makes
            // the call slower to fail.
            if (credentials.icePolicy == IcePolicy.Relay) iceTransportsType = PeerConnection.IceTransportsType.RELAY
        }
        return ConnectOptions(iceServers = iceServers, rtcConfig = rtcConfig)
    }

    private suspend fun listen(room: Room) {
        room.events.collect { event ->
            when (event) {
                // `TrackPublished` and `TrackUnpublished` carry a plain
                // `Participant`, so they cover this phone's tracks too.
                is RoomEvent.TrackSubscribed,
                is RoomEvent.TrackUnsubscribed,
                is RoomEvent.TrackPublished,
                is RoomEvent.TrackUnpublished,
                is RoomEvent.LocalTrackSubscribed,
                is RoomEvent.TrackMuted,
                is RoomEvent.TrackUnmuted,
                -> refreshTracks(room)

                is RoomEvent.ParticipantConnected -> {
                    refreshTracks(room)
                    _events.tryEmit(CallRoom.Event.PeerPresence(present = true))
                }

                is RoomEvent.ParticipantDisconnected -> {
                    refreshTracks(room)
                    remoteWeak = false
                    _events.tryEmit(CallRoom.Event.PeerPresence(present = room.remoteParticipants.isNotEmpty()))
                }

                is RoomEvent.Reconnecting -> _events.tryEmit(CallRoom.Event.Reconnecting)
                is RoomEvent.Reconnected -> {
                    refreshTracks(room)
                    _events.tryEmit(CallRoom.Event.Reconnected)
                }

                is RoomEvent.ConnectionQualityChanged -> {
                    val weak = event.quality == ConnectionQuality.POOR || event.quality == ConnectionQuality.LOST
                    val before = localWeak || remoteWeak
                    if (event.participant == room.localParticipant) localWeak = weak else remoteWeak = weak
                    val now = localWeak || remoteWeak
                    if (now != before) _events.tryEmit(CallRoom.Event.Quality(now))
                }

                is RoomEvent.Disconnected -> {
                    clearTracks()
                    // Our own leave is not news.
                    if (event.reason != DisconnectReason.CLIENT_INITIATED) {
                        _events.tryEmit(CallRoom.Event.Disconnected(byServer = event.reason in SENT_AWAY))
                    }
                }

                else -> Unit
            }
        }
    }

    /**
     * Reads the pictures out of the room as they stand now, from
     * `trackPublications` (the map itself), not `videoTrackPublications`,
     * which is derived on the SDK's own dispatcher and can still describe the
     * room from before the event that asked for this refresh. Main thread only.
     */
    private fun refreshTracks(room: Room) {
        _remoteVideo.value = room.remoteParticipants.values
            .asSequence()
            .flatMap { it.trackPublications.values.asSequence() }
            .firstNotNullOfOrNull { it.liveVideo() }
        _localVideo.value = room.localParticipant.getTrackPublication(Track.Source.CAMERA)?.liveVideo()
    }

    /**
     * The picture a publication is actually sending: video, subscribed, not
     * muted. A muted camera keeps its track, and drawing it would show the
     * other person frozen on the last frame before they turned it off.
     */
    private fun TrackPublication.liveVideo(): VideoTrack? =
        if (kind == Track.Kind.VIDEO && !muted) track as? VideoTrack else null

    /** Nothing to draw once the room is gone: a track outlives its room as an object, not as a picture. */
    private fun clearTracks() {
        _remoteVideo.value = null
        _localVideo.value = null
    }

    override suspend fun setMicrophone(enabled: Boolean): Boolean {
        val room = room ?: return false
        return runCatchingUnlessCancelled { room.localParticipant.setMicrophoneEnabled(enabled) }.getOrDefault(false)
    }

    override suspend fun setCamera(enabled: Boolean): Boolean {
        val room = room ?: return false
        val ok = runCatchingUnlessCancelled { room.localParticipant.setCameraEnabled(enabled) }.getOrDefault(false)
        withContext(Dispatchers.Main.immediate) { refreshTracks(room) }
        return ok
    }

    /**
     * As a preference order, not a device: the handler re-picks from it, so a
     * headset plugged in later still takes the sound.
     */
    override fun setSpeaker(on: Boolean) {
        speaker = on
        audio.preferredDeviceList = if (on) SPEAKER_FIRST else EARPIECE_FIRST
    }

    /** A device chosen by hand from the route list (a headset is there): that device, until the next choice. */
    override fun selectRoute(route: AudioRoute) {
        val device = audio.availableAudioDevices.firstOrNull { routeOf(it) == route } ?: return
        speaker = route == AudioRoute.Speaker
        runCatching { audio.selectDevice(device) }
    }

    /**
     * Through the camera track itself, which restarts its capturer on the
     * other lens; the publication and the picture the other person sees stay
     * the same track. The SDK's switch says nothing back, so the lens is looked
     * for first and the switch is read back from the track's options.
     */
    override suspend fun switchCamera(front: Boolean): Boolean {
        val room = room ?: return false
        val track = room.localParticipant.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack ?: return false
        val target = if (front) CameraPosition.FRONT else CameraPosition.BACK
        if (track.options.position == target) return true
        if (!hasCamera(front)) return false
        runCatchingUnlessCancelled { track.switchCamera(position = target) }.getOrElse { return false }
        return withTimeoutOrNull(CAMERA_SWITCH_MS) {
            while (track.options.position != target) delay(CAMERA_SWITCH_POLL_MS)
            true
        } ?: false
    }

    private fun hasCamera(front: Boolean): Boolean = runCatching {
        val cameras: CameraEnumerator =
            if (Camera2Enumerator.isSupported(context)) Camera2Enumerator(context) else Camera1Enumerator(true)
        cameras.deviceNames.any { if (front) cameras.isFrontFacing(it) else cameras.isBackFacing(it) }
    }.getOrDefault(false)

    override val hasRemoteParticipant: Boolean
        get() = room?.remoteParticipants?.isNotEmpty() == true

    override suspend fun disconnect() {
        room?.disconnect()
        clearTracks()
    }

    override fun release() {
        listening?.cancel()
        listening = null
        clearTracks()
        audio.unregisterAudioDeviceChangeListener(deviceListener)
        audio.unregisterOnAudioFocusChangeListener(focusListener)
        room?.release()
        room = null
        scope.cancel()
    }

    private companion object {
        /** Long enough for a capturer to restart on the other lens and send its first picture. */
        const val CAMERA_SWITCH_MS = 3_000L
        const val CAMERA_SWITCH_POLL_MS = 50L

        /** The server ended this phone's place in the room; anything else is a lost connection. */
        val SENT_AWAY = setOf(
            DisconnectReason.ROOM_DELETED,
            DisconnectReason.ROOM_CLOSED,
            DisconnectReason.PARTICIPANT_REMOVED,
            DisconnectReason.DUPLICATE_IDENTITY,
            DisconnectReason.SERVER_SHUTDOWN,
        )

        // A headset wins either way: somebody who plugged one in, or paired
        // one, has said where they want the sound.
        val SPEAKER_FIRST = listOf(
            AudioDevice.BluetoothHeadset::class.java,
            AudioDevice.WiredHeadset::class.java,
            AudioDevice.Speakerphone::class.java,
            AudioDevice.Earpiece::class.java,
        )
        val EARPIECE_FIRST = listOf(
            AudioDevice.BluetoothHeadset::class.java,
            AudioDevice.WiredHeadset::class.java,
            AudioDevice.Earpiece::class.java,
            AudioDevice.Speakerphone::class.java,
        )

        fun routeOf(device: AudioDevice): AudioRoute? = when (device) {
            is AudioDevice.Earpiece -> AudioRoute.Earpiece
            is AudioDevice.Speakerphone -> AudioRoute.Speaker
            is AudioDevice.WiredHeadset -> AudioRoute.Wired
            is AudioDevice.BluetoothHeadset -> AudioRoute.Bluetooth(device.name)
            else -> null
        }
    }
}
