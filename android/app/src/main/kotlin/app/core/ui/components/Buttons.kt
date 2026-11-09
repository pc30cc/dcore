package app.core.ui.components

import android.os.Build
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.innerShadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppColors
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Motion

/**
 * The glow under the primary button and the like button (tokens.json
 * `elevation.glowPrimary`: pink below, violet close in). Two at most on a
 * screen. Blurred shadows need Android 9; below that there is no glow.
 */
fun Modifier.glow(shape: Shape, colors: AppColors, pressed: Boolean = false, enabled: Boolean = true): Modifier {
    if (!enabled || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return this
    val pinkAlpha = if (colors.dark) 0.55f else 0.50f
    val violetAlpha = if (colors.dark) 0.45f else 0.38f
    return if (pressed) {
        dropShadow(shape, Shadow(radius = 18.dp, color = colors.gradientStops.end, spread = (-6).dp, offset = DpOffset(0.dp, 6.dp), alpha = if (colors.dark) 0.70f else 0.60f))
    } else {
        dropShadow(shape, Shadow(radius = 28.dp, color = colors.gradientStops.end, spread = (-8).dp, offset = DpOffset(0.dp, 10.dp), alpha = pinkAlpha))
            .dropShadow(shape, Shadow(radius = 14.dp, color = colors.gradientStops.start, spread = (-4).dp, offset = DpOffset(0.dp, 4.dp), alpha = violetAlpha))
    }
}

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

/**
 * The primary button: the gradient, a white label, the glow, a forward
 * arrow when it moves on (pointing left in Persian). One per screen; inside
 * sheets it has no glow ([glow] false). Loading keeps its width, hides the
 * label behind a spinner and drops the glow; disabled is flat grey.
 */
@Composable
fun GradientButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    forward: Boolean = false,
    icon: ImageVector? = null,
    glow: Boolean = true,
    fullWidth: Boolean = true,
) {
    val colors = AppTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale = pressScale(pressed && enabled && !loading)
    val active = enabled && !loading
    val loadingLabel = stringResource(R.string.ui_loading)
    Box(
        modifier = modifier
            .then(if (fullWidth) Modifier.fillMaxWidth() else Modifier)
            .heightIn(min = 56.dp)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .glow(CircleShape, colors, pressed = pressed, enabled = glow && active)
            .clip(CircleShape)
            .then(
                if (enabled) {
                    Modifier
                        .background(colors.gradient, CircleShape)
                        .innerShadow(CircleShape, Shadow(radius = 0.dp, color = Color.White, offset = DpOffset(0.dp, 1.dp), alpha = 0.28f))
                } else {
                    Modifier.background(MaterialTheme.colorScheme.surfaceContainerHighest, CircleShape)
                },
            )
            .then(if (pressed && active) Modifier.drawWithContent { drawContent(); drawRect(Color.White.copy(alpha = 0.08f)) } else Modifier)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = active,
                role = Role.Button,
                onClick = onClick,
            )
            .then(if (loading) Modifier.semantics { stateDescription = loadingLabel } else Modifier)
            .padding(horizontal = 24.dp),
        contentAlignment = Alignment.Center,
    ) {
        val content = if (enabled) colors.onGradient else colors.textTertiary
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.alpha(if (loading) 0f else 1f),
        ) {
            if (icon != null) Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(20.dp))
            Text(text, style = MaterialTheme.typography.labelLarge, color = content, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (forward) Icon(AppIcons.Forward, contentDescription = null, tint = content, modifier = Modifier.size(20.dp))
        }
        if (loading) {
            CircularProgressIndicator(color = colors.onGradient, trackColor = colors.onGradient.copy(alpha = 0.3f), strokeWidth = 2.5.dp, modifier = Modifier.size(22.dp))
        }
    }
}

/** The secondary button: no fill, a 1.5 dp ring, the theme's text colour. */
@Composable
fun OutlineButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    fullWidth: Boolean = true,
) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = CircleShape,
        color = Color.Transparent,
        contentColor = MaterialTheme.colorScheme.onSurface,
        border = BorderStroke(1.5.dp, AppTheme.colors.hairlineStrong),
        modifier = modifier.then(if (fullWidth) Modifier.fillMaxWidth() else Modifier).heightIn(min = 56.dp),
    ) {
        ButtonContent(text, icon, PaddingValues(horizontal = 24.dp), enabled)
    }
}

