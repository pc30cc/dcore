package app.core.feature.deck

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.input.pointer.util.addPointerInputChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.util.lerp
import app.core.R
import app.core.feature.card.cardDescription
import app.core.i18n.brandString
import app.core.model.Catalog
import app.core.model.ProfileCard
import app.core.model.SwipeAction
import app.core.sync.ReturnSide
import app.core.sync.ReturningCard
import app.core.ui.theme.LocalReducedMotion
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/**
 * The position of one card: where the finger has it, or where an animation
 * is taking it. Translation is in screen pixels and never mirrored: right is
 * like in every language.
 */
@Stable
class SwipeCardState(initial: Offset = Offset.Zero) {
    val offset = Animatable(initial, Offset.VectorConverter)
    var size by mutableStateOf(IntSize.Zero)
    var lowerHalf by mutableStateOf(false)

    val progress: Float get() = SwipeThresholds.progress(offset.value.x, size.width.toFloat())
    val upProgress: Float get() = SwipeThresholds.upProgress(offset.value.x, offset.value.y, size.height.toFloat())

    /** Back to the middle, with the release velocity: a spring that settles without bouncing past much. */
    suspend fun settle(velocity: Velocity = Velocity.Zero) {
        offset.animateTo(Offset.Zero, spring(dampingRatio = 0.62f, stiffness = 520f), Offset(velocity.x, velocity.y))
    }

    /**
     * Off the screen in the direction of [action], continuing the finger's
     * velocity when there was one. With less motion asked for, it simply goes.
     */
    suspend fun flyOut(action: SwipeAction, velocity: Velocity, reduced: Boolean) {
        val w = max(size.width, 1).toFloat()
        val h = max(size.height, 1).toFloat()
        val current = offset.value
        val target = when (action) {
            SwipeAction.Superlike -> Offset(current.x * 0.5f, -h * 1.5f)
            SwipeAction.Pass -> Offset(-w * 1.6f, current.y + velocity.y * 0.12f - h * 0.05f)
            else -> Offset(w * 1.6f, current.y + velocity.y * 0.12f - h * 0.05f)
        }
        if (reduced) {
            offset.snapTo(target)
            return
        }
        val distance = (target - current).getDistance()
        val speed = sqrt(velocity.x * velocity.x + velocity.y * velocity.y).coerceAtLeast(MIN_FLY_SPEED)
        val millis = (distance / speed * 1000f).toInt().coerceIn(140, 320)
        offset.animateTo(target, tween(millis, easing = if (velocity == Velocity.Zero) FastOutSlowInEasing else LinearOutSlowInEasing))
    }

    /** A card coming back (rewind, a like that did not go): in from the side it left by. */
    suspend fun enter(reduced: Boolean) {
        if (reduced) offset.snapTo(Offset.Zero) else offset.animateTo(Offset.Zero, spring(dampingRatio = 0.72f, stiffness = 380f))
    }

    private companion object {
        /** px/s: a button press flies the card at least this fast. */
        const val MIN_FLY_SPEED = 4_200f
    }
}

/**
 * What the buttons under the stack use to throw the top card the same way a
 * finger would, and to light up while it is dragged.
 */
@Stable
class DeckController {
    internal var top: SwipeCardState? by mutableStateOf(null)
    internal var commit: ((SwipeAction) -> Unit)? = null

    /** -1 (pass) to 1 (like), for the buttons' highlight. */
    val progress: Float get() = top?.progress ?: 0f

    /** Throws the top card for [action], as a finger would. False when there is no card. */
    fun swipe(action: SwipeAction): Boolean {
        val go = commit ?: return false
        go(action)
        return true
    }
}

private data class FlyingCard(val card: ProfileCard, val state: SwipeCardState, val photoIndex: Int)

/**
 * The stack: the top card follows the finger, the next one waits under it
 * and grows into place as the top one leaves. A card that is thrown keeps
 * flying above the stack while the next is already live, so fast swiping is
 * never held up by an animation.
 */
