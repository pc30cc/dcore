package app.core.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import app.core.ui.theme.AppTheme

/**
 * The logo mark: two overlapping circles (`--mark-a*` violet and `--mark-b*`
 * pink, the same in every template) with a `--mark-lens` lens where they
 * meet. 24 / 34 / 40 / 44 / 56 dp;
 * keep a quarter of its size clear around it. [mono] is for the gradient or
 * a photo behind it: white circles at 55 % and a solid lens. Never shown
 * with a name or a placeholder label. Decorative unless [contentDescription]
 * is given.
 */
@Composable
fun LogoMark(size: Dp, modifier: Modifier = Modifier, mono: Boolean = false, contentDescription: String? = null) {
    val c = AppTheme.template.colors
    val described = if (contentDescription != null) Modifier.semantics { this.contentDescription = contentDescription } else Modifier
    Canvas(modifier.size(size).then(described)) {
        // The mark's 40-unit board: two circles of radius 11 at x 15 and 25, the lens where they meet.
        val w = this.size.width
        val r = w * MARK_RADIUS
        val cy = this.size.height / 2
        val left = Offset(w / 2 - w * MARK_OFFSET, cy)
        val right = Offset(w / 2 + w * MARK_OFFSET, cy)
        val a = Path().apply { addOval(androidx.compose.ui.geometry.Rect(left, r)) }
        val b = Path().apply { addOval(androidx.compose.ui.geometry.Rect(right, r)) }
        val lens = Path().apply { op(a, b, PathOperation.Intersect) }
        if (mono) {
            drawPath(a, Color.White.copy(alpha = 0.55f))
            drawPath(b, Color.White.copy(alpha = 0.55f))
        } else {
            // Each circle's gradient runs over its own box, top-left to bottom-right.
            drawPath(a, Brush.linearGradient(listOf(c.markA1, c.markA2), start = Offset(left.x - r, cy - r), end = Offset(left.x + r, cy + r)))
            drawPath(b, Brush.linearGradient(listOf(c.markB1, c.markB2), start = Offset(right.x - r, cy - r), end = Offset(right.x + r, cy + r)))
        }
        drawPath(lens, c.markLens)
    }
}

private const val MARK_RADIUS = 11f / 40f
private const val MARK_OFFSET = 5f / 40f

/** Older name of [LogoMark], for the screens not yet restyled. */
@Composable
fun BrandMark(size: Dp, modifier: Modifier = Modifier) {
    LogoMark(size, modifier)
}

