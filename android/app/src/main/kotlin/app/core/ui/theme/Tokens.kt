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
 * Sizes, corners, type sizes and motion that do not change between
 * templates. All brand-free: a rebrand changes colours and fonts, never
 * these. [Radius], [TabBarTokens] and [GlassTokens] are the older,
 * dark-template values the screens written before the templates still
 * use; new code reads `AppTheme.template.radii` and `.sizes` instead, and
 * the screen jobs move each use over.
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

    /** Onboarding steps breathe a little more. */
    val onboardingGutter: Dp = 24.dp

    /** Between editorial sections. */
    val sectionGap: Dp = 28.dp

    /** Between chips in a row and between rows. */
    val chipGap: Dp = 8.dp

    /** The smallest touch target (Android's 48 dp; every icon button gets it). */
    val minTouch: Dp = 48.dp

    /** A settings row's least height. */
    val listRowMin: Dp = 56.dp

    /** A conversation row. */
    val conversationRow: Dp = 76.dp
}

object Radius {
    val xs: Dp = 8.dp
    val sm: Dp = 12.dp
    val md: Dp = 16.dp
    val lg: Dp = 20.dp
    val xl: Dp = 24.dp
    val xxl: Dp = 28.dp

    /** Profile cards: large rounded corners, photo edge to edge. */
    val card: Dp = 28.dp
    val sheet: Dp = 32.dp
    val dialog: Dp = 28.dp
    val field: Dp = 18.dp
    val otpCell: Dp = 16.dp
    val planCard: Dp = 20.dp
    val periodRow: Dp = 18.dp
    val promptCard: Dp = 24.dp
    val matchTile: Dp = 20.dp
    val thumb: Dp = 18.dp
    val bubble: Dp = 22.dp
    val bubbleTail: Dp = 6.dp
    val tabBar: Dp = 33.dp
    val pill: Dp = 999.dp
}

/**
 * The fixed type sizes older screens use directly; the roles live in
 * [appTypography]. sp, never dp, so the reader's font size applies. Nothing
 * is smaller than 12 sp.
 */
object TypeScale {
    val xs: TextUnit = 12.sp
    val sm: TextUnit = 13.sp
    val md: TextUnit = 14.sp
    val lg: TextUnit = 16.sp
    val xl: TextUnit = 20.sp
    val xxl: TextUnit = 24.sp
    val display: TextUnit = 32.sp
    val hero: TextUnit = 40.sp
}

/** The floating tab bar's place in the dark template (the template's `sizes` hold both). */
object TabBarTokens {
    val height: Dp = 66.dp
    val sideInset: Dp = 12.dp
    val bottomOffset: Dp = 20.dp
    val padding: Dp = 5.dp

    /** What a list under the bar keeps free at its end, so nothing reads through the bar: 66 + 20 + 16. */
    val listBottomPadding: Dp = 102.dp
}

/** The deck's action row (physical left to right, in every language). */
object DeckActionTokens {
    val rewind: Dp = 48.dp
    val pass: Dp = 68.dp
    val superLike: Dp = 56.dp
    val like: Dp = 68.dp
    val boost: Dp = 48.dp
    val gutter: Dp = 20.dp

    /** Above the screen's bottom edge, over the tab bar. */
    val bottomOffset: Dp = 100.dp
}

/** Glass blur radii of the dark template; colours are in [AppColors]. */
object GlassTokens {
    val photoChromeBlur: Dp = 24.dp
    val chipBlur: Dp = 20.dp
    val tabBarBlur: Dp = 28.dp
    val toastBlur: Dp = 24.dp
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
