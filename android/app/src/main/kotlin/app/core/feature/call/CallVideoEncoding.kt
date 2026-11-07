package app.core.feature.call

import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.CustomVideoPreset
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoCodec
import io.livekit.android.room.track.VideoEncoding

/**
 * What a call's camera captures and what it sends: one 720p picture at about
 * 1 Mbps, and two small copies for a receiver that draws it small.
 *
 * At the SDK's defaults a 720p capture uploads about 2.3 Mbps across its three
 * layers, and receiving the other side's 720p layer costs about 2 Mbps more:
 * enough to saturate a weak mobile link until signalling times out and the
 * call drops. These caps roughly halve it. Every call gets them: [LiveKitRoom]
 * is the only place a room is built. Bitrates are bits per second and rates
 * frames per second, as [VideoEncoding] takes them.
 */
internal object CallVideoEncoding {

    // 1280×720 at 30 fps, the SDK's own 720p capture. WebRTC drops it to the
    // layers' 24 fps before encoding, so asking the camera for 24 would save
    // no bandwidth and would change the frame-rate range each camera picks.
    const val CAPTURE_WIDTH = 1280
    const val CAPTURE_HEIGHT = 720
    const val CAPTURE_FPS = 30

    // The picture shown full screen: still 720p, at 1 Mbps and 24 fps instead
    // of the SDK's 1.7 Mbps at 30. Most of the saving is here.
    const val TOP_MAX_BITRATE_BPS = 1_000_000
    const val TOP_MAX_FPS = 24

    // The copies a receiver takes when it draws the picture small or its link
    // is poor, each under the SDK's own (160 kbps at 15, 450 kbps at 30). A
    // quarter and a half of the capture exactly: the SDK scales a layer down
    // by the capture's long side over the layer's.
    const val LOW_WIDTH = 320
    const val LOW_HEIGHT = 180
    const val LOW_MAX_BITRATE_BPS = 120_000
    const val LOW_MAX_FPS = 15

    const val MID_WIDTH = 640
    const val MID_HEIGHT = 360
    const val MID_MAX_BITRATE_BPS = 400_000
    const val MID_MAX_FPS = 20

    /** The front camera, which every call opens on, at the capture above. */
    val captureDefaults = LocalVideoTrackOptions(
        position = CameraPosition.FRONT,
        captureParams = VideoCaptureParameter(width = CAPTURE_WIDTH, height = CAPTURE_HEIGHT, maxFps = CAPTURE_FPS),
    )

    /** The camera's encodings, as the room's defaults, so `setCameraEnabled(true)` uses them unasked. */
    val publishDefaults = VideoTrackPublishDefaults(
        videoEncoding = VideoEncoding(maxBitrate = TOP_MAX_BITRATE_BPS, maxFps = TOP_MAX_FPS),
        // With adaptive stream a receiver drawing the picture small takes a
        // small layer, and dynacast stops the layers nobody takes.
        simulcast = true,
        // VP8: simulcast is what saves the bandwidth; an SVC codec would add a
        // backup codec, a second encoder to pay for.
        videoCodec = VideoCodec.VP8.codecName,
        // Smallest first, like the SDK's own list. Named here, or the SDK
        // adds its defaults under the top layer.
        simulcastLayers = listOf(
            CustomVideoPreset(
                capture = VideoCaptureParameter(width = LOW_WIDTH, height = LOW_HEIGHT, maxFps = LOW_MAX_FPS),
                encoding = VideoEncoding(maxBitrate = LOW_MAX_BITRATE_BPS, maxFps = LOW_MAX_FPS),
            ),
            CustomVideoPreset(
                capture = VideoCaptureParameter(width = MID_WIDTH, height = MID_HEIGHT, maxFps = MID_MAX_FPS),
                encoding = VideoEncoding(maxBitrate = MID_MAX_BITRATE_BPS, maxFps = MID_MAX_FPS),
            ),
        ),
    )
}
