package app.core.feature.auth.welcome

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.lerp
import app.core.ui.theme.Contrast
import app.core.ui.theme.DarkSemantic

/**
 * The welcome's own colours: it is drawn the same in the light and the dark
 * theme. The scene's gradient comes from the brand ([WelcomeColors]); the
 * text over it is white, with a soft scrim behind it exactly as dark as the
 * gradient there needs for WCAG AA ([scrimAlpha]).
 */
object WelcomePalette {

    /**
     * Where the gradient's colours sit (0 top, 1 bottom), and what lies
     * between: the sky only at the very top, the warm middle reached by the
     * headline, the deep bottom under the buttons.
     */
    fun stops(colors: WelcomeColors): Array<Pair<Float, Color>> = arrayOf(
        0f to colors.top,
        0.05f to lerp(colors.top, colors.middle, 0.3f),
        0.13f to lerp(colors.top, colors.middle, 0.72f),
        0.24f to colors.middle,
        0.42f to lerp(colors.middle, colors.bottom, 0.38f),
        0.62f to lerp(colors.middle, colors.bottom, 0.74f),
        0.82f to colors.bottom,
        1f to colors.bottom,
    )

    /** The gradient's colour at [fraction] of the height. */
    fun colorAt(colors: WelcomeColors, fraction: Float): Color {
        val stops = stops(colors)
        val f = fraction.coerceIn(0f, 1f)
        for (k in 1 until stops.size) {
            val (end, endColor) = stops[k]
            if (f <= end) {
                val (start, startColor) = stops[k - 1]
                val span = end - start
                return if (span <= 0f) endColor else lerp(startColor, endColor, (f - start) / span)
            }
        }
        return stops.last().second
    }

    /** The scrim's colour: the gradient's own deepest, so it reads as part of it. */
    fun scrim(colors: WelcomeColors): Color = colors.bottom

    /** White text, at the alphas the welcome uses. */
    val Headline = Color.White
    val Eyebrow = Color.White.copy(alpha = 0.94f)
    val Subtitle = Color.White.copy(alpha = 0.9f)
    val Terms = Color.White.copy(alpha = 0.80f)

    /** The headline's least bright fill: white, or the end of the Persian emphasis gradient. */
    fun headlineInk(persian: Boolean): Color = if (persian) WelcomeType.WarmEnd else Headline

    /**
     * The least opacity of [scrim] over [background] at which [text] (with
     * its own alpha, composited) reaches [ratio]. 0 when the background is
     * dark enough already; capped at 0.9.
     */
    fun scrimAlpha(background: Color, text: Color, scrim: Color, ratio: Double): Float {
        fun passes(alpha: Float): Boolean {
            val under = scrim.copy(alpha = alpha).compositeOver(background)
            return Contrast.ratio(text.compositeOver(under), under) >= ratio
        }
        if (passes(0f)) return 0f
        var low = 0f
        var high = 0.9f
        if (!passes(high)) return high
        repeat(14) {
            val mid = (low + high) / 2f
            if (passes(mid)) high = mid else low = mid
        }
        return high
    }

    /**
     * The scrim [text] needs to reach [ratio] anywhere between [top] and
     * [bottom] (fractions of the height), sampled down the span.
     */
    fun scrimOver(colors: WelcomeColors, top: Float, bottom: Float, text: Color, ratio: Double): Float {
        var need = 0f
        val scrim = scrim(colors)
        for (s in 0..SAMPLES) {
            val f = top + (bottom - top) * s / SAMPLES
            need = maxOf(need, scrimAlpha(colorAt(colors, f), text, scrim, ratio))
        }
        return need
    }

    /** Normal text: AA with a margin. */
    const val SMALL_TEXT: Double = Contrast.AA + 0.3

    /** The headline is large text (24 sp and up): AA for large text, with a margin. */
    const val LARGE_TEXT: Double = Contrast.AA_LARGE + 0.3

    /**
     * The eyebrow's glass pill: as dark as the eyebrow needs anywhere in the
     * top fifth of the screen (where it sits, whatever the text size), and
     * never less than a visible tint.
     */
    fun eyebrowPill(colors: WelcomeColors): Float = maxOf(0.28f, scrimOver(colors, 0f, 0.22f, Eyebrow, SMALL_TEXT))

    private const val SAMPLES = 8

    // MARK: - Buttons on the scene

    val LightPill = Color(0xFFFFF6F3)
    val OnLightPill = Color(0xFF2B0A0E)
    val DarkPill = Color(0xFF16060A)
    val OnDarkPill = Color.White

    // MARK: - The sheet

    /** The sheet: a dark warm brown, a little lighter at its top. */
    val SheetTop = Color(0xFF6E3324)
    val SheetBottom = Color(0xFF2A120D)
    val SheetText = Color.White
    val SheetTextSecondary = Color(0xFFF1DDD6)
    val SheetLink = Color(0xFFFFDCC9)
    val SheetField = Color.White.copy(alpha = 0.10f)
    val SheetFieldBorder = Color.White.copy(alpha = 0.22f)
    val SheetChip = Color.White.copy(alpha = 0.14f)
    val SheetPlaceholder = Color.White.copy(alpha = 0.72f)

    /** Material's roles inside the sheet, so the code boxes, messages and pickers fit it. */
    fun sheetScheme(): ColorScheme = darkColorScheme(
        primary = SheetLink,
        onPrimary = SheetBottom,
        primaryContainer = Color(0xFF8A4632),
        onPrimaryContainer = Color.White,
        secondary = SheetTextSecondary,
        onSecondary = SheetBottom,
        background = SheetBottom,
        onBackground = SheetText,
        surface = Color(0xFF3B1A12),
        onSurface = SheetText,
        surfaceVariant = Color(0xFF4F2A20),
        onSurfaceVariant = SheetTextSecondary,
        surfaceContainerLowest = SheetBottom,
        surfaceContainerLow = Color(0xFF4A251B),
        surfaceContainer = Color(0xFF52291E),
        surfaceContainerHigh = Color(0xFF5C3024),
        surfaceContainerHighest = Color(0xFF66372A),
        outline = Color(0xFFC9A79C),
        outlineVariant = Color(0xFF7A5245),
        error = DarkSemantic.danger,
        onError = Color(0xFF690005),
        inverseSurface = Color(0xFFFFF6F3),
        inverseOnSurface = SheetBottom,
    )
}
