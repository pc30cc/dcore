package app.core.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
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
 * take the design's own values ([Design]).
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
        /** The design system's own colours (tokens.json). */
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

/** Text on lime and on other light accents: near-black ink. */
val Ink: Color = Color(0xFF0B0A10)

/**
 * The fixed colours of each theme (tokens.json `color.<theme>`): every
 * Material role that is not the brand's, and the app's own roles. Dark
 * ("Ink") is the default look; light ("Paper") is drawn to the same rules.
 */
@Immutable
class Palette(
    val secondary: Color,
    val onSecondary: Color,
    val secondaryContainer: Color,
    val onSecondaryContainer: Color,
    val tertiaryContainer: Color?,
    val onTertiaryContainer: Color,
    val onTertiary: Color,
    val onPrimaryContainer: Color?,
    val background: Color,
    val onBackground: Color,
    val surfaceVariant: Color,
    val onSurfaceVariant: Color,
    val surfaceDim: Color,
    val surfaceBright: Color,
    val surfaceContainerLowest: Color,
    val surfaceContainerLow: Color,
    val surfaceContainer: Color,
    val surfaceContainerHigh: Color,
    val surfaceContainerHighest: Color,
    val outline: Color,
    val outlineVariant: Color,
    val inverseSurface: Color,
    val inverseOnSurface: Color,
    val error: Color,
    val onError: Color,
    val errorContainer: Color,
    val onErrorContainer: Color,
    // The app's roles.
    val textTertiary: Color,
    val hairlineStrong: Color,
    val like: Color,
    val pass: Color,
    val rewind: Color,
    val textGradientStart: Color,
    val textGradientEnd: Color,
    val glassFill: Color,
    val glassStroke: Color,
    val glassFallback: Color,
    val tabBarFill: Color,
    val tabBarFillOverPhoto: Color,
    val tabBarFallback: Color,
    val tabBarStroke: Color,
    val skeleton: Color,
    val skeletonHighlight: Color,
    val snackbarAction: Color?,
    val aliveTintAlpha: Float,
    val aliveLine: Color?,
) {
    companion object {
        val Dark = Palette(
            secondary = Color(0xFFCFC3EA),
            onSecondary = Color(0xFF251C3B),
            secondaryContainer = Color(0xFF2B2540),
            onSecondaryContainer = Color(0xFFECE4FF),
            tertiaryContainer = Color(0xFF26330A),
            onTertiaryContainer = Color(0xFFDDFF8A),
            onTertiary = Ink,
            onPrimaryContainer = Color(0xFFFFFFFF),
            background = Color(0xFF0A090E),
            onBackground = Color(0xFFF5F2FA),
            surfaceVariant = Color(0xFF272331),
            onSurfaceVariant = Color(0xFFB7B0C6),
            surfaceDim = Color(0xFF0A090E),
            surfaceBright = Color(0xFF2E2A38),
            surfaceContainerLowest = Color(0xFF050408),
            surfaceContainerLow = Color(0xFF121118),
            surfaceContainer = Color(0xFF17151E),
            surfaceContainerHigh = Color(0xFF1E1B27),
            surfaceContainerHighest = Color(0xFF272331),
            outline = Color(0xFF6B647A),
            outlineVariant = Color(0xFF26232F),
            inverseSurface = Color(0xFFF5F2FA),
            inverseOnSurface = Color(0xFF17151E),
            error = Color(0xFFFF6B81),
            onError = Color(0xFF3D0010),
            errorContainer = Color(0xFF4A1020),
            onErrorContainer = Color(0xFFFFD9DE),
            textTertiary = Color(0xFF8C8599),
            hairlineStrong = Color(0xFF3A3547),
            like = Color(0xFFFF2D87),
            pass = Color(0xFFF5F2FA),
            rewind = Color(0xFFFFFFFF),
            textGradientStart = Color(0xFFB58CFF),
            textGradientEnd = Color(0xFFFF5AA5),
            glassFill = Color(16, 14, 22).copy(alpha = 0.40f),
            glassStroke = Color.White.copy(alpha = 0.16f),
            glassFallback = Color(16, 14, 22).copy(alpha = 0.78f),
            tabBarFill = Color(20, 18, 27).copy(alpha = 0.62f),
            tabBarFillOverPhoto = Color(14, 12, 20).copy(alpha = 0.52f),
            tabBarFallback = Color(18, 16, 25).copy(alpha = 0.92f),
            tabBarStroke = Color.White.copy(alpha = 0.12f),
            skeleton = Color(0xFF1C1A24),
            skeletonHighlight = Color(0xFF2A2735),
            // The gradient's first stop, on the light snackbar.
            snackbarAction = null,
            aliveTintAlpha = 0.10f,
            // The alive colour at 60 %.
            aliveLine = null,
        )

        val Light = Palette(
            secondary = Color(0xFF5D5470),
            onSecondary = Color(0xFFFFFFFF),
            secondaryContainer = Color(0xFFE8E1F5),
            onSecondaryContainer = Color(0xFF221A33),
            // Lime itself, as a fill.
            tertiaryContainer = null,
            onTertiaryContainer = Color(0xFF1A2400),
            onTertiary = Color(0xFFFFFFFF),
            onPrimaryContainer = Color(0xFF2A0870),
            background = Color(0xFFF6F4F9),
            onBackground = Color(0xFF15121D),
            surfaceVariant = Color(0xFFE8E3F0),
            onSurfaceVariant = Color(0xFF4E4760),
            surfaceDim = Color(0xFFDFD9E9),
            surfaceBright = Color(0xFFFFFFFF),
            surfaceContainerLowest = Color(0xFFFFFFFF),
            surfaceContainerLow = Color(0xFFFFFFFF),
            surfaceContainer = Color(0xFFEFEBF5),
            surfaceContainerHigh = Color(0xFFE8E3F0),
            surfaceContainerHighest = Color(0xFFDFD9E9),
            outline = Color(0xFF7A738A),
            outlineVariant = Color(0xFFE2DDEA),
            inverseSurface = Color(0xFF1E1B27),
            inverseOnSurface = Color(0xFFF5F2FA),
            error = Color(0xFFC4173F),
            onError = Color(0xFFFFFFFF),
            errorContainer = Color(0xFFFFDADF),
            onErrorContainer = Color(0xFF5C0016),
            textTertiary = Color(0xFF6A6378),
            hairlineStrong = Color(0xFFCFC8DA),
            like = Color(0xFFD4116E),
            pass = Color(0xFF15121D),
            rewind = Color(0xFF15121D),
            textGradientStart = Color(0xFF6D28F0),
            textGradientEnd = Color(0xFFC2177A),
            glassFill = Color.White.copy(alpha = 0.74f),
            glassStroke = Color.White.copy(alpha = 0.90f),
            glassFallback = Color.White.copy(alpha = 0.95f),
            tabBarFill = Color.White.copy(alpha = 0.80f),
            tabBarFillOverPhoto = Color.White.copy(alpha = 0.84f),
            tabBarFallback = Color.White.copy(alpha = 0.95f),
            tabBarStroke = Color(21, 18, 29).copy(alpha = 0.08f),
            skeleton = Color(0xFFECE8F2),
            skeletonHighlight = Color(0xFFF7F5FA),
            snackbarAction = Color(0xFFC9A9FF),
            aliveTintAlpha = 0.28f,
            aliveLine = Color(0xFF8DB800),
        )
    }
}

