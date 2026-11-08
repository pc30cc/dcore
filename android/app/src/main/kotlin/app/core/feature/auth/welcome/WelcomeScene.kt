package app.core.feature.auth.welcome

import androidx.compose.animation.core.withInfiniteAnimationFrameNanos
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableLongState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlin.math.abs

/**
 * Where the welcome's text and buttons are, in the scene's pixels: the
 * bubbles keep clear of both and float in the band between them. Set from
 * the layout ([update]); a change re-lays the bubbles at the next frame.
 */
@Stable
class SceneGeometry {
    var version by mutableIntStateOf(0)
        private set
    var width = 0f
        private set
    var height = 0f
        private set

    /** The text block (eyebrow, headline, subtitle). */
    var text = Rect.Zero
        private set

    /** The headline and the subtitle, each: the scrim behind them is measured per line of text. */
    var headline = Rect.Zero
        private set
    var subtitle = Rect.Zero
        private set

    /** The buttons and the terms line. */
    var controls = Rect.Zero
        private set

    val ready: Boolean get() = width > 0f && height > 0f && controls != Rect.Zero

    fun update(
        size: Size? = null,
        text: Rect? = null,
        controls: Rect? = null,
        headline: Rect? = null,
        subtitle: Rect? = null,
    ) {
        var changed = false
        if (headline != null && differs(headline, this.headline)) {
            this.headline = headline
            changed = true
        }
        if (subtitle != null && differs(subtitle, this.subtitle)) {
            this.subtitle = subtitle
            changed = true
        }
        if (size != null && (abs(size.width - width) > 0.5f || abs(size.height - height) > 0.5f)) {
            width = size.width
            height = size.height
            changed = true
        }
        if (text != null && differs(text, this.text)) {
            this.text = text
            changed = true
        }
        if (controls != null && differs(controls, this.controls)) {
            this.controls = controls
            changed = true
        }
        if (changed) version++
    }

    /** Touches here belong to the text's links and the buttons, not to the bubbles. */
    fun reserved(x: Float, y: Float): Boolean = controls.contains(Offset(x, y)) || text.contains(Offset(x, y))

    private fun differs(a: Rect, b: Rect) =
        abs(a.left - b.left) > 0.5f || abs(a.top - b.top) > 0.5f || abs(a.right - b.right) > 0.5f || abs(a.bottom - b.bottom) > 0.5f
}

/**
 * The welcome's moving picture: the brand's gradient, the bubbles, and the
 * scrim that keeps the text readable. Decorative: TalkBack does not see it.
 *
 * One frame loop drives everything while [running] and the screen is
 * resumed: finite through the opening (so tests that wait for idle see it
 * end), then as an infinite animation. Each frame steps [field] and bumps a
 * counter the draw reads; nothing recomposes and nothing is allocated.
 */
