package app.core.ui.theme

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import app.core.i18n.AppLanguage
import app.core.storage.Appearance
import app.core.storage.AppearanceStore

/** True when the system's "remove animations" is on: motion is then cut to short fades or nothing. */
val LocalReducedMotion = staticCompositionLocalOf { false }

/**
 * Whether glass may blur what is behind it: Android 12+ (RenderEffect), and
 * not while battery saver is on. When false, every glass layer draws its
 * fixed fallback colour instead; it looks the same, only flatter.
 */
val LocalGlass = compositionLocalOf { false }

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(Radius.xs),
    small = RoundedCornerShape(Radius.sm),
    medium = RoundedCornerShape(Radius.md),
    large = RoundedCornerShape(Radius.xl),
    extraLarge = RoundedCornerShape(Radius.xxl),
)

/** Whether the app draws dark: the person's choice ([AppearanceStore]), dark unless they picked otherwise. */
@Composable
fun appearanceIsDark(): Boolean {
    val context = LocalContext.current
    val appearance by remember(context) { AppearanceStore.flow(context) }.collectAsState()
    return when (appearance) {
        Appearance.DARK -> true
        Appearance.LIGHT -> false
        Appearance.SYSTEM -> isSystemInDarkTheme()
    }
}

/**
 * The app's theme: Material 3 from the design tokens and the brand's
 * colours, dark (the default look) or light, Persian type when the app
 * speaks Persian, plus the app's own colours ([AppTheme.colors]), styles
 * ([AppTheme.type]) and whether glass may blur ([LocalGlass]).
 *
 * The layout direction is not set here: it comes from the configuration's
 * locale (`AppLocales.wrap`), so Persian is right to left in Compose and in
 * everything the platform draws alike.
 *
 * No Material You wallpaper colours: the colour belongs to the brand.
 */
@Composable
fun AppTheme(
    dark: Boolean = appearanceIsDark(),
    brand: BrandColors = BrandColors.Build,
    content: @Composable () -> Unit,
) {
    val locale = LocalConfiguration.current.locales[0]
    val persian = AppLanguage.fromTag(locale?.toLanguageTag()) == AppLanguage.FA
    val scheme = remember(dark, brand) { appColorScheme(dark, brand) }
    val colors = remember(dark, brand) { AppColors.of(dark, brand) }
    val typography = remember(persian) { appTypography(persian) }
    val type = remember(persian) { AppType.of(persian) }
    val context = LocalContext.current
    val reducedMotion = remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    val glass = rememberGlassAvailable(context)
    CompositionLocalProvider(
        LocalAppColors provides colors,
        LocalAppType provides type,
        LocalReducedMotion provides reducedMotion,
        LocalGlass provides glass,
    ) {
        MaterialTheme(colorScheme = scheme, typography = typography, shapes = AppShapes, content = content)
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

/** What Material has no role for, read like `MaterialTheme.colorScheme`. */
object AppTheme {
    val colors: AppColors
        @Composable @ReadOnlyComposable get() = LocalAppColors.current

    val type: AppType
        @Composable @ReadOnlyComposable get() = LocalAppType.current

    /** Whether glass blurs here ([LocalGlass]). */
    val glass: Boolean
        @Composable @ReadOnlyComposable get() = LocalGlass.current
}
