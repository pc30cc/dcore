package app.core.feature.onboarding

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Face
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import app.core.R
import app.core.feature.auth.screenLanguage
import app.core.brand.AppBrand
import app.core.feature.auth.InlineMessage
import app.core.feature.auth.NoteCard
import app.core.feature.auth.PrimaryButton
import app.core.i18n.brandString
import app.core.ui.theme.Radius
import app.core.ui.theme.Space
import kotlinx.coroutines.launch

// MARK: - Location

/**
 * The approximate area: the phone's coarse position (the reason said first),
 * or a city picked from the list when the person prefers, the phone cannot
 * tell, or the permission was refused.
 */
@Composable
fun LocationStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val context = LocalContext.current
    val activity = LocalActivity.current
    val scope = rememberCoroutineScope()
    var byCity by rememberSaveable { mutableStateOf(false) }
    var refused by rememberSaveable { mutableStateOf(false) }

    val locate: () -> Unit = {
        model.locating()
        scope.launch {
            val fix = CoarseLocation.current(context.applicationContext)
            if (fix == null) model.locationUnavailable() else model.located(fix.lat, fix.lng, fix.accuracyM, fix.fromGps)
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            locate()
        } else {
            refused = true
            byCity = true
        }
    }
    val phase = state.location
    OnboardingFrame(
        chrome = chrome,
        title = brandString(R.string.onboarding_location_title),
        subtitle = brandString(R.string.onboarding_location_body),
        actions = {
            if (phase is LocationPhase.Set) {
                PrimaryButton(brandString(R.string.action_next), onClick = model::submitLocation, busy = state.busy)
            } else if (!byCity) {
                PrimaryButton(
                    brandString(R.string.onboarding_location_use),
                    onClick = { if (CoarseLocation.permitted(context)) locate() else permission.launch(Manifest.permission.ACCESS_COARSE_LOCATION) },
                    busy = phase == LocationPhase.Locating || phase == LocationPhase.Saving,
                    busyLabel = brandString(R.string.onboarding_location_finding),
                )
                TextButton(onClick = { byCity = true }) { Text(brandString(R.string.onboarding_location_by_city)) }
            }
        },
    ) {
        NoteCard(icon = { Icon(Icons.Filled.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.primary) }) {
            Text(brandString(R.string.onboarding_location_privacy_title), style = MaterialTheme.typography.titleSmall)
            Text(brandString(R.string.onboarding_location_privacy), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        when {
            phase is LocationPhase.Set -> {
                Surface(shape = RoundedCornerShape(Radius.lg), color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(Space.lg), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                        Icon(Icons.Filled.LocationOn, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
                        Column(Modifier.weight(1f)) {
                            Text(
                                phase.city?.name ?: displayCountry(phase.country) ?: brandString(R.string.onboarding_location_set),
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.onPrimaryContainer,
                            )
                            Text(brandString(R.string.onboarding_location_shown), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onPrimaryContainer)
                        }
                        TextButton(onClick = { byCity = true; model.cityQueryChanged("") }) { Text(brandString(R.string.action_change)) }
                    }
                }
                if (byCity) CitySearch(state, model)
            }
            byCity || phase == LocationPhase.Unavailable -> {
                if (phase == LocationPhase.Unavailable) InlineMessage(brandString(R.string.onboarding_location_unavailable), error = false)
                if (refused) {
                    InlineMessage(brandString(R.string.onboarding_location_refused), error = false)
                    val showRationale = activity != null && ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.ACCESS_COARSE_LOCATION)
                    if (!showRationale) {
                        TextButton(onClick = { openAppSettings(context) }) { Text(brandString(R.string.action_open_settings)) }
                    }
                }
                CitySearch(state, model)
                if (!refused) TextButton(onClick = { byCity = false; locate() }) { Text(brandString(R.string.onboarding_location_use)) }
            }
            else -> Unit
        }
        InlineMessage(stepErrorText(state.error))
    }
}