@Composable
fun WelcomeScene(
    colors: WelcomeColors,
    field: BubbleField,
    art: BubbleArt,
    geometry: SceneGeometry,
    running: Boolean,
    intro: Boolean,
    headlineInk: Color,
    modifier: Modifier = Modifier,
) {
    val tick = remember { mutableLongStateOf(0L) }
    val density = LocalDensity.current.density
    // Plain, not state: written while drawing.
    val laidOutVersion = remember { intArrayOf(-1) }
    val keepOut = remember { FloatArray(8) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    // Lays the bubbles out when the text or the buttons moved: from the frame loop, and from the draw for a still scene.
    val startIntro by rememberUpdatedState(intro && running)
    val ensureLaidOut = remember(field, geometry, density) {
        {
            if (laidOutVersion[0] != geometry.version && geometry.ready) {
                layOut(field, geometry, keepOut, density, startIntro)
                laidOutVersion[0] = geometry.version
            }
        }
    }

    LaunchedEffect(field, running) {
        if (!running) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { frames(field, tick, ensureLaidOut) }
    }

    Spacer(
        modifier
            .clearAndSetSemantics { }
            .drawWithCache {
                // Read here so the cached brushes follow the text's place.
                geometry.version
                val stops = WelcomePalette.stops(colors)
                val gradient = Brush.verticalGradient(*stops, startY = 0f, endY = size.height)
                val scrimBrush = scrimBand(colors, geometry.headline, geometry.subtitle, headlineInk, size, 64f * density)
                onDrawBehind {
                    tick.longValue
                    ensureLaidOut()
                    drawRect(gradient)
                    drawIntoCanvas { art.draw(it.nativeCanvas, field, density) }
                    scrimBrush?.let { (brush, rect) -> drawRect(brush, topLeft = rect.topLeft, size = rect.size) }
                }
            },
    )
}

/**
 * A soft band of the gradient's own deepest colour behind the headline and
 * the subtitle, each as dark as its text needs there (large text 3:1, the
 * subtitle 4.5:1, both with a margin), fading out above and below. Null
 * when the gradient needs none.
 */
private fun scrimBand(colors: WelcomeColors, headline: Rect, subtitle: Rect, ink: Color, size: Size, pad: Float): Pair<Brush, Rect>? {
    if (headline == Rect.Zero || subtitle == Rect.Zero || size.height <= 0f) return null
    val h = size.height
    val forHeadline = WelcomePalette.scrimOver(colors, headline.top / h, headline.bottom / h, ink, WelcomePalette.LARGE_TEXT)
    val forSubtitle = WelcomePalette.scrimOver(colors, subtitle.top / h, subtitle.bottom / h, WelcomePalette.Subtitle, WelcomePalette.SMALL_TEXT)
    if (forHeadline <= 0f && forSubtitle <= 0f) return null
    // One level for the whole block (steps between lines would show as stripes), eased in and out.
    val alpha = maxOf(forHeadline, forSubtitle)
    val scrim = WelcomePalette.scrim(colors)
    val top = (headline.top - pad).coerceAtLeast(0f)
    val bottom = subtitle.bottom + pad
    val span = bottom - top
    fun at(y: Float) = ((y - top) / span).coerceIn(0f, 1f)
    val brush = Brush.verticalGradient(
        0f to scrim.copy(alpha = 0f),
        at(headline.top - pad * 0.5f) to scrim.copy(alpha = alpha * 0.5f),
        at(headline.top) to scrim.copy(alpha = alpha),
        at(subtitle.bottom) to scrim.copy(alpha = alpha),
        at(subtitle.bottom + pad * 0.5f) to scrim.copy(alpha = alpha * 0.5f),
        1f to scrim.copy(alpha = 0f),
        startY = top,
        endY = bottom,
    )
    return brush to Rect(0f, top, size.width, bottom)
}

/** The band the bubbles live in, and what they keep clear of. */
private fun layOut(field: BubbleField, geometry: SceneGeometry, keepOut: FloatArray, density: Float, intro: Boolean) {
    val margin = 14f * density
    val text = geometry.text
    val controls = geometry.controls
    keepOut[0] = text.left - margin
    keepOut[1] = text.top - margin
    keepOut[2] = text.right + margin
    keepOut[3] = text.bottom + margin
    keepOut[4] = 0f
    keepOut[5] = controls.top - margin * 0.5f
    keepOut[6] = geometry.width
    keepOut[7] = geometry.height
    val top = if (text == Rect.Zero) geometry.height * 0.3f else text.bottom + margin
    val bottom = controls.top - margin
    field.layout(geometry.width, geometry.height, top, bottom, keepOut, startIntro = intro)
}

private suspend fun frames(field: BubbleField, tick: MutableLongState, ensureLaidOut: () -> Unit) {
    var first = 0L
    var last = 0L
    val onFrame: (Long) -> Unit = { now ->
        ensureLaidOut()
        if (first == 0L) first = now
        if (last != 0L && field.laidOut) field.step((now - last) / 1_000_000_000f)
        last = now
        tick.longValue = now
    }
    // The opening is finite (a test waiting for idle waits it out), and bounded in time even if the
    // scene is never measured.
    val limit = ((BubbleField.INTRO_END + 1f) * 1_000_000_000f).toLong()
    while (field.time < BubbleField.INTRO_END && (first == 0L || last - first < limit)) withFrameNanos(onFrame)
    // Then the float, for as long as the screen is there.
    while (true) withInfiniteAnimationFrameNanos(onFrame)
}

/**
 * Drag, fling and pop for the bubbles, read before the content above them
 * (the text, the buttons, a scrolling column) sees the touch, and only when
 * it lands on a bubble outside the text and the buttons.
 */
fun Modifier.bubbleTouch(field: BubbleField, geometry: SceneGeometry, enabled: Boolean, onPop: () -> Unit): Modifier =
    if (!enabled) {
        this
    } else {
        pointerInput(field) {
            val tracker = VelocityTracker()
            val slop = viewConfiguration.touchSlop
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                val start = down.position
                if (geometry.reserved(start.x, start.y)) return@awaitEachGesture
                val hit = field.hit(start.x, start.y)
                if (hit < 0) return@awaitEachGesture
                down.consume()
                tracker.resetTracking()
                tracker.addPosition(down.uptimeMillis, start)
                field.grab(hit, start.x, start.y)
                var moved = false
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                    change.consume()
                    if (!change.pressed) break
                    tracker.addPosition(change.uptimeMillis, change.position)
                    if (!moved && (change.position - start).getDistance() > slop) moved = true
                    if (moved) field.dragTo(change.position.x, change.position.y)
                }
                if (moved) {
                    val velocity = tracker.calculateVelocity()
                    field.release(velocity.x, velocity.y)
                } else {
                    field.release(0f, 0f)
                    if (field.pop(hit)) onPop()
                }
            }
        }
    }

/** The haptic a pop gives. */
@Composable
fun rememberPopFeedback(): () -> Unit {
    val haptics by rememberUpdatedState(LocalHapticFeedback.current)
    return remember { { haptics.performHapticFeedback(HapticFeedbackType.ContextClick) } }
}
