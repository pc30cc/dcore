package app.core.feature.deck

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** When a drag becomes a like, a pass or "open the profile" (a 360 × 560 dp card at density 3). */
class SwipeThresholdsTest {

    private val density = 3f
    private val w = 360f * density
    private val h = 560f * density

    private fun decide(dx: Float, dy: Float = 0f, vx: Float = 0f, vy: Float = 0f) =
        SwipeThresholds.decide(dx, dy, vx, vy, w, h, density)

    @Test
    fun farEnoughRightIsALikeAndLeftIsAPass() {
        assertEquals(SwipeDecision.Like, decide(dx = w * 0.31f))
        assertEquals(SwipeDecision.Pass, decide(dx = -w * 0.31f))
    }

    @Test
    fun shortOfTheLineSpringsBack() {
        assertEquals(SwipeDecision.Cancel, decide(dx = w * 0.29f))
        assertEquals(SwipeDecision.Cancel, decide(dx = -w * 0.2f))
        assertEquals(SwipeDecision.Cancel, decide(dx = 0f))
    }

    @Test
    fun aFlingCommitsAShortDragInItsDirection() {
        val fast = 1_200f * density
        assertEquals(SwipeDecision.Like, decide(dx = w * 0.1f, vx = fast))
        assertEquals(SwipeDecision.Pass, decide(dx = -w * 0.1f, vx = -fast))
    }

    @Test
    fun aTwitchIsNotADecisionHoweverFast() {
        assertEquals(SwipeDecision.Cancel, decide(dx = w * 0.03f, vx = 3_000f * density))
    }

    @Test
    fun aFlingBackCancelsEvenPastTheLine() {
        assertEquals(SwipeDecision.Cancel, decide(dx = w * 0.4f, vx = -1_500f * density))
        assertEquals(SwipeDecision.Cancel, decide(dx = -w * 0.4f, vx = 1_500f * density))
    }

    @Test
    fun aSlowReleasePastTheLineStillCommits() {
        assertEquals(SwipeDecision.Like, decide(dx = w * 0.5f, vx = 200f * density))
    }

    @Test
    fun upOpensTheProfileDownDoesNothing() {
        assertEquals(SwipeDecision.Details, decide(dx = 10f, dy = -h * 0.2f))
        assertEquals(SwipeDecision.Details, decide(dx = 0f, dy = -h * 0.1f, vy = -1_500f * density))
        assertEquals(SwipeDecision.Cancel, decide(dx = 0f, dy = h * 0.4f, vy = 2_000f * density))
        assertEquals(SwipeDecision.Cancel, decide(dx = 0f, dy = -h * 0.25f, vy = 1_500f * density))
    }

    @Test
    fun theDominantAxisDecides() {
        // Mostly up with a little sideways: details, not a like.
        assertEquals(SwipeDecision.Details, decide(dx = w * 0.15f, dy = -h * 0.3f))
        // Mostly sideways with a little up: a like.
        assertEquals(SwipeDecision.Like, decide(dx = w * 0.35f, dy = -h * 0.1f))
    }

    @Test
    fun noSizeNoDecision() {
        assertEquals(SwipeDecision.Cancel, SwipeThresholds.decide(500f, 0f, 0f, 0f, 0f, 0f, density))
    }

    @Test
    fun progressIsSignedAndClamped() {
        assertEquals(0.5f, SwipeThresholds.progress(w * 0.15f, w), 0.001f)
        assertEquals(-1f, SwipeThresholds.progress(-w, w), 0.001f)
        assertEquals(1f, SwipeThresholds.progress(w * 2, w), 0.001f)
        assertEquals(0f, SwipeThresholds.upProgress(0f, 100f, h), 0.001f)
        assertEquals(1f, SwipeThresholds.upProgress(0f, -h, h), 0.001f)
    }

    @Test
    fun tiltFollowsTheDragAndFlipsBelowTheMiddle() {
        val r = SwipeThresholds.rotation(w * 0.25f, w, grabbedLowerHalf = false)
        assertTrue(r > 0f)
        assertEquals(-r, SwipeThresholds.rotation(w * 0.25f, w, grabbedLowerHalf = true), 0.001f)
        assertEquals(SwipeThresholds.MAX_TILT_DEGREES, SwipeThresholds.rotation(w * 5, w, false), 0.001f)
    }
}