@Composable
fun CardStack(
    cards: List<ProfileCard>,
    returning: ReturningCard?,
    catalog: Catalog,
    number: (Int) -> String,
    controller: DeckController,
    onSwiped: (ProfileCard, SwipeAction) -> Unit,
    onOpenDetails: (ProfileCard) -> Unit,
    onReturnShown: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val reduced = LocalReducedMotion.current
    val density = LocalDensity.current
    val flying = remember { mutableStateListOf<FlyingCard>() }
    val swiped by rememberUpdatedState(onSwiped)
    val openDetails by rememberUpdatedState(onOpenDetails)

    BoxWithConstraints(modifier) {
        val widthPx = with(density) { maxWidth.toPx() }
        val heightPx = with(density) { maxHeight.toPx() }
        val top = cards.firstOrNull()
        val next = cards.getOrNull(1)
        val topState = top?.let { card ->
            remember(card.id) {
                val start = returning?.takeIf { it.id == card.id }?.let { startOffset(it.side, widthPx, heightPx) } ?: Offset.Zero
                SwipeCardState(start)
            }
        }
        val photoIndexes = remember { mutableStateMapOf<String, Int>() }
        val lastNext = remember { NextCardScale() }

        fun commit(card: ProfileCard, state: SwipeCardState, action: SwipeAction, velocity: Velocity) {
            haptics.performHapticFeedback(if (action == SwipeAction.Pass) HapticFeedbackType.GestureEnd else HapticFeedbackType.Confirm)
            val ghost = FlyingCard(card, state, photoIndexes[card.id] ?: 0)
            flying += ghost
            swiped(card, action)
            scope.launch {
                state.flyOut(action, velocity, reduced)
                flying.remove(ghost)
            }
        }

        if (top != null && topState != null) {
            DisposableEffect(topState) {
                controller.top = topState
                controller.commit = { action -> commit(top, topState, action, Velocity.Zero) }
                onDispose {
                    if (controller.top === topState) {
                        controller.top = null
                        controller.commit = null
                    }
                }
            }
            LaunchedEffect(top.id, returning?.id) {
                if (returning?.id == top.id) {
                    topState.enter(reduced)
                    onReturnShown(top.id)
                }
            }
        }

        // The card under the top one, growing in as the top one is dragged away.
        if (next != null) {
            key(next.id) {
                StackCard(
                    card = next,
                    catalog = catalog,
                    number = number,
                    photoIndex = photoIndexes[next.id] ?: 0,
                    onPhotoIndex = {},
                    interactive = false,
                    modifier = Modifier
                        .fillMaxSize()
                        .graphicsLayer {
                            // Read here, in the layer, so a drag redraws this card without recomposing it.
                            val pull = topState?.let { max(abs(it.progress), it.upProgress) } ?: 0f
                            val scale = lerp(NEXT_SCALE, 1f, pull)
                            lastNext.id = next.id
                            lastNext.scale = scale
                            scaleX = scale
                            scaleY = scale
                        },
                )
            }
        }

        if (top != null && topState != null) {
            key(top.id) {
                // The card that was waiting underneath grows the rest of the way into place.
                val grow = remember(top.id) { Animatable(if (lastNext.id == top.id) lastNext.scale else 1f) }
                LaunchedEffect(top.id) {
                    if (reduced) grow.snapTo(1f) else grow.animateTo(1f, spring(dampingRatio = 0.8f, stiffness = 500f))
                }
                val description = cardDescription(top, number, catalog)
                val photoPosition = brandString(
                    R.string.deck_photo_position,
                    number((photoIndexes[top.id] ?: 0) + 1),
                    number(top.photos.size.coerceAtLeast(1)),
                )
                val likeLabel = brandString(R.string.deck_action_like)
                val passLabel = brandString(R.string.deck_action_pass)
                val superLabel = brandString(R.string.deck_action_superlike)
                val detailsLabel = brandString(R.string.deck_action_details)
                val nextLabel = brandString(R.string.deck_action_next_photo)
                val previousLabel = brandString(R.string.deck_action_previous_photo)
                Box(
                    Modifier
                        .fillMaxSize()
                        .onSizeChanged { topState.size = it }
                        .semantics(mergeDescendants = true) {
                            contentDescription = description
                            stateDescription = photoPosition
                            customActions = listOf(
                                CustomAccessibilityAction(likeLabel) { commit(top, topState, SwipeAction.Like, Velocity.Zero); true },
                                CustomAccessibilityAction(passLabel) { commit(top, topState, SwipeAction.Pass, Velocity.Zero); true },
                                CustomAccessibilityAction(superLabel) { commit(top, topState, SwipeAction.Superlike, Velocity.Zero); true },
                                CustomAccessibilityAction(detailsLabel) { openDetails(top); true },
                                CustomAccessibilityAction(nextLabel) {
                                    val i = photoIndexes[top.id] ?: 0
                                    if (i + 1 < top.photos.size) photoIndexes[top.id] = i + 1
                                    true
                                },
                                CustomAccessibilityAction(previousLabel) {
                                    val i = photoIndexes[top.id] ?: 0
                                    if (i > 0) photoIndexes[top.id] = i - 1
                                    true
                                },
                            )
                        }
                        .pointerInput(top.id) {
                            val tracker = VelocityTracker()
                            var armed = SwipeDecision.Cancel
                            detectDragGestures(
                                onDragStart = { start ->
                                    tracker.resetTracking()
                                    armed = SwipeDecision.Cancel
                                    topState.lowerHalf = start.y > size.height / 2f
                                    scope.launch { topState.offset.stop() }
                                },
                                onDrag = { change, amount ->
                                    change.consume()
                                    tracker.addPointerInputChange(change)
                                    scope.launch { topState.offset.snapTo(topState.offset.value + amount) }
                                    val o = topState.offset.value + amount
                                    val now = SwipeThresholds.decide(o.x, o.y, 0f, 0f, size.width.toFloat(), size.height.toFloat(), density.density)
                                    if (now != armed) {
                                        if (now != SwipeDecision.Cancel) haptics.performHapticFeedback(HapticFeedbackType.GestureThresholdActivate)
                                        armed = now
                                    }
                                },
                                onDragEnd = {
                                    val v = tracker.calculateVelocity()
                                    val o = topState.offset.value
                                    when (SwipeThresholds.decide(o.x, o.y, v.x, v.y, size.width.toFloat(), size.height.toFloat(), density.density)) {
                                        SwipeDecision.Like -> commit(top, topState, SwipeAction.Like, v)
                                        SwipeDecision.Pass -> commit(top, topState, SwipeAction.Pass, v)
                                        SwipeDecision.Details -> {
                                            scope.launch { topState.settle(v) }
                                            openDetails(top)
                                        }
                                        SwipeDecision.Cancel -> scope.launch { topState.settle(v) }
                                    }
                                },
                                onDragCancel = { scope.launch { topState.settle() } },
                            )
                        },
                ) {
                    StackCard(
                        card = top,
                        catalog = catalog,
                        number = number,
                        photoIndex = photoIndexes[top.id] ?: 0,
                        onPhotoIndex = { photoIndexes[top.id] = it },
                        interactive = true,
                        onOpenDetails = { openDetails(top) },
                        state = topState,
                        modifier = Modifier
                            .fillMaxSize()
                            .graphicsLayer {
                                scaleX = grow.value
                                scaleY = grow.value
                            },
                    )
                }
            }
        }

        // Thrown cards, finishing their flight above everything, untouchable.
        flying.forEach { ghost ->
            key("flying", ghost.card.id) {
                StackCard(
                    card = ghost.card,
                    catalog = catalog,
                    number = number,
                    photoIndex = ghost.photoIndex,
                    onPhotoIndex = {},
                    interactive = false,
                    state = ghost.state,
                    modifier = Modifier.fillMaxSize().semantics { },
                )
            }
        }
    }
}

