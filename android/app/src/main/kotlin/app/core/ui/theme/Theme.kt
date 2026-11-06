package app.core.ui.theme

import android.provider.Settings
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import app.core.i18n.AppLanguage

/** True when the system's "remove animations" is on: motion is then cut to fades or nothing. */
val LocalReducedMotion = staticCompositionLocalOf { false }

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(Radius.sm),
    small = RoundedCornerShape(Radius.md),
    medium = RoundedCornerShape(Radius.lg),
    large = RoundedCornerShape(Radius.card),
    extraLarge = RoundedCornerShape(Radius.card),
)

/**
 * The app's theme: Material 3 from the design tokens and the brand's colours,
 * light and dark, Persian typography when the
 * app speaks Persian.
 *
 * The layout direction is not set here: it comes from the configuration's
 * locale (`AppLocales.wrap`), so Persian is right to left in Compose and in
 * everything the platform draws (dialogs, the keyboard, notifications) alike.
 *
 * No Material You wallpaper colours: the colour belongs to the brand.
 */
@Composable
fun AppTheme(
    dark: Boolean = isSystemInDarkTheme(),
    brand: BrandColors = BrandColors.Build,
    content: @Composable () -> Unit,
) {
    val locale = LocalConfiguration.current.locales[0]
    val persian = AppLanguage.fromTag(locale?.toLanguageTag()) == AppLanguage.FA
    val scheme = remember(dark, brand) { appColorScheme(dark, brand) }
    val typography = remember(persian) { appTypography(persian) }
    val context = LocalContext.current
    val reducedMotion = remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    CompositionLocalProvider(
        LocalSemanticColors provides if (dark) DarkSemantic else LightSemantic,
        LocalReducedMotion provides reducedMotion,
    ) {
        MaterialTheme(colorScheme = scheme, typography = typography, shapes = AppShapes, content = content)
    }
}

/** The colours Material has no role for, read like `MaterialTheme.colorScheme`. */
object AppTheme {
    val colors: SemanticColors
        @Composable @ReadOnlyComposable get() = LocalSemanticColors.current
}
