package app.core.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import app.core.BuildConfig
import kotlin.math.pow

/** The brand's two colours in both themes, from brand.json (through BuildConfig). */
@Immutable
data class BrandColors(
    val brandLight: Color,
    val brandDark: Color,
    val onBrandLight: Color,
    val onBrandDark: Color,
) {
    companion object {
        val Build = BrandColors(
            brandLight = Color(BuildConfig.BRAND_PRIMARY_LIGHT),
            brandDark = Color(BuildConfig.BRAND_PRIMARY_DARK),
            onBrandLight = Color(BuildConfig.BRAND_ON_PRIMARY_LIGHT),
            onBrandDark = Color(BuildConfig.BRAND_ON_PRIMARY_DARK),
        )
    }
}

/**
 * The fixed colours: warm neutrals and the semantic colours. Chosen
 * so that every text pair passes WCAG AA (4.5:1) in its theme; `ContrastTest`
 * checks it, the brand-derived ones included.
 */
object Palette {
    object Light {
        val background = Color(0xFFFFFBFA)
        val surface = Color(0xFFFFFFFF)
        val surfaceContainerLow = Color(0xFFFBF5F4)
        val surfaceContainer = Color(0xFFF5EFEE)
        val surfaceContainerHigh = Color(0xFFEFE8E7)
        val surfaceContainerHighest = Color(0xFFE9E2E1)
        val text = Color(0xFF1D1517)
        val textSecondary = Color(0xFF5C5255)
        val outline = Color(0xFF8C8285)
        val outlineVariant = Color(0xFFD8CFD1)
        val neutralAccent = Color(0xFF5F5559)
        val neutralAccentContainer = Color(0xFFEDE3E6)
        val onNeutralAccentContainer = Color(0xFF2A2125)
    }

    object Dark {
        val background = Color(0xFF121013)
        val surface = Color(0xFF19161A)
        val surfaceContainerLow = Color(0xFF1D1A1E)
        val surfaceContainer = Color(0xFF221E23)
        val surfaceContainerHigh = Color(0xFF2A2529)
        val surfaceContainerHighest = Color(0xFF332D32)
        val text = Color(0xFFF4EEF0)
        val textSecondary = Color(0xFFCDC3C7)
        val outline = Color(0xFF978C91)
        val outlineVariant = Color(0xFF3E373C)
        val neutralAccent = Color(0xFFD3C6CB)
        val neutralAccentContainer = Color(0xFF3B3337)
        val onNeutralAccentContainer = Color(0xFFF0E4E8)
    }
}

/**
 * The colours Material has no role for: the swipe actions and statuses.
 * Read as `AppTheme.colors.like`.
 */
@Immutable
data class SemanticColors(
    val like: Color,
    val pass: Color,
    val superLike: Color,
    val danger: Color,
    val success: Color,
    /** Text and icons on a filled [like], [superLike] or [danger]. */
    val onSemantic: Color,
)

val LightSemantic = SemanticColors(
    like = Color(0xFF0B7A54),
    pass = Color(0xFF6E6468),
    superLike = Color(0xFF1F5FD1),
    danger = Color(0xFFB3261E),
    success = Color(0xFF0B7A54),
    onSemantic = Color(0xFFFFFFFF),
)

val DarkSemantic = SemanticColors(
    like = Color(0xFF4ADE9B),
    pass = Color(0xFFB3A9AD),
    superLike = Color(0xFF7AA7FF),
    danger = Color(0xFFFFB4AB),
    success = Color(0xFF4ADE9B),
    onSemantic = Color(0xFF121013),
)

val LocalSemanticColors = staticCompositionLocalOf { LightSemantic }

/**
 * Material's scheme for [dark], built from the brand's colours.
 *
 * The brand colour is used as given wherever it carries no text. Where it
 * does (a filled button's label, a text button on the background), it is
 * moved toward black in the light theme, or white in the dark one, only as far
 * as WCAG AA needs ([Contrast.ensure]): a brand whose pink is too light for
 * white text keeps its hue and gets a readable button.
 */
