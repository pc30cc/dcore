package app.core.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Motion
import app.core.ui.theme.insetShadow
import app.core.ui.theme.outerShadow
import androidx.compose.runtime.getValue

/** A press scale (0.97 in 90 ms, spring back), or nothing with reduced motion. */
@Composable
internal fun pressScale(pressed: Boolean, to: Float = 0.97f): Float {
    val reduced = LocalReducedMotion.current
    val target = if (pressed && !reduced) to else 1f
    val scale by animateFloatAsState(
        targetValue = target,
        animationSpec = if (pressed) tween(Motion.INSTANT_MS, easing = Motion.Standard) else Motion.buttonRelease(),
        label = "press",
    )
    return scale
}

/** The button corner of the template (`--r-button`: a pill, or a rounded rectangle). */
@Composable
internal fun buttonShape(): Shape = RoundedCornerShape(AppTheme.template.radii.button)

/**
 * The one primary button: `--primary-fill` (the gradient in neon, ink in
 * white) with `--on-primary`, `--btn-highlight` and no glow, a label and
 * no icon. One per screen. Loading keeps its width and shows a spinner;
 * disabled is `--surface-3` with `--text-3`. [small] is the 48 dp form that
 * hugs its label («ویرایش پروفایل»).
 */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    small: Boolean = false,
    fullWidth: Boolean = !small,
) {
    val t = AppTheme.template
    val shape = buttonShape()
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val active = enabled && !loading
    val scale = pressScale(pressed && active)
    val loadingLabel = stringResource(R.string.ui_loading)
    val content = if (enabled) t.colors.onPrimary else t.colors.text3
    Box(
        modifier = modifier
            .then(if (fullWidth) Modifier.fillMaxWidth() else Modifier)
            .heightIn(min = if (small) 48.dp else t.sizes.buttonH)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clip(shape)
            .then(
                if (enabled) {
                    Modifier.background(t.paints.primaryFill, shape).insetShadow(shape, t.shadows.btnHighlight)
                } else {
                    Modifier.background(t.colors.surface3, shape)
                },
            )
            .then(if (pressed && active) Modifier.drawWithContent { drawContent(); drawRect(Color.White.copy(alpha = 0.08f)) } else Modifier)
            .clickable(interactionSource = interaction, indication = null, enabled = active, role = Role.Button, onClick = onClick)
            .then(if (loading) Modifier.semantics { stateDescription = loadingLabel } else Modifier)
            .padding(horizontal = if (small) 18.dp else 24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            style = if (small) t.type.labelSm else t.type.label,
            color = content,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.alpha(if (loading) 0f else 1f),
        )
        if (loading) {
            CircularProgressIndicator(color = t.colors.onPrimary, trackColor = t.colors.onPrimary.copy(alpha = 0.3f), strokeWidth = 2.5.dp, modifier = Modifier.size(22.dp))
        }
    }
}

/**
 * The secondary button: no fill, a 1.5 dp `--line-strong` edge, the text
 * colour. [destructive] draws the edge and the label in `--error`
 * («حسابم رو پاک کن»). There is no tonal or inverse button.
 */
@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    small: Boolean = false,
    fullWidth: Boolean = !small,
    destructive: Boolean = false,
) {
    val t = AppTheme.template
    val shape = buttonShape()
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale = pressScale(pressed && enabled)
    val color = if (destructive) t.colors.error else t.colors.text
    Box(
        modifier = modifier
            .then(if (fullWidth) Modifier.fillMaxWidth() else Modifier)
            .heightIn(min = if (small) 48.dp else t.sizes.buttonH)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clip(shape)
            .border(1.5.dp, if (destructive) t.colors.error else t.colors.lineStrong, shape)
            .then(if (pressed && enabled) Modifier.background(t.colors.text.copy(alpha = 0.06f), shape) else Modifier)
            .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = if (small) 18.dp else 24.dp)
            .alpha(if (enabled) 1f else 0.4f),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = if (small) t.type.labelSm else t.type.label, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** What a text button does: move on (the accent), something neutral, or remove something (error). */
enum class TextActionKind { Primary, Neutral, Destructive }

/** A text button (`--type-link`): 48 dp tall, hugging its label; never an icon. */
@Composable
fun TextAction(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: TextActionKind = TextActionKind.Primary,
    enabled: Boolean = true,
) {
    val t = AppTheme.template
    val color = when (kind) {
        TextActionKind.Primary -> t.colors.primary
        TextActionKind.Neutral -> t.colors.text2
        TextActionKind.Destructive -> t.colors.error
    }
    Box(
        modifier = modifier
            .heightIn(min = 48.dp)
            .widthIn(min = 48.dp)
            .clip(buttonShape())
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp)
            .alpha(if (enabled) 1f else 0.4f),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = t.type.link, color = color, maxLines = 1)
    }
}

