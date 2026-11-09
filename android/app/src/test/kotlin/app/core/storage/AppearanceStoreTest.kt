package app.core.storage

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Dark until the person picks otherwise; the pick survives a restart and is seen at once. */
@RunWith(AndroidJUnit4::class)
class AppearanceStoreTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before
    fun clean() {
        context.getSharedPreferences("app.appearance", Context.MODE_PRIVATE).edit().clear().commit()
        AppearanceStore.reset()
    }

    @After
    fun forget() = AppearanceStore.reset()

    @Test
    fun `a new install is dark`() {
        assertEquals(Appearance.DARK, Appearance.DEFAULT)
        assertEquals(Appearance.DARK, AppearanceStore.current(context))
    }

    @Test
    fun `a pick is seen at once and after a restart`() {
        val flow = AppearanceStore.flow(context)
        AppearanceStore.choose(context, Appearance.LIGHT)
        assertEquals(Appearance.LIGHT, flow.value)
        AppearanceStore.reset()
        assertEquals(Appearance.LIGHT, AppearanceStore.current(context))
        AppearanceStore.choose(context, Appearance.SYSTEM)
        AppearanceStore.reset()
        assertEquals(Appearance.SYSTEM, AppearanceStore.current(context))
    }

    @Test
    fun `an unknown stored value falls back to dark`() {
        context.getSharedPreferences("app.appearance", Context.MODE_PRIVATE).edit().putString("appearance", "sepia").commit()
        assertEquals(Appearance.DARK, AppearanceStore.current(context))
    }
}
