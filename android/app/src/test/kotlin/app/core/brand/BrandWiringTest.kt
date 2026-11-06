package app.core.brand

import app.core.BuildConfig
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * What the build read from brands/<id>/brand.json is what the app runs with:
 * the name, the store's application id, the colours and the server.
 */
class BrandWiringTest {

    private val brand: JsonObject by lazy {
        // The module's directory is the working directory; brands/ is two up.
        val file = File("../../brands/${BuildConfig.BRAND_ID}/brand.json")
        assertTrue("brand file not found at ${file.canonicalPath}", file.isFile)
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun string(path: String): String? = path.split('.').fold(brand as kotlinx.serialization.json.JsonElement?) { node, key ->
        (node as? JsonObject)?.get(key)
    }?.jsonPrimitive?.content

    private fun hex(path: String): Long = 0xFF000000L or string(path)!!.removePrefix("#").toLong(16)

    @Test
    fun `the app name comes from the brand`() {
        assertEquals(string("appName"), BuildConfig.APP_NAME)
        assertEquals(string("appName"), AppBrand.appName)
    }

    @Test
    fun `the application id is the brand's for this store`() {
        val expected = string("android.applicationId.${BuildConfig.STORE}") ?: string("android.package")
        assertEquals(expected, BuildConfig.APPLICATION_ID)
    }

    @Test
    fun `the colours are the brand's`() {
        assertEquals(hex("colors.brand.light"), BuildConfig.BRAND_PRIMARY_LIGHT)
        assertEquals(hex("colors.brand.dark"), BuildConfig.BRAND_PRIMARY_DARK)
        assertEquals(hex("colors.onBrand.light"), BuildConfig.BRAND_ON_PRIMARY_LIGHT)
        assertEquals(hex("colors.onBrand.dark"), BuildConfig.BRAND_ON_PRIMARY_DARK)
    }

    @Test
    fun `the server is the brand's api domain over https`() {
        assertEquals("https://${string("domains.api")}", BuildConfig.API_BASE_URL)
        assertTrue(BuildConfig.REALTIME_WS_URL.startsWith("wss://"))
        assertEquals(BuildConfig.STORE, AppBrand.store.id)
    }

    @Test
    fun `the version comes from the brand unless the release passes its own`() {
        val code = string("android.versionCode")?.toInt()
        if (code != null) assertEquals(code, BuildConfig.VERSION_CODE)
        val name = string("android.versionName")
        if (name != null) assertEquals(name, BuildConfig.VERSION_NAME)
    }
}
