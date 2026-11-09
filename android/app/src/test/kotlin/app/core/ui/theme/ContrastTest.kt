package app.core.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import app.core.feature.chat.NOTE_LABEL_ALPHA
import app.core.feature.chat.bubbleQuietColor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every text colour passes WCAG AA (4.5:1) on what it sits on, and every
 * icon and outline 3:1, in the dark and the light theme, for the brand this
 * build was made from: the design's contrast table (tokens.json
 * `color.<theme>.contrast`) recomputed from the live theme objects, plus the
 * pairs older screens still draw. A brand whose colours cannot pass is a
 * failed build, not a shipped screen.
 *
 * Photo cases assume the worst: a pure white photo pixel under the layer.
 */
class ContrastTest {

    private val failures = mutableListOf<String>()

    private fun pair(name: String, foreground: Color, background: Color, min: Double = Contrast.AA) {
        val ratio = Contrast.ratio(foreground.compositeOver(background), background)
        if (ratio < min) failures += "$name: ${"%.2f".format(ratio)}:1 is below ${"%.1f".format(min)}:1"
    }

    private fun assertNoFailures() = assertTrue(failures.joinToString("\n"), failures.isEmpty())

    /** A scrim of black at [alpha] over a white photo. */
    private fun scrimOverWhite(alpha: Float): Color = Color.Black.copy(alpha = alpha).compositeOver(Color.White)

