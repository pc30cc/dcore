package app.core.i18n

import android.content.Context
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.res.stringResource
import app.core.brand.AppBrand

/** The placeholder every string uses for the product's name. */
const val APP_NAME_PLACEHOLDER: String = "{appName}"

/**
 * [text] with `{appName}` replaced by [appName].
 *
 * The strings never carry a brand name: they say `{appName}` and the name is
 * put in here, so the same translations serve every brand and a rename is a
 * build (or, once `GET /config` carries it, not even that).
 */
fun brandText(text: String, appName: String = AppBrand.appName): String =
    text.replace(APP_NAME_PLACEHOLDER, appName)

/**
 * The name `{appName}` stands for, for the whole UI. The build's default
 * until the server's configuration provides one.
 */
val LocalAppName = staticCompositionLocalOf { AppBrand.appName }

/** [stringResource] with `{appName}` filled in. */
@Composable
@ReadOnlyComposable
fun brandString(@StringRes id: Int, vararg formatArgs: Any): String =
    brandText(stringResource(id, *formatArgs), LocalAppName.current)

/** The same outside composition (notifications, toasts). */
fun Context.brandString(@StringRes id: Int, vararg formatArgs: Any): String =
    brandText(getString(id, *formatArgs))
