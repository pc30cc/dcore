package app.core.feature.onboarding

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.brand.AppBrand
import app.core.i18n.brandString
import app.core.i18n.screenLanguage
import app.core.model.City
import app.core.ui.components.AppBottomSheet
import app.core.ui.components.AppSwitch
import app.core.ui.components.AppTextField
import app.core.ui.components.HelperLine
import app.core.ui.components.PrimaryButton
import app.core.ui.components.SecondaryButton
import app.core.ui.components.SheetBody
import app.core.ui.components.TextAction
import app.core.ui.components.TextActionKind
import app.core.ui.components.templateCard
import app.core.ui.theme.AppTheme
import kotlinx.coroutines.launch

// MARK: - Location

/**
 * The approximate area: the title, the one line on what others see, and two
 * buttons: the phone's coarse position (the system asks first), or a city
 * from the list. The list opens on its own when the phone cannot tell or
 * the permission is refused. Once the area is kept, the step is passed; on
 * the step again with an area kept (back from a later step, or a step write
 * that failed), «ادامه» passes it without asking for the area again.
 */
@Composable
fun LocationStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var picking by rememberSaveable { mutableStateOf(false) }

    val locate: () -> Unit = {
        model.locating()
        scope.launch {
            val fix = CoarseLocation.current(context.applicationContext)
            if (fix == null) model.locationUnavailable() else model.located(fix.lat, fix.lng, fix.accuracyM, fix.fromGps)
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) locate() else picking = true
    }
    val phase = state.location
    LaunchedEffect(phase) { if (phase == LocationPhase.Unavailable) picking = true }
    OnboardingPage(
        chrome = chrome,
        title = brandString(R.string.onboarding_location_title),
        subtitle = brandString(R.string.onboarding_location_body),
        error = if (picking) null else stepErrorText(state.error),
        actions = {
            if (phase is LocationPhase.Set) {
                PrimaryButton(brandString(R.string.onboarding_continue), model::submitLocation, loading = state.busy)
            } else {
                PrimaryButton(
                    brandString(R.string.onboarding_location_use),
                    onClick = { if (CoarseLocation.permitted(context)) locate() else permission.launch(Manifest.permission.ACCESS_COARSE_LOCATION) },
                    loading = phase == LocationPhase.Locating || (phase == LocationPhase.Saving && !picking),
                )
            }
            Gap(OnboardingLayout.buttonGap)
            SecondaryButton(
                brandString(R.string.onboarding_location_by_city),
                onClick = {
                    model.cityQueryChanged("")
                    picking = true
                },
                enabled = !state.busy,
            )
        },
    ) { }
    if (picking) CitySheet(state, model, unavailable = phase == LocationPhase.Unavailable, onDismiss = { picking = false })
}

/** «کدوم شهر؟»: a search field and the cities it finds, one row each (the country only when they span several); a tap keeps that city. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CitySheet(state: OnboardingUiState, model: OnboardingViewModel, unavailable: Boolean, onDismiss: () -> Unit) {
    val t = AppTheme.template
    AppBottomSheet(onDismissRequest = onDismiss) {
        SheetBody(
            title = brandString(R.string.onboarding_location_city_title),
            body = if (unavailable) brandString(R.string.onboarding_location_unavailable) else null,
        ) {
            AppTextField(
                value = state.cityQuery,
                onValueChange = model::cityQueryChanged,
                placeholder = brandString(R.string.onboarding_location_city_label),
                clearable = true,
            )
            val error = stepErrorText(state.error)
            when {
                error != null -> HelperLine(error, Modifier.padding(top = CityLayout.lineTop), error = true)
                state.cityQuery.trim().length >= 2 && !state.citySearching && state.cityResults.isEmpty() ->
                    HelperLine(brandString(R.string.onboarding_location_no_city), Modifier.padding(top = CityLayout.lineTop))
            }
            // The country only tells cities apart when the results span more than one.
            val countries = state.cityResults.mapNotNull { it.country?.takeIf(String::isNotBlank) }.distinct().size > 1
            Column(Modifier.padding(top = CityLayout.listTop)) {
                state.cityResults.forEachIndexed { index, city ->
                    CityRow(city, showCountry = countries, enabled = !state.busy, Modifier.topHairline(index > 0)) { model.cityPicked(city) }
                }
            }
        }
    }
}

@Composable
private fun CityRow(city: City, showCountry: Boolean, enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val t = AppTheme.template
    Row(
        modifier.fillMaxWidth().heightIn(min = CityLayout.row).clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(CityLayout.rowGap),
    ) {
        Text(city.name, style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.weight(1f))
        if (showCountry) displayCountry(city.country)?.let { Text(it, style = t.type.bodySm, color = t.colors.text3, maxLines = 1) }
    }
}

private object CityLayout {
    val lineTop = 8.dp
    val listTop = 8.dp
    val row = 52.dp
    val rowGap = 12.dp
}

@Composable
private fun displayCountry(iso: String?): String? {
    if (iso.isNullOrBlank()) return null
    val language = screenLanguage()
    return java.util.Locale.Builder().setRegion(iso).build().getDisplayCountry(java.util.Locale.forLanguageTag(language.tag)).ifBlank { null }
}

// MARK: - Notifications

/**
 * Android 13+: two switches in a group (on), then «روشن کن» (what is
 * switched off is saved, then the system asks) or «حالا نه». Passed
 * either way; Settings can change it later.
 */
