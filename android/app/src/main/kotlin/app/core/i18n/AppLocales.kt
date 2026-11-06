package app.core.i18n

import android.app.Activity
import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import androidx.core.content.edit
import app.core.BuildConfig
import java.util.Locale

/**
 * Applies the app's language to its resources, on every Android version.
 *
 * Android 13 and later keep a per-app language themselves (`LocaleManager`,
 * and the list in system settings comes from the locale config AGP generates).
 * Older versions have no such thing, so the choice is kept in a small
 * preferences file and applied to the activity's context here.
 *
 * Read synchronously because it is needed in `attachBaseContext`, before the
 * first frame: one tiny SharedPreferences value, never the DataStore.
 *
 * The default when nothing was picked is the store's ([AppLanguage.resolve]):
 * Cafe Bazaar's build opens in Persian whatever the phone's language, Google
 * Play's follows the phone.
 */
object AppLocales {
    private const val PREFS = "app.locale"
    private const val KEY_LANGUAGE = "language"

    /** The language the person picked, or null for "the default". */
    fun chosen(context: Context): AppLanguage? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val locales = context.getSystemService(LocaleManager::class.java)?.applicationLocales
            if (locales == null || locales.isEmpty) null else AppLanguage.fromTag(locales[0].toLanguageTag())
        } else {
            AppLanguage.fromTag(prefs(context).getString(KEY_LANGUAGE, null))
        }

    /** The language on screen. */
    fun current(context: Context): AppLanguage =
        AppLanguage.resolve(
            chosenTag = chosen(context)?.tag,
            deviceTags = deviceTags(),
            defaultTag = BuildConfig.DEFAULT_LOCALE,
            followsDevice = BuildConfig.LOCALE_FOLLOWS_DEVICE,
        )

    /**
     * Picks [language] (null: back to the default) and redraws [activity] in it.
     *
     * On Android 13+ the system stores the choice and recreates the activity
     * itself; before that the choice is stored here and the activity is
     * recreated by hand.
     */
    fun choose(activity: Activity, language: AppLanguage?) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val manager = activity.getSystemService(LocaleManager::class.java) ?: return
            manager.applicationLocales =
                if (language == null) LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(language.tag)
        } else {
            prefs(activity).edit { if (language == null) remove(KEY_LANGUAGE) else putString(KEY_LANGUAGE, language.tag) }
            activity.recreate()
        }
    }

    /**
     * The context an activity should be built on: [base] with the app's
     * language applied, unless the system already applies the person's choice
     * (Android 13+ with a per-app language set).
     */
    fun wrap(base: Context): Context {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && chosen(base) != null) return base
        val language = current(base)
        val configured = base.resources.configuration.locales[0]
        if (configured != null && AppLanguage.fromTag(configured.toLanguageTag()) == language) return base
        val locale = Locale.forLanguageTag(language.tag)
        val configuration = Configuration(base.resources.configuration).apply {
            // Also sets the layout direction: right to left for Persian.
            setLocale(locale)
        }
        return base.createConfigurationContext(configuration)
    }

    private fun deviceTags(): List<String> {
        val system = LocaleList.getAdjustedDefault()
        return (0 until system.size()).map { system[it].toLanguageTag() }
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
