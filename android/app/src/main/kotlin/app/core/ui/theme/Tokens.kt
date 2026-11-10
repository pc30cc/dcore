package app.core.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.spring
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Spacing, type sizes and motion that do not change between templates.
 * All brand-free: a rebrand changes colours and fonts, never these. Corners
 * and component sizes are the template's (`AppTheme.template.radii`,
 * `.sizes`).
 */
object Space {
    /** The 4 dp grid: 0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. */
    val xxs: Dp = 2.dp
    val xs: Dp = 4.dp
    val sm: Dp = 8.dp
    val md: Dp = 12.dp
    val lg: Dp = 16.dp

    /** Between [lg] and [xl]: card padding, the screen gutter. */
    val lgx: Dp = 20.dp
    val xl: Dp = 24.dp
    val xxl: Dp = 32.dp
    val x40: Dp = 40.dp
    val xxxl: Dp = 48.dp
    val x64: Dp = 64.dp

    /** The side gutter of every screen. */
    val gutter: Dp = 20.dp

    /** The smallest touch target (Android's 48 dp; every icon button gets it). */
    val minTouch: Dp = 48.dp

    /** A settings row's least height. */
    val listRowMin: Dp = 56.dp

    /** A conversation row. */
    val conversationRow: Dp = 76.dp
}

/** The deck's action row (physical left to right, in every language). */
object DeckActionTokens {
    val rewind: Dp = 48.dp
    val pass: Dp = 68.dp
    val superLike: Dp = 56.dp
    val like: Dp = 68.dp
    val boost: Dp = 48.dp
}

/**
 * Motion. With the system's "remove animations" on
 * ([LocalReducedMotion]) everything becomes a [Motion.REDUCED_MS] crossfade:
 * no rotation, particles, confetti or drift.
 */
object Motion {
    const val INSTANT_MS: Int = 90
    const val SHORT_MS: Int = 160
    const val MEDIUM_MS: Int = 240
    const val LONG_MS: Int = 320
    const val EMPHASIZED_MS: Int = 420
    const val CELEBRATE_MS: Int = 1100
    const val REDUCED_MS: Int = 120

    /** The skeleton's sweep, right to left, looping. */
    const val SKELETON_MS: Int = 1200

    val Standard: Easing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    val EmphasizedDecelerate: Easing = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
    val EmphasizedAccelerate: Easing = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)
    val Linear: Easing = LinearEasing

    /** A button released after a press (`motion.buttonPress`). */
    fun <T> buttonRelease(): SpringSpec<T> = spring(dampingRatio = 0.6f, stiffness = 800f)

    /** The like button released (`motion.likeBurst`). */
    fun <T> likeRelease(): SpringSpec<T> = spring(dampingRatio = 0.45f, stiffness = 600f)

    /** A card that did not pass the threshold, back in place (`motion.cardSwipe.snapBack`). */
    fun <T> snapBack(): SpringSpec<T> = spring(dampingRatio = 0.7f, stiffness = 500f)

    /** A badge whose count changed. */
    fun <T> badgePop(): SpringSpec<T> = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium)

    /** Cards and sheets: a soft spring that settles without bouncing past. */
    fun <T> cardSpring(): SpringSpec<T> = spring(dampingRatio = Spring.DampingRatioLowBouncy, stiffness = Spring.StiffnessMediumLow)

    /** Screen-to-screen movement. */
    val screen: SpringSpec<IntOffset> = spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMediumLow)
}
