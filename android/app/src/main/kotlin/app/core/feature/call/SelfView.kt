package app.core.feature.call

import app.core.ui.theme.CallPalette
import android.content.Context
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.core.content.edit
import app.core.R
import app.core.ui.theme.AppTheme
import app.core.ui.theme.outerShadow
import app.core.i18n.brandString
import app.core.ui.theme.LocalReducedMotion
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * Which corner the small picture sits in. Absolute — left and right as the
 * screen has them, not start and end — because it is a place on the glass
 * the person put it, and a Persian layout must not move it across.
 */
data class SelfViewCorner(val left: Boolean, val top: Boolean) {
    /** The next corner round the screen, for the accessibility action. */
    fun next(): SelfViewCorner = when {
        top && !left -> SelfViewCorner(left = false, top = false)
        !top && !left -> SelfViewCorner(left = true, top = false)
        !top && left -> SelfViewCorner(left = true, top = true)
        else -> SelfViewCorner(left = false, top = true)
    }

    companion object {
        /** Bottom right, above the buttons: out of the name's way. */
        val DEFAULT = SelfViewCorner(left = false, top = false)

        /** The corner whose quarter of [area] the point lies in. */
        fun nearest(x: Float, y: Float, areaWidth: Float, areaTop: Float, areaBottom: Float): SelfViewCorner =
            SelfViewCorner(left = x < areaWidth / 2f, top = y < (areaTop + areaBottom) / 2f)
    }
}

/** How wide the small picture is, in dp; it is always 3:4. */
object SelfViewSize {
    const val MIN = 64f
    const val DEFAULT = 104f
    const val MAX = 176f

    /** The double-tap steps: small, as it opens, large, and round again. */
    private val STEPS = listOf(76f, DEFAULT, 150f)

    fun next(width: Float): Float = STEPS.firstOrNull { it > width + 1f } ?: STEPS.first()

    fun clamp(width: Float): Float = width.coerceIn(MIN, MAX)
}

/**
 * Where the picture was left, so the next call opens it there. Kept on the
 * phone only — it is how this person likes their screen, not an account
 * setting, and nothing in it is private.
 */
internal class SelfViewPlacement(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("call.selfView", Context.MODE_PRIVATE)

    var corner: SelfViewCorner
        // The design's place for it at first: the top left corner, under the name.
        get() = SelfViewCorner(prefs.getBoolean(KEY_LEFT, true), prefs.getBoolean(KEY_TOP, true))
        set(value) {
            prefs.edit { putBoolean(KEY_LEFT, value.left).putBoolean(KEY_TOP, value.top) }
        }

    var width: Float
        get() = SelfViewSize.clamp(prefs.getFloat(KEY_WIDTH, SelfViewSize.DEFAULT))
        set(value) {
            prefs.edit { putFloat(KEY_WIDTH, value) }
        }

    private companion object {
        const val KEY_LEFT = "left"
        const val KEY_TOP = "top"
        const val KEY_WIDTH = "width"
    }
}

/**
 * The small picture floating over a video call. Normally this phone's own
 * camera; swapped, the other person's (see [CallStage]). [content] is what
 * it shows.
 *
 * - **Tap** it to swap the two pictures, and again to swap them back. A tap
 *   is read once nothing else can be made of it: a finger that went past the
 *   touch slop is a drag, a second finger a pinch, and a second tap close
 *   behind the first a double-tap — so the swap waits out the double-tap
 *   timeout, as every tap beside a double-tap on Android does.
 * - **Drag** it anywhere; let go and it settles into the nearest corner (a
 *   flick carries it towards the corner it was thrown at).
 * - **Pinch** to make it smaller or larger, down to a thumbnail.
 * - **Double-tap** steps it small → normal → large.
 *
 * The corner and the size are the card's, not the picture's: a swap keeps
 * both. It keeps between [areaTop] and [areaBottom] (pixels from the top of
 * the call screen) — below the name and the timer, above the buttons — and
 * clear of a cutout or a navigation bar at either side; in a band lower than
 * the card (a phone on its side) it is drawn smaller, and at its smallest it
 * gives way upwards over the name, never down over the buttons.
 */
