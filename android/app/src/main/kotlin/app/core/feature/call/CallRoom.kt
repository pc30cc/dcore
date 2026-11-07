package app.core.feature.call

import app.core.model.CallToken
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/**
 * The media half of a call, behind an interface.
 *
 * WebRTC's native libraries cannot load on a JVM, so a session that named
 * LiveKit types directly could not be built in a unit test. What is most worth
 * testing in a call (the waiting, the outcomes, the races between a hang-up
 * and an answer, what happens when a microphone refuses to start or the
 * network drops) is not about media at all, and this interface keeps it
 * reachable. It is also the whole surface the rest of the app has on WebRTC:
 * when the SDK's API changes, it changes behind this.
 */
interface CallRoom {

    /** What happened when the phone tried to get in. */
    sealed interface Result {
        /**
         * In. [microphone] and [camera] say what actually started: both are
         * best-effort, and a call with neither is still a call the other
         * person answered.
         */
        data class Joined(val microphone: Boolean, val camera: Boolean) : Result
        data class Failed(val reason: String) : Result
    }

    sealed interface Event {
        /** The other person arrived in the room, or left it. Anybody in it but this phone is them. */
        data class PeerPresence(val present: Boolean) : Event

        /** This phone lost the media server and the SDK is getting it back (ICE restart or a full rejoin). */
        data object Reconnecting : Event

        /** Back after [Reconnecting]: the call carries on. */
        data object Reconnected : Event

        /**
         * This phone left the room for good: the SDK gave up reconnecting, the
         * server closed the room, or the same identity joined elsewhere.
         * [byServer] is true when the server sent the phone away (room closed
         * or deleted, participant removed), false for a lost connection.
         */
        data class Disconnected(val byServer: Boolean) : Event

        /** The link to the other person is poor ([weak]) or fine again. */
        data class Quality(val weak: Boolean) : Event

        /**
         * Another app took the audio (a phone call over the cellular network,
         * an alarm) or gave it back. While [held] is false the microphone is
         * not sent: the other person must not hear the cellular call.
         */
        data class AudioFocus(val held: Boolean) : Event
    }

    val events: Flow<Event>

    /** Where the sound can go now, and where it goes ([AudioRoutes.selected]). */
    val audioRoutes: StateFlow<AudioRoutes>

    /**
     * Joins the room at [CallToken.wsUrl] with the token's TURN servers and
     * ICE policy. Cancelling the caller cancels the join and is never reported
     * as a [Result.Failed]: a call hung up while it connected ended because it
     * was hung up, not because it failed.
     */
    suspend fun connect(credentials: CallToken, wantsVideo: Boolean): Result

    /**
     * Whether the change actually happened. A microphone another app has
     * taken, or a camera that will not start, says no, and a button that went
     * on claiming otherwise would be lying about the call.
     */
    suspend fun setMicrophone(enabled: Boolean): Boolean
    suspend fun setCamera(enabled: Boolean): Boolean

    /**
     * Loudspeaker or not, as a preference: a headset (wired or Bluetooth)
     * wins either way. Said before [connect], it is where the call starts, so
     * a voice call never begins on the loudspeaker.
     */
    fun setSpeaker(on: Boolean)

    /** Sends the sound to [route], one of [AudioRoutes.available]. */
    fun selectRoute(route: AudioRoute)

    /**
     * The front camera or the back one, while the camera is on. Whether that
     * lens is the one in use once the switch has settled.
     */
    suspend fun switchCamera(front: Boolean): Boolean

    /**
     * Whether anybody but this phone is in the room right now. A participant
     * who was there before this phone joined is never announced by an event,
     * so the side that joins second asks.
     */
    val hasRemoteParticipant: Boolean

    /** Leaves the room. Safe to call twice. */
    suspend fun disconnect()

    /** Hands the microphone, the camera and the audio focus back. Safe to call twice. */
    fun release()
}

/** One place the call's sound can go. */
sealed interface AudioRoute {
    data object Earpiece : AudioRoute
    data object Speaker : AudioRoute
    data object Wired : AudioRoute

    /** A Bluetooth headset or car kit; [name] is what the phone calls it (shown only on this phone). */
    data class Bluetooth(val name: String) : AudioRoute
}

/** The routes the phone offers now, and the one in use. */
data class AudioRoutes(
    val available: List<AudioRoute> = listOf(AudioRoute.Earpiece, AudioRoute.Speaker),
    val selected: AudioRoute? = null,
) {
    /**
     * More than the two built-in ones: a headset is there, so a simple
     * speaker switch cannot say where the sound goes and the screen offers a
     * choice instead.
     */
    val hasHeadset: Boolean get() = available.any { it is AudioRoute.Bluetooth || it is AudioRoute.Wired }

    val onSpeaker: Boolean get() = selected == AudioRoute.Speaker
}