    private fun design(theme: String, s: ColorScheme, a: AppColors) {
        // Text on every surface.
        for ((name, surface) in listOf(
            "background" to s.background,
            "surfaceContainerLowest" to s.surfaceContainerLowest,
            "surfaceContainerLow" to s.surfaceContainerLow,
            "surfaceContainer" to s.surfaceContainer,
            "surfaceContainerHigh" to s.surfaceContainerHigh,
            "surfaceContainerHighest" to s.surfaceContainerHighest,
        )) {
            pair("$theme onSurface/$name", s.onSurface, surface)
            pair("$theme onSurfaceVariant/$name", s.onSurfaceVariant, surface)
        }
        for ((name, surface) in listOf(
            "background" to s.background,
            "surfaceContainerLow" to s.surfaceContainerLow,
            "surfaceContainer" to s.surfaceContainer,
            "surfaceContainerHigh" to s.surfaceContainerHigh,
        )) {
            pair("$theme textTertiary/$name", a.textTertiary, surface)
            pair("$theme primary (text buttons)/$name", s.primary, surface)
            pair("$theme error/$name", s.error, surface)
        }
        // Containers and their labels.
        pair("$theme onPrimary/primary", s.onPrimary, s.primary)
        pair("$theme onPrimaryContainer/primaryContainer", s.onPrimaryContainer, s.primaryContainer)
        pair("$theme onSecondaryContainer/secondaryContainer", s.onSecondaryContainer, s.secondaryContainer)
        pair("$theme onTertiary/tertiary", s.onTertiary, s.tertiary)
        pair("$theme onTertiaryContainer/tertiaryContainer", s.onTertiaryContainer, s.tertiaryContainer)
        pair("$theme tertiary (alive text)/background", s.tertiary, s.background)
        pair("$theme onError/error", s.onError, s.error)
        pair("$theme onErrorContainer/errorContainer", s.onErrorContainer, s.errorContainer)
        pair("$theme inverseOnSurface/inverseSurface (snackbar)", s.inverseOnSurface, s.inverseSurface)
        pair("$theme snackbar action/inverseSurface", a.snackbarAction, s.inverseSurface)
        // Alive: the badge's ink on lime, the shared-interest chip's text on its tint.
        pair("$theme onAlive/alive", a.onAlive, a.alive)
        pair("$theme aliveText/aliveTint over surfaceContainerLow", a.aliveText, a.aliveTint.compositeOver(s.surfaceContainerLow))
        pair("$theme aliveText/aliveTint over background («نوبت توئه»)", a.aliveText, a.aliveTint.compositeOver(s.background))
        // The gradient carries only button labels (16 sp bold): white on each stop.
        pair("$theme onGradient/start", a.onGradient, a.gradientStops.start)
        pair("$theme onGradient/mid", a.onGradient, a.gradientStops.mid)
        pair("$theme onGradient/end", a.onGradient, a.gradientStops.end)
        // Display text in the text gradient (24 sp and up: 3:1).
        pair("$theme textGradientStart/background", a.textGradientStart, s.background, Contrast.AA_LARGE)
        pair("$theme textGradientEnd/background", a.textGradientEnd, s.background, Contrast.AA_LARGE)
        // Marks and outlines (non-text, 3:1); the verified check is text-sized: 4.5.
        pair("$theme onVerified/verified", a.onVerified, a.verified)
        pair("$theme verified/background", a.verified, s.background, Contrast.AA_LARGE)
        pair("$theme like/background", a.like, s.background, Contrast.AA_LARGE)
        pair("$theme pass/background", a.pass, s.background, Contrast.AA_LARGE)
        pair("$theme superLike (icon)/background", a.superLike, s.background, Contrast.AA_LARGE)
        pair("$theme onSuperLike/superLikeFill", a.onSuperLike, a.superLikeFill)
        pair("$theme outline/background", s.outline, s.background, Contrast.AA_LARGE)
        pair("$theme outline/surfaceContainerLow", s.outline, s.surfaceContainerLow, Contrast.AA_LARGE)
        // The switch's off ring on its own track.
        pair("$theme switch off ring/track", s.outline, s.surfaceContainerHighest, 2.0)
        // Text over photos: white on the scrims, worst case a white photo.
        pair("$theme onPhoto/bottom scrim 0.82", AppColors.OnPhoto, scrimOverWhite(0.82f))
        pair("$theme onPhotoVariant/bottom scrim 0.72", AppColors.OnPhotoVariant, scrimOverWhite(0.72f))
        pair("$theme kicker on photo/scrim 0.62", Color.White.copy(alpha = 0.82f), scrimOverWhite(0.62f))
        pair("$theme chip text/chip glass over scrim 0.20", Color.White, AppColors.ChipOnPhotoFill.compositeOver(scrimOverWhite(0.20f)))
        pair("$theme chip text/chip fallback over a white photo", Color.White, AppColors.ChipOnPhotoFallback.compositeOver(Color.White))
        pair("$theme toast text/toast glass over a white photo", Color.White, AppColors.ToastOnPhotoFill.compositeOver(scrimOverWhite(0.30f)))
        // Story bars under the top scrim (0.62 at the top).
        val top = scrimOverWhite(0.62f)
        val track = AppColors.StoryTrack.compositeOver(top)
        pair("$theme story fill/track", AppColors.StoryFill, track, Contrast.AA_LARGE)
        pair("$theme story track/its edge", track, AppColors.StoryEdge.compositeOver(top), Contrast.AA_LARGE)
        // Glass chrome on photos: the icon on its glass, under the top scrim, over white.
        if (a.dark) {
            pair("$theme glass icon/photoChrome", Color.White, a.glassFill.compositeOver(top), Contrast.AA_LARGE)
            pair("$theme glass icon/photoChrome fallback", Color.White, a.glassFallback.compositeOver(Color.White), Contrast.AA_LARGE)
        } else {
            pair("$theme glass icon/white chrome", s.onSurface, Color.White.copy(alpha = 0.86f).compositeOver(Color.Black), Contrast.AA_LARGE)
        }
        // The tab bar: labels on its fill, over a white photo and over the theme's background.
        // Over the deck photo the bar sits on the bottom scrim (0.82 and more there): worst, a white
        // photo under it in dark, a black one in light (the bar is white there).
        val underBar = if (a.dark) scrimOverWhite(0.82f) else Color.Black
        pair("$theme tab label/bar over photo", s.onSurfaceVariant, a.tabBarFillOverPhoto.compositeOver(underBar))
        pair("$theme tab label/bar over list", s.onSurfaceVariant, a.tabBarFallback.compositeOver(s.background))
        pair("$theme tab label selected/bar over list", s.onSurface, a.tabBarFallback.compositeOver(s.background))
    }

    private fun olderScreens(theme: String, s: ColorScheme, a: AppColors) {
        pair("$theme danger/background", a.danger, s.background)
        pair("$theme danger/surfaceContainerHigh (call line)", a.danger, s.surfaceContainerHigh)
        pair("$theme success/background", a.success, s.background)
        pair("$theme surface/onSurfaceVariant (muted count)", s.surface, s.onSurfaceVariant)
        pair("$theme onSemantic/like", a.onSemantic, a.like)
        pair("$theme onSemantic/superLike", a.onSemantic, a.superLike)
        pair("$theme onSemantic/danger", a.onSemantic, a.danger)
        // A bubble's quieter text (time, like note label), blended as drawn.
        pair("$theme own bubble time/primary", bubbleQuietColor(s.onPrimary, onGrey = false).compositeOver(s.primary), s.primary)
        pair("$theme their bubble time/surfaceContainerHigh", bubbleQuietColor(s.onSurface, onGrey = true).compositeOver(s.surfaceContainerHigh), s.surfaceContainerHigh)
        pair("$theme their like note label/surfaceContainerHigh", bubbleQuietColor(s.onSurface, onGrey = true, alpha = NOTE_LABEL_ALPHA).compositeOver(s.surfaceContainerHigh), s.surfaceContainerHigh)
        pair("$theme unsent bubble time/background", bubbleQuietColor(s.onSurfaceVariant, onGrey = false).compositeOver(s.background), s.background)
        // The new gradient bubble: its 75 % meta line on the gradient's lightest stop.
        pair("$theme gradient bubble meta/end stop", a.onGradient.copy(alpha = 0.75f).compositeOver(a.gradientStops.end), a.gradientStops.end, Contrast.AA_LARGE)
        val callBack = s.primary.copy(alpha = 0.12f).compositeOver(s.surfaceContainerHigh)
        pair("$theme call-back icon/its disc", s.primary, callBack, Contrast.AA_LARGE)
    }

