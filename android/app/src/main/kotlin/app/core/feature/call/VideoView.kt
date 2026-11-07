package app.core.feature.call

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.viewinterop.AndroidView
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.track.VideoTrack

/**
 * One video track, drawn.
 *
 * A `TextureViewRenderer`, not a `SurfaceViewRenderer`: a SurfaceView punches
 * a hole through the window and cannot be drawn over, rounded or animated,
 * and the call screen puts one picture in a rounded card on top of the other
 * and swaps them on a tap. The renderer is initialised from the room (one
 * given another EGL context draws nothing) and released when it leaves
 * composition, because one that is not holds a texture and a decoder.
 */
@Composable
fun VideoView(track: VideoTrack?, room: LiveKitRoom, modifier: Modifier = Modifier, mirror: Boolean = false) {
    if (track == null) return
    // Keyed on the track: a new one gets a new renderer, never the old one's,
    // which would show a frozen last frame after a re-subscribe.
    key(track) {
        // Left to right whatever the app's direction, so a Persian screen
        // never adds a second flip to the one [mirror] asks for.
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
            AndroidView(
                modifier = modifier,
                factory = { context ->
                    TextureViewRenderer(context).apply {
                        room.initRenderer(this)
                        setMirror(mirror)
                        track.addRenderer(this)
                    }
                },
                update = { view -> view.setMirror(mirror) },
                onRelease = { view ->
                    track.removeRenderer(view)
                    view.release()
                },
            )
        }
    }
}
