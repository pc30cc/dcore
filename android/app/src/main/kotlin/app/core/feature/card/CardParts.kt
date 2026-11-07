package app.core.feature.card

import androidx.annotation.DrawableRes
import androidx.compose.animation.animateColorAsState
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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Radius
import app.core.ui.theme.Space

/** The verified mark: a seal in the super-like blue with a white tick. */
@Composable
fun VerifiedBadge(size: Dp, modifier: Modifier = Modifier, description: String? = null) {
    Box(
        modifier = modifier
            .size(size)
            .then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(size * 0.55f).clip(CircleShape).background(Color.White))
        Icon(
            painter = painterResource(R.drawable.ic_deck_verified),
            contentDescription = null,
            tint = AppTheme.colors.superLike,
            modifier = Modifier.size(size),
        )
    }
}

/**
 * The photo position bar at the top of a card: one segment per photo, the
 * current one bright. It follows the reading direction (the first photo's
 * segment is at the start), as the tap zones do.
 */
@Composable
fun PhotoIndicator(count: Int, index: Int, modifier: Modifier = Modifier) {
    if (count <= 1) return
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
        repeat(count) { i ->
            val alpha by animateFloatAsState(if (i == index) 1f else 0.38f, tween(150), label = "segment")
            Box(
                Modifier
                    .weight(1f)
                    .height(4.dp)
                    .clip(RoundedCornerShape(Radius.pill))
                    .background(Color.White.copy(alpha = alpha)),
            )
        }
    }
}

/** A small label on a photo (likes you, active recently): translucent dark, white text. */
@Composable
fun PhotoPill(text: String, modifier: Modifier = Modifier, @DrawableRes icon: Int? = null, vector: ImageVector? = null, accent: Color = Color.White) {
    Surface(
        shape = RoundedCornerShape(Radius.pill),
        color = Color.Black.copy(alpha = 0.45f),
        contentColor = Color.White,
        modifier = modifier,
    ) {
        Row(
            Modifier.padding(horizontal = Space.md, vertical = Space.xs + 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.xs + 2.dp),
        ) {
            when {
                icon != null -> Icon(painterResource(icon), null, tint = accent, modifier = Modifier.size(14.dp))
                vector != null -> Icon(vector, null, tint = accent, modifier = Modifier.size(14.dp))
            }
            Text(text, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * A round action (pass, like, super like, rewind): presses in with a spring
 * and, while [highlight] grows (the card is dragged toward this action),
 * fills with its colour and grows a little.
 */
@Composable
fun RoundAction(
    painter: androidx.compose.ui.graphics.painter.Painter,
    description: String,
    color: Color,
    size: Dp,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    highlight: Float = 0f,
    enabled: Boolean = true,
    badge: String? = null,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val reduced = LocalReducedMotion.current
    val scale by animateFloatAsState(
        targetValue = when {
            reduced -> 1f
            pressed -> 0.86f
            else -> 1f + 0.12f * highlight.coerceIn(0f, 1f)
        },
        animationSpec = spring(dampingRatio = 0.45f, stiffness = 900f),
        label = "press",
    )
    val fill = highlight.coerceIn(0f, 1f)
    val container by animateColorAsState(lerp(actionSurface(), color, fill), tween(90), label = "fill")
    val content = lerp(color, AppTheme.colors.onSemantic, fill)
    Box(modifier, contentAlignment = Alignment.Center) {
        Surface(
            onClick = onClick,
            enabled = enabled,
            shape = CircleShape,
            color = container,
            contentColor = content,
            shadowElevation = 6.dp,
            interactionSource = interaction,
            modifier = Modifier
                .size(size)
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    alpha = if (enabled) 1f else 0.45f
                }
                .semantics {
                    contentDescription = description
                    role = Role.Button
                },
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(painter, contentDescription = null, tint = content, modifier = Modifier.size(size * 0.46f))
            }
        }
        if (badge != null) {
            Surface(
                shape = RoundedCornerShape(Radius.pill),
                color = color,
                contentColor = AppTheme.colors.onSemantic,
                modifier = Modifier.align(Alignment.TopEnd),
            ) {
                Text(badge, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp))
            }
        }
    }
}

/**
 * The face of a round button: white in the light theme, a raised grey in the
 * dark one (where a shadow does not show, the colour has to).
 */
@Composable
fun actionSurface(): Color {
    val scheme = MaterialTheme.colorScheme
    return if (scheme.background.luminance() < 0.5f) scheme.surfaceContainerHighest else scheme.surfaceContainerLowest
}

/**
 * A soft moving highlight over a placeholder shape: what "loading" looks like
 * instead of a spinner. Still when the system asks for less motion.
 */
fun Modifier.shimmer(): Modifier = composed {
    val reduced = LocalReducedMotion.current
    val base = MaterialTheme.colorScheme.surfaceContainerHigh
    val shine = MaterialTheme.colorScheme.surfaceContainerLowest.copy(alpha = 0.55f)
    if (reduced) {
        background(base)
    } else {
        val transition = rememberInfiniteTransition(label = "shimmer")
        val x by transition.animateFloat(
            initialValue = -1f,
            targetValue = 2f,
            animationSpec = infiniteRepeatable(tween(1_300, easing = LinearEasing), RepeatMode.Restart),
            label = "shimmer-x",
        )
        background(base).drawWithContent {
            drawContent()
            val width = size.width
            drawRect(
                Brush.linearGradient(
                    colors = listOf(Color.Transparent, shine, Color.Transparent),
                    start = Offset(width * x - width * 0.5f, 0f),
                    end = Offset(width * x, size.height),
                ),
            )
        }
    }
}