/**
 * How a bare icon button looks. Every kind is a 48 dp target.
 * [Glass] sits on photos: `--glass-fill` blurred (glass on) or
 * `--glass-solid` with `--glass-shadow` (glass off).
 */
enum class IconButtonKind { Plain, Tonal, Line, Glass }

/**
 * An icon button: 48 × 48 always ([size] is what is drawn; the touch area
 * never shrinks below 48 dp), with its [contentDescription] for TalkBack.
 */
@Composable
fun AppIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: IconButtonKind = IconButtonKind.Plain,
    size: Dp = 48.dp,
    iconSize: Dp = 24.dp,
    tint: Color? = null,
    backdrop: GlassBackdrop? = null,
    enabled: Boolean = true,
) {
    val t = AppTheme.template
    val iconTint = tint ?: when (kind) {
        IconButtonKind.Glass -> t.colors.onGlass
        else -> t.colors.text
    }
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale = pressScale(pressed && enabled, 0.94f)
    Box(
        modifier = modifier
            .minimumInteractiveComponentSize()
            .size(maxOf(size, 48.dp))
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            // Not clipped: the glass kind's `--glass-shadow` draws outside the disc.
            .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { this.contentDescription = contentDescription },
        contentAlignment = Alignment.Center,
    ) {
        val inner = Modifier.size(size)
        when (kind) {
            IconButtonKind.Plain -> Box(inner, contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(iconSize))
            }
            IconButtonKind.Tonal -> Box(inner.background(t.colors.surface2, CircleShape), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(iconSize))
            }
            IconButtonKind.Line -> Box(inner.border(1.5.dp, t.colors.lineStrong, CircleShape), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(iconSize))
            }
            IconButtonKind.Glass -> GlassBox(CircleShape, GlassStyle.photoChrome(), inner, backdrop) {
                Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(iconSize))
            }
        }
        if (pressed && kind != IconButtonKind.Glass) {
            Box(Modifier.size(size).clip(CircleShape).background(t.colors.text.copy(alpha = 0.10f)))
        }
    }
}

/** How a call button looks; the same in every template. */
enum class CallButtonKind {
    /** At rest: `--call-btn-fill`, blurred, with a hairline. */
    Secondary,

    /** Toggled (microphone off, camera off): `--call-btn-on-fill`. */
    Toggled,

    /** Hang up or decline: `--call-end`. */
    End,

    /** Answer: `--call-accept` (the gradient in neon, green in white). */
    Accept,
}

/** A call button (68 dp, or 56 dp in the video row), always a 48 dp target at least; never a glow. */
@Composable
fun CallButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: CallButtonKind = CallButtonKind.Secondary,
    size: Dp = 68.dp,
    backdrop: GlassBackdrop? = null,
) {
    val t = AppTheme.template
    val c = t.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale = pressScale(pressed, 0.94f)
    val inner = Modifier.size(size)
    val iconSize = if (size >= 68.dp) 28.dp else 24.dp
    Box(
        modifier = modifier
            .size(maxOf(size, 48.dp))
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clip(CircleShape)
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
            .semantics { this.contentDescription = contentDescription },
        contentAlignment = Alignment.Center,
    ) {
        when (kind) {
            CallButtonKind.Secondary -> GlassBox(CircleShape, GlassStyle.callButton(), inner, backdrop) {
                Icon(icon, contentDescription = null, tint = c.onCallBtn, modifier = Modifier.size(iconSize))
            }
            CallButtonKind.Toggled -> Box(inner.background(c.callBtnOnFill, CircleShape), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = c.onCallBtnOn, modifier = Modifier.size(iconSize))
            }
            CallButtonKind.End -> Box(inner.background(c.callEnd, CircleShape), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = c.onCallEnd, modifier = Modifier.size(iconSize))
            }
            CallButtonKind.Accept -> Box(inner.background(t.paints.callAccept, CircleShape), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = c.onCallAccept, modifier = Modifier.size(iconSize))
            }
        }
    }
}

/** The deck like button's shadow (`--glow-like`): the only glow a template draws. */
@Composable
internal fun Modifier.likeGlow(shape: Shape): Modifier = outerShadow(shape, AppTheme.template.shadows.glowLike)