    @Test
    fun `the dark theme passes AA for this build's brand`() {
        design("dark", appColorScheme(dark = true), AppColors.of(dark = true))
        olderScreens("dark", appColorScheme(dark = true), AppColors.of(dark = true))
        assertNoFailures()
    }

    @Test
    fun `the light theme passes AA for this build's brand`() {
        design("light", appColorScheme(dark = false), AppColors.of(dark = false))
        olderScreens("light", appColorScheme(dark = false), AppColors.of(dark = false))
        assertNoFailures()
    }

    @Test
    fun `the design's own colours pass in both themes`() {
        for (dark in listOf(true, false)) {
            val theme = if (dark) "design dark" else "design light"
            design(theme, appColorScheme(dark, BrandColors.Design), AppColors.of(dark, BrandColors.Design))
        }
        assertNoFailures()
    }

    @Test
    fun `the design's colours come through unchanged`() {
        val dark = appColorScheme(dark = true, BrandColors.Design)
        val light = appColorScheme(dark = false, BrandColors.Design)
        assertEquals(Color(0xFFB48CFF), dark.primary)
        assertEquals(Color(0xFF6A1FF0), light.primary)
        assertEquals(Color(0xFF7B2BFF), dark.primaryContainer)
        assertEquals(Color(0xFF0A090E), dark.background)
        assertEquals(Color(0xFFF6F4F9), light.background)
        assertEquals(Color(0xFFC6FF33), dark.tertiary)
        assertEquals(Color(0xFF4F6B00), light.tertiary)
        assertEquals(Color(0xFFC6FF33), light.tertiaryContainer)
        // The light container is a pale tint of the gradient's first stop (#EFE6FF in the design).
        val tint = light.primaryContainer
        assertTrue("light primaryContainer $tint", Contrast.ratio(tint, Color(0xFFEFE6FF)) < 1.02)
    }

    @Test
    fun `the WCAG formula matches its known values`() {
        assertEquals(21.0, Contrast.ratio(Color.Black, Color.White), 0.01)
        assertEquals(1.0, Contrast.ratio(Color.White, Color.White), 0.0001)
        // #777777 on white is the classic 4.48:1 that just fails AA.
        assertEquals(4.48, Contrast.ratio(Color(0xFF777777), Color.White), 0.01)
        // Two values from the design's table.
        assertEquals(17.92, Contrast.ratio(Color(0xFFF5F2FA), Color(0xFF0A090E)), 0.01)
        assertEquals(4.61, Contrast.ratio(Color.White, Color(0xFFE0157A)), 0.01)
    }

    @Test
    fun `a brand colour that already passes is used as given`() {
        val deep = Color(0xFF8E1238)
        assertEquals(deep, Contrast.ensure(deep, listOf(Color.White), Contrast.AA, Color.Black))
    }

    @Test
    fun `a brand colour too light for white text is darkened only as far as needed`() {
        val pink = Color(0xFFE8466A)
        val adjusted = Contrast.ensure(pink, listOf(Color.White), Contrast.AA, Color.Black)
        assertNotEquals(pink, adjusted)
        assertTrue(Contrast.ratio(adjusted, Color.White) >= Contrast.AA)
        // One step lighter would fail again: the smallest change that passes.
        val lighter = androidx.compose.ui.graphics.lerp(adjusted, pink, 0.2f)
        assertTrue(Contrast.ratio(lighter, Color.White) < Contrast.AA)
    }

    @Test
    fun `a dark label moves the container toward white`() {
        assertEquals(Color.White, Contrast.awayFrom(Color(0xFF1A0A0F)))
        assertEquals(Color.Black, Contrast.awayFrom(Color.White))
    }
}
