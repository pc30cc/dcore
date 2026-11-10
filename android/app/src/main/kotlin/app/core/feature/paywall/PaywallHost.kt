package app.core.feature.paywall

import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import app.core.AppGraph
import app.core.LocalAppGraph
import app.core.brand.AppBrand
import app.core.billing.PurchaseStep
import app.core.model.Config
import app.core.ui.components.AppBottomSheet

/**
 * Provides [LocalPaywall] to [content] and draws what it opens: the paywall
 * full screen, a packs sheet over the screen. One at a time; each has its own
 * view model, cleared when it closes.
 */
@Composable
fun PaywallHost(config: Config?, content: @Composable () -> Unit) {
    val graph = LocalAppGraph.current
    CompositionLocalProvider(LocalPaywall provides graph.paywall) {
        content()
        val request by graph.paywall.request.collectAsStateWithLifecycle()
        request?.let { open -> OpenPaywall(graph, open, config) }
    }
}

/** A view model store per open paywall, so a new one starts from its own catalogue read and clears on close. */
private class PaywallScope : ViewModelStoreOwner {
    override val viewModelStore = ViewModelStore()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OpenPaywall(graph: AppGraph, request: PaywallRequest, config: Config?) {
    val owner = remember(request) { PaywallScope() }
    androidx.compose.runtime.DisposableEffect(owner) { onDispose { owner.viewModelStore.clear() } }
    val activity = LocalActivity.current as? ComponentActivity
    val uri = LocalUriHandler.current
    CompositionLocalProvider(LocalViewModelStoreOwner provides owner) {
        val vm: StoreViewModel = viewModel { StoreViewModel(graph.purchases, graph.entitlements, request) }
        val state by vm.state.collectAsStateWithLifecycle(lifecycleOwner = LocalLifecycleOwner.current)
        // Back in front (the store's page, another app): the store's list may have caught up.
        LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.resumed() }
        val dismiss = {
            vm.stepShown()
            graph.paywall.close()
        }
        val actions = remember(vm, request) {
            object : StoreActions {
                override fun close() = dismiss()
                override fun selectPlan(plan: String) = vm.selectPlan(plan)
                override fun select(key: String) = vm.select(key)
                override fun selectItem(item: app.core.model.WalletItem) = vm.selectItem(item)
                override fun selectPack(key: String) = vm.selectPack(key)
                override fun buy(key: String) {
                    activity?.let { vm.buy(it, key) }
                }
                override fun restore() = vm.restore()
                override fun retry() = vm.load()
                override fun checkAgain() = vm.checkAgain()
                override fun stepShown() = vm.stepShown()
                override fun manage() {
                    activity?.let { graph.store.info.openSubscriptions(it, vm.currentProductId(), state.entitlements?.manageUrl) }
                }
                override fun openLink(url: String) {
                    runCatching { uri.openUri(url) }
                }
                override fun installStore() {
                    activity?.let { graph.store.info.openStoreInstall(it) }
                }
                override fun openStore() {
                    activity?.let { graph.store.info.openAppPage(it) }
                }
            }
        }
        val links = PaywallLinks(
            termsUrl = config?.legal?.termsUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.termsUrl,
            privacyUrl = config?.legal?.privacyUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.privacyUrl,
        )
        // Back and outside taps close, except while the store's sheet or the server is still answering.
        val dismissable = state.step !is PurchaseStep.InStore && state.step !is PurchaseStep.Verifying
        when (request) {
            is PaywallRequest.Plans -> Dialog(
                onDismissRequest = { if (dismissable) dismiss() },
                properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
            ) {
                // The dialog's own window: its bar icons follow the template, whatever the activity started in.
                app.core.ui.theme.DialogBarIcons()
                PaywallScreen(
                    state = state,
                    entry = request.entry,
                    store = graph.purchases.store,
                    planNames = config?.planNames.orEmpty(),
                    links = links,
                    actions = actions,
                    likes = request.likes,
                )
            }
            is PaywallRequest.Packs -> {
                val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
                AppBottomSheet(onDismissRequest = { if (dismissable) dismiss() }, sheetState = sheet) {
                    PacksContent(state = state, actions = actions)
                }
            }
        }
    }
}