/** The tonal button: a neutral action ("photo from gallery"), 56 dp or [compact] 48 dp. */
@Composable
fun TonalButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    compact: Boolean = false,
    fullWidth: Boolean = true,
) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurface,
        modifier = modifier.then(if (fullWidth) Modifier.fillMaxWidth() else Modifier).heightIn(min = if (compact) 48.dp else 56.dp),
    ) {
        ButtonContent(text, icon, PaddingValues(horizontal = 24.dp), enabled)
    }
}

@Composable
private fun ButtonContent(text: String, icon: ImageVector?, padding: PaddingValues, enabled: Boolean) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(padding).alpha(if (enabled) 1f else 0.4f),
    ) {
        if (icon != null) Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp))
        Text(text, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** What a text button does: move on (accent), something neutral, or remove something (error). */
enum class TextActionKind { Primary, Neutral, Destructive }

/** A text button: 48 dp tall, hugging its label. Destructive actions are never on the gradient. */
@Composable
fun TextAction(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: TextActionKind = TextActionKind.Primary,
    enabled: Boolean = true,
    icon: ImageVector? = null,
) {
    val color = when (kind) {
        TextActionKind.Primary -> MaterialTheme.colorScheme.primary
        TextActionKind.Neutral -> MaterialTheme.colorScheme.onSurfaceVariant
        TextActionKind.Destructive -> MaterialTheme.colorScheme.error
    }
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .minimumInteractiveComponentSize()
            .heightIn(min = 48.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp)
            .alpha(if (enabled) 1f else 0.4f),
    ) {
        if (icon != null) Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(18.dp))
        Text(text, style = MaterialTheme.typography.labelLarge.copy(fontSize = MaterialTheme.typography.labelLarge.fontSize * 0.94f), color = color, maxLines = 1)
    }
}

/** The small inverse pill ("Edit" on your own profile): 44 dp to see, 48 dp to touch. */
@Composable
fun InverseButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
) {
    val scheme = MaterialTheme.colorScheme
    Box(
        modifier
            .heightIn(min = 48.dp)
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .heightIn(min = 44.dp)
                .background(scheme.inverseSurface, CircleShape)
                .padding(horizontal = 18.dp),
        ) {
            if (icon != null) Icon(icon, contentDescription = null, tint = scheme.inverseOnSurface, modifier = Modifier.size(18.dp))
            Text(text, style = MaterialTheme.typography.labelMedium.copy(fontWeight = AppTheme.type.kicker.fontWeight), color = scheme.inverseOnSurface, maxLines = 1)
        }
    }
}

/** How a bare icon button looks. Every kind is a 48 dp target. */
enum class IconButtonKind { Plain, Tonal, Line, Glass }

/**
 * An icon button: 48 × 48 always ([size] is what is drawn; the touch area
 * never shrinks below 48 dp), with its [contentDescription] for TalkBack.
 * [IconButtonKind.Glass] sits on photos: dark glass in dark, white in light.
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
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    val iconTint = tint ?: when (kind) {
        IconButtonKind.Glass -> if (colors.dark) Color.White else scheme.onSurface
        else -> scheme.onSurface
    }
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale = pressScale(pressed && enabled, 0.94f)
    val click = Modifier
        .clip(CircleShape)
        .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
        .semantics { this.contentDescription = contentDescription }
    Box(
        modifier = modifier
            .minimumInteractiveComponentSize()
            .size(maxOf(size, 48.dp))
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .then(click),
        contentAlignment = Alignment.Center,
    ) {
        val inner = Modifier.size(size)
        when (kind) {
            IconButtonKind.Plain -> Box(inner, contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(iconSize))
            }
            IconButtonKind.Tonal -> Box(inner.background(scheme.surfaceContainerHigh, CircleShape), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(iconSize))
            }
            IconButtonKind.Line -> Surface(
                shape = CircleShape,
                color = Color.Transparent,
                border = BorderStroke(1.5.dp, colors.hairlineStrong),
                modifier = inner,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(iconSize))
                }
            }
            IconButtonKind.Glass -> GlassBox(CircleShape, GlassStyle.photoChrome(colors), inner, backdrop) {
                Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(iconSize))
            }
        }
        if (pressed && kind != IconButtonKind.Glass) {
            Box(Modifier.size(size).clip(CircleShape).background(scheme.onSurface.copy(alpha = 0.12f)))
        }
    }
}
