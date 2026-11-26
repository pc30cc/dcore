package app.core.ui.components

import android.os.Build
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.GraphicsContext
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.findRootCoordinates
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.GlobalPositionAwareModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.node.requireGraphicsContext
import androidx.compose.ui.platform.InspectorInfo
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalGlass
import app.core.ui.theme.ShadowLayer
import app.core.ui.theme.outerShadow
import kotlin.math.ceil

/**
 * What glass blurs: the content of the element marked with [glassSource]
 * (a photo, usually), recorded into a layer each time it draws. Glass
 * elements over it ([GlassBox]) draw that layer blurred behind their own
 * fill. Without a backdrop, or where blur is unavailable ([LocalGlass]),
 * glass draws its fallback colour instead.
 *
 * Positions are plain fields, not snapshot state: a glass element re-records
 * its blur only when its offset from the source changes, never because both
 * moved together (a scrolling list, say). Glass that stays put while the
 * source moves under it re-records on every such frame unless [held].
 */
@Stable
class GlassBackdrop internal constructor(internal val layer: GraphicsLayer) {
    /** The source's coordinates while it is placed, else null. */
    internal var source: LayoutCoordinates? = null
        private set

    /**
     * While true, glass over this backdrop keeps the blur it has drawn when
     * the source moves under it, and takes it again from its new place once
     * this turns false: set while a list scrolls the source under glass
     * pinned over it, so no frame of the scroll records a blur. Glass that
     * has no blur yet, or whose source has gone, still changes at once.
     */
    internal var held: Boolean = false
        set(value) {
            if (field == value) return
            field = value
            if (!value) sourcePlaced(source)
        }

    /** The glass elements that blur this backdrop, told when the source moves. */
    private val glass = ArrayList<GlassBlurNode>(4)

    internal fun attach(node: GlassBlurNode) {
        if (glass.none { it === node }) glass += node
    }

    internal fun detach(node: GlassBlurNode) {
        glass.removeAll { it === node }
    }

    /** The source was placed at [coordinates] (null: it left the composition). */
    internal fun sourcePlaced(coordinates: LayoutCoordinates?) {
        source = coordinates
        var i = 0
        while (i < glass.size) {
            glass[i].sourceMoved()
            i++
        }
    }
}

@Composable
fun rememberGlassBackdrop(): GlassBackdrop {
    val layer = rememberGraphicsLayer()
    return remember(layer) { GlassBackdrop(layer) }
}

/** Marks this element (a photo) as what [backdrop]'s glass blurs. It still draws as usual. */
fun Modifier.glassSource(backdrop: GlassBackdrop): Modifier = this then GlassSourceElement(backdrop)

/**
 * A glass recipe: the tint drawn over the blur ([fill]), the colour drawn
 * instead where nothing blurs ([fallback]: glass off, Android 11 and older,
 * battery saver, a low-RAM phone or one under about 5 GiB without a media
 * performance class, no backdrop), the blur radius, a hairline inside the
 * edge and the shadow layers under it.
 */
@Immutable
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
    Box(
        modifier = modifier
            .outerShadow(shape, style.shadow)
            .then(if (blurs) GlassBlurElement(shape, style, backdrop!!) else GlassFillElement(shape, style)),
        contentAlignment = contentAlignment,
        content = content,
    )
}

/** How many times a glass element has recorded its blur since the process started; read by tests. */
internal object GlassStats {
    var blurRecordings = 0
}

private data class GlassSourceElement(val backdrop: GlassBackdrop) : ModifierNodeElement<GlassSourceNode>() {
    override fun create() = GlassSourceNode(backdrop)
    override fun update(node: GlassSourceNode) = node.update(backdrop)
    override fun InspectorInfo.inspectableProperties() {
        name = "glassSource"
    }
}

/** Records what it draws into the backdrop's layer and tells the backdrop where it is. */
private class GlassSourceNode(private var backdrop: GlassBackdrop) :
    Modifier.Node(), DrawModifierNode, GlobalPositionAwareModifierNode {
    private var placed: LayoutCoordinates? = null

    override fun onGloballyPositioned(coordinates: LayoutCoordinates) {
        placed = coordinates
        backdrop.sourcePlaced(coordinates)
    }

    override fun onDetach() {
        if (backdrop.source === placed) backdrop.sourcePlaced(null)
        placed = null
    }

    override fun ContentDrawScope.draw() {
        backdrop.layer.record { this@draw.drawContent() }
        drawLayer(backdrop.layer)
    }

    fun update(next: GlassBackdrop) {
        if (next === backdrop) return
        if (backdrop.source === placed) backdrop.sourcePlaced(null)
        backdrop = next
        placed?.takeIf { it.isAttached }?.let(next::sourcePlaced)
        invalidateDraw()
    }
}

private data class GlassFillElement(val shape: Shape, val style: GlassStyle) : ModifierNodeElement<GlassFillNode>() {
    override fun create() = GlassFillNode(shape, style)
    override fun update(node: GlassFillNode) = node.update(shape, style)
    override fun InspectorInfo.inspectableProperties() {
        name = "glassFill"
    }
}

/** Glass where nothing blurs: the fallback colour and the hairline; nothing it does follows positions. */
private class GlassFillNode(private var shape: Shape, private var style: GlassStyle) : Modifier.Node(), DrawModifierNode {
    override val shouldAutoInvalidate: Boolean get() = false
    private val outlines = OutlineCache()

    override fun ContentDrawScope.draw() {
        val outline = outlines.outline(shape, this)
        drawOutline(outline, style.fallback)
        style.stroke?.let { drawOutline(outline, it, style = Stroke(1.dp.toPx())) }
        drawContent()
    }

