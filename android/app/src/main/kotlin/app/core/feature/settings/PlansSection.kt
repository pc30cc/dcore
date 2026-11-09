package app.core.feature.settings

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.foundation.clickable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.LocalAppGraph
import app.core.R
import app.core.billing.CatalogueJoin
import app.core.billing.storePlan
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.paywall.LocalPaywall
import app.core.feature.paywall.PaywallEntry
import app.core.feature.paywall.RestoreNotice
import app.core.feature.paywall.message
import app.core.feature.paywall.notice
import app.core.feature.paywall.planName
import app.core.i18n.brandString
import app.core.model.SettingsPatch
import app.core.ui.theme.Space
import kotlinx.coroutines.launch

/**
 * The profile tab's purchases: the plan (and the paywall), restoring what
 * the store holds, the store's own subscription page, and incognito, which
 * a plan includes (without it the switch opens the paywall).
 */
@Composable
fun PlansSection(snackbar: SnackbarHostState) {
    val graph = LocalAppGraph.current
    val paywall = LocalPaywall.current
    val activity = LocalActivity.current
    val scope = rememberCoroutineScope()
    val config by graph.config.config.collectAsStateWithLifecycle()
    val entitlements by graph.entitlements.entitlements.collectAsStateWithLifecycle()
    LaunchedEffect(graph) { graph.entitlements.ensure() }
    val e = entitlements
    val planNames = config?.planNames.orEmpty()
    val plan = e?.plan?.takeIf { it in CatalogueJoin.PLANS }
    val storeName = brandString(R.string.store_name)
    val notices = RestoreNotice.entries.associateWith { brandString(it.message(), storeName) }
    val incognitoFailed = brandString(R.string.settings_incognito_failed)

    // Incognito's current value is the profile's (GET /v1/me, revalidated): read once when shown.
    var incognito by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(graph) {
        incognito = runCatchingUnlessCancelled { graph.api.me().value.profile?.settings?.incognito }.getOrNull()
    }

    Column(Modifier.fillMaxWidth()) {
        Row(
            title = brandString(R.string.settings_plans),
            value = plan?.let { planName(it, planNames) } ?: brandString(R.string.settings_plan_free),
        ) { paywall.plans(PaywallEntry.GENERAL) }
        Row(brandString(R.string.paywall_restore)) {
            scope.launch {
                snackbar.showSnackbar(notices.getValue(graph.purchases.restore(manual = true).notice()))
            }
        }
        if (e?.storePlan(graph.purchases.store) == true) {
            Row(brandString(R.string.paywall_manage)) {
                activity?.let { graph.store.info.openSubscriptions(it, null, e.manageUrl) }
            }
        }
        val included = e?.features?.incognito == true
        ListItem(
            headlineContent = { Text(brandString(R.string.settings_incognito)) },
            supportingContent = { Text(brandString(R.string.settings_incognito_body)) },
            trailingContent = { Switch(checked = included && incognito == true, onCheckedChange = null) },
            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background),
            modifier = Modifier
                .heightIn(min = Space.minTouch)
                .toggleable(value = included && incognito == true, role = Role.Switch) { on ->
                    if (!included) {
                        paywall.plans(PaywallEntry.INCOGNITO)
                        return@toggleable
                    }
                    scope.launch {
                        runCatchingUnlessCancelled { graph.api.updateSettings(SettingsPatch(incognito = on)) }
                            .onSuccess { incognito = it.incognito }
                            .onFailure { snackbar.showSnackbar(incognitoFailed) }
                    }
                },
        )
    }
}

@Composable
private fun Row(title: String, value: String? = null, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = value?.let { { Text(it) } },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background),
        modifier = Modifier
            .heightIn(min = Space.minTouch)
            .clickable(role = Role.Button, onClick = onClick),
    )
}
