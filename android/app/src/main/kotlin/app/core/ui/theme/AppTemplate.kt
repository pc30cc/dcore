package app.core.ui.theme

import android.graphics.ColorMatrix
import android.graphics.RenderEffect
import android.os.Build
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.draw.innerShadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asComposeRenderEffect
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.sp

/** The colour scheme a template is drawn in: system bars, keyboard, Material's light/dark defaults. */
enum class Scheme { Dark, Light }

/** The tab bar: a floating pill over the content, or a full-width bar docked to the bottom. */
enum class TabBarStyle { Floating, Docked }

/** The deck and the full profile: the photo edge to edge with the name on it, or an inset card with the name below. */
enum class DeckStyle { Bleed, Card }

/** Welcome, match, own profile and photos inside profile details: full-bleed photography, or framed photos on the page. */
enum class HeroStyle { Bleed, Framed }

/** The template's seven switches (`--switch-*`): where screens differ in structure, not only in colour. */
@Immutable
data class TemplateSwitches(
    val template: String,
    val scheme: Scheme,
    val tabBar: TabBarStyle,
    val deck: DeckStyle,
    val hero: HeroStyle,
    /** Off: every glass layer draws `--glass-solid` and nothing blurs. */
    val glass: Boolean,
    /** Off: no hero light behind welcome, onboarding and the paywall, and no grain. */
    val glow: Boolean,
)

/** One CSS shadow layer (`[inset] x y blur spread colour`). */
@Immutable
data class ShadowLayer(
    val x: Dp,
    val y: Dp,
    val blur: Dp,
    val spread: Dp,
    val color: Color,
    val inset: Boolean = false,
)

/** "No shadow" (`0 0 transparent`). */
val NoShadow: List<ShadowLayer> = emptyList()

/** A CSS filter chain over a photo: `blur() saturate() brightness()`. */
@Immutable
data class PhotoFilter(val blur: Dp, val saturate: Float, val brightness: Float)

/** `rgba(r, g, b, a)`: the alpha rounded to the nearest of 255 steps, as the platform stores it. */
internal fun rgba(r: Int, g: Int, b: Int, a: Float): Color = Color(r, g, b, (a * 255f + 0.5f).toInt())

/** A type token (`weight size/line-height`) in the Persian family; [AppTemplate.inScript] makes the Latin one. */
internal fun type(weight: Int, size: Float, lineHeight: Float): TextStyle =
    TextStyle(
        fontFamily = PersianFamily,
        fontWeight = FontWeight(weight),
        fontSize = size.sp,
        // In sp: the line grows with the reader's font scale, like the text.
        lineHeight = lineHeight.sp,
        // Never letter-space Persian (it breaks the joined script).
        letterSpacing = 0.sp,
        platformStyle = Trimmed,
        lineHeightStyle = Centred,
    )

/**
 * One visual template: its id, its switches and every token of the template
 * contract as a typed Compose value. Screens read it as
 * [AppTheme.template] and branch on [switches] where the structure differs;
 * they never write a literal colour, radius or type size of their own.
 */
@Immutable
data class AppTemplate(
    val id: String,
    val switches: TemplateSwitches,
    /** `--grain-opacity`: film grain over hero backgrounds (0 when [TemplateSwitches.glow] is off). */
    val grainOpacity: Float,
    val colors: TemplateColors,
    val paints: TemplatePaints,
    val shadows: TemplateShadows,
    val radii: TemplateRadii,
    val sizes: TemplateSizes,
    val type: TemplateType,
    val filters: TemplateFilters,
) {
    /** The scheme switch: dark (light status bar icons) or light. */
    val dark: Boolean get() = switches.scheme == Scheme.Dark

    /**
     * This template with its type in the screen's script: Persian keeps the
     * tokens as they are; Latin (English, Turkish) takes [TemplateType.fontLat]
     * at the same weights, sizes and line heights.
     */
    fun inScript(persian: Boolean): AppTemplate = if (persian) this else copy(type = type.latin())
}

private fun TemplateType.latin(): TemplateType {
    fun l(style: TextStyle): TextStyle = style.copy(fontFamily = fontLat)
    return copy(
        display = l(display),
        h1 = l(h1),
        h2 = l(h2),
        h3 = l(h3),
        namePhoto = l(namePhoto),
        namePhotoAge = l(namePhotoAge),
        quote = l(quote),
        bodyLg = l(bodyLg),
        body = l(body),
        bodyStrong = l(bodyStrong),
        bodySm = l(bodySm),
        label = l(label),
        labelSm = l(labelSm),
        section = l(section),
        caption = l(caption),
        number = l(number),
        field = l(field),
        fieldPlaceholder = l(fieldPlaceholder),
        link = l(link),
        chipStrong = l(chipStrong),
        captionStrong = l(captionStrong),
        legal = l(legal),
        legalLink = l(legalLink),
        key = l(key),
        keySm = l(keySm),
    )
}

