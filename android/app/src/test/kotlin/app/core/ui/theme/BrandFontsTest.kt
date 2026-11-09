package app.core.ui.theme

import android.content.Context
import androidx.compose.ui.text.font.FontListFontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.ResourceFont
import androidx.core.content.res.ResourcesCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.R
import app.core.testing.BrandFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The fonts the build copied (`brandFonts` in build.gradle.kts) are the
 * brand's own files when brand.json names them, else the bundled open fonts,
 * under the fixed names the code uses; each loads; the Persian family has
 * only three weights (SemiBold is drawn Bold); the licences list shows the
 * bundled fonts' licences and nothing for a brand font without one.
 */
@RunWith(AndroidJUnit4::class)
class BrandFontsTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private val fonts: JsonObject? by lazy {
        Json.parseToJsonElement(BrandFile.json.readText()).jsonObject["fonts"] as? JsonObject
    }

    private fun bytes(resource: Int): ByteArray = context.resources.openRawResource(resource).use { it.readBytes() }

    private fun text(resource: Int): String = context.resources.openRawResource(resource).bufferedReader().use { it.readText() }

    /** The file a weight was copied from: the brand's, or the bundled one. */
    private fun source(key: String, weight: String, bundled: String): File {
        val named = (fonts?.get(key) as? JsonObject)?.get(weight)?.jsonPrimitive?.content
        return if (named != null) File(BrandFile.dir, named) else File("src/main/bundled-fonts/$bundled")
    }

    @Test
    fun `each font is the brand's file or the bundled one`() {
        val fa = mapOf("regular" to R.font.brand_fa_regular, "medium" to R.font.brand_fa_medium, "bold" to R.font.brand_fa_bold)
        for ((weight, id) in fa) {
            assertArrayEquals("persian $weight", source("persianFiles", weight, "persian/vazirmatn_$weight.ttf").readBytes(), bytes(id))
        }
        val latin = mapOf("regular" to R.font.brand_latin_regular, "medium" to R.font.brand_latin_medium, "bold" to R.font.brand_latin_bold)
        for ((weight, id) in latin) {
            assertArrayEquals("latin $weight", source("latinFiles", weight, "latin/bevietnampro_$weight.ttf").readBytes(), bytes(id))
        }
    }

    @Test
    fun `every font loads`() {
        for (id in listOf(
            R.font.brand_fa_regular, R.font.brand_fa_medium, R.font.brand_fa_bold,
            R.font.brand_latin_regular, R.font.brand_latin_medium, R.font.brand_latin_semibold, R.font.brand_latin_bold,
        )) {
            assertNotNull(ResourcesCompat.getFont(context, id))
        }
    }

    @Test
    fun `the names and licences are the right set's`() {
        val persianFiles = fonts?.get("persianFiles") as? JsonObject
        val faName = context.getString(R.string.brand_font_fa_name)
        val faLicence = text(R.raw.license_brand_fa)
        if (persianFiles == null) {
            assertEquals("Vazirmatn", faName)
            assertTrue(faLicence.contains("SIL Open Font License"))
        } else {
            assertEquals(fonts?.get("persian")?.jsonPrimitive?.content, faName)
            val licence = persianFiles["license"]?.jsonPrimitive?.content
            assertEquals(licence?.let { File(BrandFile.dir, it).readText() }.orEmpty(), faLicence)
        }
        val latinFiles = fonts?.get("latinFiles") as? JsonObject
        val latinLicence = text(R.raw.license_brand_latin)
        if (latinFiles == null) {
            assertEquals("Be Vietnam Pro", context.getString(R.string.brand_font_latin_name))
            assertTrue(latinLicence.contains("SIL Open Font License"))
            assertTrue(latinLicence.contains("Be Vietnam Pro"))
        }
    }

    @Test
    fun `persian has three weights and SemiBold is Bold`() {
        val family = PersianFamily as FontListFontFamily
        val byWeight = family.fonts.associate { it.weight to (it as ResourceFont).resId }
        assertEquals(R.font.brand_fa_regular, byWeight[FontWeight.Normal])
        assertEquals(R.font.brand_fa_medium, byWeight[FontWeight.Medium])
        assertEquals(R.font.brand_fa_bold, byWeight[FontWeight.SemiBold])
        assertEquals(R.font.brand_fa_bold, byWeight[FontWeight.Bold])
        assertEquals(3, byWeight.values.toSet().size)
    }

    @Test
    fun `the type scale never goes under 12 sp and Persian is never letter-spaced`() {
        for (persian in listOf(true, false)) {
            val t = appTypography(persian)
            val styles = listOf(
                t.displayLarge, t.displayMedium, t.displaySmall, t.headlineLarge, t.headlineMedium, t.headlineSmall,
                t.titleLarge, t.titleMedium, t.titleSmall, t.bodyLarge, t.bodyMedium, t.bodySmall,
                t.labelLarge, t.labelMedium, t.labelSmall,
            )
            for (style in styles) {
                assertTrue("$style", style.fontSize.value >= 12f)
                if (persian) {
                    assertEquals(0f, style.letterSpacing.value, 0f)
                    // The Persian faces have no 600: every Persian role is 400, 500 or 700.
                    assertTrue("${style.fontWeight}", style.fontWeight in setOf(FontWeight.Normal, FontWeight.Medium, FontWeight.Bold))
                    assertEquals(PersianFamily, style.fontFamily)
                } else {
                    assertEquals(LatinFamily, style.fontFamily)
                }
            }
        }
    }
}
