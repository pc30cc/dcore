package app.core.ui.theme

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import app.core.i18n.AppLanguage
import app.core.template.TemplateStore
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue

/** True when the system's "remove animations" is on: motion is then cut to short fades or nothing. */
val LocalReducedMotion = staticCompositionLocalOf { false }

/**
 * Whether glass may blur what is behind it: Android 12+ (RenderEffect), and
 * not while battery saver is on. When false, every glass layer draws its
 * fixed fallback colour instead; it looks the same, only flatter.
 */
val LocalGlass = compositionLocalOf { false }

/** The template the app draws now: the effective one ([TemplateStore]), following every change at once. */
@Composable
fun currentTemplate(): AppTemplate {
    val context = LocalContext.current
    val id by remember(context) { TemplateStore.get(context).effective }.collectAsState()
    return remember(id) { Templates.of(id) }
}

/**
 * The app's theme: the visual [template] (its tokens through
 * [AppTheme.template], Material 3's scheme, type and shapes derived from
 * them), Persian type when the app speaks Persian, and whether glass may
 * blur ([LocalGlass], never when the template's glass switch is off).
 *
 * The layout direction is not set here: it comes from the configuration's
 * locale (`AppLocales.wrap`), so Persian is right to left in Compose and in
 * everything the platform draws alike.
 *
 * No Material You wallpaper colours: the colour belongs to the template.
 */
@Composable
fun AppTheme(
    template: AppTemplate = currentTemplate(),
    content: @Composable () -> Unit,
) {
    val locale = LocalConfiguration.current.locales[0]
    val persian = AppLanguage.fromTag(locale?.toLanguageTag()) == AppLanguage.FA
    val scripted = remember(template, persian) { template.inScript(persian) }
    val scheme = remember(template) { templateColorScheme(template) }
    val typography = remember(scripted) { templateTypography(scripted) }
    val shapes = remember(template) { templateShapes(template) }
    val context = LocalContext.current
    val reducedMotion = remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    val glass = rememberGlassAvailable(context) && template.switches.glass
    CompositionLocalProvider(
        LocalAppTemplate provides scripted,
        LocalReducedMotion provides reducedMotion,
        LocalGlass provides glass,
    ) {
        MaterialTheme(colorScheme = scheme, typography = typography, shapes = shapes, content = content)
    }
}

/** Android 12+ and battery saver off, following battery saver as it changes. */
@Composable
private fun rememberGlassAvailable(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
    val power = remember(context) { context.getSystemService(PowerManager::class.java) }
    var saving by remember(context) { mutableStateOf(power?.isPowerSaveMode == true) }
    DisposableEffect(context) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                saving = power?.isPowerSaveMode == true
            }
        }
        ContextCompat.registerReceiver(
            context,
            receiver,
            IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        onDispose { runCatching { context.unregisterReceiver(receiver) } }
    }
    return !saving
}

/** The template drawn and whether glass blurs, read like `MaterialTheme.colorScheme`. */
object AppTheme {
    /**
     * The template being drawn: its id, switches and every token, its type
     * already in the screen's script. Screens read colours, paints, type,
     * radii and sizes from here and branch on `template.switches` where the
     * structure differs.
     */
    val template: AppTemplate
        @Composable @ReadOnlyComposable get() = LocalAppTemplate.current

    /** Whether glass blurs here ([LocalGlass]). */
    val glass: Boolean
        @Composable @ReadOnlyComposable get() = LocalGlass.current
}
