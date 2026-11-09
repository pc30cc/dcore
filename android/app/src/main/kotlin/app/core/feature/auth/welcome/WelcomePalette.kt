package app.core.feature.auth.welcome

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.lerp
import app.core.ui.theme.Contrast
import app.core.ui.theme.AppColors
import app.core.ui.theme.DarkSemantic
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The welcome's own colours: it is drawn the same in the light and the dark
 * theme. The scene's gradient comes from the brand ([WelcomeColors]); the
 * text over it is white, with a soft warm glow behind it exactly as dense as
 * the gradient there needs for WCAG AA ([scrimProfile]).
 */
object WelcomePalette {

    /**
     * Where the gradient's colours sit (0 top, 1 bottom), and what lies
     * between: the sky only at the very top, through a peach glow into the
     * brand's middle colour, then a deep crimson and a wine into the bottom,
     * darker still at the very end. The in-between colours are derived in
     * Oklab from the brand's three, so a brand's own gradient keeps the shape.
     */
    fun stops(colors: WelcomeColors): Array<Pair<Float, Color>> {
        val glow = oklab(colors.middle, lightness = 1.12f, hueDegrees = 12f, chroma = 0.95f)
        val deep = deep(colors)
        return arrayOf(
            0f to colors.top,
            0.05f to lerp(colors.top, colors.middle, 0.22f),
            0.10f to lerp(colors.top, glow, 0.62f),
            0.16f to glow,
            0.27f to colors.middle,
            0.41f to deep,
            0.55f to lerp(deep, colors.bottom, 0.45f),
            0.70f to colors.bottom,
            1f to oklab(colors.bottom, lightness = 0.7f),
        )
    }

    /** The gradient's colour at [fraction] of the height. */
    fun colorAt(colors: WelcomeColors, fraction: Float): Color = colorAt(stops(colors), fraction)

