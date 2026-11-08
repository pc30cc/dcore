package app.core.feature.auth.welcome

import android.content.Context
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import app.core.model.WelcomeConfig
import app.core.model.WelcomeGradient
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The brand's `welcome` block as the build wrote it to the assets
 * (`brand/welcome.json`; see app/build.gradle.kts): texts per locale, an
 * optional gradient and the names of the pictures copied next to it
 * (`brand/welcome/<name>`).
 */
@Serializable
data class BrandWelcome(
    val defaultLocale: String = "en",
    val eyebrow: Map<String, String> = emptyMap(),
    val headline: Map<String, String> = emptyMap(),
    val subtitle: Map<String, String> = emptyMap(),
    val gradient: WelcomeGradient? = null,
    val images: List<String> = emptyList(),
) {
    companion object {
        const val ASSET = "brand/welcome.json"
        const val IMAGE_FOLDER = "brand/welcome"

        private val json = Json { ignoreUnknownKeys = true }

        @Volatile private var loaded: BrandWelcome? = null

        /** Read once per process (a small file in the APK); an empty block when the brand has none. */
        fun load(context: Context): BrandWelcome = loaded ?: synchronized(this) {
            loaded ?: read(context).also { loaded = it }
        }

        private fun read(context: Context): BrandWelcome = runCatching {
            context.assets.open(ASSET).bufferedReader().use { json.decodeFromString(serializer(), it.readText()) }
        }.getOrDefault(BrandWelcome())

        fun parse(text: String): BrandWelcome = json.decodeFromString(serializer(), text)
    }
}

/** Where a bubble's picture comes from. */
sealed interface WelcomePicture {
    /** A file the brand ships (`brands/<id>/welcome/<name>`, copied into the assets). */
    data class Asset(val name: String) : WelcomePicture

    /** A picture the server's config names, fetched once and cached like photos. */
    data class Remote(val url: String) : WelcomePicture
}

/** The scene's three colours, top to bottom. */
@Immutable
data class WelcomeColors(val top: Color, val middle: Color, val bottom: Color) {
    companion object {
        /** Sky at the top, a warm coral in the middle, deep maroon at the bottom. */
        val Default = WelcomeColors(Color(0xFFA9C2EE), Color(0xFFF06A3C), Color(0xFF2B0A0E))

        fun of(gradient: WelcomeGradient?): WelcomeColors? {
            gradient ?: return null
            val top = hex(gradient.top) ?: return null
            val middle = hex(gradient.middle) ?: return null
            val bottom = hex(gradient.bottom) ?: return null
            return WelcomeColors(top, middle, bottom)
        }

        private fun hex(value: String): Color? {
            val v = value.trim()
            if (v.length != 7 || v[0] != '#') return null
            val rgb = v.substring(1).toLongOrNull(16) ?: return null
            return Color(0xFF000000L or rgb)
        }
    }
}

/** What the welcome shows, resolved: the server's config first, then the brand, then the app's defaults. */
@Immutable
data class WelcomeContent(
    val eyebrow: String,
    /** With its asterisks; see [Headline]. */
    val headline: String,
    val subtitle: String,
    val colors: WelcomeColors,
    val pictures: List<WelcomePicture>,
) {
    companion object {
        /**
         * [language] is the screen's (`fa`, `en`, `tr`). A text missing in it
         * falls back to the brand's default locale; [fallbackEyebrow],
         * [fallbackHeadline] and [fallbackSubtitle] (the app's own strings)
         * fill what neither has. Config pictures replace the brand's when
         * there are any.
         */
        fun resolve(
            brand: BrandWelcome,
            config: WelcomeConfig?,
            language: String,
            fallbackEyebrow: String,
            fallbackHeadline: String,
            fallbackSubtitle: String,
        ): WelcomeContent {
            fun pick(server: String?, texts: Map<String, String>, fallback: String): String =
                server?.takeIf { it.isNotBlank() }
                    ?: texts[language]?.takeIf { it.isNotBlank() }
                    ?: texts[brand.defaultLocale]?.takeIf { it.isNotBlank() }
                    ?: fallback
            val remote = config?.images.orEmpty().filter { it.startsWith("https://") }
            return WelcomeContent(
                eyebrow = pick(config?.eyebrow, brand.eyebrow, fallbackEyebrow),
                headline = pick(config?.headline, brand.headline, fallbackHeadline),
                subtitle = pick(config?.subtitle, brand.subtitle, fallbackSubtitle),
                colors = WelcomeColors.of(config?.gradient) ?: WelcomeColors.of(brand.gradient) ?: WelcomeColors.Default,
                pictures = if (remote.isNotEmpty()) remote.map(WelcomePicture::Remote) else brand.images.map(WelcomePicture::Asset),
            )
        }
    }
}
