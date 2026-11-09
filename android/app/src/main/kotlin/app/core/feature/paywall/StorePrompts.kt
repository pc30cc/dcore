package app.core.feature.paywall

import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.BuildConfig
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.auth.Root
import app.core.feature.call.CallPhase
import app.core.i18n.brandString
import app.core.model.Config
import app.core.net.Backend
import app.core.net.internetAvailability
import app.core.store.Store
import app.core.store.UpdateCheck
import app.core.store.UpdateMode
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.launch

/**
 * The store's part of the app's life, once an account is in:
 * - purchases: the store's updates and a resend whenever the network comes
 *   back (once per process), and at each return to the front a quiet restore
 *   of what the server does not know (usually no request) and Play's own
 *   messages (a declined renewal; once fixed there, the subscriptions are sent
 *   again, and a plan that comes back is said);
 * - in the tabs only, at a return to the front: a rating when its pacing
 *   allows (Play's sheet straight away, Bazaar's screen behind a small prompt),
 *   a recommended update at most every three days (Play's flexible update,
 *   else the store's page), and "restart" once a flexible update downloaded.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@Composable
fun StorePrompts(root: Root, config: Config?, modifier: Modifier = Modifier) {
    val graph = LocalAppGraph.current
    val context = LocalContext.current
    val activity = LocalActivity.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val updateLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) {}
    val signedIn = root == Root.Main || root == Root.Restricted
    val storeName = brandString(R.string.store_name)
    val ratePrompt = brandString(R.string.rating_prompt, storeName)
    val rateAction = brandString(R.string.rating_prompt_action)
    val updateText = brandString(R.string.update_available)
    val updateAction = brandString(R.string.update_available_action)
    val downloadedText = brandString(R.string.update_downloaded)
    val restartAction = brandString(R.string.update_downloaded_action)
    val backText = brandString(R.string.paywall_subscription_back)

    LaunchedEffect(graph) { graph.purchases.start(context.internetAvailability()) }

    // A re-sync the store asked for says something only when it brought a plan back.
    LaunchedEffect(graph) { graph.purchases.subscriptionBack.collect { snackbar.showSnackbar(backText) } }

    // A call that lasted counts toward the rating's pacing.
    LaunchedEffect(graph) {
        var liveSince: Long? = null
        graph.calls.controller.session.flatMapLatest { it?.phase ?: emptyFlow() }.collect { phase ->
            when (phase) {
                is CallPhase.Live -> liveSince = liveSince ?: phase.since.toEpochMilli()
                is CallPhase.Ended -> liveSince?.let { since ->
                    liveSince = null
                    graph.ratingPacing.noteCall((graph.clock.nowMillis() - since) / 1000)
                }
                else -> Unit
            }
        }
    }

    val downloaded by graph.store.updates.downloaded.collectAsStateWithLifecycle()
    LaunchedEffect(downloaded) {
        if (!downloaded) return@LaunchedEffect
        if (snackbar.showSnackbar(downloadedText, restartAction, duration = SnackbarDuration.Indefinite) == SnackbarResult.ActionPerformed) {
            graph.store.updates.completeFlexible()
        }
    }

    LifecycleResumeEffect(signedIn, root) {
        val job = if (!signedIn) {
            null
        } else {
            scope.launch {
                activity?.let(graph.billing::showStoreMessages)
                graph.purchases.signedIn()
                val host = activity ?: return@launch
                // The sample backend (debug screenshots and tests) never prompts: its pictures stay the screens'.
                if (root != Root.Main || Backend.isSample(context)) return@launch
                val recommended = config?.minVersion?.recommended ?: 0
                if (BuildConfig.VERSION_CODE < recommended && graph.updatePacing.due()) {
                    graph.updatePacing.asked()
                    val check = graph.store.updates.check()
                    val started = check is UpdateCheck.Available && check.flexibleAllowed &&
                        graph.store.updates.start(host, updateLauncher, check, UpdateMode.FLEXIBLE)
                    if (!started && snackbar.showSnackbar(updateText, updateAction, withDismissAction = true) == SnackbarResult.ActionPerformed) {
                        graph.store.info.openAppPage(host)
                    }
                    return@launch
                }
                if (graph.ratingPacing.due()) {
                    graph.ratingPacing.asked()
                    when (graph.store.info.store) {
                        // Play forbids a question before its sheet; the sheet may show nothing (its quota).
                        Store.PLAY -> graph.store.rating.requestRating(host)
                        Store.BAZAAR -> if (snackbar.showSnackbar(ratePrompt, rateAction, withDismissAction = true) == SnackbarResult.ActionPerformed) {
                            graph.store.rating.requestRating(host)
                        }
                    }
                }
            }
        }
        onPauseOrDispose { job?.cancel() }
    }

    SnackbarHost(snackbar, modifier.padding(bottom = 96.dp))
}
