package app.core.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every text colour passes WCAG AA (4.5:1) on what it sits on, in the
 * light and the dark theme, and a brand whose colours cannot is a failed build,
 * not a shipped screen. Runs against the brand this build was made from.
 */
class ContrastTest {

    private fun assertPair(name: String, foreground: Color, background: Color, min: Double = Contrast.AA) {
        val ratio = Contrast.ratio(foreground, background)
        assertTrue("$name: ${"%.2f".format(ratio)}:1 is below ${"%.1f".format(min)}:1", ratio >= min)
    }

    private fun assertScheme(theme: String, scheme: ColorScheme, semantic: SemanticColors) {
        assertPair("$theme onBackground/background", scheme.onBackground, scheme.background)
        assertPair("$theme onSurface/surface", scheme.onSurface, scheme.surface)
        assertPair("$theme onSurfaceVariant/background", scheme.onSurfaceVariant, scheme.background)
        assertPair("$theme onSurfaceVariant/surfaceContainerHigh", scheme.onSurfaceVariant, scheme.surfaceContainerHigh)
        assertPair("$theme onPrimary/primary (button labels)", scheme.onPrimary, scheme.primary)
        assertPair("$theme primary/background (text buttons)", scheme.primary, scheme.background)
        assertPair("$theme primary/surface", scheme.primary, scheme.surface)
        assertPair("$theme onPrimaryContainer/primaryContainer", scheme.onPrimaryContainer, scheme.primaryContainer)
        assertPair("$theme onSecondaryContainer/secondaryContainer", scheme.onSecondaryContainer, scheme.secondaryContainer)
        assertPair("$theme onError/error", scheme.onError, scheme.error)
        assertPair("$theme like/background", semantic.like, scheme.background)
        assertPair("$theme superLike/background", semantic.superLike, scheme.background)
        assertPair("$theme danger/background", semantic.danger, scheme.background)
        assertPair("$theme onSemantic/like", semantic.onSemantic, semantic.like)
        assertPair("$theme onSemantic/superLike", semantic.onSemantic, semantic.superLike)
        // Icons and outlines: non-text contrast (WCAG 1.4.11).
        assertPair("$theme pass/background", semantic.pass, scheme.background, Contrast.AA_LARGE)
        assertPair("$theme outline/background", scheme.outline, scheme.background, Contrast.AA_LARGE)
    }

    @Test
    fun `this build's brand passes AA in the light theme`() {
        assertScheme("light", appColorScheme(dark = false), LightSemantic)
    }

    @Test
    fun `this build's brand passes AA in the dark theme`() {
        assertScheme("dark", appColorScheme(dark = true), DarkSemantic)
    }

    @Test
    fun `the WCAG formula matches its known values`() {
        assertEquals(21.0, Contrast.ratio(Color.Black, Color.White), 0.01)
        assertEquals(1.0, Contrast.ratio(Color.White, Color.White), 0.0001)
        // #777777 on white is the classic 4.48:1 that just fails AA.
        assertEquals(4.48, Contrast.ratio(Color(0xFF777777), Color.White), 0.01)
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
