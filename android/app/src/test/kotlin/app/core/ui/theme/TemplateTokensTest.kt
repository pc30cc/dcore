package app.core.ui.theme

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.LayoutDirection
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.lang.reflect.Modifier

/**
 * Every template defines every token of the contract, and each one can be
 * read back as plain values: the test writes `build/template-tokens/<id>.json`
 * (keys are the token names lowercased without dashes, values in CSS units:
 * colours as rgba, gradients with their angle and stops, shadows as layers,
 * type as weight/size/line) and `<id>-material3.json` (the Material scheme),
 * for an outside comparison with the template sources.
 */
class TemplateTokensTest {

    private val outDir = File("build/template-tokens")

    @Test
    fun `every template defines the whole contract and dumps it`() {
        outDir.mkdirs()
        val counts = mutableMapOf<String, Int>()
        for (template in listOf(Templates.Neon, Templates.White)) {
            val tokens = dump(template)
            counts[template.id] = tokens.size
            File(outDir, "${template.id}.json").writeText(JsonObject(tokens).toString())
            File(outDir, "${template.id}-material3.json").writeText(JsonObject(scheme(templateColorScheme(template))).toString())
        }
        // The contract's 223 tokens: the id, the seven switches and every value.
        assertEquals(mapOf("neon" to CONTRACT_SIZE, "white" to CONTRACT_SIZE), counts)
    }

    @Test
    fun `the templates ship in display order and an unknown id draws neon`() {
        assertEquals(listOf("neon", "white"), Templates.ids)
        assertEquals("neon", Templates.of("sepia").id)
        assertEquals("white", Templates.of("white").id)
        assertTrue(Templates.Neon.dark)
        assertTrue(!Templates.White.dark)
    }

    /** A brand unlike the design: a green accent and a green "yes" gradient in both themes. */
    private val green = BrandColors.Design.copy(
        brandLight = Color(0xFF0B6E45),
        brandDark = Color(0xFF5FD39A),
        gradientLight = GradientStops(Color(0xFF0B7A4B), Color(0xFF0E8F5A), Color(0xFF13A86A)),
        gradientDark = GradientStops(Color(0xFF112233), Color(0xFF445566), Color(0xFF778899)),
    )

    @Test
    fun `the brand's colours drive the accent group of both templates`() {
        val neon = Templates.of(Templates.NEON, green)
        val design = Templates.Neon
        assertEquals(Color(0xFF112233), neon.paints.likeFill.stop(0))
        assertEquals(Color(0xFF778899), neon.paints.primaryFill.stop(2))
        // Accent text, caret, the filled OTP edge, the icon gradient, the title word, the heart, the snackbar action.
        for ((name, pair) in mapOf(
            "primary" to (neon.colors.primary to design.colors.primary),
            "caret" to (neon.colors.caret to design.colors.caret),
            "otp-filled" to (neon.shadows.otpFilled.first().color to design.shadows.otpFilled.first().color),
            "icon-grad-1" to (neon.colors.iconGrad1 to design.colors.iconGrad1),
            "verified" to (neon.paints.verified.stop(0) to design.paints.verified.stop(0)),
            "tab-active-icon" to (neon.paints.tabActiveIcon.stop(2) to design.paints.tabActiveIcon.stop(2)),
            "accent-text" to (neon.paints.accentText.stop(0) to design.paints.accentText.stop(0)),
            "like" to (neon.colors.like to design.colors.like),
            "inverse-action" to (neon.colors.inverseAction to design.colors.inverseAction),
        )) assertNotEquals("neon $name follows the brand", pair.second, pair.first)
        // The accent keeps the brand's hue: the brand's own colour where it already reads 4.5:1.
        assertEquals(Color(0xFF5FD39A), neon.colors.primary)

        val white = Templates.of(Templates.WHITE, green)
        val plain = Templates.White
        assertEquals(Color(0xFF0B6E45), white.colors.primary)
        for ((name, pair) in mapOf(
            "caret" to (white.colors.caret to plain.colors.caret),
            "tint" to (white.colors.primaryTint to plain.colors.primaryTint),
            "like" to (white.colors.like to plain.colors.like),
            "super-icon" to (white.colors.superIcon to plain.colors.superIcon),
            "kb-act" to (white.colors.kbAct to plain.colors.kbAct),
            "icon-grad-2" to (white.colors.iconGrad2 to plain.colors.iconGrad2),
            "inverse-action" to (white.colors.inverseAction to plain.colors.inverseAction),
            "tag-fill" to (white.paints.tagFill.stop(0) to plain.paints.tagFill.stop(0)),
            "like-fill" to (white.paints.likeFill.stop(0) to plain.paints.likeFill.stop(0)),
            "unread-fill" to (white.paints.unreadFill.stop(0) to plain.paints.unreadFill.stop(0)),
            "ring-fill" to (white.paints.ringFill.stop(0) to plain.paints.ringFill.stop(0)),
            "verified" to (white.paints.verified.stop(0) to plain.paints.verified.stop(0)),
            "badge-fill" to (white.paints.badgeFill.stop(0) to plain.paints.badgeFill.stop(0)),
            "quote-bar" to (white.paints.quoteBar.stop(0) to plain.paints.quoteBar.stop(0)),
            "progress-fill" to (white.paints.progressFill.stop(0) to plain.paints.progressFill.stop(0)),
            "bubble-out" to (white.paints.bubbleOut.stop(0) to plain.paints.bubbleOut.stop(0)),
            "glow-like" to (white.shadows.glowLike.last().color to plain.shadows.glowLike.last().color),
            "material tertiary" to (templateColorScheme(white).tertiary to templateColorScheme(plain).tertiary),
            "material onTertiaryContainer" to (templateColorScheme(white).onTertiaryContainer to templateColorScheme(plain).onTertiaryContainer),
        )) assertNotEquals("white $name follows the brand", pair.second, pair.first)
        // The like button takes the brand's light gradient.
        assertEquals(Color(0xFF0B7A4B), white.paints.likeFill.stop(0))
        // White's ink controls stay ink.
        assertEquals(plain.paints.primaryFill, white.paints.primaryFill)
    }

