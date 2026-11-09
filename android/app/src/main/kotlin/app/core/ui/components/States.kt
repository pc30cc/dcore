package app.core.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.core.R
import app.core.i18n.Numerals
import app.core.i18n.screenLanguage
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Motion
import app.core.ui.theme.Space
import app.core.ui.theme.brushTint

/**
 * A screen with nothing to show yet: a soft violet glow behind a tonal tile
 * with a gradient-stroked icon, where you are (title), why (body), and the
 * one thing that fixes it ([action], a tonal button) plus at most one text
 * button ([secondary]). Never the gradient button.
 */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    action: String? = null,
    onAction: (() -> Unit)? = null,
    secondary: String? = null,
    onSecondary: (() -> Unit)? = null,
) {
    EmptyStateLayout(rememberVectorPainter(icon), title, body, modifier) {
        if (action != null && onAction != null) TonalButton(action, onAction)
        if (secondary != null && onSecondary != null) TextAction(secondary, onSecondary)
    }
}

/** [EmptyState] with a drawable icon and a free action slot (the older screens' form). */
@Composable
fun EmptyState(
    @androidx.annotation.DrawableRes icon: Int,
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
) {
    EmptyStateLayout(painterResource(icon), title, body, modifier) { action?.invoke() }
}

@Composable
private fun EmptyStateLayout(icon: Painter, title: String, body: String, modifier: Modifier, actions: @Composable () -> Unit) {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    Box(modifier.fillMaxWidth().padding(horizontal = Space.xl, vertical = Space.xxl), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.md),
            modifier = Modifier.widthIn(max = 420.dp),
        ) {
            Box(
                Modifier
                    .size(88.dp)
                    .background(
                        Brush.radialGradient(listOf(colors.gradientStops.start.copy(alpha = if (colors.dark) 0.28f else 0.16f), Color.Transparent)),
                        CircleShape,
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .size(60.dp)
                        .background(scheme.surfaceContainerHigh, RoundedCornerShape(20.dp))
                        .border(1.dp, colors.hairlineStrong, RoundedCornerShape(20.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(icon, contentDescription = null, tint = Color.Black, modifier = Modifier.size(30.dp).brushTint(colors.gradient))
                }
            }
            Spacer(Modifier.height(Space.xs))
            Text(
                title,
                style = MaterialTheme.typography.titleMedium.copy(fontSize = 19.sp),
                color = scheme.onSurface,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                body,
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 24.sp),
                color = scheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(Space.sm))
            actions()
        }
    }
}

/**
 * The shape of what is loading, swept by a lighter band from right to left
 * every 1.2 s (still with reduced motion). No spinners outside buttons.
 */
@Composable
fun Modifier.skeleton(shape: Shape = RoundedCornerShape(8.dp)): Modifier {
    val colors = AppTheme.colors
    val reduced = LocalReducedMotion.current
    val sweep = if (reduced) {
        0.5f
    } else {
        val transition = rememberInfiniteTransition(label = "skeleton")
        val value by transition.animateFloat(
            initialValue = 1.3f,
            targetValue = -0.3f,
            animationSpec = infiniteRepeatable(tween(Motion.SKELETON_MS, easing = LinearEasing), RepeatMode.Restart),
            label = "sweep",
        )
        value
    }
    return clip(shape)
        .background(colors.skeleton, shape)
        .drawWithContent {
            if (!reduced) {
                val w = size.width
                val x = w * sweep
                drawRect(
                    Brush.linearGradient(
                        listOf(Color.Transparent, colors.skeletonHighlight, Color.Transparent),
                        start = Offset(x - w * 0.3f, 0f),
                        end = Offset(x + w * 0.3f, 0f),
                    ),
                )
            }
            drawContent()
        }
}

/** A loading list row: a circle and two bars. */
@Composable
fun SkeletonRow(modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().height(76.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(Modifier.size(54.dp).skeleton(CircleShape))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.fillMaxWidth(0.45f).height(12.dp).skeleton(CircleShape))
            Box(Modifier.fillMaxWidth(0.75f).height(10.dp).skeleton(CircleShape))
        }
    }
}

/** A loading card: the card's silhouette with its name and meta bars. */
@Composable
fun SkeletonCard(modifier: Modifier = Modifier) {
    Box(modifier.skeleton(RoundedCornerShape(28.dp))) {
        Column(Modifier.align(Alignment.BottomStart).padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(120.dp, 16.dp).background(AppTheme.colors.skeletonHighlight, CircleShape))
            Box(Modifier.size(72.dp, 12.dp).background(AppTheme.colors.skeletonHighlight, CircleShape))
        }
    }
}

/**
 * An onboarding step's top: back at the start (pointing back, so right in
 * Persian), «۳ از ۸» at the end, an optional skip, and the segments under
 * them, filling from the start: done ones gradient, the current one half.
 */
@Composable
fun StepsHeader(
    step: Int,
    total: Int,
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
    skip: String? = null,
    onSkip: (() -> Unit)? = null,
) {
    val language = screenLanguage()
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) {
                AppIconButton(AppIcons.Back, stringResource(R.string.ui_back), onBack)
            } else {
                Spacer(Modifier.size(48.dp))
            }
            Spacer(Modifier.weight(1f))
            if (skip != null && onSkip != null) TextAction(skip, onSkip, kind = TextActionKind.Neutral)
            Text(
                stringResource(R.string.ui_step_of, Numerals.format(step, language), Numerals.format(total, language)),
                style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium),
                color = AppTheme.colors.textTertiary,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
        }
        StepProgress(step, total)
    }
}

/** The segments of [StepsHeader] on their own. */
@Composable
fun StepProgress(step: Int, total: Int, modifier: Modifier = Modifier, height: Dp = 4.dp) {
    val colors = AppTheme.colors
    val rest = MaterialTheme.colorScheme.surfaceContainerHighest
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        for (i in 1..total) {
            val fill = when {
                i < step -> 1f
                i == step -> 0.5f
                else -> 0f
            }
            Box(Modifier.weight(1f).height(height).clip(CircleShape).background(rest)) {
                if (fill > 0f) Box(Modifier.fillMaxWidth(fill).fillMaxHeight().background(colors.gradient, CircleShape))
            }
        }
    }
}
