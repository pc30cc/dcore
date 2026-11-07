package app.core.feature.call

import androidx.annotation.DrawableRes
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.i18n.brandString
import app.core.media.BlurHashImage
import app.core.media.ImageLoading
import app.core.media.LocalRemoteImages
import app.core.ui.theme.BrandColors
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Space
import coil3.compose.AsyncImage

/*
 * The visual language every call surface shares: the full screen, the
 * bubble over the app and the picture-in-picture window. Opaque, always, on
 * the call's own dark backdrop in both themes, so nothing behind a call (a
 * chat, the lock screen's wallpaper) ever shows through it.
 */

/** The call's own near-black. Opaque. */
internal val CALL_BACKGROUND = Color(0xFF0B0A0D)

/** The bottom of the backdrop. Opaque. */
private val CALL_BACKDROP_BOTTOM = Color(0xFF050407)

/** The card behind a picture that has not arrived, a step up from the backdrop. */
internal val CALL_TILE = Color(0xFF1E1B21)

/** Ending a call, answering one, closing a finished one. Each passes 3:1 against white text and the backdrop. */
internal val CALL_END_RED = Color(0xFFD93025)
internal val CALL_ANSWER_GREEN = Color(0xFF128A4A)
internal val CALL_DONE_GREY = Color(0xFF3A3640)

/**
 * The backdrop: the brand's dark tone deepened nearly to black at the top,
 * black at the bottom, with a soft glow of the brand colour where the face is.
 */
@Composable
internal fun CallBackdrop(modifier: Modifier = Modifier, glowAt: Float = 0.32f) {
    val brand = BrandColors.Build.brandDark
    val top = remember(brand) { lerp(brand, Color.Black, 0.70f) }
    val middle = remember(brand) { lerp(brand, CALL_BACKGROUND, 0.88f) }
    Box(
        modifier
            .fillMaxSize()
            .background(CALL_BACKGROUND)
            .background(Brush.verticalGradient(listOf(top, middle, CALL_BACKDROP_BOTTOM)))
            .drawBehind {
                val center = Offset(size.width / 2f, size.height * glowAt)
                val radius = size.minDimension * 0.75f
                drawCircle(
                    brush = Brush.radialGradient(listOf(brand.copy(alpha = 0.22f), Color.Transparent), center = center, radius = radius),
                    radius = radius,
                    center = center,
                )
            },
    )
}

/** Over a picture that fills the screen: the top and bottom darkened, so the name and the buttons stay legible. */
@Composable
internal fun VideoScrims(modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    0f to Color.Black.copy(alpha = 0.55f),
                    0.22f to Color.Transparent,
                    0.62f to Color.Transparent,
                    1f to Color.Black.copy(alpha = 0.72f),
                ),
            ),
    )
}

/** Below this height (a phone on its side) a call screen leaves the face out. */
internal val COMPACT_CALL_HEIGHT = 480.dp

internal fun callFaceSize(maxHeight: Dp, incoming: Boolean): Dp = when {
    maxHeight < 560.dp -> 88.dp
    maxHeight < 700.dp -> if (incoming) 120.dp else 108.dp
    else -> if (incoming) 152.dp else 132.dp
}

/**
 * The match's face: their photo, or a person silhouette on a quiet circle.
 * Never a letter. Photos load through the app's own image cache.
 */
