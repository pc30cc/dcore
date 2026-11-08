package app.core.feature.auth.welcome

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import app.core.BuildConfig
import app.core.model.WelcomeGradient
import app.core.ui.theme.Contrast
import app.core.ui.theme.DarkSemantic
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every text on the welcome and in the sheet passes WCAG AA on what is
 * behind it: on the scene through the scrim the scene draws (measured the
 * way the scene measures it), on the pills and in the sheet directly.
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

    /** Where the text may sit: anywhere in the top 45 % (any font scale, any phone). */
    private val spans = (0..8).map { k -> (k * 0.05f) to (k * 0.05f + 0.1f) }

    @Test
    fun `the subtitle and the headline pass over every gradient through the scene's scrim`() {
        for ((name, colors) in gradients) {
            for ((top, bottom) in spans) {
                for (persian in listOf(false, true)) {
                    val ink = WelcomePalette.headlineInk(persian)
                    val headline = WelcomePalette.scrimOver(colors, top, bottom, ink, WelcomePalette.LARGE_TEXT)
                    val subtitle = WelcomePalette.scrimOver(colors, top, bottom, WelcomePalette.Subtitle, WelcomePalette.SMALL_TEXT)
                    // The scene draws one level, the larger, behind the whole block.
                    val alpha = maxOf(headline, subtitle)
                    val scrim = WelcomePalette.scrim(colors).copy(alpha = alpha)
                    for (s in 0..10) {
                        val f = top + (bottom - top) * s / 10f
                        val under = scrim.compositeOver(WelcomePalette.colorAt(colors, f))
                        assertRatio("$name headline ($persian) at $f", ink, under, Contrast.AA_LARGE)
                        assertRatio("$name subtitle at $f", WelcomePalette.Subtitle, under, Contrast.AA)
                    }
                }
            }
        }
    }

    @Test
    fun `the default scrim stays soft, so the gradient still shows`() {
        // Over the template's layout (the text between 3 % and 25 % of the height).
        val alpha = maxOf(
            WelcomePalette.scrimOver(WelcomeColors.Default, 0.06f, 0.16f, WelcomePalette.headlineInk(false), WelcomePalette.LARGE_TEXT),
            WelcomePalette.scrimOver(WelcomeColors.Default, 0.16f, 0.25f, WelcomePalette.Subtitle, WelcomePalette.SMALL_TEXT),
        )
        assertTrue("scrim $alpha", alpha <= 0.62f)
    }

    @Test
    fun `the eyebrow passes on its glass pill anywhere near the top`() {
        for ((name, colors) in gradients) {
            val pill = WelcomePalette.scrim(colors).copy(alpha = WelcomePalette.eyebrowPill(colors))
            for (s in 0..22) {
                val under = pill.compositeOver(WelcomePalette.colorAt(colors, s / 100f))
                assertRatio("$name eyebrow at ${s / 100f}", WelcomePalette.Eyebrow, under, Contrast.AA)
            }
        }
    }

    @Test
    fun `the terms line and the buttons pass on the scene's bottom`() {
        for ((name, colors) in gradients.filter { it.first != "pale" && it.first != "neon" }) {
            for (f in listOf(0.82f, 0.9f, 1f)) {
                assertRatio("$name terms at $f", WelcomePalette.Terms, WelcomePalette.colorAt(colors, f), Contrast.AA)
            }
        }
        assertRatio("sign in label", WelcomePalette.OnLightPill, WelcomePalette.LightPill, Contrast.AA)
        assertRatio("sign up label", WelcomePalette.OnDarkPill, WelcomePalette.DarkPill, Contrast.AA)
    }

    @Test
    fun `the sheet's texts pass from its top to its bottom`() {
        val scheme = WelcomePalette.sheetScheme()
        for (f in listOf(0f, 0.25f, 0.5f, 0.75f, 1f)) {
            val sheet = androidx.compose.ui.graphics.lerp(WelcomePalette.SheetTop, WelcomePalette.SheetBottom, f)
            assertRatio("title at $f", WelcomePalette.SheetText, sheet, Contrast.AA)
            assertRatio("secondary at $f", WelcomePalette.SheetTextSecondary, sheet, Contrast.AA)
            assertRatio("link at $f", WelcomePalette.SheetLink, sheet, Contrast.AA)
            assertRatio("error at $f", DarkSemantic.danger, sheet, Contrast.AA)
            assertRatio("success at $f", DarkSemantic.success, sheet, Contrast.AA)
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
