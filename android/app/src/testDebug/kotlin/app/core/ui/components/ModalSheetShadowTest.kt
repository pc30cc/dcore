package app.core.ui.components

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogWindowProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowWindowManagerImpl
import kotlin.math.abs

/**
 * The modal sheet's own shadow (`--sheet-shadow`) is cast where the sheet
 * is, over its top edge: the scrim above it is one even colour, with no
 * sheet-sized shadow left at the top of the screen.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xhdpi")
class ModalSheetShadowTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @OptIn(ExperimentalMaterial3Api::class)
    @Test
    fun `a sheet's shadow falls over its top edge, never at the top of the screen`() {
        compose.setContent {
            AppTheme(template = Templates.of(Templates.WHITE)) {
                Box(Modifier.fillMaxSize().background(AppTheme.template.colors.bg))
                AppBottomSheet(onDismissRequest = {}) { Box(Modifier.fillMaxWidth().height(SHEET)) }
            }
        }
        compose.waitForIdle()
        val window = sheetWindow()
        val w = window.width
        // The top of the screen and a point just above the reach of the sheet's shadow: the same scrim.
        val top = window.getPixel(w / 2, w / 20)
        val sheetTop = window.height - (SHEET.value * DENSITY).toInt()
        val above = window.getPixel(w / 2, sheetTop - (SHADOW_REACH * DENSITY).toInt())
        assertTrue("the scrim at the top ${Integer.toHexString(top)} differs from the scrim above the sheet ${Integer.toHexString(above)}", close(top, above))
    }

    private fun close(a: Int, b: Int): Boolean =
        abs(android.graphics.Color.red(a) - android.graphics.Color.red(b)) <= 2 &&
            abs(android.graphics.Color.green(a) - android.graphics.Color.green(b)) <= 2 &&
            abs(android.graphics.Color.blue(a) - android.graphics.Color.blue(b)) <= 2 &&
            abs(android.graphics.Color.alpha(a) - android.graphics.Color.alpha(b)) <= 2

    private fun sheetWindow(): Bitmap {
        val views = Shadow.extract<ShadowWindowManagerImpl>(compose.activity.windowManager).views
        val window = views.firstNotNullOf { provider(it)?.window }
        val decor = window.decorView
        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        var result = -1
        PixelCopy.request(window, bitmap, { result = it }, Handler(Looper.getMainLooper()))
        shadowOf(Looper.getMainLooper()).idle()
        check(result == PixelCopy.SUCCESS) { "copying the sheet's window failed: $result" }
        return bitmap
    }

    private fun provider(view: View): DialogWindowProvider? = when (view) {
        is DialogWindowProvider -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { provider(view.getChildAt(it)) }
        else -> null
    }

    private companion object {
        val SHEET = 300.dp
        const val DENSITY = 2f
        /** Further than any template's sheet shadow reaches above the sheet (48 dp blur, 20 dp up). */
        const val SHADOW_REACH = 120f
    }
}
