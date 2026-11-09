package app.core.feature.auth.welcome

import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import app.core.BuildConfig
import app.core.model.WelcomeGradient
import app.core.ui.theme.Contrast
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every text on the welcome and in the sheet passes WCAG AA on what is
 * behind it: on the scene through the glow the scene draws (the same
 * profile, sampled at every run of text's corners and middle), on the pills
 * and in the sheet directly.
 * Checked for the default gradient, this build's brand gradient, and a
 * few deliberately awkward ones a brand might choose.
 */
class WelcomeContrastTest {

    private fun assertRatio(name: String, text: Color, background: Color, min: Double) {
        val ratio = Contrast.ratio(text.compositeOver(background), background)
        assertTrue("$name: ${"%.2f".format(ratio)}:1 is below ${"%.1f".format(min)}:1", ratio >= min)
    }

    private val brandGradient: WelcomeColors? by lazy {
        val file = File("../../brands/${BuildConfig.BRAND_ID}/brand.json")
        if (!file.isFile) return@lazy null
        val welcome = Json.parseToJsonElement(file.readText()).jsonObject["welcome"] as? JsonObject ?: return@lazy null
        val gradient = welcome["gradient"] as? JsonObject ?: return@lazy null
        WelcomeColors.of(WelcomeGradient(gradient["top"]!!.jsonPrimitive.content, gradient["middle"]!!.jsonPrimitive.content, gradient["bottom"]!!.jsonPrimitive.content))
    }

    private val gradients: List<Pair<String, WelcomeColors>> by lazy {
        listOfNotNull(
            "default" to WelcomeColors.Default,
            brandGradient?.let { "brand" to it },
            "pale" to WelcomeColors(Color(0xFFFFFFFF), Color(0xFFFFE8D6), Color(0xFF3A2A2A)),
            "neon" to WelcomeColors(Color(0xFF7CFFCB), Color(0xFFFFE600), Color(0xFF101010)),
        )
    }

    // A 411 x 891 dp phone at xhdpi, and the welcome's text block: eyebrow, headline, subtitle.
    private val dp = 2f
    private val width = 411 * dp
    private val height = 891 * dp

    /** The text block as its lines: the eyebrow, two headline lines (the second wider), two subtitle lines. */
    private fun block(top: Float, ink: Color): List<ScrimLine> {
        fun centred(y: Float, w: Float, h: Float) = Rect(width / 2f - w * dp / 2f, y, width / 2f + w * dp / 2f, y + h * dp)
        val eyebrow = centred(top, 110f, 16f)
        val headline1 = centred(eyebrow.bottom + 10 * dp, 170f, 36f)
        val headline2 = centred(headline1.bottom, 300f, 36f)
        val subtitle1 = centred(headline2.bottom + 10 * dp, 300f, 20f)
        val subtitle2 = centred(subtitle1.bottom, 240f, 20f)
        return listOf(
            ScrimLine(eyebrow, WelcomePalette.Eyebrow, WelcomePalette.SMALL_TEXT),
            ScrimLine(headline1, ink, WelcomePalette.LARGE_TEXT),
            ScrimLine(headline2, ink, WelcomePalette.LARGE_TEXT),
            ScrimLine(subtitle1, WelcomePalette.Subtitle, WelcomePalette.SMALL_TEXT),
            ScrimLine(subtitle2, WelcomePalette.Subtitle, WelcomePalette.SMALL_TEXT),
        )
    }

    /** Where the text block may start: anywhere in the top 30 % (any status bar, font scale or phone), so the text stays in the top 45 %. */
    private val tops = (0..12).map { it * 0.025f * height }

    @Test
    fun `every glyph passes over every gradient through the scene's glow`() {
        for ((name, colors) in gradients) {
            for (persian in listOf(false, true)) {
                val ink = WelcomePalette.headlineInk(persian)
                for (top in tops) {
                    val lines = block(top, ink)
                    val profile = WelcomePalette.scrimProfile(colors, lines, width, height, dp)
                    for (line in lines) {
                        val r = line.rect
                        // Corners, edges and middle of each run of text.
                        for (fx in listOf(0f, 0.25f, 0.5f, 0.75f, 1f)) for (fy in listOf(0f, 0.5f, 1f)) {
                            val x = r.left + (r.width - 1f) * fx
                            val y = r.top + (r.height - 1f) * fy
                            val alpha = profile?.alphaAt(x, y) ?: 0f
                            val under = WelcomePalette.scrim(colors).copy(alpha = alpha).compositeOver(WelcomePalette.colorAt(colors, y / height))
                            val min = if (line.ratio == WelcomePalette.LARGE_TEXT) Contrast.AA_LARGE else Contrast.AA
                            assertRatio("$name (persian $persian) at ${"%.0f".format(x / dp)},${"%.0f".format(y / dp)} dp", line.ink, under, min)
                        }
                    }
                }
            }
        }
    }

    @Test
    fun `the default glow stays soft behind the headline and leaves the sides bright`() {
        // The template's layout on a phone without a status bar (the screen tests'), and with one.
        for (top in listOf(52 * dp, 84 * dp)) {
            val lines = block(top, WelcomePalette.headlineInk(false))
            val profile = WelcomePalette.scrimProfile(WelcomeColors.Default, lines, width, height, dp)!!
            val headline = lines[2].rect
            val middle = profile.alphaAt(headline.center.x, headline.center.y)
            assertTrue("behind the headline $middle", middle <= 0.6f)
            for (line in lines) {
                val y = line.rect.center.y
                assertTrue("at the side at ${y / dp} dp", profile.alphaAt(0f, y) <= 0.08f)
            }
            // Gone a little way under the subtitle, where the bubbles start.
            assertEquals(0f, profile.alphaAt(width / 2f, lines.last().rect.bottom + 60 * dp), 0.01f)
        }
    }

    @Test
    fun `the default scrim is a warm deep tone, not the gradient's near-black`() {
        val scrim = WelcomePalette.scrim(WelcomeColors.Default)
        assertTrue("red over blue: $scrim", scrim.red > scrim.blue * 2f && scrim.red > 0.45f)
        // The brand's middle colour appears at full strength in the gradient.
        assertTrue(WelcomePalette.stops(WelcomeColors.Default).any { it.second == WelcomeColors.Default.middle })
    }

    @Test
    fun `the terms line and the buttons pass on the scene's bottom`() {
        for ((name, colors) in gradients.filter { it.first != "pale" && it.first != "neon" }) {
            for (f in listOf(0.82f, 0.9f, 1f)) {
                assertRatio("$name terms at $f", WelcomePalette.Terms, WelcomePalette.colorAt(colors, f), Contrast.AA)
            }
        }
        assertRatio("sign in label", WelcomePalette.OnLightPill, WelcomePalette.LightPill, Contrast.AA)
        // Sign up is smoked glass: over the scene's bottom, or over the lightest face rising behind it.
        for (behind in listOf(WelcomePalette.colorAt(WelcomeColors.Default, 0.9f), Color(0xFFFFF1E6), Color.White)) {
            assertRatio("sign up label over $behind", WelcomePalette.OnDarkPill, WelcomePalette.DarkGlass.compositeOver(behind), Contrast.AA)
        }
    }

    @Test
    fun `the sheet's texts pass from its top to its bottom`() {
        val scheme = WelcomePalette.sheetScheme()
        for (f in listOf(0f, 0.15f, 0.3f, 0.45f, 0.6f, 0.75f, 1f)) {
            val sheet = WelcomePalette.sheetColorAt(f)
            assertRatio("title at $f", WelcomePalette.SheetText, sheet, Contrast.AA)
            assertRatio("secondary at $f", WelcomePalette.SheetTextSecondary, sheet, Contrast.AA)
            assertRatio("link at $f", WelcomePalette.SheetLink, sheet, Contrast.AA)
            assertRatio("error at $f", WelcomePalette.SheetError, sheet, Contrast.AA)
            assertRatio("success at $f", WelcomePalette.SheetSuccess, sheet, Contrast.AA)
            val field = WelcomePalette.SheetField.compositeOver(sheet)
            assertRatio("number at $f", WelcomePalette.SheetText, field, Contrast.AA)
            assertRatio("placeholder at $f", WelcomePalette.SheetPlaceholder, field, Contrast.AA)
            val chip = WelcomePalette.SheetChip.compositeOver(field)
            assertRatio("dial code at $f", WelcomePalette.SheetText, chip, Contrast.AA)
            assertRatio("onSurfaceVariant at $f", scheme.onSurfaceVariant, sheet, Contrast.AA)
        }
        assertRatio("code digits", scheme.onSurface, scheme.surfaceContainerLow, Contrast.AA)
        assertRatio("continue label", WelcomePalette.OnLightPill, WelcomePalette.LightPill, Contrast.AA)
    }
}