    fun update(shape: Shape, style: GlassStyle) {
        if (shape == this.shape && style == this.style) return
        if (shape != this.shape) outlines.clear()
        this.shape = shape
        this.style = style
        invalidateDraw()
    }
}

private data class GlassBlurElement(val shape: Shape, val style: GlassStyle, val backdrop: GlassBackdrop) :
    ModifierNodeElement<GlassBlurNode>() {
    override fun create() = GlassBlurNode(shape, style, backdrop)
    override fun update(node: GlassBlurNode) = node.update(shape, style, backdrop)
    override fun InspectorInfo.inspectableProperties() {
        name = "glassBlur"
    }
}

/**
 * Glass that blurs [backdrop]: keeps its offset from the source (both
 * placed in the same root, else no offset and the fallback) and records the
 * blurred layer again only when that offset, its size or the radius changed
 * (an offset change waits while the backdrop is held). A change inside the
 * source still shows, because the blurred layer draws the source's layer by
 * reference.
 */
internal class GlassBlurNode(
    private var shape: Shape,
    private var style: GlassStyle,
    private var backdrop: GlassBackdrop,
) : Modifier.Node(), DrawModifierNode, GlobalPositionAwareModifierNode {
    override val shouldAutoInvalidate: Boolean get() = false

    private data class Recording(val size: Size, val offset: Offset, val radius: Float)

    private var graphics: GraphicsContext? = null
    private var layer: GraphicsLayer? = null
    private var self: LayoutCoordinates? = null
    private var offset: Offset = Offset.Unspecified
    private var recorded: Recording? = null
    private val outlines = OutlineCache()

    override fun onAttach() {
        val context = requireGraphicsContext()
        graphics = context
        layer = context.createGraphicsLayer()
        backdrop.attach(this)
    }

    override fun onDetach() {
        backdrop.detach(this)
        layer?.let { graphics?.releaseGraphicsLayer(it) }
        layer = null
        graphics = null
        recorded = null
        offset = Offset.Unspecified
        self = null
    }

    override fun onGloballyPositioned(coordinates: LayoutCoordinates) {
        self = coordinates
        sourceMoved()
    }

    /** Where this glass is in the source's coordinates now; a change redraws it, unless the backdrop is [GlassBackdrop.held]. */
    fun sourceMoved() {
        val source = backdrop.source
        val here = self
        val now = if (
            source != null && here != null && source.isAttached && here.isAttached &&
            source.findRootCoordinates() === here.findRootCoordinates()
        ) {
            source.localPositionOf(here, Offset.Zero)
        } else {
            Offset.Unspecified
        }
        if (now == offset) return
        // Held: the blur drawn stays; releasing the hold calls this again.
        if (backdrop.held && offset.isSpecified && now.isSpecified) return
        offset = now
        if (isAttached) invalidateDraw()
    }

    override fun ContentDrawScope.draw() {
        val outline = outlines.outline(shape, this)
        val blurLayer = layer
        val at = offset
        if (blurLayer != null && at.isSpecified) {
            val radius = style.blur.toPx()
            val margin = ceil(radius * 2f)
            val key = Recording(size, at, radius)
            if (key != recorded) {
                blurLayer.renderEffect = BlurEffect(radius, radius, TileMode.Clamp)
                blurLayer.record(IntSize((size.width + 2 * margin).toInt(), (size.height + 2 * margin).toInt())) {
                    translate(margin - at.x, margin - at.y) { drawLayer(backdrop.layer) }
                }
                recorded = key
                GlassStats.blurRecordings++
            }
            clipPath(outlines.path()) {
                translate(-margin, -margin) { drawLayer(blurLayer) }
            }
            drawOutline(outline, style.fill)
        } else {
            drawOutline(outline, style.fallback)
        }
        style.stroke?.let { drawOutline(outline, it, style = Stroke(1.dp.toPx())) }
        drawContent()
    }

    fun update(shape: Shape, style: GlassStyle, backdrop: GlassBackdrop) {
        if (backdrop !== this.backdrop) {
            this.backdrop.detach(this)
            this.backdrop = backdrop
            recorded = null
            if (isAttached) backdrop.attach(this)
            offset = Offset.Unspecified
            sourceMoved()
            if (isAttached) invalidateDraw()
        }
        if (shape != this.shape) {
            this.shape = shape
            outlines.clear()
            invalidateDraw()
        }
        if (style != this.style) {
            this.style = style
            recorded = null
            invalidateDraw()
        }
    }
}

/** A shape's outline and its clip path, made again only when the size, direction, density or shape changes. */
private class OutlineCache {
    private var size = Size.Unspecified
    private var direction: LayoutDirection? = null
    private var density = Float.NaN
    private var shape: Shape? = null
    private var outline: Outline? = null
    private var path: Path? = null

    fun outline(shape: Shape, scope: DrawScope): Outline {
        val cached = outline
        if (cached != null && shape == this.shape && scope.size == size && scope.layoutDirection == direction && scope.density == density) {
            return cached
        }
        val made = shape.createOutline(scope.size, scope.layoutDirection, scope)
        this.shape = shape
        size = scope.size
        direction = scope.layoutDirection
        density = scope.density
        outline = made
        path = null
        return made
    }

    /** The clip path of the outline last returned by [outline]. */
    fun path(): Path = path ?: when (val o = outline) {
        is Outline.Generic -> o.path
        is Outline.Rounded -> Path().apply { addRoundRect(o.roundRect) }
        is Outline.Rectangle -> Path().apply { addRect(o.rect) }
        null -> Path()
    }.also { path = it }

    fun clear() {
        outline = null
        path = null
        shape = null
    }
}
