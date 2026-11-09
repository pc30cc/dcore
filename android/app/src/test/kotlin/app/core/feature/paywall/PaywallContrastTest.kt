package app.core.feature.paywall

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import app.core.ui.theme.Contrast
import app.core.ui.theme.DarkSemantic
import app.core.ui.theme.LightSemantic
import app.core.ui.theme.appColorScheme
import org.junit.Assert.assertTrue
import org.junit.Test

/** The colour pairs the paywall and the packs sheet add, in both themes, for this build's brand. */
class PaywallContrastTest {

    private fun pair(name: String, foreground: Color, background: Color, min: Double = Contrast.AA) {
        val ratio = Contrast.ratio(foreground, background)
        assertTrue("$name: ${"%.2f".format(ratio)}:1 is below ${"%.1f".format(min)}:1", ratio >= min)
    }

    private fun check(dark: Boolean) {
        val s = appColorScheme(dark = dark)
        val semantic = if (dark) DarkSemantic else LightSemantic
        val theme = if (dark) "dark" else "light"
        // The hero: the brand at 16 % over the background, under the headline and its line.
        val hero = s.primary.copy(alpha = 0.16f).compositeOver(s.background)
        pair("$theme headline/hero", s.onBackground, hero)
        pair("$theme hero line/hero", s.onSurfaceVariant, hero)
        // Badges.
        pair("$theme popular badge", s.onPrimaryContainer, s.primaryContainer)
        pair("$theme new badge", s.onTertiaryContainer, s.tertiaryContainer)
        // Benefits card: text and its check marks (non-text, 3:1).
        pair("$theme benefit/surfaceContainer", s.onSurface, s.surfaceContainer)
        pair("$theme benefit tick/surfaceContainer", s.primary, s.surfaceContainer, Contrast.AA_LARGE)
        // An option: its border when chosen (non-text), its "every month" line.
        pair("$theme chosen border/background", s.primary, s.background, Contrast.AA_LARGE)
        pair("$theme period line/background", s.onSurfaceVariant, s.background)
        // Step cards and their buttons (the card's own text colour).
        pair("$theme step card", s.onSurface, s.surfaceContainerHigh)
        pair("$theme failed card", s.onErrorContainer, s.errorContainer)
        // The bottom bar: links and the store's terms.
        pair("$theme links/surface", s.primary, s.surface)
        pair("$theme terms/background", s.onSurfaceVariant, s.background)
        // The done disc.
        pair("$theme done tick/its disc", semantic.success, semantic.success.copy(alpha = 0.16f).compositeOver(s.background), Contrast.AA_LARGE)
        // The current plan card, the "Current plan" badge on its period and the line in place of the button.
        pair("$theme current plan", s.onSecondaryContainer, s.secondaryContainer)
        // Bottom sheets (Material draws them on surfaceContainerLow): "Not now", "See plans", "Clear",
        // the packs sheet's "You have N", "Or get a plan", "Restore purchases", and its restore notice.
        pair("$theme sheet text buttons/surfaceContainerLow", s.primary, s.surfaceContainerLow)
        pair("$theme sheet notice/surfaceContainerLow", s.onSurfaceVariant, s.surfaceContainerLow)
        // The restricted screen's purchases card: "Manage subscription" and "Restore purchases".
        pair("$theme restricted card buttons/surfaceContainer", s.primary, s.surfaceContainer)
        pair("$theme restricted card notice/surfaceContainer", s.onSurfaceVariant, s.surfaceContainer)
    }

    @Test fun `the paywall passes AA in the light theme`() = check(dark = false)

    @Test fun `the paywall passes AA in the dark theme`() = check(dark = true)
}