/**
 * The colours Material has no role for (tokens.json `app`), read as
 * `AppTheme.colors.like`.
 *
 * Two rules hold them together: the gradient ([gradient]) is the one "yes"
 * colour (primary buttons, like, match, the selected plan, unread counts,
 * your own bubbles), and [alive] marks only live signals (online,
 * super-like, shared interests, the new-likes count, best value), always
 * with [onAlive] ink on it.
 */
@Immutable
data class AppColors(
    val dark: Boolean,
    val gradientStops: GradientStops,
    /** White, on the gradient: button labels only (16 sp bold, 4.61:1 at worst). */
    val onGradient: Color,
    val textGradientStart: Color,
    val textGradientEnd: Color,
    /** The like heart and accents outside the gradient. */
    val like: Color,
    /** The pass ✕ as an icon on the theme's background. */
    val pass: Color,
    /** The super-like star as text or an icon on the theme's surfaces (lime in dark, its text form in light). */
    val superLike: Color,
    /** The super-like button's fill in light (lime); in dark the button is glass with a lime ring. */
    val superLikeFill: Color,
    val onSuperLike: Color,
    val alive: Color,
    val onAlive: Color,
    /** Alive as text on the theme's background (shared-interest chips, «نوبت توئه»). */
    val aliveText: Color,
    val aliveTint: Color,
    val aliveLine: Color,
    val verified: Color,
    val onVerified: Color,
    val boost: Color,
    val rewind: Color,
    val textTertiary: Color,
    val hairlineStrong: Color,
    /** Glass over photos (header buttons, deck actions). */
    val glassFill: Color,
    val glassStroke: Color,
    val glassFallback: Color,
    val tabBarFill: Color,
    val tabBarFillOverPhoto: Color,
    val tabBarFallback: Color,
    val tabBarStroke: Color,
    val skeleton: Color,
    val skeletonHighlight: Color,
    val snackbarAction: Color,
    /** Errors and destructive actions (Material's `error`). */
    val danger: Color,
    /** A done state (a sent code, a read receipt). */
    val success: Color,
    /** Text and icons on a filled [like], [superLike] or [danger]. */
    val onSemantic: Color,
) {
    /** The gradient as a fill, at its 250° angle. */
    val gradient: Brush get() = cssLinearGradient(GRADIENT_ANGLE, gradientStops)

    /** The gradient for display text and drawn strokes on the background (lighter in dark, deeper in light). */
    val textGradient: Brush get() = cssLinearGradient(GRADIENT_ANGLE, listOf(textGradientStart, textGradientEnd))

    companion object {
        /** The gradient's CSS angle: violet from the top end, pink toward the bottom start. */
        const val GRADIENT_ANGLE: Float = 250f

        // Photo layers: the same in both themes (text over photos is always white on the dark scrim).
        val OnPhoto: Color = Color.White
        val OnPhotoVariant: Color = Color.White.copy(alpha = 0.88f)
        val StoryFill: Color = Color.White
        val StoryTrack: Color = Color.White.copy(alpha = 0.32f)
        val StoryEdge: Color = Color.Black.copy(alpha = 0.28f)
        val ChipOnPhotoFill: Color = Color(16, 14, 22).copy(alpha = 0.50f)
        val ChipOnPhotoFallback: Color = Color(16, 14, 22).copy(alpha = 0.72f)
        val ChipOnPhotoStroke: Color = Color.White.copy(alpha = 0.16f)
        val ToastOnPhotoFill: Color = Color(16, 14, 22).copy(alpha = 0.62f)
        val Verified: Color = Color(0xFF8A4FFF)

        /** The top scrim under a photo's chrome and story bars (200 dp tall). */
        val PhotoScrimTop: Brush = Brush.verticalGradient(
            0f to Color.Black.copy(alpha = 0.62f),
            0.55f to Color.Black.copy(alpha = 0.30f),
            1f to Color.Transparent,
        )

        /** The bottom scrim under a name, meta lines and chips (62-66 % of the photo). */
        val PhotoScrimBottom: Brush = Brush.verticalGradient(
            0f to Color.Transparent,
            0.20f to Color.Black.copy(alpha = 0.20f),
            0.42f to Color.Black.copy(alpha = 0.55f),
            0.66f to Color.Black.copy(alpha = 0.82f),
            1f to Color.Black.copy(alpha = 0.94f),
        )

        fun of(dark: Boolean, brand: BrandColors = BrandColors.Build): AppColors {
            val p = if (dark) Palette.Dark else Palette.Light
            val scheme = appColorScheme(dark, brand)
            val stops = if (dark) brand.gradientDark else brand.gradientLight
            val alive = if (dark) brand.aliveDark else brand.aliveLight
            val aliveText = if (dark) brand.aliveTextDark else brand.aliveTextLight
            return AppColors(
                dark = dark,
                gradientStops = stops,
                onGradient = Color.White,
                textGradientStart = p.textGradientStart,
                textGradientEnd = p.textGradientEnd,
                like = p.like,
                pass = p.pass,
                superLike = aliveText,
                superLikeFill = alive,
                onSuperLike = Ink,
                alive = alive,
                onAlive = Ink,
                aliveText = aliveText,
                aliveTint = alive.copy(alpha = p.aliveTintAlpha),
                aliveLine = p.aliveLine ?: alive.copy(alpha = 0.60f),
                verified = Verified,
                onVerified = Color.White,
                boost = scheme.primary,
                rewind = p.rewind,
                textTertiary = p.textTertiary,
                hairlineStrong = p.hairlineStrong,
                glassFill = p.glassFill,
                glassStroke = p.glassStroke,
                glassFallback = p.glassFallback,
                tabBarFill = p.tabBarFill,
                tabBarFillOverPhoto = p.tabBarFillOverPhoto,
                tabBarFallback = p.tabBarFallback,
                tabBarStroke = p.tabBarStroke,
                skeleton = p.skeleton,
                skeletonHighlight = p.skeletonHighlight,
                snackbarAction = p.snackbarAction ?: stops.start,
                danger = p.error,
                success = aliveText,
                onSemantic = if (dark) Ink else Color.White,
            )
        }
    }
}

