package app.core.feature.paywall

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.compositeOver
import app.core.ui.theme.AppTemplate
import app.core.ui.theme.BrandColors
import app.core.ui.theme.Contrast
import app.core.ui.theme.CssLinearGradient
import app.core.ui.theme.CssRadialGradients
import app.core.ui.theme.Templates
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The colour pairs the paywall and the packs sheet draw, read from the
 * live templates with this build's brand: text 4.5:1, the title's large
 * highlighted word 3:1, in `neon` and in `white`.
 */
class PaywallContrastTest {

    private val failures = mutableListOf<String>()

    private fun pair(name: String, foreground: Color, background: Color, min: Double = Contrast.AA) {
        val ratio = Contrast.ratio(foreground.compositeOver(background), background)
        if (ratio < min) failures += "$name: ${"%.2f".format(ratio)}:1 is below ${"%.1f".format(min)}:1"
    }

    private fun Brush.colors(): List<Color> = when (this) {
        is SolidColor -> listOf(value)
        is CssLinearGradient -> colors
        else -> emptyList()
    }

    private fun check(name: String, t: AppTemplate) {
        val c = t.colors
        val chosen = c.primaryTint.compositeOver(c.surface1)
        // The title and its highlighted count («۱۲ نفر»), large text.
        pair("$name title/page", c.text, c.bg)
        t.paints.accentText.colors().forEach { pair("$name highlighted count/page", it, c.bg, Contrast.AA_LARGE) }
        // The segmented selector: the others on the track, the chosen one on its thumb.
        pair("$name plan segment/track", c.text2, c.surface2)
        pair("$name chosen segment/thumb", c.onSegThumb, c.segThumb.compositeOver(c.surface2))
        // A plan card of the rail, chosen or not.
        pair("$name plan card name", c.text, c.surface1)
        pair("$name chosen plan card name", c.text, chosen)
        // The benefits on the page.
        pair("$name benefit/page", c.text, c.bg)
        // A period row: its name, saving, total and currency word, chosen or not.
        for ((state, fill) in listOf("period" to c.surface1, "chosen period" to chosen)) {
            pair("$name name/$state", c.text, fill)
            pair("$name saving or current/$state", c.primary, fill)
            pair("$name currency word/$state", c.text3, fill)
        }
        // The store line, a failure on it, and the links.
        pair("$name store line/page", c.text3, c.bg)
        pair("$name failure line/page", c.error, c.bg)
        pair("$name links/page", c.text2, c.bg)
        // With the glow on, the hero light is behind the top of the block (the title, its count and the benefits when
        // the block is tall): each light at full strength over the page, alone and together where they overlap. The
        // lines and links under the button rest at the bottom, clear of it.
        if (t.switches.glow) {
            for ((light, under) in heroLights(t)) {
                pair("$name title/$light", c.text, under)
                t.paints.accentText.colors().forEach { pair("$name highlighted count/$light", it, under, Contrast.AA_LARGE) }
                pair("$name benefit/$light", c.text, under)
            }
        }
        // The packs sheet: the balance, a pack's price chosen or not, its terms line.
        pair("$name balance/sheet", c.text3, c.surfaceSheet)
        pair("$name pack count/card", c.text, c.surface1)
        pair("$name pack price/card", c.text2, c.surface1)
        pair("$name pack price/chosen card", c.text2, chosen)
        pair("$name terms/sheet", c.text3, c.surfaceSheet)
        pair("$name failure/sheet", c.error, c.surfaceSheet)
    }

    /** The hero light's brightest points over the page: each light's centre alone, then all of them stacked. */
    private fun heroLights(t: AppTemplate): List<Pair<String, Color>> {
        val bg = t.colors.bg
        val layers = (t.paints.heroBg as? CssRadialGradients)?.layers ?: return listOf("hero" to (t.paints.heroBg.colors().firstOrNull()?.compositeOver(bg) ?: bg))
        val centres = layers.map { layer -> layer.stops.first().second }
        val alone = centres.mapIndexed { i, colour -> "hero light ${i + 1}" to colour.compositeOver(bg) }
        // CSS paints the first layer on top.
        val stacked = centres.reversed().fold(bg) { under, colour -> colour.compositeOver(under) }
        return alone + ("hero lights stacked" to stacked)
    }

    @Test
    fun `the paywall and the packs pass AA in both templates`() {
        check("neon", Templates.of(Templates.NEON, BrandColors.Build))
        check("white", Templates.of(Templates.WHITE, BrandColors.Build))
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }
}
