package app.core.feature.settings

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import app.core.BuildConfig
import app.core.LocalAppGraph
import app.core.R
import app.core.brand.AppBrand
import app.core.feature.paywall.LocalPaywall
import app.core.feature.paywall.PaywallEntry
import app.core.feature.auth.PhoneNumbers
import app.core.feature.profile.planValue
import app.core.i18n.AppLanguage
import app.core.i18n.AppLocales
import app.core.i18n.Digits
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.i18n.screenLanguage
import app.core.model.SettingsPatch
import app.core.model.UiConfig
import app.core.store.RatingOutcome
import app.core.store.UpdateCheck
import app.core.store.UpdateMode
import app.core.ui.components.AppBarTitle
import app.core.ui.components.AppDialog
import app.core.ui.components.AppSnackbar
import app.core.ui.components.PushedAppBar
import app.core.ui.components.RowEnd
import app.core.ui.components.SettingsGroup
import app.core.ui.components.SettingsRow
import app.core.ui.components.TemplatePicker
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space
import kotlinx.coroutines.launch

/** The sheet open over Settings, kept across a configuration change. */
private enum class SettingsSheet { Language, Notifications, Privacy, Account, Help, Legal, Licences }

/**
 * Settings (m18), a screen of its own over the tabs: the template picker as
 * the first group (the stored choice is checked, never the template drawn),
 * then «زبان» (with the language), «اعلان‌ها», «حریم خصوصی و ایمنی»;
 * «حساب», «اشتراک» (with the plan); «کمک و پشتیبانی», «قوانین و حریم
 * خصوصی»; «خروج از حساب» and «حذف حساب» in `--error`; the version under
 * them. Rows are 52 dp, titles only, a chevron on the rows that open
 * something; each opens a sheet (or the plans, or [onDelete]).
 */
