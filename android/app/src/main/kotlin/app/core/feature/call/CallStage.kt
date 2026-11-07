package app.core.feature.call

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import io.livekit.android.room.track.VideoTrack

/** One picture on a video call, and whether it is drawn as a mirror. */
internal data class StagePicture<T : Any>(val track: T, val mirror: Boolean)

/**
 * What a video call's two pictures are doing: which one fills the screen, and
 * what the card floating over it ([SelfView]) shows.
 *
 * Normally the other person's picture fills the screen and this phone's own
 * floats in the card; a tap on the card swaps them, another swaps them back.
 * Each picture keeps its own mirror wherever it is drawn. There is no card,
 * and nothing to swap, while this phone's camera gives no picture. Generic in
 * the track so the rule is tested without a media track.
 */
internal data class CallStage<T : Any>(
    val big: StagePicture<T>?,
    val hasCard: Boolean,
    /** In the card; null there (swapped, their camera off) is their face on a dark tile. */
    val small: StagePicture<T>?,
    val swapped: Boolean,
) {
    companion object {
        fun <T : Any> of(remote: T?, remoteMirror: Boolean, own: T?, ownMirror: Boolean, swapped: Boolean): CallStage<T> {
            val theirs = remote?.let { StagePicture(it, remoteMirror) }
            val mine = own?.let { StagePicture(it, ownMirror) } ?: return CallStage(theirs, hasCard = false, small = null, swapped = false)
            return if (swapped) CallStage(big = mine, hasCard = true, small = theirs, swapped = true)
            else CallStage(big = theirs, hasCard = true, small = mine, swapped = false)
        }
    }
}

/**
 * Whether the pictures are swapped, remembered against this phone's own
 * picture so the swap does not outlive it: the camera going off ends it, and
 * the picture that comes back starts in the card. Switching lens keeps the
 * same track, and the swap with it.
 */
@Composable
internal fun rememberStageSwap(own: Any?): MutableState<Boolean> = remember(own) { mutableStateOf(false) }

/** What the card shows: a picture, or (swapped, their camera off) their face on a dark tile. */
@Composable
internal fun StageCardContent(picture: StagePicture<VideoTrack>?, room: LiveKitRoom, face: @Composable (size: Dp) -> Unit) {
    if (picture != null) {
        VideoView(picture.track, room, Modifier.fillMaxSize(), mirror = picture.mirror)
    } else {
        BoxWithConstraints(Modifier.fillMaxSize().background(CALL_TILE), contentAlignment = Alignment.Center) {
            face(maxWidth * 0.56f)
        }
    }
}
