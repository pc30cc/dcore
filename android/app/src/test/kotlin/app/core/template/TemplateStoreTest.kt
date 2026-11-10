package app.core.template

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.model.UiConfig
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** The stored choice, ui and pending flag survive a restart; the older appearance setting migrates once. */
@RunWith(AndroidJUnit4::class)
class TemplateStoreTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun prefs(name: String) = context.getSharedPreferences(name, Context.MODE_PRIVATE)

    @Before
    fun clean() {
        prefs("app.template").edit().clear().commit()
        prefs("app.appearance").edit().clear().commit()
        TemplateStore.reset()
    }

    @After
    fun forget() = TemplateStore.reset()

    private fun restart(): TemplateStore {
        TemplateStore.reset()
        return TemplateStore.get(context)
    }

    @Test
    fun `a new install follows the default and draws neon`() {
        val state = TemplateStore.get(context).state.value
        assertEquals(TemplateState(choice = "default", ui = null, pending = false), state)
        assertEquals("neon", TemplateStore.get(context).effective.value)
    }

    @Test
    fun `the state is seen at once and after a restart`() {
        val store = TemplateStore.get(context)
        val effective = store.effective
        store.update { it.copy(choice = "white", pending = true) }
        assertEquals("white", effective.value)
        store.update { it.copy(ui = UiConfig("white", listOf("white", "neon", "sepia"))) }
        val again = restart().state.value
        assertEquals("white", again.choice)
        assertTrue(again.pending)
        assertEquals(UiConfig("white", listOf("white", "neon", "sepia")), again.ui)
    }

    @Test
    fun `the first frame after a restart is drawn in the default the server sent last`() {
        TemplateStore.get(context).update { it.copy(ui = UiConfig("white", listOf("neon", "white"))) }
        assertEquals("white", restart().effective.value)
    }

    @Test
    fun `light migrates to white, pending, once`() {
        prefs("app.appearance").edit().putString("appearance", "light").commit()
        val state = TemplateStore.get(context).state.value
        assertEquals("white", state.choice)
        assertTrue("the account gets the migrated choice", state.pending)
        assertNull(prefs("app.appearance").getString("appearance", null))
        // Once: a later change is not undone by the older file.
        TemplateStore.get(context).update { it.copy(choice = "neon", pending = false) }
        assertEquals("neon", restart().state.value.choice)
    }

    @Test
    fun `the config version of the ui is kept with it`() {
        TemplateStore.get(context).update { it.copy(ui = UiConfig("white", listOf("neon", "white")), uiVersion = 9) }
        assertEquals(9L, restart().state.value.uiVersion)
    }

    @Test
    fun `the migrated state is on disk before the older value is removed`() {
        prefs("app.appearance").edit().putString("appearance", "light").commit()
        val writes = mutableListOf<String>()
        val state = SharedPreferencesPersistence(Recording(context, writes)).load()
        assertEquals("white", state.choice)
        assertEquals(listOf("app.template commit", "app.appearance clear apply"), writes)
        assertNull(prefs("app.appearance").getString("appearance", null))
        assertEquals("white", prefs("app.template").getString("choice", null))
    }

    /** A context whose preference files write down how each edit is saved (commit or apply) and whether it clears. */
    private class Recording(base: Context, private val writes: MutableList<String>) : ContextWrapper(base) {
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
            Prefs(name, super.getSharedPreferences(name, mode), writes)

        private class Prefs(val name: String, val real: SharedPreferences, val writes: MutableList<String>) : SharedPreferences by real {
            override fun edit(): SharedPreferences.Editor = Editor(name, real.edit(), writes)
        }

        private class Editor(val name: String, val real: SharedPreferences.Editor, val writes: MutableList<String>) : SharedPreferences.Editor {
            private var cleared = false

            private fun saved(how: String) {
                writes += if (cleared) "$name clear $how" else "$name $how"
            }

            private fun then(change: () -> Unit): SharedPreferences.Editor {
                change()
                return this
            }

            override fun putString(key: String?, value: String?) = then { real.putString(key, value) }
            override fun putStringSet(key: String?, values: MutableSet<String>?) = then { real.putStringSet(key, values) }
            override fun putInt(key: String?, value: Int) = then { real.putInt(key, value) }
            override fun putLong(key: String?, value: Long) = then { real.putLong(key, value) }
            override fun putFloat(key: String?, value: Float) = then { real.putFloat(key, value) }
            override fun putBoolean(key: String?, value: Boolean) = then { real.putBoolean(key, value) }
            override fun remove(key: String?) = then { real.remove(key) }
            override fun clear() = then {
                cleared = true
                real.clear()
            }
            override fun commit(): Boolean = real.commit().also { saved("commit") }
            override fun apply() {
                real.apply()
                saved("apply")
            }
        }
    }

    @Test
    fun `dark and system migrate to default`() {
        for (older in listOf("dark", "system")) {
            prefs("app.template").edit().clear().commit()
            prefs("app.appearance").edit().putString("appearance", older).commit()
            val state = restart().state.value
            assertEquals(older, TemplateState(choice = "default"), state)
            assertFalse(prefs("app.appearance").contains("appearance"))
        }
    }

    @Test
    fun `a malformed stored choice reads as default`() {
        prefs("app.template").edit().putString("choice", "Not An Id").commit()
        assertEquals("default", restart().state.value.choice)
    }

    @Test
    fun `a choice the build does not ship stays stored and draws the default`() {
        TemplateStore.get(context).update { it.copy(choice = "sepia") }
        val store = restart()
        assertEquals("sepia", store.state.value.choice)
        assertEquals("neon", store.effective.value)
    }
}