fun appColorScheme(dark: Boolean, brand: BrandColors = BrandColors.Build): ColorScheme {
    if (dark) {
        val p = Palette.Dark
        val primary = Contrast.ensure(brand.brandDark, listOf(brand.onBrandDark, p.background, p.surface), Contrast.AA, Contrast.awayFrom(brand.onBrandDark))
        val primaryContainer = lerp(brand.brandDark, p.background, 0.72f)
        val onPrimaryContainer = Contrast.ensure(lerp(brand.brandDark, Color.White, 0.6f), listOf(primaryContainer), Contrast.AA, Color.White)
        return darkColorScheme(
            primary = primary,
            onPrimary = brand.onBrandDark,
            primaryContainer = primaryContainer,
            onPrimaryContainer = onPrimaryContainer,
            inversePrimary = brand.brandLight,
            secondary = p.neutralAccent,
            onSecondary = p.background,
            secondaryContainer = p.neutralAccentContainer,
            onSecondaryContainer = p.onNeutralAccentContainer,
            tertiary = DarkSemantic.superLike,
            onTertiary = DarkSemantic.onSemantic,
            background = p.background,
            onBackground = p.text,
            surface = p.surface,
            onSurface = p.text,
            surfaceVariant = p.surfaceContainerHigh,
            onSurfaceVariant = p.textSecondary,
            surfaceContainerLowest = p.background,
            surfaceContainerLow = p.surfaceContainerLow,
            surfaceContainer = p.surfaceContainer,
            surfaceContainerHigh = p.surfaceContainerHigh,
            surfaceContainerHighest = p.surfaceContainerHighest,
            outline = p.outline,
            outlineVariant = p.outlineVariant,
            error = DarkSemantic.danger,
            onError = Color(0xFF690005),
            inverseSurface = Palette.Light.surface,
            inverseOnSurface = Palette.Light.text,
        )
    }
    val p = Palette.Light
    val primary = Contrast.ensure(brand.brandLight, listOf(brand.onBrandLight, p.background, p.surface), Contrast.AA, Contrast.awayFrom(brand.onBrandLight))
    val primaryContainer = lerp(brand.brandLight, Color.White, 0.85f)
    val onPrimaryContainer = Contrast.ensure(lerp(brand.brandLight, Color.Black, 0.55f), listOf(primaryContainer), Contrast.AA, Color.Black)
    return lightColorScheme(
        primary = primary,
        onPrimary = brand.onBrandLight,
        primaryContainer = primaryContainer,
        onPrimaryContainer = onPrimaryContainer,
        inversePrimary = brand.brandDark,
        secondary = p.neutralAccent,
        onSecondary = Color.White,
        secondaryContainer = p.neutralAccentContainer,
        onSecondaryContainer = p.onNeutralAccentContainer,
        tertiary = LightSemantic.superLike,
        onTertiary = LightSemantic.onSemantic,
        background = p.background,
        onBackground = p.text,
        surface = p.surface,
        onSurface = p.text,
        surfaceVariant = p.surfaceContainerHigh,
        onSurfaceVariant = p.textSecondary,
        surfaceContainerLowest = Color.White,
        surfaceContainerLow = p.surfaceContainerLow,
        surfaceContainer = p.surfaceContainer,
        surfaceContainerHigh = p.surfaceContainerHigh,
        surfaceContainerHighest = p.surfaceContainerHighest,
        outline = p.outline,
        outlineVariant = p.outlineVariant,
        error = LightSemantic.danger,
        onError = Color.White,
        inverseSurface = Palette.Dark.surface,
        inverseOnSurface = Palette.Dark.text,
    )
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
     * When no step reaches it (a brand whose colours fight each other, such as
     * a dark label on a colour that must also read on a light background),
     * the step with the best worst-case contrast is returned, and
     * `ContrastTest` fails the build for that brand: the brand needs other
     * colours, which is a designer's call, not this function's.
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
