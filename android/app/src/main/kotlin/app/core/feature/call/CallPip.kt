package app.core.feature.call

import android.os.Handler
import android.os.Looper
import android.util.Rational
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.i18n.brandString
import app.core.ui.theme.Space
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.delay
import java.time.Instant
import kotlin.math.roundToInt

/**
 * The call in the system's picture-in-picture window while the person is in
 * another app: the other person's picture edge to edge; with their camera off,
 * their face and the timer. Nothing else: the window is small, and its two
 * buttons (mute, end) are the system's ([CallPictureInPicture]).
 */
@Composable
fun PipCallView(state: CallScreenState, room: LiveKitRoom?, remoteVideo: VideoTrack?, modifier: Modifier = Modifier) {
    val picture = remoteVideo?.takeIf { room != null }
    Box(modifier.fillMaxSize().testTag(CallTags.PIP), contentAlignment = Alignment.Center) {
        CallBackdrop(glowAt = 0.38f)
        if (picture != null && room != null) {
            VideoView(picture, room, Modifier.fillMaxSize())
        } else {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs), modifier = Modifier.padding(Space.sm)) {
                CallFace(state.peer.photoUrl, state.peer.blurhash, size = 52.dp)
                Text(state.peer.name, style = MaterialTheme.typography.labelLarge, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                CallClock(state.phase, color = Color.White.copy(alpha = 0.78f))
            }
        }
        if (state.muted) MutedBadge(Modifier.align(Alignment.BottomStart).padding(Space.sm))
    }
}

/**
 * The call, small, over the rest of the app while its screen is minimised:
 * a card with the other person's picture (or their face) and the timer, which
 * can be dragged anywhere and tapped to bring the call back.
 */
@Composable
fun FloatingCallBubble(state: CallScreenState, room: LiveKitRoom?, remoteVideo: VideoTrack?, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val picture = remoteVideo?.takeIf { state.video && state.phase is CallPhase.Live && room != null }
    val width = if (picture != null) 112.dp else 96.dp
    val height = if (picture != null) 152.dp else 124.dp
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    // Screen coordinates, left to right in every language: a drag's x is the
    // finger's, so the offset must be too.
    BoxWithConstraints(modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(Space.md), contentAlignment = AbsoluteAlignment.TopLeft) {
        val density = LocalDensity.current
        val maxX = with(density) { (maxWidth - width).toPx().coerceAtLeast(0f) }
        val maxY = with(density) { (maxHeight - height).toPx().coerceAtLeast(0f) }
        // Starts at the top on the end side, out of the way of a list's first
        // rows and the back arrow; stays where it is dropped.
        var x by remember { mutableFloatStateOf(Float.NaN) }
        var y by remember { mutableFloatStateOf(with(density) { 56.dp.toPx() }) }
        if (x.isNaN()) x = if (rtl) 0f else maxX
        val label = brandString(R.string.call_bubble_return, app.core.feature.card.isolate(state.peer.name))
        val shape = RoundedCornerShape(20.dp)
        Surface(
            shape = shape,
            color = CALL_BACKGROUND,
            contentColor = Color.White,
            onClick = onOpen,
            modifier = Modifier
                .absoluteOffset { IntOffset(x.coerceIn(0f, maxX).roundToInt(), y.coerceIn(0f, maxY).roundToInt()) }
                .size(width, height)
                .shadow(12.dp, shape)
                .pointerInput(maxX, maxY) {
                    detectDragGestures { change, drag ->
                        change.consume()
                        x = (x + drag.x).coerceIn(0f, maxX)
                        y = (y + drag.y).coerceIn(0f, maxY)
                    }
                }
                .border(1.dp, Color.White.copy(alpha = 0.2f), shape)
                .semantics { contentDescription = label }
                .testTag(CallTags.BUBBLE),
        ) {
            Box(contentAlignment = Alignment.Center) {
                CallBackdrop(glowAt = 0.4f)
                if (picture != null && room != null) {
                    VideoView(picture, room, Modifier.fillMaxSize().clip(shape))
                    Box(Modifier.fillMaxSize().padding(bottom = Space.xs), contentAlignment = Alignment.BottomCenter) {
                        CallClock(state.phase, color = Color.White)
                    }
                } else {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                        CallHalo(ringing = state.phase !is CallPhase.Live, faceSize = 44.dp) {
                            CallFace(state.peer.photoUrl, state.peer.blurhash, size = 44.dp)
                        }
                        CallClock(state.phase, color = Color.White.copy(alpha = 0.88f))
                    }
                }
                if (state.muted) MutedBadge(Modifier.align(Alignment.TopStart).padding(Space.xs))
            }
        }
    }
}

