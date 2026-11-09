package app.core.feature.paywall

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.LocalAppGraph
import app.core.R
import app.core.billing.storePlan
import app.core.feature.auth.screenLanguage
import app.core.feature.onboarding.formatDate
import app.core.i18n.brandString
import app.core.model.Entitlements
import app.core.store.Store
import app.core.ui.theme.Radius
import app.core.ui.theme.Space
import kotlinx.coroutines.launch
import java.time.ZoneId

/**
 * On a restricted (suspended or banned) account's screen: restoring
 * purchases, always (a purchase the server never received must still reach
 * it), and, for a plan from this build's store, the plan, whether it renews
 * and the store's own page to cancel it. The server answers both reads for
 * restricted sessions.
 */
@Composable
fun SubscriptionNotice(modifier: Modifier = Modifier) {
    val graph = LocalAppGraph.current
    val activity = LocalActivity.current
    val scope = rememberCoroutineScope()
    val config by graph.config.config.collectAsStateWithLifecycle()
    val entitlements by graph.entitlements.entitlements.collectAsStateWithLifecycle()
    LaunchedEffect(graph) { graph.entitlements.ensure() }
    var restoring by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<RestoreNotice?>(null) }
    SubscriptionNoticeContent(
        entitlements = entitlements,
        store = graph.purchases.store,
        planNames = config?.planNames.orEmpty(),
        restoring = restoring,
        notice = notice,
        onManage = { manageUrl -> activity?.let { graph.store.info.openSubscriptions(it, null, manageUrl) } },
        onRestore = {
            restoring = true
            notice = null
            scope.launch {
                notice = graph.purchases.restore(manual = true).notice()
                restoring = false
            }
        },
        modifier = modifier,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SubscriptionNoticeContent(
    entitlements: Entitlements?,
    store: Store,
    planNames: Map<String, String>,
    restoring: Boolean,
    notice: RestoreNotice?,
    onManage: (manageUrl: String?) -> Unit,
    onRestore: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val storeName = brandString(R.string.store_name)
    val plan = entitlements?.takeIf { it.storePlan(store) }
    Surface(modifier.fillMaxWidth(), shape = RoundedCornerShape(Radius.lg), color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(Space.lg), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text(
                brandString(if (plan != null) R.string.restricted_subscription_title else R.string.restricted_purchases_title),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                if (plan != null) subscriptionBody(plan, planNames, storeName) else brandString(R.string.restricted_purchases_body, storeName),
                style = MaterialTheme.typography.bodyMedium,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                if (plan != null) {
                    OutlinedButton(onClick = { onManage(plan.manageUrl) }, modifier = Modifier.heightIn(min = Space.minTouch)) {
                        Text(brandString(R.string.paywall_manage))
                    }
                }
                TextButton(onClick = onRestore, enabled = !restoring, modifier = Modifier.heightIn(min = Space.minTouch)) {
                    Text(brandString(if (restoring) R.string.paywall_restoring else R.string.paywall_restore))
                }
            }
            notice?.let {
                Text(
                    brandString(it.message(), storeName),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
        }
    }
}

/** It renews (and where to cancel it), it ends on a date, or neither is known. */
@Composable
private fun subscriptionBody(e: Entitlements, planNames: Map<String, String>, storeName: String): String {
    val name = planName(e.plan, planNames)
    val language = screenLanguage()
    val date = e.planExpiresAt?.let { formatDate(it.atZone(ZoneId.systemDefault()).toLocalDate(), language) }
    return when {
        e.autoRenew == true -> brandString(R.string.restricted_subscription_body, name, storeName)
        date != null -> brandString(R.string.restricted_subscription_body_ends, name, date)
        else -> brandString(R.string.restricted_subscription_body_plain, name, storeName)
    }
}