@Composable
private fun CitySearch(state: OnboardingUiState, model: OnboardingViewModel) {
    OutlinedTextField(
        value = state.cityQuery,
        onValueChange = model::cityQueryChanged,
        singleLine = true,
        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
        trailingIcon = { if (state.citySearching) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) },
        label = { Text(brandString(R.string.onboarding_location_city_label)) },
        modifier = Modifier.fillMaxWidth(),
    )
    if (state.cityQuery.trim().length >= 2 && !state.citySearching && state.cityResults.isEmpty() && state.error == null) {
        Text(brandString(R.string.onboarding_location_no_city), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Column {
        state.cityResults.forEach { city ->
            ListItem(
                headlineContent = { Text(city.name) },
                supportingContent = displayCountry(city.country)?.let { { Text(it) } },
                leadingContent = { Icon(Icons.Filled.LocationOn, contentDescription = null) },
                modifier = Modifier.clickable(enabled = !state.busy) { model.cityPicked(city) },
            )
        }
    }
}

@Composable
private fun displayCountry(iso: String?): String? {
    if (iso.isNullOrBlank()) return null
    val language = screenLanguage()
    return java.util.Locale.Builder().setRegion(iso).build().getDisplayCountry(java.util.Locale.forLanguageTag(language.tag)).ifBlank { null }
}

private fun openAppSettings(context: android.content.Context) {
    runCatching {
        context.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}

// MARK: - Notifications

/** Android 13+: why, then the system's question. Passed either way; settings can change it later. */
@Composable
fun NotificationsStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { model.submitNotifications() }
    OnboardingFrame(
        chrome = chrome,
        title = brandString(R.string.onboarding_notifications_title),
        subtitle = brandString(R.string.onboarding_notifications_body),
        actions = {
            PrimaryButton(
                brandString(R.string.onboarding_notifications_allow),
                onClick = {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) permission.launch(Manifest.permission.POST_NOTIFICATIONS) else model.submitNotifications()
                },
                busy = state.busy,
            )
            TextButton(onClick = model::submitNotifications, enabled = !state.busy) { Text(brandString(R.string.action_not_now)) }
        },
    ) {
        Reason(Icons.Filled.Favorite, R.string.onboarding_notifications_matches)
        Reason(Icons.Filled.Notifications, R.string.onboarding_notifications_messages)
        Reason(Icons.Filled.Lock, R.string.onboarding_notifications_private)
        InlineMessage(stepErrorText(state.error))
    }
}

@Composable
private fun Reason(icon: ImageVector, @StringRes text: Int) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(22.dp))
        }
        Text(brandString(text), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
    }
}

// MARK: - Community guidelines

/** The guidelines in short, the full text a tap away, and the agreement that finishes sign-up. */
@Composable
fun GuidelinesStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val uri = LocalUriHandler.current
    val url = state.config?.legal?.guidelinesUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.guidelinesUrl
    OnboardingFrame(
        chrome = chrome,
        title = brandString(R.string.onboarding_rules_title),
        subtitle = brandString(R.string.onboarding_rules_body),
        actions = {
            PrimaryButton(brandString(R.string.onboarding_rules_agree), onClick = model::acceptGuidelines, busy = state.busy || state.finishing)
        },
    ) {
        Rule(Icons.Filled.Face, R.string.onboarding_rule_real_title, R.string.onboarding_rule_real)
        Rule(Icons.Filled.Favorite, R.string.onboarding_rule_kind_title, R.string.onboarding_rule_kind)
        Rule(Icons.Filled.CheckCircle, R.string.onboarding_rule_consent_title, R.string.onboarding_rule_consent)
        Rule(Icons.Filled.Warning, R.string.onboarding_rule_safe_title, R.string.onboarding_rule_safe)
        Rule(Icons.Filled.Check, R.string.onboarding_rule_adults_title, R.string.onboarding_rule_adults)
        if (url.isNotBlank()) {
            OutlinedButton(onClick = { uri.openUri(url) }, shape = RoundedCornerShape(Radius.pill), modifier = Modifier.fillMaxWidth()) {
                Text(brandString(R.string.onboarding_rules_read_full))
            }
        }
        InlineMessage(stepErrorText(state.error))
    }
}

@Composable
private fun Rule(icon: ImageVector, @StringRes title: Int, @StringRes body: Int) {
    Row(Modifier.fillMaxWidth().padding(vertical = Space.xs), horizontalArrangement = Arrangement.spacedBy(Space.md)) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(22.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(brandString(title), style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
            Text(brandString(body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
