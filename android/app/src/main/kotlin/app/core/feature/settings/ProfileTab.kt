package app.core.feature.settings

import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.core.BuildConfig
import app.core.LocalAppGraph
import app.core.R
import app.core.i18n.AppLanguage
import app.core.i18n.AppLocales
import app.core.i18n.brandString
import app.core.store.BillingAvailability
import app.core.store.BillingUnavailableReason
import app.core.store.RatingOutcome
import app.core.store.Store
import app.core.store.UpdateCheck
import app.core.store.UpdateMode
import app.core.ui.components.EmptyState
import app.core.ui.theme.Space
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** This build's store's name: each store build has its own `store_name`, so neither names the other's. */
@Suppress("UnusedReceiverParameter")
@StringRes
fun Store.label(): Int = R.string.store_name

/**
 * The Profile tab: the profile itself is not built (it needs `GET/PATCH /me`);
 * below it, the settings that work today: language, rating, updates, the
 * store's payment status and the open-source licences.
 */
@Composable
fun ProfileTab() {
    val graph = LocalAppGraph.current
    val store = graph.store
    val activity = LocalActivity.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var showLanguages by rememberSaveable { mutableStateOf(false) }
    var showLicences by rememberSaveable { mutableStateOf(false) }
    var confirmSignOut by rememberSaveable { mutableStateOf(false) }
    var paymentsStatus by rememberSaveable { mutableStateOf<Int?>(null) }
    // Play reports the update flow's result here; the next check shows the state.
    val updateLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) {}

    val storeName = brandString(store.info.store.label())
    val current = AppLocales.current(context)
    val ratingUnavailable = brandString(R.string.rating_unavailable)
    val upToDate = brandString(R.string.update_up_to_date)
    val updateFailed = brandString(R.string.update_check_failed)

    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize()) {
            item {
                EmptyState(
                    icon = R.drawable.ic_tab_profile,
                    title = brandString(R.string.profile_empty_title),
                    body = brandString(R.string.profile_empty_body),
                )
            }
            item { SectionHeader(brandString(R.string.settings_plans)) }
            item { PlansSection(snackbar) }
            item { SectionHeader(brandString(R.string.settings_section)) }
            item {
                SettingsRow(brandString(R.string.settings_language), languageName(AppLocales.chosen(context), current)) {
                    showLanguages = true
                }
            }
            item {
                SettingsRow(brandString(R.string.settings_rate)) {
                    val host = activity ?: return@SettingsRow
                    scope.launch {
                        if (store.rating.requestRating(host) is RatingOutcome.Unavailable) snackbar.showSnackbar(ratingUnavailable)
                    }
                }
            }
            item {
                SettingsRow(brandString(R.string.settings_updates)) {
                    val host = activity ?: return@SettingsRow
                    scope.launch {
                        when (val check = store.updates.check()) {
                            UpdateCheck.UpToDate -> snackbar.showSnackbar(upToDate)
                            // Immediate only: the flexible flow's "restart to
                            // install" step is not built (PlayUpdates).
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
            }
            item {
                SettingsRow(
                    title = brandString(R.string.settings_payments),
                    value = brandString(paymentsStatus ?: R.string.payments_check, storeName),
                ) {
                    scope.launch { paymentsStatus = paymentsText(store.billing.connect()) }
                }
            }
            item {
                SettingsRow(brandString(R.string.settings_licences)) { showLicences = true }
            }
            item {
                SettingsRow(brandString(R.string.action_sign_out)) { confirmSignOut = true }
            }
            item {
                Text(
                    text = brandString(R.string.settings_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE, storeName),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = Space.lg),
                )
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
    }

    if (showLanguages) {
        LanguageDialog(
            chosen = AppLocales.chosen(context),
            onDismiss = { showLanguages = false },
            onChoose = { language ->
                showLanguages = false
                activity?.let { AppLocales.choose(it, language) }
            },
        )
    }
    if (showLicences) LicencesDialog(onDismiss = { showLicences = false })
    if (confirmSignOut) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text(brandString(R.string.settings_sign_out_title)) },
            text = { Text(brandString(R.string.settings_sign_out_body)) },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    confirmSignOut = false
                    scope.launch { graph.auth.signOut() }
                }) { Text(brandString(R.string.action_sign_out)) }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { confirmSignOut = false }) { Text(brandString(R.string.action_cancel)) }
            },
        )
    }
}