@Composable
fun SelfView(
    areaTop: Float,
    areaBottom: Float,
    /** The other person's first name, for TalkBack. */
    peerName: String,
    /** Whether this phone's own picture is the big one, so the card shows the other side. */
    swapped: Boolean,
    onSwap: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    val context = LocalContext.current
    val placement = remember(context) { SelfViewPlacement(context) }
    var corner by remember { mutableStateOf(placement.corner) }
    var widthDp by remember { mutableFloatStateOf(placement.width) }
    val scope = rememberCoroutineScope()
    val still = LocalReducedMotion.current
    // Read by the gesture and the accessibility action, which outlive any one
    // composition: a swap asked for after the screen has recomposed must reach
    // the swap that is on screen now.
    val swap by rememberUpdatedState(onSwap)

    BoxWithConstraints(modifier.fillMaxSize()) {
        val density = LocalDensity.current
        val margin = with(density) { 12.dp.toPx() }
        val areaWidth = constraints.maxWidth.toFloat()
        // Left and right as the glass has them, whatever the language.
        val safe = WindowInsets.safeDrawing
        val left = safe.getLeft(density, LayoutDirection.Ltr) + margin
        val right = maxOf(left, areaWidth - safe.getRight(density, LayoutDirection.Ltr) - margin)
        val top = areaTop + margin
        val bottom = maxOf(top, areaBottom - margin)
        val geometry = SelfViewGeometry(
            areaWidth = areaWidth,
            areaHeight = constraints.maxHeight.toFloat(),
            left = left,
            right = right,
            top = top,
            bottom = bottom,
            density = density.density,
        )
        val shownDp = geometry.shownWidth(widthDp)
        val goal = geometry.target(corner, widthDp)

        val position = remember { Animatable(goal, Offset.VectorConverter) }
        var dragging by remember { mutableStateOf(false) }
        // Settles into the corner whenever it changes, or the room it has does
        // (the name's line wraps, the call connects and the face goes, the
        // phone turns). Straight there when the system says no animations.
        LaunchedEffect(goal, dragging, still) {
            if (dragging) return@LaunchedEffect
            if (still) {
                position.snapTo(goal)
            } else {
                position.animateTo(goal, spring(dampingRatio = 0.8f, stiffness = Spring.StiffnessMediumLow))
            }
        }
        // Read by the gesture, which outlives any one size of the screen.
        val measures by rememberUpdatedState(geometry)

        val t = AppTheme.template
        val shape = RoundedCornerShape(t.radii.lg)
        val label = if (swapped) brandString(R.string.call_self_theirs, peerName) else brandString(R.string.call_self_yours)
        val state = if (swapped) brandString(R.string.call_self_you_large) else brandString(R.string.call_self_they_large, peerName)
        val swapLabel = brandString(R.string.call_self_swap)
        val smaller = brandString(R.string.call_self_smaller)
        val larger = brandString(R.string.call_self_larger)
        val move = brandString(R.string.call_self_move)

        Box(
            Modifier
                // Absolute, not start-relative: in Persian a start-relative
                // offset would put "left" on the right and move the card
                // against the finger.
                .align(AbsoluteAlignment.TopLeft)
                .absoluteOffset { IntOffset(position.value.x.roundToInt(), position.value.y.roundToInt()) }
                .size(shownDp.dp, (shownDp * 4f / 3f).dp)
                .outerShadow(shape, t.shadows.floatShadow)
                .clip(shape)
                // Dark until a picture's first frame: a renderer made fresh
                // by a swap is see-through for a moment, and the big picture
                // must not show through it.
                .background(CallPalette.tile)
                .border(1.dp, t.colors.callBtnLine, shape)
                // One element: what it shows, what fills the screen, and a
                // click that swaps them. The picture or face inside adds nothing.
                .clearAndSetSemantics {
                    testTag = CallTags.SELF_VIEW
                    contentDescription = label
                    stateDescription = state
                    onClick(label = swapLabel) {
                        swap()
                        true
                    }
                    customActions = listOf(
                        CustomAccessibilityAction(move) {
                            corner = corner.next().also { placement.corner = it }
                            true
                        },
                        CustomAccessibilityAction(smaller) {
                            widthDp = SelfViewSize.clamp(shownDp - 28f).also { placement.width = it }
                            true
                        },
                        CustomAccessibilityAction(larger) {
                            widthDp = SelfViewSize.clamp(shownDp + 28f).also { placement.width = it }
                            true
                        },
                    )
                },
        ) {
            content()
            // Over the picture rather than on it: the renderer is an Android
            // view, and the touches are the card's, not the picture's.
            Box(
                Modifier
                    .matchParentSize()
                    .pointerInput(Unit) {
                        /**
                         * One touch, from its finger coming down to every
                         * finger lifting: a drag or a pinch moves and sizes
                         * the card as it goes. Returns when the fingers lift:
                         * the time they did when nothing moved and nothing
                         * cancelled it — a tap — else null. [onMoveStart] is
                         * told the moment it becomes a drag or a pinch.
                         */
                        suspend fun AwaitPointerEventScope.track(
                            down: PointerInputChange,
                            onMoveStart: () -> Unit,
                        ): Long? {
                            // In the call screen's own coordinates: the card
                            // moves under the finger, so its local ones stand still.
                            var at = position.value
                            var travelled = Offset.Zero
                            val velocity = VelocityTracker()
                            velocity.addPosition(down.uptimeMillis, travelled)
                            var moved = false
                            var liftedAt: Long? = null
                            // A tap that wobbles is still a tap: nothing moves
                            // until the finger has gone past the touch slop, or
                            // a second finger has come down to pinch.
                            var pending = Offset.Zero
                            do {
                                val event = awaitPointerEvent()
                                // Lifted, not cancelled (a cancel's lift comes consumed).
                                liftedAt = if (event.changes.all { it.changedToUp() }) {
                                    event.changes.firstOrNull()?.uptimeMillis
                                } else {
                                    null
                                }
                                val zoom = event.calculateZoom()
                                var pan = event.calculatePan()
                                if (!moved) {
                                    pending += pan
                                    val pinching = event.changes.count { it.pressed } > 1
                                    if (!pinching && pending.getDistance() < viewConfiguration.touchSlop) continue
                                    moved = true
                                    dragging = true
                                    onMoveStart()
                                    pan = pending
                                }
                                if (zoom != 1f || pan != Offset.Zero) {
                                    if (zoom != 1f) {
                                        val g = measures
                                        val before = g.shownWidth(widthDp)
                                        // From the size on screen, so a card held
                                        // small by a low band answers at once.
                                        widthDp = SelfViewSize.clamp(before * zoom)
                                        // Grows and shrinks about its middle, not its corner.
                                        val grown = (g.shownWidth(widthDp) - before) * g.density
                                        at -= Offset(grown / 2f, grown * 2f / 3f)
                                    }
                                    travelled += pan
                                    at = measures.clamp(at + pan, widthDp)
                                    val next = at
                                    scope.launch { position.snapTo(next) }
                                    event.changes.forEach { if (it.positionChanged()) it.consume() }
                                }
                                event.changes.firstOrNull()?.let { velocity.addPosition(it.uptimeMillis, travelled) }
                            } while (event.changes.any { it.pressed })

                            if (!moved) return liftedAt
                            // A flick counts: where it was heading, a fifth of a second on.
                            val v = velocity.calculateVelocity()
                            val g = measures
                            val w = g.shownWidth(widthDp) * g.density
                            val aimed = at + Offset(w / 2f, w * 2f / 3f) + Offset(v.x, v.y) * 0.2f
                            val next = SelfViewCorner.nearest(aimed.x, aimed.y, g.areaWidth, g.top, g.bottom)
                            placement.corner = next
                            placement.width = widthDp
                            corner = next
                            dragging = false
                            return null
                        }

                        awaitEachGesture {
                            val firstUp = track(awaitFirstDown(requireUnconsumed = false)) {}
                                ?: return@awaitEachGesture
                            // A tap: unless a second follows close behind it,
                            // which makes the two a double-tap.
                            val second = withTimeoutOrNull(viewConfiguration.doubleTapTimeoutMillis) {
                                var next: PointerInputChange
                                do {
                                    next = awaitFirstDown(requireUnconsumed = false)
                                } while (next.uptimeMillis < firstUp + viewConfiguration.doubleTapMinTimeMillis)
                                next
                            }
                            if (second == null) {
                                swap()
                                return@awaitEachGesture
                            }
                            // A second touch that drags or pinches leaves the
                            // first a tap of its own, swapped the moment that is clear.
                            val secondUp = track(second) { swap() }
                            if (secondUp != null) {
                                widthDp = measures.nextStep(widthDp).also { placement.width = it }
                            }
                        }
                    },
            )
        }
    }
}