@Composable
fun NotificationsStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val t = AppTheme.template
    var matches by rememberSaveable { mutableStateOf(true) }
    var messages by rememberSaveable { mutableStateOf(true) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { model.submitNotifications() }
    OnboardingPage(
        chrome = chrome,
        title = brandString(R.string.onboarding_notifications_title),
        error = stepErrorText(state.error),
        actions = {
            PrimaryButton(
                brandString(R.string.onboarding_notifications_allow),
                onClick = {
                    model.turnOnNotifications(matches, messages) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) permission.launch(Manifest.permission.POST_NOTIFICATIONS) else model.submitNotifications()
                    }
                },
                enabled = matches || messages,
                loading = state.busy,
            )
            Gap(NotificationLayout.laterTop)
            TextAction(brandString(R.string.action_not_now), model::submitNotifications, kind = TextActionKind.Neutral, enabled = !state.busy)
        },
    ) {
        Gap(OnboardingLayout.groupTop)
        val shape = RoundedCornerShape(t.radii.card)
        Column(Modifier.fillMaxWidth().templateCard(shape).padding(horizontal = NotificationLayout.groupPad)) {
            SwitchRow(brandString(R.string.onboarding_notifications_matches), matches) { matches = it }
            SwitchRow(brandString(R.string.onboarding_notifications_messages), messages, Modifier.topHairline()) { messages = it }
        }
    }
}

/** A 64 dp row: the label, the switch at the end; the whole row toggles. */
@Composable
private fun SwitchRow(label: String, checked: Boolean, modifier: Modifier = Modifier, onChange: (Boolean) -> Unit) {
    val t = AppTheme.template
    Row(
        modifier.fillMaxWidth().heightIn(min = NotificationLayout.row).toggleable(value = checked, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.weight(1f))
        AppSwitch(checked, onCheckedChange = null)
    }
}

private object NotificationLayout {
    val groupPad = 16.dp
    val row = 64.dp
    val laterTop = 8.dp
}

// MARK: - Community guidelines

/** The five rules, each a short title and one line, split by hairlines; «قبول دارم» finishes sign-up; the full text a tap away. */
@Composable
fun GuidelinesStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val t = AppTheme.template
    val uri = LocalUriHandler.current
    val url = state.config?.legal?.guidelinesUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.guidelinesUrl
    OnboardingPage(
        chrome = chrome,
        title = brandString(R.string.onboarding_rules_title),
        error = stepErrorText(state.error),
        actions = {
            PrimaryButton(brandString(R.string.onboarding_rules_agree), model::acceptGuidelines, loading = state.busy || state.finishing)
            if (url.isNotBlank()) {
                Gap(RuleLayout.fullTop)
                TextAction(brandString(R.string.onboarding_rules_read_full), { uri.openUri(url) }, kind = TextActionKind.Neutral, style = t.type.legalLink)
            }
        },
    ) {
        Gap(OnboardingLayout.rulesTop)
        RULES.forEachIndexed { index, (title, body) ->
            Column(Modifier.fillMaxWidth().topHairline(index > 0).padding(vertical = RuleLayout.padY)) {
                Text(brandString(title), style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.semantics { heading() })
                Text(brandString(body), style = t.type.bodySm, color = t.colors.text2, modifier = Modifier.padding(top = RuleLayout.bodyTop))
            }
        }
    }
}

private val RULES = listOf(
    R.string.onboarding_rule_real_title to R.string.onboarding_rule_real,
    R.string.onboarding_rule_kind_title to R.string.onboarding_rule_kind,
    R.string.onboarding_rule_consent_title to R.string.onboarding_rule_consent,
    R.string.onboarding_rule_safe_title to R.string.onboarding_rule_safe,
    R.string.onboarding_rule_adults_title to R.string.onboarding_rule_adults,
)

private object RuleLayout {
    val padY = 13.dp
    val bodyTop = 2.dp
    val fullTop = 6.dp
}