    fun colorAt(stops: Array<Pair<Float, Color>>, fraction: Float): Color {
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

    /**
     * [color] moved in Oklab: its lightness and chroma scaled, its hue turned
     * by [hueDegrees] (negative toward red from an orange).
     */
    fun oklab(color: Color, lightness: Float = 1f, hueDegrees: Float = 0f, chroma: Float = 1f): Color {
        val lab = color.convert(ColorSpaces.Oklab)
        val a = lab.green
        val b = lab.blue
        val c = sqrt(a * a + b * b) * chroma
        val h = atan2(b, a) + hueDegrees * (PI.toFloat() / 180f)
        return Color(
            (lab.red * lightness).coerceIn(0f, 1f),
            (c * cos(h)).coerceIn(-0.5f, 0.5f),
            (c * sin(h)).coerceIn(-0.5f, 0.5f),
            color.alpha,
            ColorSpaces.Oklab,
        ).convert(ColorSpaces.Srgb)
    }

    /** The gradient's crimson: the brand's middle, darker and turned a little toward red. */
    fun deep(colors: WelcomeColors): Color = oklab(colors.middle, lightness = 0.72f, hueDegrees = -10f)

    /**
     * The scrim's colour: the gradient's own crimson ([deep]), so the text's
     * backing reads as a deeper, burnt part of the same sunset, not as grey
     * or brown over it. Taken darker, toward the bottom, only for a brand
     * whose colours are too light for white text even through a dense scrim.
     */
    fun scrim(colors: WelcomeColors): Color {
        val base = deep(colors)
        val lightest = (0..9).map { colorAt(colors, it * 0.05f) }.maxBy { Contrast.luminance(it) }
        for (step in 0..20) {
            val candidate = lerp(base, colors.bottom, step / 20f)
            val under = candidate.copy(alpha = MAX_SCRIM).compositeOver(lightest)
            if (Contrast.ratio(Subtitle.compositeOver(under), under) >= SMALL_TEXT) return candidate
        }
        return colors.bottom
    }

    /** White text, at the alphas the welcome uses. */
    val Headline = Color.White
    val Eyebrow = Color.White.copy(alpha = 0.94f)
    val Subtitle = Color.White.copy(alpha = 0.92f)
    val Terms = Color.White.copy(alpha = 0.72f)

    /** The headline's least bright fill: white, or the end of the Persian emphasis gradient. */
    fun headlineInk(persian: Boolean): Color = if (persian) WelcomeType.WarmEnd else Headline

    /**
     * The least opacity of [scrim] over [background] at which [text] (with
     * its own alpha, composited) reaches [ratio]. 0 when the background is
     * dark enough already; capped at [MAX_SCRIM].
     */
    fun scrimAlpha(background: Color, text: Color, scrim: Color, ratio: Double): Float {
        fun passes(alpha: Float): Boolean {
            val under = scrim.copy(alpha = alpha).compositeOver(background)
            return Contrast.ratio(text.compositeOver(under), under) >= ratio
        }
        if (passes(0f)) return 0f
        var low = 0f
        var high = MAX_SCRIM
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
        val stops = stops(colors)
        for (s in 0..SAMPLES) {
            val f = top + (bottom - top) * s / SAMPLES
            need = maxOf(need, scrimAlpha(colorAt(stops, f), text, scrim, ratio))
        }
        return need
    }

    /** Normal text: AA with a margin. */
    const val SMALL_TEXT: Double = Contrast.AA + 0.3

    /** The headline is large text (24 sp and up): AA for large text, with a margin. */
    const val LARGE_TEXT: Double = Contrast.AA_LARGE + 0.3

    /** The densest the scrim gets. */
    const val MAX_SCRIM = 0.92f

    private const val SAMPLES = 8

    /**
     * The soft glow of [scrim] behind the text on a [width] x [height]
     * scene: each run of text in [lines] gets the opacity its ink needs
     * there, over its own width; the rows between and around are eased, so
     * the glow has no edge and hugs the text instead of crossing the screen.
     * Null when the gradient needs none. Pixels and dp as the scene's.
     */
    fun scrimProfile(colors: WelcomeColors, lines: List<ScrimLine>, width: Float, height: Float, density: Float): ScrimProfile? {
        val visible = lines.filter { it.rect.height > 0f && it.rect.width > 0f }
        if (visible.isEmpty() || height <= 0f || width <= 0f) return null
        val needs = visible.map { scrimOver(colors, it.rect.top / height, it.rect.bottom / height, it.ink, it.ratio) }
        if (needs.all { it <= 0f }) return null
        val step = ROW_DP * density
        val reach = (SCRIM_REACH_DP / ROW_DP).toInt()
        val top = visible.minOf { it.rect.top } - 2 * reach * step
        val bottom = visible.maxOf { it.rect.bottom } + 2 * reach * step
        val rows = ((bottom - top) / step).toInt() + 2
        val alpha = FloatArray(rows)
        val pad = SCRIM_PAD_DP * density
        // The text is centred on the screen.
        val centerX = width / 2f
        for (row in 0 until rows) {
            val y = top + row * step
            visible.forEachIndexed { k, line ->
                // A row counts for a line when it crosses it at all, so its glyphs' edges are covered too.
                if (y + step >= line.rect.top && y - step <= line.rect.bottom) alpha[row] = maxOf(alpha[row], needs[k])
            }
        }
        // Widened by the reach, then eased twice by half of it: every row of text keeps at least what
        // it needs, and the glow fades out over twice the reach around the text.
        val smoothAlpha = soften(alpha, reach)
        // Its outline: one smooth oval around the whole block, as narrow as still holds every line's
        // corners (padded), instead of a shape that steps with each line's width.
        val blockTop = visible.minOf { it.rect.top } - pad
        val blockBottom = visible.maxOf { it.rect.bottom } + pad
        val centerY = (blockTop + blockBottom) / 2f
        val semiY = (blockBottom - blockTop) / 2f * OVAL_TALL
        var semiX = 0f
        for (line in visible) {
            val dx = maxOf(abs(line.rect.left - centerX), abs(line.rect.right - centerX)) + pad
            for (y in floatArrayOf(line.rect.top, line.rect.bottom)) {
                val dy = (y - centerY) / semiY
                semiX = maxOf(semiX, dx / sqrt((1f - dy * dy).coerceAtLeast(0.05f)))
            }
        }
        val smoothHalf = FloatArray(rows) { row ->
            val dy = (top + row * step - centerY) / semiY
            if (dy * dy >= 1f) 0f else semiX * sqrt(1f - dy * dy)
        }
        // The glow fades out by the screen's sides where there is room, so the gradient shows there at full strength.
        val room = width / 2f - (smoothHalf.maxOrNull() ?: 0f)
        val fade = room.coerceIn(SCRIM_FADE_MIN_DP * density, SCRIM_FADE_DP * density)
        return ScrimProfile(
            color = scrim(colors),
            top = top,
            step = step,
            alpha = smoothAlpha,
            halfWidth = smoothHalf,
            centerX = centerX,
            fade = fade,
        )
    }

    private fun soften(values: FloatArray, reach: Int): FloatArray {
        val widened = FloatArray(values.size) { i ->
            var m = 0f
            for (j in maxOf(0, i - reach)..minOf(values.lastIndex, i + reach)) m = maxOf(m, values[j])
            m
        }
        val half = maxOf(1, reach / 2)
        return box(box(widened, half), half)
    }

    private fun box(values: FloatArray, radius: Int): FloatArray = FloatArray(values.size) { i ->
        var sum = 0f
        for (j in i - radius..i + radius) sum += values.getOrElse(j) { 0f }
        sum / (2 * radius + 1)
    }

    private const val ROW_DP = 2f
    private const val SCRIM_REACH_DP = 26f
    private const val SCRIM_PAD_DP = 10f
    private const val SCRIM_FADE_DP = 56f
    private const val SCRIM_FADE_MIN_DP = 28f

    /** How much taller than the text block the glow's oval is. */
    private const val OVAL_TALL = 1.3f

    // MARK: - Buttons on the scene

    val LightPill = Color(0xFFFFF6F3)
    val OnLightPill = Color(0xFF2B0A0E)

    /** A light pill's word while it cannot be pressed: faded mauve (disabled controls are exempt from contrast). */
    val DisabledOnLightPill = Color(0xFF9C7E86)
    val DarkPill = Color(0xFF16060A)

    /** Sign up: [DarkPill] as smoked glass, the bubbles faintly behind it. */
    val DarkGlass = DarkPill.copy(alpha = 0.78f)
    val OnDarkPill = Color.White

    // MARK: - The sheet

    /** The sheet: a rich rust at its top into a dark warm brown. */
    val SheetTop = Color(0xFF883927)
    val SheetMiddle = Color(0xFF5C2417)
    val SheetBottom = Color(0xFF280E0A)
    val sheetStops: Array<Pair<Float, Color>> = arrayOf(0f to SheetTop, 0.45f to SheetMiddle, 1f to SheetBottom)

    /** The sheet's colour at [fraction] of its height. */
    fun sheetColorAt(fraction: Float): Color = colorAt(sheetStops, fraction)
    val SheetText = Color.White
    val SheetTextSecondary = Color(0xFFF1DDD6)
    val SheetLink = Color(0xFFFFDCC9)
    val SheetField = Color.White.copy(alpha = 0.10f)
    val SheetChip = Color.Black.copy(alpha = 0.22f)
    val SheetPlaceholder = Color.White.copy(alpha = 0.82f)

    /** Messages on the warm sheet: lighter than the app's ink-theme error and success, which it is not. */
    val SheetError = Color(0xFFFFB4AB)
    val SheetSuccess = Color(0xFF4ADE9B)

    /** The app's colours inside the sheet: the dark set with the sheet's own error and success. */
    val SheetColors: AppColors by lazy { DarkSemantic.copy(danger = SheetError, success = SheetSuccess) }

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
        error = SheetError,
        onError = Color(0xFF690005),
        inverseSurface = Color(0xFFFFF6F3),
        inverseOnSurface = SheetBottom,
    )
}