/**
 * The call screen's measures, in pixels from its top left: the band the card
 * keeps to between [top] and [bottom], [left] and [right], and the whole
 * screen it may be dragged across.
 */
internal data class SelfViewGeometry(
    val areaWidth: Float,
    val areaHeight: Float,
    val left: Float,
    val right: Float,
    val top: Float,
    val bottom: Float,
    /** Pixels per dp. */
    val density: Float,
) {
    /**
     * The width the card is drawn at, in dp: the one asked for, or less when
     * the band is lower than that card would be — never under [SelfViewSize.MIN].
     */
    fun shownWidth(widthDp: Float): Float {
        val fits = (bottom - top) * 3f / 4f / density
        return minOf(widthDp, maxOf(SelfViewSize.MIN, fits))
    }

    /**
     * The width a double-tap steps to: the next step up from the card as it
     * is drawn — or, when the band draws that step no larger (a phone on its
     * side), round to the smallest, so a double-tap always does something
     * while there is a smaller step to take.
     */
    fun nextStep(widthDp: Float): Float {
        val shown = shownWidth(widthDp)
        val next = SelfViewSize.next(shown)
        return if (shownWidth(next) > shown + 1f) next else SelfViewSize.next(SelfViewSize.MAX)
    }

    /**
     * Where the card's top left goes in [corner]. Taller than the band even
     * at its smallest, it gives way upwards — over the name, never down over
     * the buttons.
     */
    fun target(corner: SelfViewCorner, widthDp: Float): Offset {
        val w = shownWidth(widthDp) * density
        val h = w * 4f / 3f
        val x = if (corner.left) left else right - w
        val y = if (corner.top) minOf(top, bottom - h) else bottom - h
        return Offset(x.coerceAtLeast(0f), y.coerceAtLeast(0f))
    }

    /** Kept on the screen while it is dragged; the corners are for letting go. */
    fun clamp(p: Offset, widthDp: Float): Offset {
        val w = shownWidth(widthDp) * density
        val h = w * 4f / 3f
        return Offset(
            x = p.x.coerceIn(0f, maxOf(0f, areaWidth - w)),
            y = p.y.coerceIn(0f, maxOf(0f, areaHeight - h)),
        )
    }
}
