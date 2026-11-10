package app.core.ui.theme

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Material's scheme as the template derives it ([templateColorScheme]) and
 * the template tokens the screens draw with pass WCAG AA (4.5:1 for text,
 * 3:1 for icons and outlines) in the dark template (`neon`, for the brand
 * this build was made from) and the light one (`white`). The templates'
 * own table is [TemplateContrastTest]; this one checks the pairs the
 * screens put together (snackbars, tags, bubbles, call lines, the tab bar
 * over a photo). A brand whose colours cannot pass is a failed build, not a
 * shipped screen.
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

    /** Every colour a paint passes through (its stops; a solid paint's one colour). */
    private val Brush.colors: List<Color>
        get() = when (this) {
            is SolidColor -> listOf(value)
            is CssLinearGradient -> colors
            is IconGradient -> colors
            else -> listOf(representative)
        }

    private fun design(theme: String, t: AppTemplate) {
        val s = templateColorScheme(t)
        val c = t.colors
        val p = t.paints
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
            pair("$theme text-3/$name", c.text3, surface)
            pair("$theme primary (text buttons)/$name", s.primary, surface)
            pair("$theme error/$name", s.error, surface)
        }
        // Containers and their labels.
        pair("$theme onPrimary/primary", s.onPrimary, s.primary)
        pair("$theme onPrimaryContainer/primaryContainer", s.onPrimaryContainer, s.primaryContainer)
        pair("$theme onSecondaryContainer/secondaryContainer", s.onSecondaryContainer, s.secondaryContainer)
        pair("$theme onTertiary/tertiary", s.onTertiary, s.tertiary)
        pair("$theme onTertiaryContainer/tertiaryContainer", s.onTertiaryContainer, s.tertiaryContainer)
        pair("$theme tertiary (accent text)/background", s.tertiary, s.background)
        pair("$theme onError/error", s.onError, s.error)
        pair("$theme onErrorContainer/errorContainer", s.onErrorContainer, s.errorContainer)
        pair("$theme inverseOnSurface/inverseSurface (snackbar)", s.inverseOnSurface, s.inverseSurface)
        pair("$theme snackbar action/inverse", c.inverseAction, c.inverse)
        // Tags: the pill's ink on every stop of its fill; the accent on its tint (shared interests, «نوبت توئه»).
        for (stop in p.tagFill.colors) pair("$theme on-tag/tag-fill", c.onTag, stop)
        pair("$theme accent/primary-tint over surface-1", c.primary, c.primaryTint.compositeOver(c.surface1))
        pair("$theme accent/primary-tint over the page", c.primary, c.primaryTint.compositeOver(c.bg))
        // The like fill carries icons and button labels: its ink on each stop.
        for (stop in p.likeFill.colors) pair("$theme on-like/like-fill", c.onLike, stop)
        // Display text in the accent (24 sp and up: 3:1).
        for (stop in p.accentText.colors) pair("$theme accent text/background", stop, s.background, Contrast.AA_LARGE)
        // Marks and outlines (non-text, 3:1); the verified badge's check is an icon (3:1 at every stop of its fill).
        for (stop in p.verified.colors) {
            pair("$theme on-verified/verified", c.onVerified, stop, Contrast.AA_LARGE)
            pair("$theme verified/background", stop, s.background, Contrast.AA_LARGE)
        }
        pair("$theme like/background", c.like, s.background, Contrast.AA_LARGE)
        pair("$theme pass/background", c.text, s.background, Contrast.AA_LARGE)
        pair("$theme super like (icon)/background", c.primary, s.background, Contrast.AA_LARGE)
        pair("$theme outline/background", s.outline, s.background, Contrast.AA_LARGE)
        pair("$theme outline/surfaceContainerLow", s.outline, s.surfaceContainerLow, Contrast.AA_LARGE)
        // The switch's off ring on its own track.
        pair("$theme switch off ring/track", s.outline, s.surfaceContainerHighest, 2.0)
        // Glass chrome on photos: the icon on its glass, under the top scrim, over white; its solid fallback.
        val top = p.photoScrimTop.colors.first().compositeOver(Color.White)
        pair("$theme glass icon/photo chrome", c.onGlass, c.glassFill.compositeOver(top), Contrast.AA_LARGE)
        pair("$theme glass icon/photo chrome fallback", c.onGlass, c.glassSolid.compositeOver(Color.White), Contrast.AA_LARGE)
        // The tab bar: labels on its fill, over a photo (neon's floating bar over the deck's bottom scrim; worst,
        // a white photo under it) and over the page.
        val underBar = if (t.switches.tabBar == TabBarStyle.Floating) p.photoScrimBottom.colors.last().compositeOver(Color.White) else c.bg
        pair("$theme tab label/bar over photo", c.tabColorPhoto, c.tabbarFillPhoto.compositeOver(underBar))
        pair("$theme tab label/bar over the page", c.tabColor, c.tabbarFill.compositeOver(c.bg))
        pair("$theme tab label selected/bar over the page", c.tabActiveColor, c.tabbarFill.compositeOver(c.bg))
    }

    private fun screens(theme: String, t: AppTemplate) {
        val s = templateColorScheme(t)
        val c = t.colors
        pair("$theme error/background", c.error, s.background)
        pair("$theme error/surfaceContainerHigh (call line)", c.error, s.surfaceContainerHigh)
        pair("$theme online word/background", c.onlineText, s.background)
        pair("$theme surface/onSurfaceVariant (muted count)", s.surface, s.onSurfaceVariant)
        // A bubble's quieter text, as the thread draws it: your newest message's meta («۱۸:۲۵، دیده شد»)
        // and a like note's label in `--on-bubble-out-2` on every stop of `--bubble-out`; on theirs, the
        // label and the voice length in `--text-3`; a removed message in `--text-3` on the page.
        t.paints.bubbleOut.colors.distinct().forEachIndexed { i, stop ->
            pair("$theme own bubble meta/bubble-out stop $i", c.onBubbleOut2.compositeOver(stop), stop)
        }
        pair("$theme their voice length, like note label/bubble-in", c.text3, c.bubbleIn)
        pair("$theme unsent bubble text/page", c.text3, c.bg)
        // The call line and «زنگ بزن» on the page.
        pair("$theme call line/page", c.text3, c.bg)
        pair("$theme missed call line/page", c.error, c.bg)
        pair("$theme call back/page", c.primary, c.bg)
    }

    @Test
    fun `the dark theme passes AA for this build's brand`() {
        design("dark", Templates.of(Templates.NEON))
        screens("dark", Templates.of(Templates.NEON))
        assertNoFailures()
    }

    @Test
    fun `the light theme passes AA for this build's brand`() {
        design("light", Templates.of(Templates.WHITE))
        screens("light", Templates.of(Templates.WHITE))
        assertNoFailures()
    }

    @Test
    fun `the design's own colours pass in both themes`() {
        design("design dark", Templates.Neon)
        design("design light", Templates.White)
        assertNoFailures()
    }

    @Test
    fun `Material's scheme carries the template's colours`() {
        val dark = templateColorScheme(Templates.Neon)
        val light = templateColorScheme(Templates.White)
        // Dark: the accent text colour leads Material's scheme; the container is the gradient's first stop.
        assertEquals(Color(0xFFDD6BF2), dark.primary)
        assertEquals(Color(0xFF7B2BFF), dark.primaryContainer)
        assertEquals(Color(0xFF0A090E), dark.background)
        // Light: ink leads every control, the accent is tertiary.
        assertEquals(Color(0xFF111114), light.primary)
        assertEquals(Color(0xFF5B2FD9), light.tertiary)
        assertEquals(Color(0xFFFFFFFF), light.background)
        assertEquals(Color(0xFF5B2FD9), Templates.White.colors.like)
        assertEquals(Color(0xFFF0ECFC), Templates.White.colors.primaryTint)
        assertEquals(
            listOf(Color(0xFF7B2BFF), Color(0xFFC21FD0), Color(0xFFE0157A)),
            Templates.Neon.paints.likeFill.colors,
        )
        assertNotEquals(Templates.White.paints.likeFill, Templates.Neon.paints.likeFill)
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
