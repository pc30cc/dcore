package app.core.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.i18n.Numerals
import app.core.i18n.screenLanguage
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Motion
import app.core.ui.theme.Space
import androidx.compose.runtime.getValue

/**
 * A screen with nothing to show yet: the title (`--type-h2`), at most one
 * short line, and the one thing that helps ([action], a secondary button),
 * centred. No illustration and no icon.
 */
@Composable
fun EmptyState(
    title: String,
    modifier: Modifier = Modifier,
    body: String? = null,
    action: String? = null,
    onAction: (() -> Unit)? = null,
) {
    EmptyStateLayout(title, body, modifier) {
        if (action != null && onAction != null) SecondaryButton(action, onAction, small = true)
    }
}

@Composable
private fun EmptyStateLayout(title: String, body: String?, modifier: Modifier, actions: @Composable () -> Unit) {
    val t = AppTheme.template
    Box(modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = Space.xxl), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.widthIn(max = 420.dp),
        ) {
            Text(title, style = t.type.h2, color = t.colors.text, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
            if (body != null) Text(body, style = t.type.bodySm, color = t.colors.text2, textAlign = TextAlign.Center)
            Spacer(Modifier.height(Space.lg))
            actions()
        }
    }
}

/**
 * The shape of what is loading (`--skeleton`), swept by `--skeleton-hi`
 * from right to left every 1.2 s (still with reduced motion). No spinners
 * outside buttons.
 */
@Composable
fun Modifier.skeleton(shape: Shape = RoundedCornerShape(AppTheme.template.radii.xs)): Modifier {
    val t = AppTheme.template
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
        .background(t.colors.skeleton, shape)
        .drawWithContent {
            if (!reduced) {
                val w = size.width
                val x = w * sweep
                drawRect(
                    Brush.linearGradient(
                        listOf(Color.Transparent, t.colors.skeletonHi, Color.Transparent),
                        start = Offset(x - w * 0.3f, 0f),
                        end = Offset(x + w * 0.3f, 0f),
                    ),
                )
            }
            drawContent()
        }
}

/**
 * An onboarding step's top: back at the start, «رد شو» at the end only on
 * optional steps ([skip]), and the one 4 dp progress bar under them, inside
 * the 20 dp gutter, filled from the start. No step counter.
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
    Column(modifier.fillMaxWidth()) {
        // The back glyph lines up with the gutter (8 dp + the 48 dp target's 12 dp); «رد شو» keeps 6 dp at the end.
        Row(Modifier.fillMaxWidth().height(56.dp).padding(start = 8.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) {
                AppIconButton(AppIcons.Back, stringResource(R.string.ui_back), onBack)
            } else {
                Spacer(Modifier.size(48.dp))
            }
            Spacer(Modifier.weight(1f))
            if (skip != null && onSkip != null) TextAction(skip, onSkip, kind = TextActionKind.Neutral)
        }
        StepProgress(step, total, Modifier.padding(horizontal = Space.gutter))
    }
}

/**
 * The onboarding progress on its own: one 4 dp bar, [step] of [total]
 * filled from the start. Screen readers hear the step («۳ از ۸»), which is
 * no longer drawn.
 */
@Composable
fun StepProgress(step: Int, total: Int, modifier: Modifier = Modifier) {
    val language = screenLanguage()
    val fraction = if (total <= 0) 0f else (step.toFloat() / total).coerceIn(0f, 1f)
    val spoken = stringResource(R.string.ui_step_of, Numerals.format(step, language), Numerals.format(total, language))
    ProgressBar(
        fraction,
        modifier.semantics {
            progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f)
            stateDescription = spoken
        },
    )
}