/** The template being drawn (see [AppTheme.template]). */
val LocalAppTemplate = staticCompositionLocalOf { Templates.Neon }

/** Dark text on the dark template's light accent (`--primary`) where Material fills with it. */
private val InkOnLight = Color(0xFF21003F)

/**
 * Material 3's scheme for [template], so Material components (text
 * buttons, menus, date pickers, sheets) fall in line:
 * - a light template: `primary` is the ink every control is drawn in
 *   (`--primary-fill`), the accent (`--primary`) is `tertiary`, the
 *   surfaces step through the template's greys;
 * - a dark one keeps the structure the dark theme had: `primary` is the
 *   accent text colour (`--primary`), its container the gradient's first
 *   stop, the surfaces the template's.
 */
fun templateColorScheme(template: AppTemplate): ColorScheme {
    val c = template.colors
    return if (template.dark) {
        val onPrimary = Contrast.ensure(InkOnLight, listOf(c.primary), Contrast.AA, Color.Black)
        darkColorScheme(
            primary = c.primary,
            onPrimary = onPrimary,
            primaryContainer = template.paints.primaryFill.stop(0),
            onPrimaryContainer = c.onPrimary,
            inversePrimary = c.inverseAction,
            secondary = Color(0xFFCFC3EA),
            onSecondary = Color(0xFF251C3B),
            secondaryContainer = Color(0xFF2B2540),
            onSecondaryContainer = Color(0xFFECE4FF),
            tertiary = c.primary,
            onTertiary = onPrimary,
            tertiaryContainer = c.primaryTint.compositeOver(c.surface1),
            onTertiaryContainer = c.text,
            background = c.bg,
            onBackground = c.text,
            surface = c.bg,
            onSurface = c.text,
            surfaceVariant = c.surface3,
            onSurfaceVariant = c.text2,
            surfaceTint = c.primary,
            inverseSurface = c.inverse,
            inverseOnSurface = c.onInverse,
            error = c.error,
            onError = Color(0xFF3D0010),
            errorContainer = c.errorTint,
            onErrorContainer = Color(0xFFFFD9DE),
            outline = c.outline,
            outlineVariant = c.line,
            scrim = Color.Black,
            surfaceBright = Color(0xFF2E2A38),
            surfaceContainer = c.photoPlaceholder,
            surfaceContainerHigh = c.surface2,
            surfaceContainerHighest = c.surface3,
            surfaceContainerLow = c.surface1,
            surfaceContainerLowest = Color(0xFF050408),
            surfaceDim = c.bg,
        )
    } else {
        val accent = LightAccentRoles.of(c.primary, c.primaryTint)
        lightColorScheme(
            primary = template.paints.primaryFill.stop(0),
            onPrimary = c.onPrimary,
            primaryContainer = c.surface3,
            onPrimaryContainer = c.text,
            inversePrimary = c.inverseAction,
            secondary = c.text2,
            onSecondary = Color(0xFFFFFFFF),
            secondaryContainer = c.surface2,
            onSecondaryContainer = c.text,
            tertiary = c.primary,
            onTertiary = c.onPrimary,
            tertiaryContainer = c.primaryTint,
            onTertiaryContainer = accent.onContainer,
            background = c.bg,
            onBackground = c.text,
            surface = c.bg,
            onSurface = c.text,
            surfaceVariant = c.surface2,
            onSurfaceVariant = c.text2,
            surfaceTint = c.bg,
            inverseSurface = c.inverse,
            inverseOnSurface = c.onInverse,
            error = c.error,
            onError = Color(0xFFFFFFFF),
            errorContainer = c.errorTint,
            onErrorContainer = Color(0xFF7A1022),
            outline = c.outline,
            outlineVariant = c.actLine,
            scrim = c.text,
            surfaceBright = c.bg,
            surfaceContainer = c.surface2,
            surfaceContainerHigh = c.photoPlaceholder,
            surfaceContainerHighest = c.surface3,
            surfaceContainerLow = Color(0xFFFAFAFB),
            surfaceContainerLowest = c.bg,
            surfaceDim = c.photoPlaceholder,
            primaryFixed = c.surface3,
            primaryFixedDim = Color(0xFFC9C9D0),
            onPrimaryFixed = c.text,
            onPrimaryFixedVariant = Color(0xFF3F3F46),
            secondaryFixed = c.surface2,
            secondaryFixedDim = c.lineStrong,
            onSecondaryFixed = c.text,
            onSecondaryFixedVariant = c.text2,
            tertiaryFixed = c.primaryTint,
            tertiaryFixedDim = accent.fixedDim,
            onTertiaryFixed = accent.onFixed,
            onTertiaryFixedVariant = accent.onFixedVariant,
        )
    }
}

/** The colour of a paint at stop [index] (its only colour when solid). */
internal fun androidx.compose.ui.graphics.Brush.stop(index: Int): Color = when (this) {
    is androidx.compose.ui.graphics.SolidColor -> value
    is CssLinearGradient -> colors[index.coerceIn(0, colors.lastIndex)]
    is IconGradient -> colors[index.coerceIn(0, colors.lastIndex)]
    else -> representative
}

