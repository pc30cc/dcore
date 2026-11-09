package app.core.testing

import app.core.BuildConfig
import java.io.File

/**
 * This build's brand folder: `brands/<id>` in the repository, or under the
 * folder the build was given with `-PbrandsDir` (passed to the tests as the
 * `app.brandsDir` property).
 */
object BrandFile {
    private val root: File
        get() = File(System.getProperty("app.brandsDir")?.takeIf { it.isNotBlank() } ?: "../../brands")

    /** `<brands>/<id>/`. */
    val dir: File get() = File(root, BuildConfig.BRAND_ID)

    /** `<brands>/<id>/brand.json`. */
    val json: File get() = File(dir, "brand.json")
}
