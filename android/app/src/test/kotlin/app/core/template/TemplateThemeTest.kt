package app.core.template

import android.content.Context
import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.common.Diag
import app.core.model.Config
import app.core.model.Settings
import app.core.model.UiConfig
import app.core.ui.theme.AppTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** A pick, or a new default from the admin, recomposes what is on screen at once: no restart. */
@RunWith(AndroidJUnit4::class)
class TemplateThemeTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    @Before
    fun clean() {
        context.getSharedPreferences("app.template", Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("app.appearance", Context.MODE_PRIVATE).edit().clear().commit()
        TemplateStore.reset()
    }

    @After
    fun forget() {
        scope.cancel()
        TemplateStore.reset()
    }

    @Test
    fun `a choice and a new admin default are drawn at once, in the same activity`() {
        val store = TemplateStore.get(context)
        val controller = TemplateController(store, send = { Settings(template = it) }, signedIn = { false }, scope = scope, diag = Diag.Silent)
        val drawn = mutableListOf<String>()
        var page = Color.Unspecified
        var materialBackground = Color.Unspecified
        compose.setContent {
            AppTheme {
                val template = AppTheme.template
                val background = MaterialTheme.colorScheme.background
                SideEffect {
                    drawn += template.id
                    page = template.colors.bg
                    materialBackground = background
                }
            }
        }
        val activity = compose.activity
        compose.waitForIdle()
        assertEquals("neon", drawn.last())
        assertEquals(Color(0xFF0A090E), page)

        compose.runOnUiThread { controller.setChoice("white") }
        compose.waitForIdle()
        assertEquals("white", drawn.last())
        assertEquals(Color.White, page)
        assertEquals(Color.White, materialBackground)

        // Back to the default, then the admin makes white the default: a person on default follows.
        compose.runOnUiThread { controller.setChoice("default") }
        compose.waitForIdle()
        assertEquals("neon", drawn.last())
        compose.runOnUiThread { controller.onConfig(Config(v = 2, ui = UiConfig("white", listOf("neon", "white")))) }
        compose.waitForIdle()
        assertEquals("white", drawn.last())
        assertSame("no restart", activity, compose.activity)
    }
}
