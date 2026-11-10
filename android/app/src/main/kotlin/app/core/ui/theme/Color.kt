package app.core.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import app.core.BuildConfig
import kotlin.math.pow

/** The three stops of the "yes" gradient. */
@Immutable
data class GradientStops(val start: Color, val mid: Color, val end: Color)

/**
 * The colours a brand sets (brand.json `colors`, through BuildConfig), in both
 * themes: the accent and its label (`brand`, `onBrand`), the "yes" gradient,
 * the "alive" accent and its text form. Optional roles the brand leaves out
 * take the design's own values ([Design]). The templates draw their accent
 * group from them ([Templates.of]: `brand` and the gradients; a brand that
 * keeps the design's values gets the templates exactly as designed); the
 * alive roles feed the launcher and the website.
 */
@Immutable
data class BrandColors(
    val brandLight: Color,
    val brandDark: Color,
    val onBrandLight: Color,
    val onBrandDark: Color,
    val gradientLight: GradientStops = Design.gradientLight,
    val gradientDark: GradientStops = Design.gradientDark,
    val aliveLight: Color = Design.aliveLight,
    val aliveDark: Color = Design.aliveDark,
    val aliveTextLight: Color = Design.aliveTextLight,
    val aliveTextDark: Color = Design.aliveTextDark,
) {
    companion object {
        /** The design's own colours. */
        val Design = BrandColors(
            brandLight = Color(0xFF6A1FF0),
            brandDark = Color(0xFFB48CFF),
            onBrandLight = Color(0xFFFFFFFF),
            onBrandDark = Color(0xFF21003F),
            gradientLight = GradientStops(Color(0xFF7B2BFF), Color(0xFFC21FD0), Color(0xFFE0157A)),
            gradientDark = GradientStops(Color(0xFF7B2BFF), Color(0xFFC21FD0), Color(0xFFE0157A)),
            aliveLight = Color(0xFFC6FF33),
            aliveDark = Color(0xFFC6FF33),
            aliveTextLight = Color(0xFF4F6B00),
            aliveTextDark = Color(0xFFC6FF33),
        )

        /** BuildConfig's long, or [fallback] when the brand left the role out (0). */
        private fun built(value: Long, fallback: Color): Color = if (value == 0L) fallback else Color(value)

        /** This build's brand. */
        val Build: BrandColors by lazy {
            BrandColors(
                brandLight = Color(BuildConfig.BRAND_PRIMARY_LIGHT),
                brandDark = Color(BuildConfig.BRAND_PRIMARY_DARK),
                onBrandLight = Color(BuildConfig.BRAND_ON_PRIMARY_LIGHT),
                onBrandDark = Color(BuildConfig.BRAND_ON_PRIMARY_DARK),
                gradientLight = GradientStops(
                    built(BuildConfig.BRAND_GRADIENT_START_LIGHT, Design.gradientLight.start),
                    built(BuildConfig.BRAND_GRADIENT_MID_LIGHT, Design.gradientLight.mid),
                    built(BuildConfig.BRAND_GRADIENT_END_LIGHT, Design.gradientLight.end),
                ),
                gradientDark = GradientStops(
                    built(BuildConfig.BRAND_GRADIENT_START_DARK, Design.gradientDark.start),
                    built(BuildConfig.BRAND_GRADIENT_MID_DARK, Design.gradientDark.mid),
                    built(BuildConfig.BRAND_GRADIENT_END_DARK, Design.gradientDark.end),
                ),
                aliveLight = built(BuildConfig.BRAND_ALIVE_LIGHT, Design.aliveLight),
                aliveDark = built(BuildConfig.BRAND_ALIVE_DARK, Design.aliveDark),
                aliveTextLight = built(BuildConfig.BRAND_ALIVE_TEXT_LIGHT, Design.aliveTextLight),
                aliveTextDark = built(BuildConfig.BRAND_ALIVE_TEXT_DARK, Design.aliveTextDark),
            )
        }
    }
}

/** WCAG 2.x contrast, on sRGB colours. */
object Contrast {
    /** Normal text (WCAG 1.4.3, level AA). */
    const val AA: Double = 4.5

    /** Large text and non-text UI (WCAG 1.4.3 large, 1.4.11). */
    const val AA_LARGE: Double = 3.0

    fun luminance(color: Color): Double {
        fun channel(c: Float): Double {
            val v = c.toDouble()
            return if (v <= 0.04045) v / 12.92 else ((v + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue)
    }

    fun ratio(a: Color, b: Color): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (maxOf(la, lb) + 0.05) / (minOf(la, lb) + 0.05)
    }

    /**
     * [color], moved toward [toward] in 1 % steps just until it reaches [min]
     * against every colour in [against]. Unchanged when it already does.
     *
     * When no step reaches it (a brand whose colours fight each other), the
     * step with the best worst-case contrast is returned, and `ContrastTest`
     * fails the build for that brand: the brand needs other colours, which is
     * a designer's call, not this function's.
     */
    fun ensure(color: Color, against: List<Color>, min: Double, toward: Color): Color {
        var best = color
        var bestWorst = -1.0
        for (step in 0..100) {
            val candidate = lerp(color, toward, step / 100f)
            val worst = against.minOf { ratio(candidate, it) }
            if (worst >= min) return candidate
            if (worst > bestWorst) {
                best = candidate
                bestWorst = worst
            }
        }
        return best
    }

    /**
     * Which way a container must move to read better under [label]: toward
     * black under a light label, toward white under a dark one. 0.179 is the
     * luminance at which black and white text contrast equally.
     */
    fun awayFrom(label: Color): Color = if (luminance(label) >= 0.179) Color.Black else Color.White
}