/** The timer once both are on the line; the phase's own word before and after. */
@Composable
internal fun CallClock(phase: CallPhase, color: Color) {
    val language = rememberLanguage()
    val text = when (phase) {
        is CallPhase.Live -> when {
            phase.reconnecting -> brandString(R.string.call_status_reconnecting)
            else -> {
                var now by remember { mutableStateOf(Instant.now()) }
                LaunchedEffect(phase.since) {
                    while (true) {
                        now = Instant.now()
                        delay(1_000)
                    }
                }
                callDuration((now.toEpochMilli() - phase.since.toEpochMilli()) / 1000, language)
            }
        }
        CallPhase.Connecting -> brandString(R.string.call_status_connecting)
        CallPhase.Ringing -> brandString(R.string.call_status_ringing)
        CallPhase.Placing -> brandString(R.string.call_status_calling)
        is CallPhase.Ended -> brandString(R.string.call_end_ended)
    }
    Text(
        text,
        style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
        color = color,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
    )
}

@Composable
private fun MutedBadge(modifier: Modifier = Modifier) {
    Surface(color = CALL_END_RED, shape = CircleShape, modifier = modifier.size(22.dp).border(1.dp, Color.White.copy(alpha = 0.3f), CircleShape)) {
        Box(contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_call_mic_off), contentDescription = brandString(R.string.call_action_unmute), tint = Color.White, modifier = Modifier.size(14.dp))
        }
    }
}

/**
 * The shape of the picture [track] carries, for the picture-in-picture
 * window: null until a frame arrives. Read from the frames by a sink that
 * keeps nothing of them.
 */
@Composable
fun rememberVideoAspect(track: VideoTrack?): Rational? {
    var aspect by remember(track) { mutableStateOf<Rational?>(null) }
    DisposableEffect(track) {
        if (track == null) return@DisposableEffect onDispose { }
        val main = Handler(Looper.getMainLooper())
        var lastWidth = 0
        var lastHeight = 0
        val sink = livekit.org.webrtc.VideoSink { frame ->
            val w = frame.rotatedWidth
            val h = frame.rotatedHeight
            if (w > 0 && h > 0 && (w != lastWidth || h != lastHeight)) {
                lastWidth = w
                lastHeight = h
                main.post { aspect = pipAspect(w, h) }
            }
        }
        track.addRenderer(sink)
        onDispose {
            track.removeRenderer(sink)
            main.removeCallbacksAndMessages(null)
        }
    }
    return aspect
}

/** [width] by [height] as the system's picture-in-picture accepts it: between 1:2.39 and 2.39:1. */
fun pipAspect(width: Int, height: Int): Rational {
    if (width <= 0 || height <= 0) return VOICE_PIP_ASPECT
    val ratio = (width.toDouble() / height).coerceIn(PIP_MIN_RATIO, PIP_MAX_RATIO)
    return Rational((ratio * 1000).roundToInt(), 1000)
}

/** A face, a name and a timer: a little taller than wide. */
val VOICE_PIP_ASPECT = Rational(3, 4)

private const val PIP_MIN_RATIO = 1 / 2.38
private const val PIP_MAX_RATIO = 2.38