    @Test
    fun `a brand with the design's colours gets the templates exactly as designed`() {
        assertSame(Templates.Neon, Templates.of(Templates.NEON, BrandColors.Design))
        assertSame(Templates.White, Templates.of(Templates.WHITE, BrandColors.Design))
        assertEquals(Color(0xFFDD6BF2), Templates.Neon.colors.primary)
        assertEquals(Color(0xFF5B2FD9), Templates.White.colors.primary)
        // The same brand twice is built once.
        assertSame(Templates.of(Templates.WHITE, green), Templates.of(Templates.WHITE, green))
    }

    private fun dump(t: AppTemplate): Map<String, JsonElement> {
        val out = linkedMapOf<String, JsonElement>()
        out["themename"] = JsonPrimitive(t.id)
        out["switchtemplate"] = JsonPrimitive(t.switches.template)
        out["switchscheme"] = JsonPrimitive(t.switches.scheme.name.lowercase())
        out["switchtabbar"] = JsonPrimitive(t.switches.tabBar.name.lowercase())
        out["switchdeck"] = JsonPrimitive(t.switches.deck.name.lowercase())
        out["switchhero"] = JsonPrimitive(t.switches.hero.name.lowercase())
        out["switchglass"] = JsonPrimitive(if (t.switches.glass) "on" else "off")
        out["switchglow"] = JsonPrimitive(if (t.switches.glow) "on" else "off")
        out["grainopacity"] = JsonPrimitive(t.grainOpacity)
        fields(t.colors) { name, raw -> out[key(name)] = color(Color((raw as Long).toULong())) }
        fields(t.paints) { name, raw -> out[key(name)] = brush(raw as Brush) }
        fields(t.shadows) { name, raw ->
            @Suppress("UNCHECKED_CAST")
            out[key(name)] = shadow(raw as List<ShadowLayer>)
        }
        fields(t.radii) { name, raw -> out["r" + key(name)] = JsonPrimitive(raw as Float) }
        fields(t.sizes) { name, raw ->
            out[key(name)] = when (raw) {
                is Float -> JsonPrimitive(raw)
                is PaddingValues -> buildJsonArray {
                    add(JsonPrimitive(raw.calculateTopPadding().value))
                    add(JsonPrimitive(raw.calculateEndPadding(LayoutDirection.Ltr).value))
                    add(JsonPrimitive(raw.calculateBottomPadding().value))
                    add(JsonPrimitive(raw.calculateStartPadding(LayoutDirection.Ltr).value))
                }
                else -> error("$name: ${raw?.javaClass}")
            }
        }
        fields(t.type) { name, raw ->
            when (raw) {
                is FontFamily -> out[key(name)] = JsonPrimitive(family(raw))
                is TextStyle -> out["type" + key(name)] = buildJsonObject {
                    put("weight", raw.fontWeight?.weight)
                    put("size", raw.fontSize.value)
                    put("lineHeight", raw.lineHeight.value)
                    put("family", family(raw.fontFamily))
                }
                else -> error("$name: ${raw?.javaClass}")
            }
        }
        fields(t.filters) { name, raw ->
            val f = raw as PhotoFilter
            out[key(name)] = buildJsonObject {
                put("blur", f.blur.value)
                put("saturate", f.saturate)
                put("brightness", f.brightness)
            }
        }
        return out
    }

