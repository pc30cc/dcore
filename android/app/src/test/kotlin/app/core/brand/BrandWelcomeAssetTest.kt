package app.core.brand

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.BuildConfig
import app.core.feature.auth.welcome.BrandWelcome
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import app.core.testing.BrandFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The welcome block the app reads (the build's generated
 * `brand/welcome.json` and the pictures in `brand/welcome/`) is brand.json's
 * `welcome` block; the welcome draws its pictures.
 */
@RunWith(AndroidJUnit4::class)
class BrandWelcomeAssetTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private val block: JsonObject? by lazy {
        val file = BrandFile.json
        assertTrue("brand file not found at ${file.canonicalPath}", file.isFile)
        Json.parseToJsonElement(file.readText()).jsonObject["welcome"] as? JsonObject
    }

    private fun texts(key: String): Map<String, String> =
        (block?.get(key) as? JsonObject)?.mapValues { it.value.jsonPrimitive.content }.orEmpty()

    @Test
    fun `the generated asset carries brand json's welcome block`() {
        val welcome = BrandWelcome.load(context)
        assertEquals(texts("eyebrow"), welcome.eyebrow)
        assertEquals(texts("headline"), welcome.headline)
        assertEquals(texts("subtitle"), welcome.subtitle)
        val images = block?.get("images")?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
        assertEquals(images, welcome.images)
        val gradient = block?.get("gradient") as? JsonObject
        if (gradient != null) {
            assertNotNull(welcome.gradient)
            assertEquals(gradient["middle"]!!.jsonPrimitive.content, welcome.gradient!!.middle)
        }
    }

    @Test
    fun `every picture the block names ships with the app`() {
        val welcome = BrandWelcome.load(context)
        for (name in welcome.images) {
            context.assets.open("${BrandWelcome.IMAGE_FOLDER}/$name").use { assertTrue(it.read() >= 0) }
        }
    }

    @Test
    fun `the template's headline marks an emphasis in every language`() {
        if (BuildConfig.BRAND_ID != "_template") return
        for ((language, headline) in texts("headline")) {
            assertTrue("$language: $headline", headline.count { it == '*' } == 2)
        }
    }
}
