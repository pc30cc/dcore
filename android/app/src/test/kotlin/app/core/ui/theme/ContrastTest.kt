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
        assertPair("$theme primary/surfaceContainerLow (bottom sheets)", scheme.primary, scheme.surfaceContainerLow)
        assertPair("$theme primary/surfaceContainer (cards)", scheme.primary, scheme.surfaceContainer)
        assertPair("$theme onPrimaryContainer/primaryContainer", scheme.onPrimaryContainer, scheme.primaryContainer)
        assertPair("$theme onSecondaryContainer/secondaryContainer", scheme.onSecondaryContainer, scheme.secondaryContainer)
        assertPair("$theme onError/error", scheme.onError, scheme.error)
        assertPair("$theme like/background", semantic.like, scheme.background)
        assertPair("$theme superLike/background", semantic.superLike, scheme.background)
        assertPair("$theme danger/background", semantic.danger, scheme.background)
        // A missed call's title on the call line.
        assertPair("$theme danger/surfaceContainerHigh (call line)", semantic.danger, scheme.surfaceContainerHigh)
        assertPair("$theme onSurface/surfaceContainerHigh (call line)", scheme.onSurface, scheme.surfaceContainerHigh)
        // Count badges: requests (error), unread (primary), a muted conversation's unread (grey).
        assertPair("$theme surface/onSurfaceVariant (muted count)", scheme.surface, scheme.onSurfaceVariant)
        assertPair("$theme onSemantic/like", semantic.onSemantic, semantic.like)
        assertPair("$theme onSemantic/superLike", semantic.onSemantic, semantic.superLike)
        // A bubble's quieter text (time, like note label, voice line), blended as drawn: on your own
        // bubble (the brand colour), on theirs (grey), and on an unsent one (no fill: the thread's
        // background; 75 % there was 3.9:1 in light).
        assertPair("$theme own bubble time/primary", bubbleQuietColor(scheme.onPrimary, onGrey = false).compositeOver(scheme.primary), scheme.primary)
        assertPair("$theme their bubble time/surfaceContainerHigh", bubbleQuietColor(scheme.onSurface, onGrey = true).compositeOver(scheme.surfaceContainerHigh), scheme.surfaceContainerHigh)
        assertPair("$theme their like note label/surfaceContainerHigh", bubbleQuietColor(scheme.onSurface, onGrey = true, alpha = NOTE_LABEL_ALPHA).compositeOver(scheme.surfaceContainerHigh), scheme.surfaceContainerHigh)
        assertPair("$theme unsent bubble time/background", bubbleQuietColor(scheme.onSurfaceVariant, onGrey = false).compositeOver(scheme.background), scheme.background)
        assertPair("$theme unsent bubble time/surface", bubbleQuietColor(scheme.onSurfaceVariant, onGrey = false).compositeOver(scheme.surface), scheme.surface)
        // Icons and outlines: non-text contrast (WCAG 1.4.11).
        // The call line's call-back button: the accent on its 12 % tint of itself, over the line.
        val callBack = scheme.primary.copy(alpha = 0.12f).compositeOver(scheme.surfaceContainerHigh)
        assertPair("$theme call-back icon/its disc", scheme.primary, callBack, Contrast.AA_LARGE)
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
