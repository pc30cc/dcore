package app.core.ui.theme

import android.app.ActivityManager
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
import app.core.common.Diag
import app.core.i18n.AppLanguage
import app.core.template.TemplateStore
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue

/** True when the system's "remove animations" is on: motion is then cut to short fades or nothing. */
val LocalReducedMotion = staticCompositionLocalOf { false }

/**
 * Whether glass may blur what is behind it: Android 12+ (RenderEffect), not
 * while battery saver is on, not on a low-RAM phone, and only on a phone
 * that declares a media performance class of Android 12 or later or has at
 * least [GLASS_MIN_RAM_BYTES] of RAM ([glassBlurAllowed]). When false, every
 * glass layer draws its fixed fallback colour instead; it looks the same,
 * only flatter.
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

/**
 * Whether this phone may blur glass: Android 12+, battery saver off, not a
 * low-RAM phone, and a media performance class of Android 12 or later or at
 * least [GLASS_MIN_RAM_BYTES] of RAM. A live blur re-renders on every frame
 * in which what is behind it moves; on a weak GPU that alone drops frames.
 */
internal fun glassBlurAllowed(sdk: Int, powerSave: Boolean, lowRam: Boolean, performanceClass: Int, totalMemBytes: Long): Boolean =
    sdk >= Build.VERSION_CODES.S && !powerSave && !lowRam &&
        (performanceClass >= Build.VERSION_CODES.S || totalMemBytes >= GLASS_MIN_RAM_BYTES)

/** About 5 GiB: a phone sold as 6 GB reports about 5.6e9 bytes, one sold as 4 GB about 3.6e9. */
internal const val GLASS_MIN_RAM_BYTES = 5L * 1024 * 1024 * 1024

/** What the device says about itself for [glassBlurAllowed], read once. */
private data class GlassDevice(val lowRam: Boolean, val performanceClass: Int, val totalMemBytes: Long)

/** The device's glass decision has been logged in this process. */
@Volatile private var glassLogged = false

private fun glassDevice(context: Context): GlassDevice {
    val activity = context.getSystemService(ActivityManager::class.java)
    val memory = ActivityManager.MemoryInfo()
    runCatching { activity?.getMemoryInfo(memory) }
    return GlassDevice(
        lowRam = runCatching { activity?.isLowRamDevice == true }.getOrDefault(false),
        performanceClass = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Build.VERSION.MEDIA_PERFORMANCE_CLASS else 0,
        totalMemBytes = memory.totalMem,
    )
}

/** [glassBlurAllowed] for this phone, following battery saver as it changes. */
@Composable
private fun rememberGlassAvailable(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
    val device = remember(context) {
        glassDevice(context).also { d ->
            if (!glassLogged) {
                glassLogged = true
                val on = glassBlurAllowed(Build.VERSION.SDK_INT, false, d.lowRam, d.performanceClass, d.totalMemBytes)
                Diag.Android.info("Glass", "blur=$on perf=${d.performanceClass} ramMiB=${d.totalMemBytes / (1024 * 1024)} lowRam=${d.lowRam}")
            }
        }
    }
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
    return glassBlurAllowed(Build.VERSION.SDK_INT, saving, device.lowRam, device.performanceClass, device.totalMemBytes)
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
