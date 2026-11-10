package app.core.feature.auth.welcome

import android.content.Context
import app.core.model.WelcomeConfig
import app.core.model.WelcomeGradient
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The brand's `welcome` block as the build wrote it to the assets
 * (`brand/welcome.json`; see app/build.gradle.kts): texts per locale, an
 * optional gradient and the names of the pictures copied next to it
 * (`brand/welcome/<name>`). The welcome draws only the pictures; its one
 * title is the app's own string.
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

/** Where a welcome picture comes from. */
sealed interface WelcomePicture {
    /** A file the brand ships (`brands/<id>/welcome/<name>`, copied into the assets). */
    data class Asset(val name: String) : WelcomePicture

    /** A picture the server's config names, fetched once and cached like photos. */
    data class Remote(val url: String) : WelcomePicture
}

/**
 * The welcome's pictures in the order they are tried: the ones the server's
 * config names (https only), then the brand's own files, which stay the
 * fallback when none of the config's can be loaded (offline, a bad URL).
 */
data class WelcomeSources(
    val remote: List<WelcomePicture.Remote> = emptyList(),
    val brand: List<WelcomePicture.Asset> = emptyList(),
) {
    val isEmpty: Boolean get() = remote.isEmpty() && brand.isEmpty()

    /** The non-empty sets, config first. */
    val sets: List<List<WelcomePicture>> get() = listOf(remote, brand).filter { it.isNotEmpty() }
}

/** Where the welcome's pictures come from. Never a member's photo. */
object WelcomeContent {
    fun pictures(brand: BrandWelcome, config: WelcomeConfig?): WelcomeSources = WelcomeSources(
        remote = config?.images.orEmpty().filter { it.startsWith("https://") }.map(WelcomePicture::Remote),
        brand = brand.images.map(WelcomePicture::Asset),
    )
}