@Composable
fun SettingsRoute(onBack: () -> Unit, onDelete: () -> Unit) {
    val graph = LocalAppGraph.current
    val model: SettingsModel = viewModel(
        factory = viewModelFactory { initializer { SettingsModel(graph.api, graph.auth, graph.clock, graph.preferences::signedInAs) } },
    )
    val state by model.state.collectAsStateWithLifecycle()
    val config by graph.config.config.collectAsStateWithLifecycle()
    val entitlements by graph.entitlements.entitlements.collectAsStateWithLifecycle()
    val templates by graph.templates.state.collectAsStateWithLifecycle()
    LaunchedEffect(graph) { graph.entitlements.ensure() }
    val paywall = LocalPaywall.current
    val activity = LocalActivity.current
    val context = LocalContext.current
    val uri = LocalUriHandler.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var sheet by rememberSaveable { mutableStateOf<SettingsSheet?>(null) }
    var confirmSignOut by rememberSaveable { mutableStateOf<Boolean?>(null) }
    val language = screenLanguage()
    // Notices are shown in the screen's language; a resource read once per event.
    val notices = rememberNotices()
    LaunchedEffect(model) {
        model.events.collect { event ->
            when (event) {
                is SettingsEvent.Notice -> snackbar.showSnackbar(notices(event.text))
                is SettingsEvent.Open -> runCatching { uri.openUri(event.url) }
                SettingsEvent.NeedsPlan -> paywall.plans(PaywallEntry.INCOGNITO)
            }
        }
    }

    val t = AppTheme.template
    Box(Modifier.fillMaxSize().background(t.colors.bg)) {
        Column(Modifier.fillMaxSize()) {
            PushedAppBar(onBack) { AppBarTitle(brandString(R.string.settings_title)) }
            Column(
                Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .navigationBarsPadding()
                    .padding(start = Space.gutter, end = Space.gutter, top = SettingsLayout.top, bottom = SettingsLayout.bottom),
                verticalArrangement = Arrangement.spacedBy(SettingsLayout.groupGap),
            ) {
                TemplatePicker(
                    choice = templates.choice,
                    offered = (templates.ui ?: UiConfig.Default).templates,
                    onChoose = graph.templates::setChoice,
                )
                SettingsGroup {
                    SettingsRow(
                        brandString(R.string.settings_language),
                        value = brandString(AppLocales.current(context).nameRes()),
                        minHeight = SettingsLayout.row,
                        onClick = { sheet = SettingsSheet.Language },
                    )
                    SettingsRow(brandString(R.string.settings_notifications), divider = true, minHeight = SettingsLayout.row, onClick = {
                        model.ensureLoaded()
                        sheet = SettingsSheet.Notifications
                    })
                    SettingsRow(brandString(R.string.settings_privacy), divider = true, minHeight = SettingsLayout.row, onClick = {
                        model.ensureLoaded()
                        sheet = SettingsSheet.Privacy
                    })
                }
                SettingsGroup {
                    SettingsRow(
                        brandString(R.string.settings_account),
                        value = state.signedInAs?.let { signInLabel(it, language) },
                        minHeight = SettingsLayout.row,
                        onClick = { sheet = SettingsSheet.Account },
                    )
                    SettingsRow(
                        brandString(R.string.me_plan),
                        value = planValue(entitlements, config?.planNames.orEmpty()),
                        divider = true,
                        minHeight = SettingsLayout.row,
                        onClick = { paywall.plans(PaywallEntry.GENERAL) },
                    )
                }
                SettingsGroup {
                    SettingsRow(brandString(R.string.settings_help), minHeight = SettingsLayout.row, onClick = { sheet = SettingsSheet.Help })
                    SettingsRow(brandString(R.string.settings_legal), divider = true, minHeight = SettingsLayout.row, onClick = { sheet = SettingsSheet.Legal })
                }
                SettingsGroup {
                    SettingsRow(brandString(R.string.action_sign_out), end = RowEnd.None, minHeight = SettingsLayout.row, onClick = { confirmSignOut = false })
                    SettingsRow(brandString(R.string.settings_delete), end = RowEnd.None, danger = true, divider = true, minHeight = SettingsLayout.row, onClick = onDelete)
                }
                Text(
                    brandString(R.string.settings_version, versionLabel(BuildConfig.VERSION_NAME, language)),
                    style = t.type.caption,
                    color = t.colors.text3,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = SettingsLayout.versionTop),
                )
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(Space.gutter)) { data -> AppSnackbar(data.visuals.message) }
    }

    val ratingUnavailable = brandString(R.string.rating_unavailable)
    val upToDate = brandString(R.string.update_up_to_date)
    val updateFailed = brandString(R.string.update_check_failed)
    // Play reports the update flow's result here; the next check shows the state.
    val updateLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) {}
    // Notifications switched on while the phone does not allow them (Android 13+): ask it too.
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val close = { sheet = null }
    when (sheet) {
        SettingsSheet.Language -> LanguageSheet(AppLocales.chosen(context), onDismiss = close) { choice ->
            sheet = null
            activity?.let { AppLocales.choose(it, choice) }
        }
        SettingsSheet.Notifications -> NotificationsSheet(state.notifications, loaded = state.loaded, onDismiss = close) { matches, messages ->
            val turningOn = matches == true || messages == true
            if (turningOn && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            model.setNotifications(matches, messages)
        }
        SettingsSheet.Privacy -> PrivacySheet(state.settings, loaded = state.loaded, incognitoIncluded = entitlements?.features?.incognito == true, onDismiss = close) { patch ->
            if (patch.incognito == true && entitlements?.features?.incognito != true) {
                paywall.plans(PaywallEntry.INCOGNITO)
            } else {
                model.setPrivacy(patch)
            }
        }
        SettingsSheet.Account -> AccountSheet(
            exporting = state.exporting,
            onDismiss = close,
            onExport = model::export,
            onSignOutEverywhere = {
                sheet = null
                confirmSignOut = true
            },
        )
        SettingsSheet.Help -> HelpSheet(
            supportEmail = config?.legal?.supportEmail?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.supportEmail,
            onDismiss = close,
            onEmail = { email ->
                val intent = Intent(Intent.ACTION_SENDTO, "mailto:$email".toUri())
                runCatching { activity?.startActivity(intent) }
            },
            onRate = {
                val host = activity
                if (host != null) {
                    scope.launch {
                        if (graph.store.rating.requestRating(host) is RatingOutcome.Unavailable) snackbar.showSnackbar(ratingUnavailable)
                    }
                }
            },
            onUpdates = {
                val host = activity
                if (host != null) {
                    scope.launch {
                        val store = graph.store
                        when (val check = store.updates.check()) {
                            UpdateCheck.UpToDate -> snackbar.showSnackbar(upToDate)
                            // Immediate only: the flexible flow's "restart to install" step is not built.
                            is UpdateCheck.Available ->
                                if (!(check.immediateAllowed && store.updates.start(host, updateLauncher, check, UpdateMode.IMMEDIATE))) {
                                    if (!store.info.openAppPage(host)) snackbar.showSnackbar(updateFailed)
                                }
                            // Cafe Bazaar: its app page is where updates are.
                            is UpdateCheck.Unsupported -> if (!store.info.openAppPage(host)) snackbar.showSnackbar(updateFailed)
                            is UpdateCheck.Failed -> snackbar.showSnackbar(updateFailed)
                        }
                    }
                }
            },
        )
        SettingsSheet.Legal -> {
            val legal = config?.legal
            LegalSheet(
                termsUrl = legal?.termsUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.termsUrl,
                privacyUrl = legal?.privacyUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.privacyUrl,
                guidelinesUrl = legal?.guidelinesUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.guidelinesUrl,
                onDismiss = close,
                onOpen = { url -> runCatching { uri.openUri(url) } },
                onLicences = { sheet = SettingsSheet.Licences },
            )
        }
        SettingsSheet.Licences -> LicencesSheet(onDismiss = close)
        null -> Unit
    }

    confirmSignOut?.let { everywhere ->
        AppDialog(
            title = brandString(if (everywhere) R.string.settings_sign_out_all_title else R.string.dialog_sign_out_title),
            body = null,
            confirm = brandString(R.string.dialog_sign_out_confirm),
            onConfirm = {
                confirmSignOut = null
                model.signOut(everywhere)
            },
            dismiss = brandString(R.string.dialog_sign_out_stay),
            onDismiss = { confirmSignOut = null },
            // Signing out loses nothing: the confirming word in the ordinary ink, red only for deleting.
            destructive = false,
        )
    }
}