@StringRes
private fun paymentsText(availability: BillingAvailability): Int = when (availability) {
    BillingAvailability.Ready -> R.string.payments_ready
    is BillingAvailability.Unavailable -> when (availability.reason) {
        BillingUnavailableReason.STORE_NOT_INSTALLED -> R.string.payments_store_missing
        BillingUnavailableReason.STORE_NOT_READY -> R.string.payments_store_not_ready
        BillingUnavailableReason.NOT_SUPPORTED -> R.string.payments_not_supported
        BillingUnavailableReason.SERVICE_UNAVAILABLE -> R.string.payments_service_unavailable
        BillingUnavailableReason.ERROR -> R.string.payments_error
    }
}

@Composable
private fun languageName(chosen: AppLanguage?, current: AppLanguage): String {
    val name = brandString(current.nameRes())
    return if (chosen == null) brandString(R.string.language_default_with, name) else name
}

@StringRes
private fun AppLanguage.nameRes(): Int = when (this) {
    AppLanguage.EN -> R.string.language_en
    AppLanguage.FA -> R.string.language_fa
    AppLanguage.TR -> R.string.language_tr
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = Space.gutter, end = Space.gutter, top = Space.xl, bottom = Space.sm)
            .semantics { heading() },
    )
}

@Composable
private fun SettingsRow(title: String, value: String? = null, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = value?.let { { Text(it) } },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background),
        modifier = Modifier
            .heightIn(min = Space.minTouch)
            .clickable(role = Role.Button, onClick = onClick),
    )
}

@Composable
private fun LanguageDialog(chosen: AppLanguage?, onDismiss: () -> Unit, onChoose: (AppLanguage?) -> Unit) {
    val options: List<Pair<AppLanguage?, String>> =
        listOf<Pair<AppLanguage?, String>>(null to brandString(R.string.language_default)) +
            AppLanguage.entries.map { it to brandString(it.nameRes()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(brandString(R.string.settings_language)) },
        text = {
            Column(Modifier.selectableGroup()) {
                options.forEach { (language, name) ->
                    ListItem(
                        headlineContent = { Text(name) },
                        leadingContent = { RadioButton(selected = language == chosen, onClick = null) },
                        modifier = Modifier.selectable(selected = language == chosen, role = Role.RadioButton) { onChoose(language) },
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(brandString(R.string.action_close)) } },
    )
}

@Composable
private fun LicencesDialog(onDismiss: () -> Unit) {
    val resources = LocalResources.current
    // Each bundled font with its licence text: the brand's two fonts (the
    // build's choice, see brandFonts in build.gradle.kts; a licence that is
    // empty, a commercial font's, is not listed) and the welcome's two faces.
    val fonts = listOf(
        resources.getString(R.string.licences_font, resources.getString(R.string.brand_font_fa_name)) to R.raw.license_brand_fa,
        resources.getString(R.string.licences_font, resources.getString(R.string.brand_font_latin_name)) to R.raw.license_brand_latin,
        resources.getString(R.string.licences_instrument_serif) to R.raw.license_instrument_serif,
        resources.getString(R.string.licences_lalezar) to R.raw.license_lalezar,
    )
    val texts by produceState(initialValue = emptyList<Pair<String, String>>(), resources) {
        value = withContext(Dispatchers.IO) {
            fonts.map { (name, raw) -> name to resources.openRawResource(raw).bufferedReader().use { it.readText() } }
                .filter { (_, text) -> text.isNotBlank() }
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(brandString(R.string.settings_licences)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                texts.forEachIndexed { index, (name, text) ->
                    Text(
                        name,
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.padding(top = if (index == 0) 0.dp else Space.lg),
                    )
                    Text(text, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = Space.sm))
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(brandString(R.string.action_close)) } },
    )
}
