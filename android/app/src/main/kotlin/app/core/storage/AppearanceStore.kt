package app.core.storage

import android.content.Context
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Dark (the default look), light, or whatever the phone is doing. */
enum class Appearance(val key: String) {
    DARK("dark"),
    LIGHT("light"),
    SYSTEM("system"),
    ;

    companion object {
        /** Dark until the person picks otherwise. */
        val DEFAULT: Appearance = DARK

        fun from(key: String?): Appearance? = entries.firstOrNull { it.key == key }
    }
}

/**
 * The theme the person picked, read synchronously so the first frame is
 * already in it (like the language, see `AppLocales`): one small
 * SharedPreferences value, never the DataStore, whose first read is
 * asynchronous and would show the dark theme for a moment to someone who
 * chose light. A plain setting, not a credential; the file name and key are
 * fixed neutral constants.
 */
object AppearanceStore {
    private const val PREFS = "app.appearance"
    private const val KEY = "appearance"

    private var state: MutableStateFlow<Appearance>? = null

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The picked appearance, or [Appearance.DEFAULT]. */
    fun current(context: Context): Appearance = flow(context).value

    /** The picked appearance, following changes made with [choose]. */
    @Synchronized
    fun flow(context: Context): StateFlow<Appearance> {
        val existing = state
        if (existing != null) return existing.asStateFlow()
        val read = Appearance.from(prefs(context).getString(KEY, null)) ?: Appearance.DEFAULT
        return MutableStateFlow(read).also { state = it }.asStateFlow()
    }

    /** Picks [appearance]; every screen follows at once. */
    @Synchronized
    fun choose(context: Context, appearance: Appearance) {
        prefs(context).edit { putString(KEY, appearance.key) }
        val existing = state
        if (existing == null) state = MutableStateFlow(appearance) else existing.value = appearance
    }

    /** Forgets the cached value (tests: the next read goes to the file). */
    @Synchronized
    fun reset() {
        state = null
    }
}
