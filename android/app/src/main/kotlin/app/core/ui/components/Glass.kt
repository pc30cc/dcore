package app.core.ui.components

import android.os.Build
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalGlass
import app.core.ui.theme.ShadowLayer
import app.core.ui.theme.outerShadow
import kotlin.math.ceil
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue

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
 * A glass recipe: the tint drawn over the blur ([fill]), the colour drawn
 * instead where nothing blurs ([fallback]: glass off, Android 11 and older,
 * battery saver, no backdrop), the blur radius, a hairline inside the edge
 * and the shadow layers under it.
 */
data class GlassStyle(
    val fill: Color,
    val fallback: Color,
    val blur: Dp,
    val stroke: Color? = null,
    val shadow: List<ShadowLayer> = emptyList(),
) {
    companion object {
        /** Header buttons on photos (`--glass-*`). */
        @Composable
        fun photoChrome(): GlassStyle {
            val t = AppTheme.template
            return GlassStyle(t.colors.glassFill, t.colors.glassSolid, t.sizes.glassBlur, t.colors.glassLine, t.shadows.glassShadow)
        }

        /** Chips, pills, the remove button and toasts on photos (`--photo-chip-*`): white text on a dark fill in every template. */
        @Composable
        fun photoChip(): GlassStyle {
            val t = AppTheme.template
            return GlassStyle(t.colors.photoChipFill, t.colors.photoChipFill, t.sizes.glassBlur, t.colors.photoChipLine)
        }

        /** A secondary call button at rest (`--call-btn-*`), the same in every template. */
        @Composable
        fun callButton(): GlassStyle {
            val t = AppTheme.template
            return GlassStyle(t.colors.callBtnFill, t.colors.callBtnFill, t.sizes.callBlur, t.colors.callBtnLine)
        }

        /** The deck's rewind, pass and boost (`--act-*`): blurred where glass is on. */
        @Composable
        fun deckAction(): GlassStyle {
            val t = AppTheme.template
            return GlassStyle(t.colors.actFill, t.colors.actFill, t.sizes.glassBlur, t.colors.actLine, t.shadows.actShadow)
        }
    }
}

/**
 * A box of glass: [backdrop] blurred behind [style]'s fill on Android 12+
 * when [LocalGlass] allows (never when the template's glass switch is off),
 * else the style's fallback colour, clipped to [shape], with its edge
 * stroke and shadow.
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
            .outerShadow(shape, style.shadow)
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
