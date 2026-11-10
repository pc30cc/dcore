package app.core.template

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import app.core.model.UiConfig
import app.core.ui.theme.Templates
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * What the phone knows about the template: the person's [choice]
 * (`default` or a template id), the last `config.ui` the server sent
 * ([ui]; null until one arrived) with the config version it came in
 * ([uiVersion]), and whether the choice still has to reach the server
 * ([pending]).
 */
data class TemplateState(
    val choice: String = TemplateRule.DEFAULT,
    val ui: UiConfig? = null,
    val pending: Boolean = false,
    val uiVersion: Long = 0,
) {
    /** The template drawn ([TemplateRule]). */
    val effective: String get() = TemplateRule.effective(choice, ui)
}

/** Where [TemplateStore] keeps its state between launches. */
interface TemplatePersistence {
    /** The stored state; [TemplateState] defaults when nothing was stored. */
    fun load(): TemplateState

    fun save(state: TemplateState)

    /** Nothing kept: tests and previews. */
    class InMemory(private var state: TemplateState = TemplateState()) : TemplatePersistence {
        override fun load(): TemplateState = state

        override fun save(state: TemplateState) {
            this.state = state
        }
    }
}

/**
 * The template state, read synchronously so the first frame (and the launch
 * window, see `MainActivity`) is already in the last effective template:
 * a few SharedPreferences values, never the DataStore, whose first read is
 * asynchronous. One instance per process ([get]).
 */
class TemplateStore(private val persistence: TemplatePersistence) {
    private val _state = MutableStateFlow(persistence.load())
    private val _effective = MutableStateFlow(_state.value.effective)

    val state: StateFlow<TemplateState> = _state.asStateFlow()

    /** The id drawn now; changes only when the drawn template does. */
    val effective: StateFlow<String> = _effective.asStateFlow()

    /** Applies [change] and stores the result; returns it. */
    @Synchronized
    fun update(change: (TemplateState) -> TemplateState): TemplateState {
        val next = change(_state.value)
        if (next != _state.value) {
            persistence.save(next)
            _state.value = next
            _effective.value = next.effective
        }
        return next
    }

    companion object {
        @Volatile
        private var instance: TemplateStore? = null

        /** The process's store, over the app's SharedPreferences (migrating the older appearance setting once). */
        fun get(context: Context): TemplateStore =
            instance ?: synchronized(this) {
                instance ?: TemplateStore(SharedPreferencesPersistence(context.applicationContext)).also { instance = it }
            }

        /** Forgets the process's store (tests: the next [get] reads the file again). */
        @Synchronized
        fun reset() {
            instance = null
        }
    }
}

/**
 * [TemplateState] in a small SharedPreferences file. The file name and keys
 * are fixed neutral constants; nothing in it is a credential.
 *
 * The first read migrates the older dark/light/system preference once:
 * light becomes `white` (pending, so the account gets it), dark and system
 * become `default`. The older value is removed only once the migrated
 * state is on disk (a synchronous commit), so a process death in between
 * leaves the older value to migrate again.
 */
internal class SharedPreferencesPersistence(private val context: Context) : TemplatePersistence {
    private val prefs: SharedPreferences get() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override fun load(): TemplateState {
        val p = prefs
        if (!p.contains(KEY_CHOICE)) migrate()?.let { migrated ->
            if (write(migrated, commit = true)) {
                context.getSharedPreferences(OLDER_PREFS, Context.MODE_PRIVATE).edit { clear() }
            }
            return migrated
        }
        val choice = p.getString(KEY_CHOICE, null)?.takeIf { TemplateRule.isWireChoice(it) } ?: TemplateRule.DEFAULT
        val default = p.getString(KEY_UI_DEFAULT, null)
        val offered = p.getString(KEY_UI_OFFERED, null)
        val ui = if (default != null && offered != null) {
            UiConfig(defaultTemplate = default, templates = offered.split(',').filter { it.isNotEmpty() })
        } else {
            null
        }
        return TemplateState(
            choice = choice,
            ui = ui,
            pending = p.getBoolean(KEY_PENDING, false),
            uiVersion = if (ui != null) p.getLong(KEY_UI_VERSION, 0L) else 0L,
        )
    }

    override fun save(state: TemplateState) {
        write(state, commit = false)
    }

    /**
     * Writes [state]; with [commit], synchronously, returning whether it
     * reached the disk. The editor is used directly because the migration
     * needs commit()'s result, which the KTX `edit {}` does not return.
     */
    @SuppressLint("UseKtx")
    private fun write(state: TemplateState, commit: Boolean): Boolean {
        val editor = prefs.edit()
            .putString(KEY_CHOICE, state.choice)
            .putBoolean(KEY_PENDING, state.pending)
        if (state.ui != null) {
            editor.putString(KEY_UI_DEFAULT, state.ui.defaultTemplate)
                .putString(KEY_UI_OFFERED, state.ui.templates.joinToString(","))
                .putLong(KEY_UI_VERSION, state.uiVersion)
        } else {
            editor.remove(KEY_UI_DEFAULT).remove(KEY_UI_OFFERED).remove(KEY_UI_VERSION)
        }
        if (commit) return editor.commit()
        editor.apply()
        return true
    }

    /** The state the older appearance setting stands for, or null when there is none (the older file is left as it is). */
    private fun migrate(): TemplateState? {
        val older = context.getSharedPreferences(OLDER_PREFS, Context.MODE_PRIVATE)
        val value = older.getString(OLDER_KEY, null) ?: return null
        return when (value) {
            OLDER_LIGHT -> TemplateState(choice = LIGHT_TEMPLATE, pending = true)
            else -> TemplateState(choice = TemplateRule.DEFAULT)
        }
    }

    companion object {
        const val PREFS = "app.template"
        const val KEY_CHOICE = "choice"
        const val KEY_PENDING = "pending"
        const val KEY_UI_DEFAULT = "ui.default"
        const val KEY_UI_OFFERED = "ui.offered"
        const val KEY_UI_VERSION = "ui.v"

        /** The appearance setting builds before the templates kept (dark, light or system). */
        const val OLDER_PREFS = "app.appearance"
        const val OLDER_KEY = "appearance"
        const val OLDER_LIGHT = "light"

        /** What a light appearance becomes. */
        const val LIGHT_TEMPLATE = Templates.WHITE
    }
}