@Composable
internal fun CallFace(photoUrl: String?, blurhash: String?, size: Dp, modifier: Modifier = Modifier) {
    val remote = LocalRemoteImages.current && !LocalInspectionMode.current
    val context = LocalContext.current
    Box(
        modifier
            .size(size)
            .clip(CircleShape)
            .background(CALL_TILE),
        contentAlignment = Alignment.Center,
    ) {
        if (blurhash != null) BlurHashImage(blurhash, Modifier.fillMaxSize())
        if (photoUrl == null || !remote) {
            if (blurhash == null) {
                Icon(Icons.Filled.Person, contentDescription = null, tint = Color.White.copy(alpha = 0.72f), modifier = Modifier.size(size * 0.6f))
            }
        } else {
            val request = remember(photoUrl) { ImageLoading.request(context, photoUrl) }
            AsyncImage(
                model = request,
                contentDescription = null,
                imageLoader = ImageLoading.loader(context),
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

/**
 * The face with the ring around it: while the call rings, soft circles in the
 * brand colour grow out of the photo and fade, the pulse of a ringing phone;
 * once answered one quiet ring stays. "Remove animations" leaves it still.
 */
@Composable
internal fun CallHalo(ringing: Boolean, faceSize: Dp, face: @Composable () -> Unit) {
    val still = LocalReducedMotion.current
    val pulse = if (ringing && !still) {
        val loop = rememberInfiniteTransition(label = "ring")
        val value by loop.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(PULSE_MS, easing = LinearEasing), RepeatMode.Restart),
            label = "ring.pulse",
        )
        value
    } else {
        -1f
    }
    val brand = BrandColors.Build.brandDark
    val spread = faceSize * 0.42f
    Box(
        Modifier
            .size(faceSize + spread * 2)
            .drawBehind {
                val base = faceSize.toPx() / 2f
                val reach = spread.toPx()
                if (pulse >= 0f) {
                    for (i in 0 until PULSE_RINGS) {
                        val p = (pulse + i.toFloat() / PULSE_RINGS) % 1f
                        drawCircle(color = brand.copy(alpha = (1f - p) * 0.34f), radius = base + reach * p)
                    }
                } else {
                    drawCircle(color = Color.White.copy(alpha = if (ringing) 0.16f else 0.08f), radius = base + reach * 0.22f)
                }
                drawCircle(color = Color.White.copy(alpha = 0.22f), radius = base + 1.5.dp.toPx(), style = Stroke(width = 1.5.dp.toPx()))
            },
        contentAlignment = Alignment.Center,
    ) {
        face()
    }
}

private const val PULSE_MS = 2_400
private const val PULSE_RINGS = 3

/**
 * One round button under the call, with its name under it.
 *
 * [on] is the lit state (white for a toggle) and [tint] a fixed colour for
 * the buttons that end, answer or close a call. The two states of a toggle are
 * two shapes, round at rest and a rounded square switched on, so the state
 * does not rest on colour alone. A disabled button keeps its shape and loses
 * its contrast. TalkBack hears [label] once, with the toggle's state.
 */
@Composable
internal fun CallButton(
    @DrawableRes icon: Int,
    label: String,
    tag: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    on: Boolean = false,
    toggle: Boolean = false,
    enabled: Boolean = true,
    tint: Color? = null,
    caption: String = label,
    diameter: Dp = TOGGLE_SIZE,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val still = LocalReducedMotion.current
    val corner by animateFloatAsState(
        targetValue = when {
            pressed -> 30f
            on && tint == null -> 32f
            else -> 50f
        },
        animationSpec = if (still) tween(0) else spring(),
        label = "callButtonShape",
    )
    val scale by animateFloatAsState(if (pressed && !still) 0.92f else 1f, label = "callButtonScale")
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.sm),
        modifier = modifier.widthIn(min = diameter, max = diameter + 32.dp),
    ) {
        Surface(
            color = when {
                !enabled -> Color.White.copy(alpha = 0.08f)
                tint != null -> tint
                on -> Color.White
                else -> Color.White.copy(alpha = 0.16f)
            },
            contentColor = when {
                !enabled -> Color.White.copy(alpha = 0.38f)
                tint != null -> Color.White
                on -> CALL_BACKGROUND
                else -> Color.White
            },
            shape = RoundedCornerShape(percent = corner.toInt()),
            enabled = enabled,
            onClick = onClick,
            interactionSource = interaction,
            modifier = Modifier
                // Never squeezed: the header gives way first.
                .requiredSize(diameter)
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                }
                .semantics {
                    role = if (toggle) Role.Switch else Role.Button
                    if (toggle) selected = on
                }
                .testTag(tag),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(painterResource(icon), contentDescription = label, modifier = Modifier.size(diameter * 0.42f))
            }
        }
        Text(
            caption,
            style = MaterialTheme.typography.labelMedium,
            color = Color.White.copy(alpha = if (enabled) 0.88f else 0.45f),
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().clearAndSetSemantics {},
        )
    }
}

