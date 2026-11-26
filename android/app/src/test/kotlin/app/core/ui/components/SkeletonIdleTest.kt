package app.core.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The loading sweep moves on every frame but only redraws: what wears a
 * skeleton is not composed again for it (nor are its semantics rebuilt), and
 * with less motion asked for nothing changes at all.
 *
 * The clock is held from the start: with it advancing by itself the test
 * rule cancels infinite animations, and the sweep would never run.
 */
@RunWith(AndroidJUnit4::class)
class SkeletonIdleTest {

    @get:Rule val compose = createComposeRule()

    private var compositions = 0

    @Composable
    private fun Probe() {
        SideEffect { compositions++ }
        Box(Modifier.size(120.dp, 40.dp).skeleton())
    }

    /** The snapshot state changes applied over [frames] frames. */
    private fun appliedOver(frames: Int): List<Set<Any>> {
        val applied = mutableListOf<Set<Any>>()
        val observer = Snapshot.registerApplyObserver { changed, _ -> if (changed.isNotEmpty()) applied += changed }
        try {
            repeat(frames) { compose.mainClock.advanceTimeByFrame() }
        } finally {
            observer.dispose()
        }
        return applied
    }

    @Test
    fun theSweepMovesWithoutComposingItsCallerAgain() {
        compose.mainClock.autoAdvance = false
        compose.setContent { AppTheme(template = Templates.Neon) { Probe() } }
        repeat(3) { compose.mainClock.advanceTimeByFrame() }
        val settled = compositions
        assertTrue("the sweep runs", appliedOver(60).isNotEmpty())
        assertEquals("composed again while sweeping", settled, compositions)
    }

    @Test
    fun withReducedMotionTheSkeletonIsStill() {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            AppTheme(template = Templates.Neon) {
                CompositionLocalProvider(LocalReducedMotion provides true) { Probe() }
            }
        }
        repeat(3) { compose.mainClock.advanceTimeByFrame() }
        assertEquals(emptyList<Set<Any>>(), appliedOver(60))
    }
}
