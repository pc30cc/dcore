package app.core.feature.auth.welcome

import androidx.compose.ui.graphics.Color
import app.core.model.Config
import app.core.model.WelcomeConfig
import app.core.model.WelcomeGradient
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WelcomeContentTest {

    private val brand = BrandWelcome(
        defaultLocale = "en",
        eyebrow = mapOf("en" to "Welcome to", "fa" to "خوش آمدید به"),
        headline = mapOf("en" to "{appName}, *hello*", "fa" to "{appName}، *سلام*"),
        subtitle = mapOf("en" to "Brand subtitle"),
        gradient = WelcomeGradient("#112233", "#445566", "#778899"),
        images = listOf("a.webp", "b.png"),
    )

    private fun resolve(config: WelcomeConfig?, language: String, from: BrandWelcome = brand) = WelcomeContent.resolve(
        brand = from,
        config = config,
        language = language,
        fallbackEyebrow = "fallback eyebrow",
        fallbackHeadline = "*{appName}*",
        fallbackSubtitle = "fallback subtitle",
    )

    @Test
    fun `the brand's texts in the screen's language, its default language where one is missing`() {
        val fa = resolve(null, "fa")
        assertEquals("خوش آمدید به", fa.eyebrow)
        assertEquals("{appName}، *سلام*", fa.headline)
        assertEquals("Brand subtitle", fa.subtitle)
        val tr = resolve(null, "tr")
        assertEquals("Welcome to", tr.eyebrow)
    }

    @Test
    fun `the server's config wins, field by field`() {
        val content = resolve(WelcomeConfig(headline = "Server *headline*", subtitle = " "), "en")
        assertEquals("Welcome to", content.eyebrow)
        assertEquals("Server *headline*", content.headline)
        // A blank override is no override.
        assertEquals("Brand subtitle", content.subtitle)
    }

    @Test
    fun `without a brand block the app's own strings fill in`() {
        val content = resolve(null, "en", BrandWelcome())
        assertEquals("fallback eyebrow", content.eyebrow)
        assertEquals("*{appName}*", content.headline)
        assertEquals("fallback subtitle", content.subtitle)
        assertEquals(WelcomeColors.Default, content.colors)
        assertEquals(emptyList<WelcomePicture>(), content.pictures)
    }

    @Test
    fun `colours come from the config, then the brand, then the default, and a bad colour is ignored`() {
        assertEquals(Color(0xFF112233), resolve(null, "en").colors.top)
        val server = resolve(WelcomeConfig(gradient = WelcomeGradient("#FFFFFF", "#000000", "#123456")), "en")
        assertEquals(Color(0xFF123456), server.colors.bottom)
        val bad = resolve(WelcomeConfig(gradient = WelcomeGradient("white", "#000000", "#123456")), "en")
        assertEquals(Color(0xFF112233), bad.colors.top)
        assertNull(WelcomeColors.of(WelcomeGradient("#12345", "#000000", "#000000")))
    }

    @Test
    fun `pictures are the brand's files unless the config names https pictures`() {
        assertEquals(listOf(WelcomePicture.Asset("a.webp"), WelcomePicture.Asset("b.png")), resolve(null, "en").pictures)
        val server = resolve(WelcomeConfig(images = listOf("https://cdn.example.com/w/1.webp", "http://insecure.example.com/2.png")), "en")
        assertEquals(listOf(WelcomePicture.Remote("https://cdn.example.com/w/1.webp")), server.pictures)
    }

    @Test
    fun `the build's file and the config's block decode`() {
        val file = """{"defaultLocale":"fa","eyebrow":{"fa":"سلام"},"headline":{"en":"*Hi*"},"gradient":{"top":"#A9C2EE","middle":"#F06A3C","bottom":"#2B0A0E"},"images":["x.webp"],"future":1}"""
        val parsed = BrandWelcome.parse(file)
        assertEquals("fa", parsed.defaultLocale)
        assertEquals(WelcomeColors.Default, WelcomeColors.of(parsed.gradient))
        assertEquals(listOf("x.webp"), parsed.images)
        assertEquals(BrandWelcome(), BrandWelcome.parse("{}"))

        val json = Json { ignoreUnknownKeys = true }
        val config = json.decodeFromString(Config.serializer(), """{"v":3,"welcome":{"headline":"*Hey*","gradient":{"top":"#000000","middle":"#111111","bottom":"#222222"},"images":["https://cdn.example.com/a.webp"]}}""")
        assertEquals("*Hey*", config.welcome?.headline)
        assertEquals(listOf("https://cdn.example.com/a.webp"), config.welcome?.images)
        assertNull(json.decodeFromString(Config.serializer(), """{"v":1}""").welcome)
    }
}
