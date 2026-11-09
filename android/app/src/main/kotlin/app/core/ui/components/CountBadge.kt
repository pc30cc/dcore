package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.contentColorFor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.AlignmentLine
import androidx.compose.ui.layout.FirstBaseline
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * A count, sized to its text at every text size: one height for every count
 * (from the font size), so "3", "12" and "99+" in one column stand equally
 * tall; a circle for one figure, a short pill for more. Material's badge
 * keeps a fixed width and lets the height follow the font's line, which at
 * large text in Persian (a tall line) made it a tall pill over its icon.
 * Here the height comes from the font size, the width from the text, and
 * the figures' middle (from the baseline) sits on the badge's middle,
 * whatever the script's line metrics. Not read by TalkBack: whatever it
 * counts says so.
 */
@Composable
fun CountBadge(
    text: String,
    modifier: Modifier = Modifier,
    containerColor: Color = MaterialTheme.colorScheme.error,
    contentColor: Color = contentColorFor(containerColor),
) {
    val style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold)
    Layout(
        content = { Text(text, style = style, color = contentColor, maxLines = 1, softWrap = false) },
        modifier = modifier.background(containerColor, RoundedCornerShape(50)),
    ) { measurables, _ ->
        val label = measurables.single().measure(Constraints())
        val em = style.fontSize.toPx()
        val tall = max(BADGE_MIN.roundToPx(), (em * BADGE_EM).roundToInt())
        // Never narrower than tall (one figure is a circle); never taller than the font needs.
        val wide = max(tall, label.width + 2 * BADGE_PAD_H.roundToPx())
        val height = tall
        val baseline = label[FirstBaseline].takeIf { it != AlignmentLine.Unspecified } ?: (label.height * 0.75f).roundToInt()
        val top = (height / 2f - (baseline - em * FIGURE_HALF_EM)).roundToInt()
        layout(wide, height) {
            label.placeRelative((wide - label.width) / 2, top)
        }
    }
}

/** [count] for a badge: itself up to [max], else "[max]+" ("۹+"), in the reader's digits via [number]. */
fun badgeCount(count: Int, max: Int, number: (Int) -> String): String =
    if (count > max) number(max) + "+" else number(count)

/**
 * Puts [badge] over [content] (an icon button) with its centre on the
 * icon's top end corner, [inset] in from the button's edges, mirrored in a
 * right-to-left layout. A larger badge (large text) grows around that point
 * and stays inside the button rather than over what is beside it.
 */
@Composable
fun BadgeAnchor(
    badge: (@Composable () -> Unit)?,
    modifier: Modifier = Modifier,
    inset: Dp = 12.dp,
    content: @Composable () -> Unit,
) {
    Layout(contents = listOf(content, badge ?: {}), modifier = modifier) { (main, extra), constraints ->
        val button = main.single().measure(constraints)
        val mark = extra.firstOrNull()?.measure(Constraints())
        layout(button.width, button.height) {
            button.placeRelative(0, 0)
            if (mark != null) {
                val edge = inset.roundToPx()
                val cx = (button.width - edge).coerceAtMost(button.width - mark.width / 2)
                val cy = edge.coerceAtLeast(mark.height / 2)
                mark.placeRelative(cx - mark.width / 2, cy - mark.height / 2)
            }
        }
    }
}

private val BADGE_MIN = 16.dp
/** Room beside the figures: small, so two figures make a pill only a little wider than a circle. */
private val BADGE_PAD_H = 3.dp

/** A badge's height for its font size: 16 dp at the 11 sp label. */
private const val BADGE_EM = 1.45f

/** Figures stand about 0.7 em on the baseline; half of that is their middle. */
private const val FIGURE_HALF_EM = 0.36f
