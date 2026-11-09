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
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import app.core.R
import app.core.ui.theme.AppTheme

/**
 * The logo mark: two overlapping circles (violet and pink, from the brand's
 * gradient) with a white lens where they meet. 24 / 34 / 40 / 44 / 56 dp;
 * keep a quarter of its size clear around it. [mono] is for the gradient or
 * a photo behind it: white circles at 55 % and a solid lens. Never shown
 * with a name or a placeholder label. Decorative unless [contentDescription]
 * is given.
 */
@Composable
fun LogoMark(size: Dp, modifier: Modifier = Modifier, mono: Boolean = false, contentDescription: String? = null) {
    val stops = AppTheme.colors.gradientStops
    val described = if (contentDescription != null) Modifier.semantics { this.contentDescription = contentDescription } else Modifier
    Canvas(modifier.size(size).then(described)) {
        val w = this.size.width
        val r = w * 0.30f
        val cy = this.size.height / 2
        val left = Offset(w / 2 - r * 0.5f, cy)
        val right = Offset(w / 2 + r * 0.5f, cy)
        val a = Path().apply { addOval(androidx.compose.ui.geometry.Rect(left, r)) }
        val b = Path().apply { addOval(androidx.compose.ui.geometry.Rect(right, r)) }
        val lens = Path().apply { op(a, b, PathOperation.Intersect) }
        if (mono) {
            drawPath(a, Color.White.copy(alpha = 0.55f))
            drawPath(b, Color.White.copy(alpha = 0.55f))
        } else {
            drawPath(a, Brush.linearGradient(listOf(lerp(stops.start, Color.White, 0.25f), lerp(stops.start, Color.Black, 0.1f)), start = Offset(left.x, cy - r), end = Offset(left.x, cy + r)))
            drawPath(b, Brush.linearGradient(listOf(lerp(stops.end, Color.White, 0.25f), lerp(stops.end, Color.Black, 0.05f)), start = Offset(right.x, cy - r), end = Offset(right.x, cy + r)))
        }
        drawPath(lens, Color.White)
    }
}

/** Older name of [LogoMark], for the screens not yet restyled. */
@Composable
fun BrandMark(size: Dp, modifier: Modifier = Modifier) {
    LogoMark(size, modifier)
}

/** The mark with TalkBack's «نشانه», where it stands alone at the top of a screen. */
@Composable
fun LogoMarkLabelled(size: Dp, modifier: Modifier = Modifier, mono: Boolean = false) {
    LogoMark(size, modifier, mono, stringResource(R.string.ui_logo))
}