/**
 * Material's type roles from the template's type tokens (already in the
 * screen's script, see [AppTemplate.inScript]), so screens that still use
 * `MaterialTheme.typography` follow the template's sizes.
 */
fun templateTypography(template: AppTemplate): Typography {
    val t = template.type
    return Typography(
        displayLarge = t.display,
        displayMedium = t.display,
        displaySmall = t.namePhoto,
        headlineLarge = t.h1,
        headlineMedium = t.h1,
        headlineSmall = t.h2,
        titleLarge = t.h2,
        titleMedium = t.h3,
        titleSmall = t.bodyStrong,
        bodyLarge = t.bodyLg,
        bodyMedium = t.body,
        bodySmall = t.bodySm,
        labelLarge = t.label,
        labelMedium = t.labelSm,
        labelSmall = t.caption,
    )
}

/** Material's shapes from the template's radii (dialogs and sheets take `extraLarge`). */
fun templateShapes(template: AppTemplate): Shapes {
    val r = template.radii
    return Shapes(
        extraSmall = RoundedCornerShape(r.xs),
        small = RoundedCornerShape(r.sm),
        medium = RoundedCornerShape(r.md),
        large = RoundedCornerShape(r.xl),
        extraLarge = RoundedCornerShape(r.dialog),
    )
}

/**
 * The outer layers of a CSS shadow list, under what follows in the chain
 * (put it before the background). Blurred layers need Android 9; below
 * that only the unblurred ones are drawn.
 */
fun Modifier.outerShadow(shape: Shape, layers: List<ShadowLayer>): Modifier =
    layers.asReversed().filter { !it.inset }.fold(this) { m, l ->
        if (l.blur.value > 0f && Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            m
        } else {
            m.dropShadow(shape, Shadow(radius = l.blur, color = l.color.copy(alpha = 1f), spread = l.spread, offset = DpOffset(l.x, l.y), alpha = l.color.alpha))
        }
    }

/** The inset layers of a CSS shadow list, over the background (put it after the background, before the content). */
fun Modifier.insetShadow(shape: Shape, layers: List<ShadowLayer>): Modifier =
    layers.asReversed().filter { it.inset }.fold(this) { m, l ->
        m.innerShadow(shape, Shadow(radius = l.blur, color = l.color.copy(alpha = 1f), spread = l.spread, offset = DpOffset(l.x, l.y), alpha = l.color.alpha))
    }

/**
 * A [PhotoFilter] over what this element draws: blurred, saturated and
 * brightened on Android 12+; below that the blur is left out and the
 * brightness drawn as a dim over it.
 */
fun Modifier.photoFilter(filter: PhotoFilter): Modifier =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        graphicsLayer {
            val radius = filter.blur.toPx()
            val matrix = ColorMatrix().apply {
                setSaturation(filter.saturate)
                postConcat(ColorMatrix().apply { setScale(filter.brightness, filter.brightness, filter.brightness, 1f) })
            }
            val colour = RenderEffect.createColorFilterEffect(android.graphics.ColorMatrixColorFilter(matrix))
            renderEffect = if (radius > 0f) {
                RenderEffect.createBlurEffect(radius, radius, colour, android.graphics.Shader.TileMode.CLAMP).asComposeRenderEffect()
            } else {
                colour.asComposeRenderEffect()
            }
            clip = true
        }
    } else {
        drawWithContent {
            drawContent()
            drawRect(Color.Black.copy(alpha = (1f - filter.brightness).coerceIn(0f, 1f)))
        }
    }

/**
 * White's Material roles made from its accent (tertiary's container text
 * and fixed roles): the token file's values for the design's accent, the
 * same shades of a brand's accent otherwise, each 4.5:1 on what it is on.
 */
private class LightAccentRoles(val onContainer: Color, val fixedDim: Color, val onFixed: Color, val onFixedVariant: Color) {
    companion object {
        private val Design = LightAccentRoles(Color(0xFF2E128A), Color(0xFFD9CFFA), Color(0xFF1E0A5C), Color(0xFF4A22BE))

        fun of(accent: Color, tint: Color): LightAccentRoles {
            if (accent == WhiteAccent.Design.accent) return Design
            val fixedDim = lerp(accent, Color.White, 0.75f)
            return LightAccentRoles(
                onContainer = Contrast.ensure(lerp(accent, Color.Black, 0.5f), listOf(tint), Contrast.AA, Color.Black),
                fixedDim = fixedDim,
                onFixed = Contrast.ensure(lerp(accent, Color.Black, 0.65f), listOf(tint), Contrast.AA, Color.Black),
                onFixedVariant = Contrast.ensure(lerp(accent, Color.Black, 0.15f), listOf(fixedDim), Contrast.AA, Color.Black),
            )
        }
    }
}