    private fun family(f: FontFamily?): String = when (f) {
        PersianFamily -> "fa"
        LatinFamily -> "lat"
        else -> "other"
    }

    /** The instance fields of a token class, in declaration order. */
    private fun fields(holder: Any, each: (String, Any?) -> Unit) {
        for (field in holder.javaClass.declaredFields) {
            if (Modifier.isStatic(field.modifiers)) continue
            field.isAccessible = true
            each(field.name, field.get(holder))
        }
    }

    private fun key(name: String): String = name.lowercase()

    private fun color(c: Color): JsonElement = buildJsonArray {
        add(JsonPrimitive(Math.round(c.red * 255)))
        add(JsonPrimitive(Math.round(c.green * 255)))
        add(JsonPrimitive(Math.round(c.blue * 255)))
        add(JsonPrimitive(c.alpha))
    }

    private fun stops(positions: List<Float>, colors: List<Color>): JsonArray = buildJsonArray {
        positions.zip(colors).forEach { (p, c) -> add(buildJsonArray { add(JsonPrimitive(p)); add(color(c)) }) }
    }

    private fun brush(b: Brush): JsonElement = when (b) {
        is SolidColor -> buildJsonObject { put("solid", color(b.value)) }
        is CssLinearGradient -> buildJsonObject {
            put("linear", b.angle)
            put("stops", stops(b.stops, b.colors))
        }
        is IconGradient -> buildJsonObject { put("icon", stops(b.stops, b.colors)) }
        is CssRadialGradients -> buildJsonObject {
            put(
                "radials",
                buildJsonArray {
                    for (layer in b.layers) {
                        add(
                            buildJsonObject {
                                when (val s = layer.size) {
                                    RadialSize.FarthestCorner -> put("size", "circle-farthest-corner")
                                    is RadialSize.Ellipse -> put("size", buildJsonArray { add(JsonPrimitive(s.rx)); add(JsonPrimitive(s.ry)) })
                                }
                                put("at", buildJsonArray { add(JsonPrimitive(layer.cx)); add(JsonPrimitive(layer.cy)) })
                                put("stops", stops(layer.stops.map { it.first }, layer.stops.map { it.second }))
                            },
                        )
                    }
                },
            )
        }
        else -> error("unexpected brush ${b.javaClass}")
    }

    private fun shadow(layers: List<ShadowLayer>): JsonElement = buildJsonArray {
        for (l in layers) {
            add(
                buildJsonObject {
                    put("x", l.x.value)
                    put("y", l.y.value)
                    put("blur", l.blur.value)
                    put("spread", l.spread.value)
                    put("color", color(l.color))
                    put("inset", l.inset)
                },
            )
        }
    }

    private fun scheme(s: ColorScheme): Map<String, JsonElement> {
        val out = linkedMapOf<String, JsonElement>()
        for (field in s.javaClass.declaredFields) {
            if (Modifier.isStatic(field.modifiers) || field.type != java.lang.Long.TYPE) continue
            field.isAccessible = true
            val c = Color((field.get(s) as Long).toULong())
            out[field.name.substringBefore('$')] = JsonPrimitive("#%02X%02X%02X".format(Math.round(c.red * 255), Math.round(c.green * 255), Math.round(c.blue * 255)))
        }
        return out
    }

    private companion object {
        const val CONTRACT_SIZE = 223
    }
}