internal val TOGGLE_SIZE = 64.dp
internal val PRIMARY_SIZE = 76.dp

/**
 * The buttons of a call ringing this phone: Decline on the left, Answer on
 * the right in every language (the platform's own incoming-call layout, so a
 * thumb never meets the other button in Persian), and between them, on a
 * video call, "voice only". Answer breathes gently, as a ringing phone's does.
 */
@Composable
internal fun IncomingCallButtons(
    video: Boolean,
    onDecline: () -> Unit,
    onAnswer: () -> Unit,
    onAnswerVoiceOnly: (() -> Unit)?,
) {
    val still = LocalReducedMotion.current
    val breath = if (still) 1f else {
        val loop = rememberInfiniteTransition(label = "answer")
        val value by loop.animateFloat(1f, 1.08f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "answer.breath")
        value
    }
    val direction = LocalLayoutDirection.current
    BoxWithConstraints(Modifier.fillMaxWidth().padding(bottom = Space.xl)) {
        val diameter = if (maxWidth < 340.dp) 68.dp else PRIMARY_SIZE
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.Top) {
                CompositionLocalProvider(LocalLayoutDirection provides direction) {
                    CallButton(
                        icon = R.drawable.ic_call_end,
                        label = brandString(R.string.call_action_decline),
                        tag = CallTags.DECLINE,
                        tint = CALL_END_RED,
                        onClick = onDecline,
                        diameter = diameter,
                    )
                    if (video && onAnswerVoiceOnly != null) {
                        CallButton(
                            icon = R.drawable.ic_call_phone,
                            label = brandString(R.string.call_action_answer_audio),
                            caption = brandString(R.string.call_action_answer_audio_short),
                            tag = CallTags.ANSWER_VOICE,
                            onClick = onAnswerVoiceOnly,
                            diameter = diameter,
                        )
                    }
                    Box(
                        Modifier.graphicsLayer {
                            scaleX = breath
                            scaleY = breath
                        },
                    ) {
                        CallButton(
                            icon = if (video) R.drawable.ic_call_videocam else R.drawable.ic_call_phone,
                            label = brandString(if (video && onAnswerVoiceOnly != null) R.string.call_action_answer_video else R.string.call_action_answer),
                            caption = brandString(if (video && onAnswerVoiceOnly != null) R.string.call_action_answer_video_short else R.string.call_action_answer),
                            tag = CallTags.ANSWER,
                            tint = CALL_ANSWER_GREEN,
                            onClick = onAnswer,
                            diameter = diameter,
                        )
                    }
                }
            }
        }
    }
}

/** A short line on the call's surface: a warning or a state the person should know. */
@Composable
internal fun CallNotice(text: String, modifier: Modifier = Modifier, tag: String = CallTags.NOTICE) {
    Surface(
        color = Color.White.copy(alpha = 0.14f),
        contentColor = Color.White,
        shape = RoundedCornerShape(percent = 50),
        modifier = modifier.testTag(tag),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelLarge,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.sm),
        )
    }
}

/** Test tags of the call surfaces. */
object CallTags {
    const val SCREEN = "call.screen"
    const val STATUS = "call.status"
    const val DETAIL = "call.detail"
    const val NOTICE = "call.notice"
    const val ANSWER = "call.answer"
    const val ANSWER_VOICE = "call.answer.voice"
    const val DECLINE = "call.decline"
    const val HANG_UP = "call.hangUp"
    const val MUTE = "call.mute"
    const val CAMERA = "call.camera"
    const val FLIP = "call.flip"
    const val SPEAKER = "call.speaker"
    const val AUDIO = "call.audio"
    const val MINIMISE = "call.minimise"
    const val RETRY = "call.retry"
    const val SETTINGS = "call.settings"
    const val SELF_VIEW = "call.selfView"
    const val BUBBLE = "call.bubble"
    const val PIP = "call.pip"
    const val ROUTES = "call.routes"
    const val HEADER_AUDIO = "call.header.audio"
    const val HEADER_VIDEO = "call.header.video"
    const val HEADER_SETTINGS = "call.header.settings"
    const val CONSENT = "call.consent"
    const val CONSENT_LINE = "call.consent.line"
}
