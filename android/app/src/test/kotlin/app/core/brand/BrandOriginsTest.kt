package app.core.brand

import app.core.BuildConfig
import app.core.net.origins.OriginsTrust
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * What Gradle compiled in for the signed origins list is brand.json's:
 * `id`, `origins.publicKeys`, `origins.bootstrap`, the same in both stores.
 */
class BrandOriginsTest {

    private val brand: JsonObject by lazy {
        val file = File("../../brands/${BuildConfig.BRAND_ID}/brand.json")
        assertTrue("brand file not found at ${file.canonicalPath}", file.isFile)
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private val origins: JsonObject? get() = brand["origins"] as? JsonObject

    @Test
    fun theBrandIdIsBrandJsonsId() {
        assertEquals(brand["id"]!!.jsonPrimitive.content, BuildConfig.BRAND_ID)
        assertEquals(BuildConfig.BRAND_ID, OriginsTrust.fromBuild().brand)
    }

    @Test
    fun theKeysAreBrandJsonsKeys() {
        val listed = (origins?.get("publicKeys") as? JsonArray).orEmpty().map { entry ->
            val key = entry.jsonObject
            key["kid"]!!.jsonPrimitive.content to key["key"]!!.jsonPrimitive.content
        }
        assertEquals(listed.joinToString(",") { "${it.first}:${it.second}" }, BuildConfig.ORIGINS_PUBLIC_KEYS)
        assertEquals(listed.map { it.first }.toSet(), OriginsTrust.fromBuild().keys.keys)
    }

    @Test
    fun theCopiesAreBrandJsonsCopies() {
        val listed = (origins?.get("bootstrap") as? JsonArray).orEmpty().map { it.jsonPrimitive.content }
        assertEquals(listed.joinToString(" "), BuildConfig.ORIGINS_BOOTSTRAP)
        assertEquals(listed, OriginsTrust.buildBootstrap())
    }
}
