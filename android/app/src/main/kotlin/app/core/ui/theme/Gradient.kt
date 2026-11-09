package app.core.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.LinearGradientShader
import androidx.compose.ui.graphics.Shader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.graphicsLayer
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/**
 * A linear gradient at a CSS angle (0° points up, 90° right), spanning the
 * box the way CSS does: the gradient line runs through the centre and is
 * long enough that the two far corners get the first and last colours.
 * Physical, like CSS: it does not mirror in a right-to-left layout.
 */
@Immutable
private class CssLinearGradient(
    private val angle: Float,
    private val colors: List<Color>,
    private val stops: List<Float>?,
) : ShaderBrush() {
    override fun createShader(size: Size): Shader {
        val radians = Math.toRadians(angle.toDouble())
        val dx = sin(radians).toFloat()
        val dy = -cos(radians).toFloat()
        val half = (abs(size.width * dx) + abs(size.height * dy)) / 2f
        val cx = size.width / 2f
        val cy = size.height / 2f
        return LinearGradientShader(
            from = Offset(cx - dx * half, cy - dy * half),
            to = Offset(cx + dx * half, cy + dy * half),
            colors = colors,
            colorStops = stops,
        )
    }

    override fun equals(other: Any?): Boolean =
        other is CssLinearGradient && other.angle == angle && other.colors == colors && other.stops == stops

    override fun hashCode(): Int = (angle.hashCode() * 31 + colors.hashCode()) * 31 + stops.hashCode()
}

/** The three-stop "yes" gradient (start 0 %, middle 52 %, end 100 %) at [angle]. */
fun cssLinearGradient(angle: Float, stops: GradientStops): Brush =
    CssLinearGradient(angle, listOf(stops.start, stops.mid, stops.end), listOf(0f, 0.52f, 1f))

/** An evenly spaced gradient of [colors] at [angle]. */
fun cssLinearGradient(angle: Float, colors: List<Color>): Brush = CssLinearGradient(angle, colors, null)

/**
 * Paints what this element draws (an icon, a line glyph, text) with [brush]
 * instead of its own colour: the content is the mask. Draw the content in any
 * opaque colour.
 */
fun Modifier.brushTint(brush: Brush): Modifier =
    graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
        .drawWithContent {
            drawContent()
            drawRect(brush, blendMode = BlendMode.SrcIn)
        }
