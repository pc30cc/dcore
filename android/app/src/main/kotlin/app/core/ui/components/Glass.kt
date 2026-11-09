package app.core.ui.components

import android.os.Build
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import app.core.ui.theme.AppColors
import app.core.ui.theme.AppTheme
import app.core.ui.theme.GlassTokens
import app.core.ui.theme.LocalGlass
import kotlin.math.ceil

/**
 * What glass blurs: the content of the element marked with [glassSource]
 * (a photo, usually), recorded into a layer each time it draws. Glass
 * elements over it ([GlassBox]) draw that layer blurred behind their own
 * fill. Without a backdrop, or where blur is unavailable ([LocalGlass]),
 * glass draws its fallback colour instead.
 */
@Stable
class GlassBackdrop internal constructor(internal val layer: GraphicsLayer) {
    /** Where the source is, in the root's coordinates. */
    internal var origin: Offset by mutableStateOf(Offset.Unspecified)
}

@Composable
fun rememberGlassBackdrop(): GlassBackdrop {
    val layer = rememberGraphicsLayer()
    return remember(layer) { GlassBackdrop(layer) }
}

/** Marks this element (a photo) as what [backdrop]'s glass blurs. It still draws as usual. */
fun Modifier.glassSource(backdrop: GlassBackdrop): Modifier =
    onGloballyPositioned { backdrop.origin = it.positionInRoot() }
        .drawWithContent {
            backdrop.layer.record { this@drawWithContent.drawContent() }
            drawLayer(backdrop.layer)
        }

/**
 * A glass recipe (tokens.json `glass`): the tint over the blur, the colour
 * drawn instead where there is no blur, the blur radius and an edge stroke.
 */
data class GlassStyle(
    val fill: Color,
    val fallback: Color,
    val blur: Dp,
    val stroke: Color? = null,
    /** A soft drop shadow under light glass over photos (the light theme's chrome). */
    val shadow: Boolean = false,
) {
    companion object {
        /** Header buttons and deck actions over a photo: dark glass in dark, white in light. */
        @Composable
        fun photoChrome(colors: AppColors = AppTheme.colors): GlassStyle =
            if (colors.dark) {
                GlassStyle(colors.glassFill, colors.glassFallback, GlassTokens.photoChromeBlur, colors.glassStroke)
            } else {
                GlassStyle(Color.White.copy(alpha = 0.86f), Color.White.copy(alpha = 0.94f), GlassTokens.photoChromeBlur, null, shadow = true)
            }

        /** Chips and position labels on a photo: always dark glass (white text reads 5.14:1 at worst). */
        val ChipOnPhoto = GlassStyle(AppColors.ChipOnPhotoFill, AppColors.ChipOnPhotoFallback, GlassTokens.chipBlur, AppColors.ChipOnPhotoStroke)

        /** A toast over a photo. */
        val ToastOnPhoto = GlassStyle(AppColors.ToastOnPhotoFill, AppColors.ChipOnPhotoFallback, GlassTokens.toastBlur, AppColors.ChipOnPhotoStroke)

        /** The tab bar over the deck photo. */
        @Composable
        fun tabBarOverPhoto(colors: AppColors = AppTheme.colors): GlassStyle =
            GlassStyle(colors.tabBarFillOverPhoto, colors.tabBarFallback, GlassTokens.tabBarBlur, colors.tabBarStroke, shadow = true)

        /** The tab bar over lists: the opaque fill, never a blur (text under it must not ghost through). */
        @Composable
        fun tabBarOverList(colors: AppColors = AppTheme.colors): GlassStyle =
            GlassStyle(colors.tabBarFallback, colors.tabBarFallback, 0.dp, colors.tabBarStroke, shadow = true)
    }
}

/**
 * A box of glass: [backdrop] blurred behind [style]'s fill on Android 12+
 * (when [LocalGlass] allows), else the style's fallback colour, clipped to
 * [shape], with its edge stroke.
 */
@Composable
fun GlassBox(
    shape: Shape,
    style: GlassStyle,
    modifier: Modifier = Modifier,
    backdrop: GlassBackdrop? = null,
    contentAlignment: Alignment = Alignment.Center,
    content: @Composable BoxScope.() -> Unit,
) {
    val blurs = LocalGlass.current && backdrop != null && style.blur > 0.dp &&
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
    val blurLayer = if (blurs) rememberGraphicsLayer() else null
    val position = remember { PositionHolder() }
    Box(
        modifier = modifier
            .then(if (style.shadow) Modifier.softShadow(shape) else Modifier)
            .onGloballyPositioned { position.value = it.positionInRoot() }
            .drawBehind {
                val outline = shape.createOutline(size, layoutDirection, this)
                val origin = backdrop?.origin ?: Offset.Unspecified
                val here = position.value
                if (blurLayer != null && backdrop != null && origin.isSpecified && here.isSpecified) {
                    val radius = style.blur.toPx()
                    val margin = ceil(radius * 2f)
                    val offset = here - origin
                    blurLayer.renderEffect = BlurEffect(radius, radius, TileMode.Clamp)
                    blurLayer.record(IntSize((size.width + 2 * margin).toInt(), (size.height + 2 * margin).toInt())) {
                        translate(margin - offset.x, margin - offset.y) { drawLayer(backdrop.layer) }
                    }
                    clipPath(outline.asPath()) {
                        translate(-margin, -margin) { drawLayer(blurLayer) }
                    }
                    drawOutline(outline, style.fill)
                } else {
                    drawOutline(outline, style.fallback)
                }
                style.stroke?.let { drawOutline(outline, it, style = Stroke(1.dp.toPx())) }
            },
        contentAlignment = contentAlignment,
        content = content,
    )
}

/** The glass's own place in the root; snapshot state, so a move redraws the blur under it. */
private class PositionHolder {
    var value: Offset by mutableStateOf(Offset.Unspecified)
}

private fun Outline.asPath(): Path = when (this) {
    is Outline.Generic -> path
    is Outline.Rounded -> Path().apply { addRoundRect(roundRect) }
    is Outline.Rectangle -> Path().apply { addRect(rect) }
}

/**
 * The soft shadow under floating layers in light theme (`0 6 18 -8` black
 * at 35 %), drawn on Android 9+ only (blurred shadows need it there).
 */
fun Modifier.softShadow(shape: Shape, alpha: Float = 0.35f): Modifier =
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
        this
    } else {
        dropShadow(shape, Shadow(radius = 18.dp, color = Color.Black, spread = (-8).dp, offset = DpOffset(0.dp, 6.dp), alpha = alpha))
    }
