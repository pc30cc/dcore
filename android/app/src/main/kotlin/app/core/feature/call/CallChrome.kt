package app.core.feature.call

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
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
import app.core.ui.components.AvatarFocus
import app.core.ui.components.closerFace
import app.core.ui.components.CallButton
import app.core.ui.components.CallButtonKind
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.CallPalette
import app.core.ui.theme.Space
import app.core.ui.theme.photoFilter
import coil3.compose.AsyncImage

/*
 * The visual language every call surface shares: the full screen, the
 * bubble over the app and the picture-in-picture window. Opaque, always, on
 * the call's own dark backdrop in both themes, so nothing behind a call (a
 * chat, the lock screen's wallpaper) ever shows through it.
 */

/**
 * The bubble's and the picture-in-picture window's backdrop: the brand's
 * dark tone deepened nearly to black at the top, black at the bottom, with
 * a soft glow of the brand colour where the face is.
 */
@Composable
internal fun CallBackdrop(modifier: Modifier = Modifier, glowAt: Float = 0.32f) {
    val brand = CallPalette.backdropTint
    val top = remember(brand) { lerp(brand, Color.Black, 0.70f) }
    val middle = remember(brand) { lerp(brand, CallPalette.stage, 0.88f) }
    Box(
        modifier
            .fillMaxSize()
            .background(CallPalette.stage)
            .background(Brush.verticalGradient(listOf(top, middle, CallPalette.backdropBottom)))
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

/**
 * The call screen's backdrop (m12): the other person's photo, larger than
 * the screen (`inset: -60px`) under `--photo-backdrop-filter` (blurred,
 * dimmed), the same in every template; its blurhash while it loads, the
 * call's own dark when there is neither.
 */
@Composable
internal fun CallPhotoBackdrop(photoUrl: String?, blurhash: String?, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    val remote = LocalRemoteImages.current && !LocalInspectionMode.current
    val context = LocalContext.current
    Box(modifier.fillMaxSize().background(CallPalette.stage).clipToBounds()) {
        if (photoUrl == null && blurhash == null) return@Box
        Box(
            Modifier
                .fillMaxSize()
                .graphicsLayer {
                    val grow = 1f + 2f * BACKDROP_BLEED.toPx() / size.width.coerceAtLeast(1f)
                    scaleX = grow
                    scaleY = grow
                }
                .photoFilter(t.filters.photoBackdropFilter),
        ) {
            if (blurhash != null) BlurHashImage(blurhash, Modifier.fillMaxSize())
            if (photoUrl != null && remote) {
                val request = remember(photoUrl) { ImageLoading.request(context, photoUrl) }
                AsyncImage(
                    model = request,
                    contentDescription = null,
                    imageLoader = ImageLoading.loader(context),
                    contentScale = ContentScale.Crop,
                    alignment = BiasAlignment(0f, -0.6f),
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

/** How far the blurred photo reaches past each edge, so its blur never shows an edge. */
private val BACKDROP_BLEED = 60.dp

/**
 * Over a picture that fills the screen: `--call-scrim-top` 170 dp under the
 * name and the timer, `--photo-scrim-bottom` over the lowest third under the
 * buttons.
 */
@Composable
internal fun VideoScrims(modifier: Modifier = Modifier) {
    val t = AppTheme.template
    Box(modifier.fillMaxSize()) {
        Box(Modifier.fillMaxWidth().height(CALL_SCRIM_TOP).background(t.paints.callScrimTop))
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(CALL_SCRIM_BOTTOM).background(t.paints.photoScrimBottom))
    }
}

private val CALL_SCRIM_TOP = 170.dp
private const val CALL_SCRIM_BOTTOM = 0.34f

/** Below this height (a phone on its side) a call screen leaves the face out. */
internal val COMPACT_CALL_HEIGHT = 480.dp

/**
 * The match's face: the photo's blurhash at once and the photo over it once
 * loaded; a person silhouette on a quiet circle only while nothing of the
 * face is known (no blurhash; under a photo still loading or that never
 * loads). Never a letter. Photos load through the app's own image cache.
 */
@Composable
internal fun CallFace(photoUrl: String?, blurhash: String?, size: Dp, modifier: Modifier = Modifier) {
    val remote = LocalRemoteImages.current && !LocalInspectionMode.current
    val context = LocalContext.current
    Box(
        modifier
            .size(size)
            .clip(CircleShape)
            .background(CallPalette.tile),
        contentAlignment = Alignment.Center,
    ) {
        // Bottom up: the silhouette only when nothing of the face is known,
        // the blurhash at once, the photo over it once it loads (and while it
        // loads, or if it never does, what is under it shows).
        if (blurhash != null) {
            BlurHashImage(blurhash, Modifier.fillMaxSize().testTag(CallTags.FACE_BLURHASH))
        } else {
            Icon(
                AppIcons.Person,
                contentDescription = null,
                tint = AppTheme.template.colors.onPhoto2,
                modifier = Modifier.size(size * 0.6f).testTag(CallTags.FACE_SILHOUETTE),
            )
        }
        if (photoUrl != null && remote) {
            val request = remember(photoUrl) { ImageLoading.request(context, photoUrl) }
            val zoom = size >= CALL_FACE_ZOOM_FROM
            AsyncImage(
                model = request,
                contentDescription = null,
                imageLoader = ImageLoading.loader(context),
                contentScale = ContentScale.Crop,
                alignment = AvatarFocus,
                // A portrait in a large circle: a little closer, so the face fills it.
                modifier = Modifier.fillMaxSize().then(if (zoom) Modifier.closerFace() else Modifier).testTag(CallTags.FACE_PHOTO),
            )
        }
    }
}

/**
 * The face in its ring (`.cav .ring`): a `--ring-fill` ring 4 dp wide around
 * it (thinner around a small face) with a 2.5 dp gap in the page colour,
 * still, ringing or not (the call's line says it rings). [ringing] is kept
 * for the bubble, which draws the same ring.
 */
@Composable
internal fun CallHalo(@Suppress("UNUSED_PARAMETER") ringing: Boolean, faceSize: Dp, face: @Composable () -> Unit) {
    val t = AppTheme.template
    val ring = if (faceSize >= 96.dp) 4.dp else 2.dp
    val gap = if (faceSize >= 96.dp) 2.5.dp else 1.5.dp
    Box(
        Modifier
            .size(faceSize + ring * 2)
            .background(t.paints.ringFill, CircleShape)
            .padding(ring - gap)
            .background(t.colors.bg, CircleShape)
            .padding(gap),
        contentAlignment = Alignment.Center,
    ) {
        face()
    }
}

/**
 * One round button of the call's row (m13): [CallButton] in its kind, 56 dp
 * (the end button 68), a toggle drawn white with an ink icon while [on].
 * TalkBack hears [label] once, with the toggle's state. A disabled one keeps
 * its place and loses its contrast.
 */
@Composable
internal fun CallControl(
    icon: ImageVector,
    label: String,
    tag: String,
    onClick: () -> Unit,
    /** Drawn toggled (white with an ink icon): microphone or camera off, speaker on. */
    on: Boolean = false,
    /** A switch for TalkBack, on or off ("Microphone, switch, on"); null: a button. */
    switchOn: Boolean? = null,
    enabled: Boolean = true,
    kind: CallButtonKind = if (on) CallButtonKind.Toggled else CallButtonKind.Secondary,
    size: Dp = CALL_ROW_BUTTON,
) {
    CallButton(
        icon = icon,
        contentDescription = label,
        onClick = onClick,
        kind = kind,
        size = size,
        enabled = enabled,
        toggled = switchOn,
        modifier = Modifier.testTag(tag),
    )
}

internal val CALL_ROW_BUTTON = 56.dp

/** The ring screen's face (132 dp) and larger: the photo drawn closer ([closerFace]). */
private val CALL_FACE_ZOOM_FROM = 100.dp

/**
 * A 68 dp call button with its name under it (`.cc`: `--type-label-sm`,
 * `--on-photo-2`, 10 dp under, 80 dp wide): the ring's and a finished
 * call's buttons. TalkBack hears [label].
 */
@Composable
internal fun LabelledCallButton(
    icon: ImageVector,
    label: String,
    tag: String,
    onClick: () -> Unit,
    kind: CallButtonKind = CallButtonKind.Secondary,
    caption: String = label,
) {
    val t = AppTheme.template
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(CALL_LABEL_GAP),
        modifier = Modifier.width(CALL_LABELLED_WIDTH),
    ) {
        CallButton(icon = icon, contentDescription = label, onClick = onClick, kind = kind, size = CALL_RING_BUTTON, modifier = Modifier.testTag(tag))
        Text(
            caption,
            style = t.type.labelSm,
            color = t.colors.onPhoto2,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().clearAndSetSemantics {},
        )
    }
}

private val CALL_RING_BUTTON = 68.dp
private val CALL_LABEL_GAP = 10.dp
private val CALL_LABELLED_WIDTH = 80.dp

/**
 * The buttons of a call ringing this phone (m12): Decline on the left,
 * Answer on the right in every language (the platform's own incoming-call
 * layout, so a thumb never meets the other button in Persian), and between
 * them, on a video call, «فقط صدا». Answer is `--call-accept`; no glow.
 */
@Composable
internal fun IncomingCallButtons(
    video: Boolean,
    onDecline: () -> Unit,
    onAnswer: () -> Unit,
    onAnswerVoiceOnly: (() -> Unit)?,
) {
    val direction = LocalLayoutDirection.current
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Row(
            Modifier.fillMaxWidth().widthIn(max = CALL_RING_ROW_MAX).padding(horizontal = CALL_RING_ROW_INSET),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Top,
        ) {
            CompositionLocalProvider(LocalLayoutDirection provides direction) {
                LabelledCallButton(
                    icon = AppIcons.PhoneDown,
                    label = brandString(R.string.call_action_decline),
                    tag = CallTags.DECLINE,
                    kind = CallButtonKind.End,
                    onClick = onDecline,
                )
                if (video && onAnswerVoiceOnly != null) {
                    LabelledCallButton(
                        icon = AppIcons.Phone,
                        label = brandString(R.string.call_action_answer_audio),
                        caption = brandString(R.string.call_action_answer_audio_short),
                        tag = CallTags.ANSWER_VOICE,
                        onClick = onAnswerVoiceOnly,
                    )
                }
                LabelledCallButton(
                    icon = if (video) AppIcons.Video else AppIcons.Phone,
                    label = brandString(if (video && onAnswerVoiceOnly != null) R.string.call_action_answer_video else R.string.call_action_answer),
                    caption = brandString(if (video && onAnswerVoiceOnly != null) R.string.call_action_answer_video_short else R.string.call_action_answer),
                    tag = CallTags.ANSWER,
                    kind = CallButtonKind.Accept,
                    onClick = onAnswer,
                )
            }
        }
    }
}

/** `.cctl{left:36px;right:36px}`: 16 dp more than the screen's gutter. */
private val CALL_RING_ROW_INSET = 16.dp
private val CALL_RING_ROW_MAX = 440.dp

/** A short line on the call's surface: a warning or a state the person should know (a photo pill). */
@Composable
internal fun CallNotice(text: String, modifier: Modifier = Modifier, tag: String = CallTags.NOTICE) {
    val t = AppTheme.template
    Text(
        text,
        style = t.type.labelSm,
        color = t.colors.onPhoto,
        textAlign = TextAlign.Center,
        modifier = modifier
            .testTag(tag)
            .background(t.colors.photoChipFill, RoundedCornerShape(t.radii.chip))
            .border(1.dp, t.colors.photoChipLine, RoundedCornerShape(t.radii.chip))
            .padding(horizontal = Space.lg, vertical = Space.sm),
    )
}

/** Test tags of the call surfaces. */
object CallTags {
    const val SCREEN = "call.screen"
    const val MESSAGE = "call.message"
    const val REPLY = "call.reply"
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
    const val FACE_SILHOUETTE = "call.face.silhouette"
    const val FACE_BLURHASH = "call.face.blurhash"
    const val FACE_PHOTO = "call.face.photo"
}
