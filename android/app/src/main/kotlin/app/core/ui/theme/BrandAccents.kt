package app.core.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.lerp

/**
 * `neon`'s accent group: the "yes" gradient ([yes]), the accent text and
 * icons on the page ([primary]: `--primary`, `--caret`, `--otp-filled`),
 * the icon gradient ([icon]: `--icon-grad-*`, `--verified`,
 * `--tab-active-icon`), the highlighted title word ([accentText]), the heart
 * ([like]) and the action on the light snackbar ([inverseAction]).
 */
@Immutable
data class NeonAccent(
    val yes: GradientStops,
    val primary: Color,
    val icon: GradientStops,
    val accentText: Pair<Color, Color>,
    val like: Color,
    val inverseAction: Color,
) {
    companion object {
        private val BG = Color(0xFF0A090E)
        private val SURFACE_1 = Color(0xFF121118)
        private val SURFACE_2 = Color(0xFF1E1B27)
        private val INVERSE = Color(0xFFF5F2FA)

        /** The design's own values. */
        val Design = NeonAccent(
            yes = BrandColors.Design.gradientDark,
            primary = Color(0xFFDD6BF2),
            icon = GradientStops(Color(0xFF9D5CFF), Color(0xFFD02AC8), Color(0xFFFF2D87)),
            accentText = Color(0xFFB58CFF) to Color(0xFFFF5AA5),
            like = Color(0xFFFF4D9D),
            inverseAction = Color(0xFF9A3FE0),
        )

        /** Whether [brand] keeps the design's dark colours (then [Design] applies exactly). */
        fun isDesign(brand: BrandColors): Boolean =
            brand.brandDark == BrandColors.Design.brandDark && brand.gradientDark == BrandColors.Design.gradientDark

        /**
         * The group in [brand]'s colours: the accent from `brand.dark`, the
         * gradient-made roles from the dark gradient; a role whose source the
         * brand keeps at the design's value keeps the design's role. Text
         * roles read 4.5:1 and icons 3:1 on neon's page and surfaces.
         */
        fun of(brand: BrandColors): NeonAccent {
            val design = BrandColors.Design
            val yes = brand.gradientDark
            val ownAccent = brand.brandDark != design.brandDark
            val ownGradient = yes != design.gradientDark
            val primary = if (ownAccent) {
                val tint = yes.mid.copy(alpha = 0.14f).compositeOver(SURFACE_1)
                Contrast.ensure(brand.brandDark, listOf(BG, SURFACE_1, SURFACE_2, tint), Contrast.AA, Color.White)
            } else {
                Design.primary
            }
            fun icon(c: Color) = Contrast.ensure(c, listOf(BG), Contrast.AA_LARGE, Color.White)
            fun title(c: Color) = Contrast.ensure(lerp(c, Color.White, 0.3f), listOf(BG), Contrast.AA, Color.White)
            return NeonAccent(
                yes = yes,
                primary = primary,
                icon = if (ownGradient) GradientStops(icon(yes.start), icon(yes.mid), icon(yes.end)) else Design.icon,
                accentText = if (ownGradient) title(yes.start) to title(yes.end) else Design.accentText,
                like = if (ownGradient) icon(yes.end) else Design.like,
                inverseAction = if (ownAccent) Contrast.ensure(primary, listOf(INVERSE), Contrast.AA, Color.Black) else Design.inverseAction,
            )
        }
    }
}

/**
 * `white`'s accent group: the one accent ([accent]: `--primary`, `--caret`,
 * `--tag-fill`, `--like`, `--unread-fill`, `--ring-fill`, `--verified`,
 * `--badge-fill`, `--quote-bar`, `--progress-fill`, `--bubble-out`,
 * `--super-icon`, `--kb-act`, `--icon-grad-*`), its tint ([tint],
 * `--primary-tint`), the like button's gradient ([like]), the action on the
 * dark snackbar ([inverseAction]) and the like button's coloured shadow
 * ([glow]).
 */
@Immutable
data class WhiteAccent(
    val accent: Color,
    val tint: Color,
    val like: GradientStops,
    val inverseAction: Color,
    val glow: Color,
) {
    companion object {
        private val BG = Color(0xFFFFFFFF)
        private val SURFACE_2 = Color(0xFFF3F3F5)
        private val INVERSE = Color(0xFF1C1C20)

        /** The design's own values. */
        val Design = WhiteAccent(
            accent = Color(0xFF5B2FD9),
            tint = Color(0xFFF0ECFC),
            like = GradientStops(Color(0xFF6B3EEB), Color(0xFF5B2FD9), Color(0xFF4E25C6)),
            inverseAction = Color(0xFFB6A3FF),
            glow = rgba(60, 25, 160, 0.4f),
        )

        /** Whether [brand] keeps the design's light colours (then [Design] applies exactly). */
        fun isDesign(brand: BrandColors): Boolean =
            brand.brandLight == BrandColors.Design.brandLight && brand.gradientLight == BrandColors.Design.gradientLight

        /**
         * The group in [brand]'s colours: the accent from `brand.light` (white
         * text on it and the accent on white both 4.5:1), the like button from
         * the light gradient when the brand sets one, else from the accent.
         */
        fun of(brand: BrandColors): WhiteAccent {
            val design = BrandColors.Design
            val ownAccent = brand.brandLight != design.brandLight
            val ownGradient = brand.gradientLight != design.gradientLight
            val accent = if (ownAccent) readable(brand.brandLight) else Design.accent
            // The white heart on the like button: 3:1 on every stop.
            fun onWhite(c: Color) = Contrast.ensure(c, listOf(Color.White), Contrast.AA_LARGE, Color.Black)
            val like = when {
                ownGradient -> GradientStops(onWhite(brand.gradientLight.start), onWhite(brand.gradientLight.mid), onWhite(brand.gradientLight.end))
                ownAccent -> GradientStops(onWhite(lerp(accent, Color.White, 0.12f)), accent, lerp(accent, Color.Black, 0.12f))
                else -> Design.like
            }
            return WhiteAccent(
                accent = accent,
                tint = if (ownAccent) tintOf(accent) else Design.tint,
                like = like,
                inverseAction = if (ownAccent) Contrast.ensure(lerp(accent, Color.White, 0.5f), listOf(INVERSE), Contrast.AA, Color.White) else Design.inverseAction,
                glow = if (ownAccent || ownGradient) lerp(like.mid, Color.Black, 0.35f).copy(alpha = 0.4f) else Design.glow,
            )
        }

        /** The own bubble's second text line (`--on-bubble-out-2`), which must read on the accent too. */
        private val BUBBLE_META = Color.White.copy(alpha = 0.86f)

        /**
         * [c] darkened just until it reads 4.5:1 on the page, `--surface-2`
         * and its own tint, and white text (the bubble's meta line included)
         * reads 4.5:1 on it; unchanged when it already does.
         */
        private fun readable(c: Color): Color {
            for (step in 0..100) {
                val x = lerp(c, Color.Black, step / 100f)
                val ok = listOf(BG, SURFACE_2, tintOf(x)).all { Contrast.ratio(x, it) >= Contrast.AA } &&
                    Contrast.ratio(BUBBLE_META.compositeOver(x), x) >= Contrast.AA
                if (ok) return x
            }
            return Color.Black
        }

        /** The accent's pale fill on white, as the design's #F0ECFC is to #5B2FD9 (about 9 %). */
        private fun tintOf(accent: Color): Color = accent.copy(alpha = 0.09f).compositeOver(BG)
    }
}
