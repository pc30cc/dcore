package app.core.feature.call

import android.media.AudioManager
import android.media.ToneGenerator

/**
 * The tone a caller hears while the other phone rings, so a call that is
 * ringing sounds like one and is not mistaken for a call that hung. Behind an
 * interface so the session that decides when it plays is tested on a JVM.
 */
interface Ringback {
    /** Plays until [stop]. Twice is once. */
    fun start()

    /** Silence, and the tone's resources handed back. Safe when not playing. */
    fun stop()
}

/** No tone (tests, previews). */
object SilentRingback : Ringback {
    override fun start() = Unit
    override fun stop() = Unit
}

/**
 * The platform's call-progress tone ([ToneGenerator.TONE_SUP_RINGTONE]) on the
 * stream the call will use: the voice-call stream for a voice call, which
 * starts on the earpiece, the media stream for a video call on the
 * loudspeaker. One generator per ring, released at [stop]: the system has few.
 * One that cannot be made leaves the ring silent, never the call failed.
 */
class ToneRingback(private val video: Boolean) : Ringback {
    private var tone: ToneGenerator? = null

    override fun start() {
        if (tone != null) return
        tone = runCatching {
            ToneGenerator(if (video) AudioManager.STREAM_MUSIC else AudioManager.STREAM_VOICE_CALL, VOLUME)
                .also { it.startTone(ToneGenerator.TONE_SUP_RINGTONE) }
        }.getOrNull()
    }

    override fun stop() {
        val playing = tone ?: return
        tone = null
        runCatching {
            playing.stopTone()
            playing.release()
        }
    }

    private companion object {
        /** Of ToneGenerator's 0-100: present, not startling. */
        const val VOLUME = 70
    }
}
