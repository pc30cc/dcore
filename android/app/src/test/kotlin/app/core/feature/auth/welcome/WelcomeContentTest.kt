package app.core.feature.auth.welcome

import app.core.model.Config
import app.core.model.WelcomeConfig
import app.core.model.WelcomeGradient
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WelcomeContentTest {

    private val brand = BrandWelcome(
        defaultLocale = "en",
        headline = mapOf("en" to "{appName}, *hello*"),
        gradient = WelcomeGradient("#112233", "#445566", "#778899"),
        images = listOf("a.webp", "b.png"),
    )

    @Test
    fun `the config's https pictures come first and the brand's files stay their fallback`() {
        val own = listOf(WelcomePicture.Asset("a.webp"), WelcomePicture.Asset("b.png"))
        assertEquals(WelcomeSources(brand = own), WelcomeContent.pictures(brand, null))
        assertEquals(listOf(own), WelcomeContent.pictures(brand, WelcomeConfig(headline = "x")).sets)
        val server = WelcomeContent.pictures(brand, WelcomeConfig(images = listOf("https://cdn.example.com/w/1.webp", "http://insecure.example.com/2.png")))
        assertEquals(listOf(WelcomePicture.Remote("https://cdn.example.com/w/1.webp")), server.remote)
        // The brand's own are kept behind them, for when none of the config's can be loaded.
        assertEquals(listOf(listOf(WelcomePicture.Remote("https://cdn.example.com/w/1.webp")), own), server.sets)
        // Only insecure ones named: the brand's files alone.
        assertEquals(listOf(own), WelcomeContent.pictures(brand, WelcomeConfig(images = listOf("http://insecure.example.com/2.png"))).sets)
    }

    @Test
    fun `without a brand block or a config there are no pictures`() {
        val none = WelcomeContent.pictures(BrandWelcome(), null)
        assertTrue(none.isEmpty)
        assertEquals(emptyList<List<WelcomePicture>>(), none.sets)
    }

    @Test
    fun `the build's file and the config's block decode`() {
        val file = """{"defaultLocale":"fa","eyebrow":{"fa":"سلام"},"headline":{"en":"*Hi*"},"gradient":{"top":"#A9C2EE","middle":"#F06A3C","bottom":"#2B0A0E"},"images":["x.webp"],"future":1}"""
        val parsed = BrandWelcome.parse(file)
        assertEquals("fa", parsed.defaultLocale)
        assertEquals("#F06A3C", parsed.gradient?.middle)
        assertEquals(listOf("x.webp"), parsed.images)
        assertEquals(BrandWelcome(), BrandWelcome.parse("{}"))

        val json = Json { ignoreUnknownKeys = true }
        val config = json.decodeFromString(Config.serializer(), """{"v":3,"welcome":{"headline":"*Hey*","gradient":{"top":"#000000","middle":"#111111","bottom":"#222222"},"images":["https://cdn.example.com/a.webp"]}}""")
        assertEquals("*Hey*", config.welcome?.headline)
        assertEquals(listOf("https://cdn.example.com/a.webp"), config.welcome?.images)
        assertNull(json.decodeFromString(Config.serializer(), """{"v":1}""").welcome)
    }
}