val LocalAppColors = staticCompositionLocalOf { AppColors.of(dark = true) }

/** The app colours of the dark theme (the default look). */
val DarkSemantic: AppColors by lazy { AppColors.of(dark = true) }

/** The app colours of the light theme. */
val LightSemantic: AppColors by lazy { AppColors.of(dark = false) }

/** Older name of [AppColors]. */
typealias SemanticColors = AppColors

/** Older name of [LocalAppColors]. */
val LocalSemanticColors get() = LocalAppColors

/**
 * Material's scheme: the fixed palette of the theme with the brand's accent
 * (`primary`), its container (the gradient's first stop in dark, a pale tint
 * of it in light) and the alive accent as `tertiary`.
 *
 * The accent is used as given when it reads (AA) on every surface it is
 * drawn on as text; otherwise it is moved toward white (dark) or black
 * (light) just far enough ([Contrast.ensure]).
 */
fun appColorScheme(dark: Boolean, brand: BrandColors = BrandColors.Build): ColorScheme {
    val p = if (dark) Palette.Dark else Palette.Light
    val accent = if (dark) brand.brandDark else brand.brandLight
    val onAccent = if (dark) brand.onBrandDark else brand.onBrandLight
    val primary = Contrast.ensure(
        accent,
        listOf(onAccent, p.background, p.surfaceContainerLow, p.surfaceContainer, p.surfaceContainerHigh),
        Contrast.AA,
        Contrast.awayFrom(onAccent),
    )
    val stops = if (dark) brand.gradientDark else brand.gradientLight
    val primaryContainer = if (dark) stops.start else lerp(stops.start, Color.White, 0.88f)
    val onPrimaryContainer = Contrast.ensure(
        p.onPrimaryContainer ?: Color.White,
        listOf(primaryContainer),
        Contrast.AA,
        if (dark) Color.White else Color.Black,
    )
    val alive = if (dark) brand.aliveDark else brand.aliveLight
    val aliveText = if (dark) brand.aliveTextDark else brand.aliveTextLight
    val tertiaryContainer = p.tertiaryContainer ?: alive
    return if (dark) {
        darkColorScheme(
            primary = primary,
            onPrimary = onAccent,
            primaryContainer = primaryContainer,
            onPrimaryContainer = onPrimaryContainer,
            inversePrimary = brand.brandLight,
            secondary = p.secondary,
            onSecondary = p.onSecondary,
            secondaryContainer = p.secondaryContainer,
            onSecondaryContainer = p.onSecondaryContainer,
            tertiary = aliveText,
            onTertiary = p.onTertiary,
            tertiaryContainer = tertiaryContainer,
            onTertiaryContainer = p.onTertiaryContainer,
            background = p.background,
            onBackground = p.onBackground,
            surface = p.background,
            onSurface = p.onBackground,
            surfaceVariant = p.surfaceVariant,
            onSurfaceVariant = p.onSurfaceVariant,
            surfaceTint = primary,
            inverseSurface = p.inverseSurface,
            inverseOnSurface = p.inverseOnSurface,
            error = p.error,
            onError = p.onError,
            errorContainer = p.errorContainer,
            onErrorContainer = p.onErrorContainer,
            outline = p.outline,
            outlineVariant = p.outlineVariant,
            scrim = Color.Black,
            surfaceBright = p.surfaceBright,
            surfaceContainer = p.surfaceContainer,
            surfaceContainerHigh = p.surfaceContainerHigh,
            surfaceContainerHighest = p.surfaceContainerHighest,
            surfaceContainerLow = p.surfaceContainerLow,
            surfaceContainerLowest = p.surfaceContainerLowest,
            surfaceDim = p.surfaceDim,
        )
    } else {
        lightColorScheme(
            primary = primary,
            onPrimary = onAccent,
            primaryContainer = primaryContainer,
            onPrimaryContainer = onPrimaryContainer,
            inversePrimary = brand.brandDark,
            secondary = p.secondary,
            onSecondary = p.onSecondary,
            secondaryContainer = p.secondaryContainer,
            onSecondaryContainer = p.onSecondaryContainer,
            tertiary = aliveText,
            onTertiary = p.onTertiary,
            tertiaryContainer = tertiaryContainer,
            onTertiaryContainer = p.onTertiaryContainer,
            background = p.background,
            onBackground = p.onBackground,
            surface = p.background,
            onSurface = p.onBackground,
            surfaceVariant = p.surfaceVariant,
            onSurfaceVariant = p.onSurfaceVariant,
            surfaceTint = primary,
            inverseSurface = p.inverseSurface,
            inverseOnSurface = p.inverseOnSurface,
            error = p.error,
            onError = p.onError,
            errorContainer = p.errorContainer,
            onErrorContainer = p.onErrorContainer,
            outline = p.outline,
            outlineVariant = p.outlineVariant,
            scrim = Color.Black,
            surfaceBright = p.surfaceBright,
            surfaceContainer = p.surfaceContainer,
            surfaceContainerHigh = p.surfaceContainerHigh,
            surfaceContainerHighest = p.surfaceContainerHighest,
            surfaceContainerLow = p.surfaceContainerLow,
            surfaceContainerLowest = p.surfaceContainerLowest,
            surfaceDim = p.surfaceDim,
        )
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
