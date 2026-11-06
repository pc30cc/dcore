package app.core.i18n

/**
 * The languages the app ships, and the rule that picks one.
 *
 * Strings live in `res/values` (English), `res/values-fa` and `res/values-tr`;
 * adding a language means a folder there and an entry here. The layout
 * direction follows the language through the platform (`supportsRtl`), so
 * Persian is right to left everywhere without a screen having to ask.
 */
enum class AppLanguage(val tag: String, val rightToLeft: Boolean) {
    EN("en", rightToLeft = false),
    FA("fa", rightToLeft = true),
    TR("tr", rightToLeft = false),
    ;

    companion object {
        /** The language for a BCP 47 tag or bare language code (`fa`, `fa-IR`, `tr-TR`), or null. */
        fun fromTag(tag: String?): AppLanguage? {
            val language = tag?.trim()?.substringBefore('-')?.substringBefore('_')?.lowercase()
            if (language.isNullOrEmpty()) return null
            return entries.firstOrNull { it.tag == language }
        }

        /**
         * The language to show.
         *
         * 1. What the person picked (in the app, or in Android 13+'s per-app
         *    language settings), when it is one the app has.
         * 2. Otherwise, for a store whose build follows the device
         *    ([followsDevice]: Google Play), the first device language the app
         *    has.
         * 3. Otherwise the store's default ([defaultTag]: Persian for Cafe
         *    Bazaar, English for Google Play), and English if that is not
         *    shipped either.
         */
        fun resolve(
            chosenTag: String?,
            deviceTags: List<String>,
            defaultTag: String,
            followsDevice: Boolean,
        ): AppLanguage {
            fromTag(chosenTag)?.let { return it }
            if (followsDevice) {
                deviceTags.firstNotNullOfOrNull(::fromTag)?.let { return it }
            }
            return fromTag(defaultTag) ?: EN
        }
    }
}
