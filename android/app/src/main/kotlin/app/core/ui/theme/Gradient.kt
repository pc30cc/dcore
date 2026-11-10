package app.core.ui.theme

import android.graphics.ComposeShader
import android.graphics.Matrix
import android.graphics.PorterDuff
import android.graphics.RadialGradient
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toArgb
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sin

/**
 * A CSS `linear-gradient` at [angle] (0° points up, 90° right), spanning the
 * box the way CSS does: the gradient line runs through the centre and is
 * long enough that the two far corners get the first and last colours.
 * Physical, like CSS: it does not mirror in a right-to-left layout.
 * [stops] are positions from 0 to 1, one per colour.
 */
@Immutable
class CssLinearGradient(
    val angle: Float,
    val colors: List<Color>,
    val stops: List<Float>,
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

    override fun toString(): String = "CssLinearGradient($angle, $colors, $stops)"
}

/** A CSS linear gradient from `position to colour` pairs. */
fun cssLinearGradient(angle: Float, vararg stops: Pair<Float, Color>): Brush =
    CssLinearGradient(angle, stops.map { it.second }, stops.map { it.first })

/** The three-stop "yes" gradient (start 0 %, middle 52 %, end 100 %) at [angle]. */
fun cssLinearGradient(angle: Float, stops: GradientStops): Brush =
    CssLinearGradient(angle, listOf(stops.start, stops.mid, stops.end), listOf(0f, 0.52f, 1f))

/** An evenly spaced gradient of [colors] at [angle]. */
fun cssLinearGradient(angle: Float, colors: List<Color>): Brush =
    CssLinearGradient(angle, colors, colors.indices.map { if (colors.size == 1) 0f else it / (colors.size - 1f) })

/**
 * The icon gradient (an SVG `objectBoundingBox` gradient from the top-right
 * corner to the bottom-left one), used to fill line icons and the verified
 * badge. Physical: the same corners in both directions.
 */
@Immutable
class IconGradient(val colors: List<Color>, val stops: List<Float>) : ShaderBrush() {
    override fun createShader(size: Size): Shader =
        LinearGradientShader(from = Offset(size.width, 0f), to = Offset(0f, size.height), colors = colors, colorStops = stops)

    override fun equals(other: Any?): Boolean = other is IconGradient && other.colors == colors && other.stops == stops

    override fun hashCode(): Int = colors.hashCode() * 31 + stops.hashCode()

    override fun toString(): String = "IconGradient($colors, $stops)"
}

fun iconGradient(vararg stops: Pair<Float, Color>): Brush = IconGradient(stops.map { it.second }, stops.map { it.first })

/** How far a radial layer reaches. */
sealed interface RadialSize {
    /** CSS `circle` without a size: to the farthest corner of the box. */
    data object FarthestCorner : RadialSize

    /** CSS `<x>% <y>%`: an ellipse with these radii, as fractions of the box's width and height. */
    data class Ellipse(val rx: Float, val ry: Float) : RadialSize
}

/** One CSS `radial-gradient` layer: its size, its centre (fractions of the box) and its stops. */
@Immutable
data class RadialLayer(val size: RadialSize, val cx: Float, val cy: Float, val stops: List<Pair<Float, Color>>)

/**
 * CSS `radial-gradient` layers, the first one on top (CSS background order),
 * composed in a single shader.
 */
@Immutable
class CssRadialGradients(val layers: List<RadialLayer>) : ShaderBrush() {
    override fun createShader(size: Size): Shader {
        val shaders = layers.map { layer(it, size) }
        // CSS paints the first layer on top: compose from the bottom up.
        return shaders.reversed().reduce { below, above -> ComposeShader(below, above, PorterDuff.Mode.SRC_OVER) }
    }

    private fun layer(layer: RadialLayer, size: Size): Shader {
        val cx = layer.cx * size.width
        val cy = layer.cy * size.height
        val colors = layer.stops.map { it.second.toArgb() }.toIntArray()
        val positions = layer.stops.map { it.first }.toFloatArray()
        return when (val s = layer.size) {
            RadialSize.FarthestCorner -> {
                val r = max(
                    max(hypot(cx, cy), hypot(size.width - cx, cy)),
                    max(hypot(cx, size.height - cy), hypot(size.width - cx, size.height - cy)),
                ).coerceAtLeast(1f)
                RadialGradient(cx, cy, r, colors, positions, android.graphics.Shader.TileMode.CLAMP)
            }
            is RadialSize.Ellipse -> {
                val rx = (s.rx * size.width).coerceAtLeast(1f)
                val ry = (s.ry * size.height).coerceAtLeast(1f)
                RadialGradient(cx, cy, rx, colors, positions, android.graphics.Shader.TileMode.CLAMP).apply {
                    setLocalMatrix(Matrix().apply { setScale(1f, ry / rx, cx, cy) })
                }
            }
        }
    }

    override fun equals(other: Any?): Boolean = other is CssRadialGradients && other.layers == layers

    override fun hashCode(): Int = layers.hashCode()

    override fun toString(): String = "CssRadialGradients($layers)"
}

fun cssRadialGradients(vararg layers: RadialLayer): Brush = CssRadialGradients(layers.toList())

/** The colour a paint shows where one colour has to stand for it (a solid fill, or the gradient's middle stop). */
val Brush.representative: Color
    get() = when (this) {
        is SolidColor -> value
        is CssLinearGradient -> colors[colors.size / 2]
        is IconGradient -> colors[colors.size / 2]
        is CssRadialGradients -> layers.first().stops.first().second
        else -> Color.Unspecified
    }

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
