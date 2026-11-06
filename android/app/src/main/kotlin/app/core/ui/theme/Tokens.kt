package app.core.ui.theme

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.spring
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The design tokens, in code.
 *
 * Colours are in [Palette] (neutrals and semantics, fixed) and come from the
 * brand for `brand` and `onBrand` (BuildConfig, from brand.json). Everything
 * here is brand-free: a rebrand changes the two brand colours and nothing else.
 */
object Space {
    /** The 4 dp grid. */
    val xxs: Dp = 2.dp
    val xs: Dp = 4.dp
    val sm: Dp = 8.dp
    val md: Dp = 12.dp
    val lg: Dp = 16.dp
    val xl: Dp = 24.dp
    val xxl: Dp = 32.dp
    val xxxl: Dp = 48.dp

    /** The side gutter of every screen. */
    val gutter: Dp = lg

    /** The smallest touch target (at least 44 pt; Android's 48 dp). */
    val minTouch: Dp = 48.dp
}

object Radius {
    val sm: Dp = 8.dp
    val md: Dp = 12.dp
    val lg: Dp = 20.dp

    /** Profile cards: large rounded corners, photo edge to edge. */
    val card: Dp = 28.dp
    val pill: Dp = 999.dp
}

/**
 * The fixed type scale (eight sizes). Material's roles map onto it in
 * [appTypography]; sp, never dp, so the reader's font size setting applies.
 */
object TypeScale {
    val xs: TextUnit = 11.sp
    val sm: TextUnit = 12.sp
    val md: TextUnit = 14.sp
    val lg: TextUnit = 16.sp
    val xl: TextUnit = 20.sp
    val xxl: TextUnit = 24.sp
    val display: TextUnit = 32.sp
    val hero: TextUnit = 40.sp
}

/**
 * Motion (springs for cards, short eases elsewhere, and the system's
 * "remove animations" respected: see [LocalReducedMotion]).
 */
object Motion {
    const val SHORT_MS: Int = 150
    const val MEDIUM_MS: Int = 250
    const val LONG_MS: Int = 400

    /** Cards and sheets: a soft spring that settles without bouncing past. */
    fun <T> cardSpring(): SpringSpec<T> = spring(dampingRatio = Spring.DampingRatioLowBouncy, stiffness = Spring.StiffnessMediumLow)

    /** Screen-to-screen movement. */
    val screen: SpringSpec<IntOffset> = spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMediumLow)
}
