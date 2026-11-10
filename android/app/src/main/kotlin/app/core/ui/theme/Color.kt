package app.core.ui.theme

import androidx.compose.material3.ColorScheme
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

/** Text on light accents in the dark template: near-black ink. */
val Ink: Color = Color(0xFF0B0A10)

/**
 * The older app colours (`AppTheme.colors`), mapped onto the template being
 * drawn so the screens written before the templates keep compiling and
 * follow the template. New code reads [AppTheme.template] instead; the
 * screen jobs move each use over (the mapping is in [AppColors.of]).
 */
@Immutable
data class AppColors(
    val dark: Boolean,
    /** The "yes" gradient's three stops (`--like-fill`'s colours). */
    val gradientStops: GradientStops,
    /** Text and icons on [gradient] (`--on-like`). */
    val onGradient: Color,
    val textGradientStart: Color,
    val textGradientEnd: Color,
    /** `--like`. */
    val like: Color,
    /** The pass icon on the page (`--text`). */
    val pass: Color,
    /** The super-like star as text or an icon on the page (`--primary`). */
    val superLike: Color,
    val superLikeFill: Color,
    val onSuperLike: Color,
    /** A filled accent pill (`--tag-fill`'s middle colour) with [onAlive] on it. */
    val alive: Color,
    val onAlive: Color,
    /** Accent text on the page (`--primary`). */
    val aliveText: Color,
    /** `--primary-tint`. */
    val aliveTint: Color,
    val aliveLine: Color,
    val verified: Color,
    val onVerified: Color,
    val boost: Color,
    val rewind: Color,
    /** `--text-3`. */
    val textTertiary: Color,
    /** `--line-strong`. */
    val hairlineStrong: Color,
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
    /** Errors and destructive actions (`--error`). */
    val danger: Color,
    /** A done state (`--online-text`). */
    val success: Color,
    /** Text and icons on a filled [like], [superLike] or [danger]. */
    val onSemantic: Color,
    /** The template's own `--like-fill`, when it is not the three stops at [GRADIENT_ANGLE]. */
    val yesFill: Brush? = null,
) {
    /** The "yes" fill as a brush (`--like-fill`). */
    val gradient: Brush get() = yesFill ?: cssLinearGradient(GRADIENT_ANGLE, gradientStops)

    /** Display text in the accent (`--accent-text`'s colours). */
    val textGradient: Brush get() = cssLinearGradient(270f, listOf(textGradientStart, textGradientEnd))

    companion object {
        /** The gradient's CSS angle: violet from the top end, pink toward the bottom start. */
        const val GRADIENT_ANGLE: Float = 250f

        // Photo layers: white text on a dark scrim in every template. Later screens read
        // `--on-photo`, `--photo-scrim-*`, `--photo-chip-*` and `--story-*` from the template.
        val OnPhoto: Color = Color.White
        val OnPhotoVariant: Color = Color.White.copy(alpha = 0.88f)
        val StoryFill: Color = Color.White
        val StoryTrack: Color = Color.White.copy(alpha = 0.32f)
        val StoryEdge: Color = Color.Black.copy(alpha = 0.28f)
        val ChipOnPhotoFill: Color = Color(16, 14, 22).copy(alpha = 0.62f)
        val ChipOnPhotoFallback: Color = Color(16, 14, 22).copy(alpha = 0.78f)
        val ChipOnPhotoStroke: Color = Color.White.copy(alpha = 0.20f)
        val ToastOnPhotoFill: Color = Color(16, 14, 22).copy(alpha = 0.62f)

        /** The top scrim under a photo's chrome and story bars (`--photo-scrim-top` of `neon`). */
        val PhotoScrimTop: Brush = Brush.verticalGradient(
            0f to Color.Black.copy(alpha = 0.58f),
            0.55f to Color.Black.copy(alpha = 0.26f),
            1f to Color.Transparent,
        )

        /** The bottom scrim under a name and its lines (`--photo-scrim-bottom` of `neon`). */
        val PhotoScrimBottom: Brush = Brush.verticalGradient(
            0f to Color.Transparent,
            0.22f to Color.Black.copy(alpha = 0.18f),
            0.48f to Color.Black.copy(alpha = 0.55f),
            0.74f to Color.Black.copy(alpha = 0.84f),
            1f to Color.Black.copy(alpha = 0.94f),
        )

        /** [template]'s tokens under the older names. */
        fun of(template: AppTemplate): AppColors {
            val c = template.colors
            val p = template.paints
            val like = p.likeFill
            val accent = p.accentText
            return AppColors(
                dark = template.dark,
                gradientStops = GradientStops(like.stop(0), like.stop(1), like.stop(2)),
                onGradient = c.onLike,
                textGradientStart = accent.stop(0),
                textGradientEnd = accent.stop(1),
                like = c.like,
                pass = c.text,
                superLike = c.primary,
                superLikeFill = c.primary,
                onSuperLike = if (template.dark) Ink else c.onPrimary,
                alive = p.tagFill.stop(1),
                onAlive = c.onTag,
                aliveText = c.primary,
                aliveTint = c.primaryTint,
                aliveLine = c.primary.copy(alpha = 0.40f),
                verified = p.verified.stop(1),
                onVerified = c.onVerified,
                boost = c.boostIcon,
                rewind = c.actIcon,
                textTertiary = c.text3,
                hairlineStrong = c.lineStrong,
                glassFill = c.glassFill,
                glassStroke = c.glassLine,
                glassFallback = c.glassSolid,
                tabBarFill = c.tabbarFill,
                tabBarFillOverPhoto = c.tabbarFillPhoto,
                tabBarFallback = c.tabbarFill,
                tabBarStroke = c.tabbarLine,
                skeleton = c.skeleton,
                skeletonHighlight = c.skeletonHi,
                snackbarAction = c.inverseAction,
                danger = c.error,
                success = c.onlineText,
                onSemantic = if (template.dark) Ink else Color.White,
                yesFill = like,
            )
        }

        /** The dark (`neon`, with [brand]'s gradient) or light (`white`) template's, under the older names. */
        fun of(dark: Boolean, brand: BrandColors = BrandColors.Build): AppColors =
            of(Templates.of(if (dark) Templates.NEON else Templates.WHITE, brand))
    }
}

val LocalAppColors = staticCompositionLocalOf { AppColors.of(Templates.Neon) }

/** The older app colours of `neon` (the dark template). */
val DarkSemantic: AppColors by lazy { AppColors.of(dark = true) }

/** The older app colours of `white` (the light template). */
val LightSemantic: AppColors by lazy { AppColors.of(dark = false) }

/** Older name of [AppColors]. */
typealias SemanticColors = AppColors

/** Older name of [LocalAppColors]. */
val LocalSemanticColors get() = LocalAppColors

/** Material's scheme of the dark (`neon`, [brand]'s gradient) or the light (`white`) template ([templateColorScheme]). */
fun appColorScheme(dark: Boolean, brand: BrandColors = BrandColors.Build): ColorScheme =
    templateColorScheme(Templates.of(if (dark) Templates.NEON else Templates.WHITE, brand))

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
