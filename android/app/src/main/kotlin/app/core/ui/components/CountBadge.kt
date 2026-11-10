package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.AlignmentLine
import androidx.compose.ui.layout.FirstBaseline
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import app.core.ui.theme.AppTheme
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * A count (`.unread`: `--unread-fill`, `--on-unread`, `--type-caption-strong`,
 * 22 dp at the design's text size), sized to its text at every text size:
 * one height for every count (from the font size), so "3", "12" and "99+"
 * in one column stand equally tall; a circle for one figure, a pill 7 dp
 * beyond the figures for more. The height comes from the font size, the
 * width from the text, and the figures' middle (from the baseline) sits on
 * the badge's middle, whatever the script's line metrics (Persian's tall
 * line made a fixed-line badge a tall pill at large text). [fill] and
 * [contentColor] change it (a muted conversation's quiet count). Not read
 * by TalkBack: whatever it counts says so.
 */
@Composable
fun CountBadge(
    text: String,
    modifier: Modifier = Modifier,
    fill: Brush = AppTheme.template.paints.unreadFill,
    contentColor: Color = AppTheme.template.colors.onUnread,
) {
    val style = AppTheme.template.type.captionStrong
    Layout(
        content = { Text(text, style = style, color = contentColor, maxLines = 1, softWrap = false) },
        modifier = modifier.background(fill, RoundedCornerShape(50)),
    ) { measurables, _ ->
        val label = measurables.single().measure(Constraints())
        val em = style.fontSize.toPx()
        val tall = max(BADGE_MIN.roundToPx(), (em * BADGE_EM).roundToInt())
        // Never narrower than tall (one figure is a circle); never taller than the font needs.
        val wide = max(tall, label.width + 2 * BADGE_PAD_H.roundToPx())
        val baseline = label[FirstBaseline].takeIf { it != AlignmentLine.Unspecified } ?: (label.height * 0.75f).roundToInt()
        val top = (tall / 2f - (baseline - em * FIGURE_HALF_EM)).roundToInt()
        layout(wide, tall) {
            label.placeRelative((wide - label.width) / 2, top)
        }
    }
}

/** [count] for a badge: itself up to [max], else "[max]+" ("۹+"), in the reader's digits via [number]. */
fun badgeCount(count: Int, max: Int, number: (Int) -> String): String =
    if (count > max) number(max) + "+" else number(count)

private val BADGE_MIN = 16.dp

/** `.unread{padding:0 7px}`. */
private val BADGE_PAD_H = 7.dp

/** A badge's height for its font size: 22 dp at the 12 sp caption (`.unread{height:22px}`). */
private const val BADGE_EM = 22f / 12f

/** Figures stand about 0.7 em on the baseline; half of that is their middle. */
private const val FIGURE_HALF_EM = 0.36f
