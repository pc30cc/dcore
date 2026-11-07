package app.core.feature.deck

import kotlin.math.abs

/** What a released drag on the top card means. */
enum class SwipeDecision { Like, Pass, Details, Cancel }

/**
 * When a drag on the top card becomes a like, a pass or "open the profile",
 * in one place, tested on the JVM.
 *
 * Directions are the screen's, not the reading direction's: right is like in
 * every language (a habit people carry between apps), so the card's
 * translation and these offsets are absolute, never mirrored for Persian.
 *
 * A drag commits when it went far enough ([distanceFraction] of the card's
 * width, [upFraction] of its height up) or when it was flung fast enough
 * ([flingDpPerSecond]) in the direction it was already going, past a small
 * minimum so a fast twitch is not a decision. A fling against the drag cancels
 * it: someone who dragged right and threw back left changed their mind.
 */
object SwipeThresholds {
    const val DISTANCE_FRACTION = 0.30f
    const val UP_FRACTION = 0.18f
    const val FLING_DP_PER_SECOND = 1_000f
    const val FLING_MIN_FRACTION = 0.08f

    /**
     * [dx]/[dy] are the card's offset in px (right and down positive), [vx]/[vy]
     * the release velocity in px/s, [density] px per dp.
     */
    fun decide(
        dx: Float,
        dy: Float,
        vx: Float,
        vy: Float,
        widthPx: Float,
        heightPx: Float,
        density: Float,
    ): SwipeDecision {
        if (widthPx <= 0f || heightPx <= 0f) return SwipeDecision.Cancel
        val fling = FLING_DP_PER_SECOND * density
        val horizontal = abs(dx) >= abs(dy)

        if (horizontal) {
            val far = abs(dx) >= widthPx * DISTANCE_FRACTION
            val flungSameWay = abs(vx) >= fling && sameSign(dx, vx) && abs(dx) >= widthPx * FLING_MIN_FRACTION
            val flungBack = abs(vx) >= fling && !sameSign(dx, vx)
            if ((far && !flungBack) || flungSameWay) return if (dx > 0) SwipeDecision.Like else SwipeDecision.Pass
            return SwipeDecision.Cancel
        }

        if (dy < 0) {
            val far = -dy >= heightPx * UP_FRACTION
            val flungUp = vy <= -fling && -dy >= heightPx * FLING_MIN_FRACTION
            val flungDown = vy >= fling
            if ((far && !flungDown) || flungUp) return SwipeDecision.Details
        }
        return SwipeDecision.Cancel
    }

    /**
     * How far toward a like (positive, up to 1) or a pass (negative, down to -1)
     * the card is: what the overlays and the buttons under the card show.
     */
    fun progress(dx: Float, widthPx: Float): Float =
        if (widthPx <= 0f) 0f else (dx / (widthPx * DISTANCE_FRACTION)).coerceIn(-1f, 1f)

    /** How far toward "open the profile", 0 to 1. */
    fun upProgress(dx: Float, dy: Float, heightPx: Float): Float =
        if (heightPx <= 0f || dy >= 0f || abs(dx) > abs(dy)) 0f else (-dy / (heightPx * UP_FRACTION)).coerceIn(0f, 1f)

    /** The card's tilt for a drag: up to 12°, the other way round when it was grabbed below its middle. */
    fun rotation(dx: Float, widthPx: Float, grabbedLowerHalf: Boolean): Float {
        if (widthPx <= 0f) return 0f
        val degrees = (dx / widthPx * MAX_TILT_DEGREES * 1.6f).coerceIn(-MAX_TILT_DEGREES, MAX_TILT_DEGREES)
        return if (grabbedLowerHalf) -degrees else degrees
    }

    const val MAX_TILT_DEGREES = 12f

    private fun sameSign(a: Float, b: Float): Boolean = (a > 0f && b > 0f) || (a < 0f && b < 0f)
}