@Composable
private fun StackCard(
    card: ProfileCard,
    catalog: Catalog,
    number: (Int) -> String,
    photoIndex: Int,
    onPhotoIndex: (Int) -> Unit,
    interactive: Boolean,
    modifier: Modifier = Modifier,
    onOpenDetails: () -> Unit = {},
    state: SwipeCardState? = null,
) {
    val reduced = LocalReducedMotion.current
    val moved = if (state != null) {
        Modifier.graphicsLayer {
            val o = state.offset.value
            translationX = o.x
            translationY = o.y
            if (!reduced) {
                rotationZ = SwipeThresholds.rotation(o.x, state.size.width.toFloat(), state.lowerHalf)
                transformOrigin = TransformOrigin(0.5f, if (state.lowerHalf) -0.25f else 1.25f)
            }
        }
    } else {
        Modifier
    }
    DeckCardFace(
        card = card,
        photoIndex = photoIndex,
        onPhotoIndex = onPhotoIndex,
        catalog = catalog,
        number = number,
        onOpenDetails = onOpenDetails,
        interactive = interactive,
        progress = { state?.progress ?: 0f },
        upProgress = { state?.upProgress ?: 0f },
        modifier = modifier.then(moved),
    )
}

private const val NEXT_SCALE = 0.94f

private fun startOffset(side: ReturnSide, width: Float, height: Float): Offset = when (side) {
    ReturnSide.Left -> Offset(-width * 1.3f, 0f)
    ReturnSide.Right -> Offset(width * 1.3f, 0f)
    ReturnSide.Top -> Offset(0f, -height * 1.3f)
}

/** The scale the waiting card was last drawn at, so it keeps growing from there when it becomes the top. Not state: written while drawing. */
private class NextCardScale {
    var id: String? = null
    var scale: Float = NEXT_SCALE
}