/** A run of text on the scene (scene pixels), its least bright ink and the contrast it needs. */
class ScrimLine(val rect: Rect, val ink: Color, val ratio: Double)

/**
 * The glow behind the text: per row from [top] (every [step] pixels) its
 * opacity at full strength and the half width (from [centerX]) it keeps
 * that over; beyond, it fades out over [fade].
 */
class ScrimProfile(
    val color: Color,
    val top: Float,
    val step: Float,
    val alpha: FloatArray,
    val halfWidth: FloatArray,
    val centerX: Float,
    val fade: Float,
) {
    val bottom: Float get() = top + step * (alpha.size - 1)

    /** The glow's opacity at ([x], [y]). */
    fun alphaAt(x: Float, y: Float): Float {
        val position = (y - top) / step
        if (position < 0f || position > alpha.lastIndex) return 0f
        val row = position.toInt().coerceAtMost(alpha.lastIndex - 1).coerceAtLeast(0)
        val t = (position - row).coerceIn(0f, 1f)
        val a = alpha[row] + (alpha[row + 1] - alpha[row]) * t
        val half = halfWidth[row] + (halfWidth[row + 1] - halfWidth[row]) * t
        val beyond = kotlin.math.abs(x - centerX) - half
        if (beyond <= 0f) return a
        val k = (1f - beyond / fade).coerceIn(0f, 1f)
        return a * k * k * (3f - 2f * k)
    }
}