/** A string resource by id, in the screen's language, for notices raised outside composition. */
@Composable
private fun rememberNotices(): (Int) -> String {
    val resources = androidx.compose.ui.platform.LocalResources.current
    val name = app.core.i18n.LocalAppName.current
    return remember(resources, name) { { id: Int -> app.core.i18n.brandText(resources.getString(id), name) } }
}

/**
 * What the account was signed in with, as the Account row shows it: a
 * number as its holder writes it at home in the screen's digits
 * («۰۹۱۲ ۳۴۵ ۶۷۸۹»), an address as it is; both kept left to right inside a
 * right-to-left line.
 */
fun signInLabel(identity: String, language: AppLanguage): String {
    val shown = if (identity.startsWith("+")) Digits.localize(PhoneNumbers.displayNational(identity), language) else identity
    return LTR_ISOLATE + shown + POP_ISOLATE
}

private const val LTR_ISOLATE = "\u2066"
private const val POP_ISOLATE = "\u2069"

/**
 * The version as the screen's language writes numbers: Persian digits with
 * «٫» between the parts in Persian («۱٫۰٫۰»), the build's own text otherwise.
 */
fun versionLabel(versionName: String, language: AppLanguage): String =
    if (language == AppLanguage.FA) Numerals.digits(versionName, language).replace('.', '٫') else versionName

@StringRes
internal fun AppLanguage.nameRes(): Int = when (this) {
    AppLanguage.EN -> R.string.language_en
    AppLanguage.FA -> R.string.language_fa
    AppLanguage.TR -> R.string.language_tr
}

/** Settings on the design's phone (dp). */
internal object SettingsLayout {
    val top = 14.dp
    val bottom = 30.dp
    val groupGap = 12.dp
    val row = 52.dp
    val versionTop = 2.dp
}
