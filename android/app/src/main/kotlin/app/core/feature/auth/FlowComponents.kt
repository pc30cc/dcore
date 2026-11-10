package app.core.feature.auth

/**
 * The language the screen is drawn in (the configuration's locale, which the
 * app sets from the person's choice): what digits, calendars and number
 * formats follow.
 */
@androidx.compose.runtime.Composable
@androidx.compose.runtime.ReadOnlyComposable
fun screenLanguage(): app.core.i18n.AppLanguage =
    app.core.i18n.AppLanguage.fromTag(androidx.compose.ui.platform.LocalConfiguration.current.locales[0]?.toLanguageTag()) ?: app.core.i18n.AppLanguage.EN

/** A plural resource with `{appName}` filled in, like `brandString`. */
@androidx.compose.runtime.Composable
fun brandPlural(@androidx.annotation.PluralsRes id: Int, count: Int, vararg formatArgs: Any): String =
    app.core.i18n.brandText(androidx.compose.ui.res.pluralStringResource(id, count, *formatArgs), app.core.i18n.LocalAppName.current)
