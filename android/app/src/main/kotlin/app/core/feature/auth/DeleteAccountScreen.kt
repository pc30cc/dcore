package app.core.feature.auth

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import app.core.LocalAppGraph
import app.core.R
import app.core.common.Clock
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.onboarding.StepError
import app.core.feature.onboarding.formatDate
import app.core.feature.settings.DataExport
import app.core.feature.settings.SettingsEvent
import app.core.i18n.brandString
import app.core.i18n.brandText
import app.core.billing.wireName
import app.core.model.DeletionPreflight
import app.core.model.StoreSubscriptionNotice
import app.core.net.ApiError
import app.core.net.ServerApi
import app.core.store.Store
import app.core.ui.components.HelperLine
import app.core.ui.components.PrimaryButton
import app.core.ui.components.SecondaryButton
import app.core.ui.components.TextAction
import app.core.ui.components.overhangingTarget
import app.core.ui.theme.AppTheme
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId

/** What the delete screen shows and does. */
data class DeleteAccountUi(
    /** What deleting does not cancel (a store subscription that renews), once read. */
    val preflight: DeletionPreflight? = null,
    val deleting: Boolean = false,
    val exporting: Boolean = false,
    val error: StepError? = null,
)

/**
 * Deleting the account in the app (`POST /v1/me/deletion`; a suspended or
 * banned account may too): the profile goes at once and everything can come
 * back by signing in until the purge, [GRACE_DAYS] later. The session ends
 * with it ([AuthGate.ended]). Before that the store subscription that keeps
 * renewing is named (`GET /v1/me/deletion/preflight`), and a copy of the data
 * can be taken ([DataExport]).
 */
class DeleteAccountModel(private val api: ServerApi, private val gate: AuthGate, private val clock: Clock) : ViewModel() {
    private val _state = MutableStateFlow(DeleteAccountUi())
    val state: StateFlow<DeleteAccountUi> = _state.asStateFlow()
    private val _events = Channel<SettingsEvent>(Channel.BUFFERED)
    val events: Flow<SettingsEvent> = _events.receiveAsFlow()
    private val dataExport = DataExport(api, clock)

    init {
        viewModelScope.launch {
            runCatchingUnlessCancelled { api.deletionPreflight() }.onSuccess { preflight -> _state.update { it.copy(preflight = preflight) } }
        }
    }

    /** The last day everything comes back by signing in. */
    fun restorableUntil(zone: ZoneId = ZoneId.systemDefault()): LocalDate = clock.now().atZone(zone).toLocalDate().plusDays(GRACE_DAYS)

    fun delete() {
        if (_state.value.deleting) return
        _state.update { it.copy(deleting = true, error = null) }
        viewModelScope.launch {
            runCatchingUnlessCancelled { api.deleteAccount() }
                .onSuccess {
                    // The server ended every session with it: back to the welcome on this phone.
                    gate.ended(null)
                }
                .onFailure { e -> _state.update { it.copy(deleting = false, error = if (e is ApiError.Network) StepError.Offline else StepError.Failed) } }
        }
    }

    fun export() {
        if (_state.value.exporting) return
        _state.update { it.copy(exporting = true) }
        viewModelScope.launch {
            val event = dataExport.run()
            _state.update { it.copy(exporting = false) }
            _events.send(event)
        }
    }

    companion object {
        /** The server keeps a deleted account restorable this long before purging it. */
        const val GRACE_DAYS = 30L
    }
}

/**
 * «حسابت رو پاک می‌کنی؟» (m20): what happens, one consequence a row (no one
 * sees the profile from now on; everything comes back by signing in until the
 * date; then it is gone for good; and, while a store subscription renews, that
 * deleting does not cancel it, with «مدیریت اشتراک»), «اول یه نسخه از
 * اطلاعاتم رو بگیر», then «نه، می‌مونم» as the primary button and «حسابم رو
 * پاک کن» as the red outline under it.
 */
@Composable
fun DeleteAccountRoute(onBack: () -> Unit) {
    val graph = LocalAppGraph.current
    val model: DeleteAccountModel = viewModel(factory = viewModelFactory { initializer { DeleteAccountModel(graph.api, graph.auth, graph.clock) } })
    val state by model.state.collectAsStateWithLifecycle()
    val language = screenLanguage()
    val activity = LocalActivity.current
    val uri = LocalUriHandler.current
    val resources = LocalResources.current
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(model) {
        model.events.collect { event ->
            when (event) {
                is SettingsEvent.Notice -> snackbar.showSnackbar(brandText(resources.getString(event.text)))
                is SettingsEvent.Open -> runCatching { uri.openUri(event.url) }
                SettingsEvent.NeedsPlan -> Unit
            }
        }
    }
    val subscription = state.preflight?.subscription
    DeletePage(
        restoreDate = formatDate(model.restorableUntil(), language),
        subscription = subscription != null,
        manage = managedHere(subscription, graph.purchases.store),
        onManage = { activity?.let { graph.store.info.openSubscriptions(it, null, subscription?.manageUrl) } },
        onExport = model::export,
        exporting = state.exporting,
        onStay = onBack,
        onDelete = model::delete,
        deleting = state.deleting,
        error = when (state.error) {
            null -> null
            StepError.Offline -> brandString(R.string.error_offline)
            else -> brandString(R.string.error_generic)
        },
        onBack = onBack,
        snackbar = snackbar,
    )
}

/**
 * Whether this build's store holds [notice]'s subscription, so its page here
 * can cancel it: one bought in the other store's build is not in this
 * store's list, and its link would open a page without it.
 */
internal fun managedHere(notice: StoreSubscriptionNotice?, store: Store): Boolean =
    notice != null && notice.store == store.wireName()

/**
 * The delete screen drawn from its parts: see [DeleteAccountRoute].
 * [subscription] says one keeps renewing; [manage] adds its store page
 * when this build's store holds it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DeletePage(
    restoreDate: String,
    subscription: Boolean,
    onManage: () -> Unit,
    onExport: () -> Unit,
    exporting: Boolean,
    onStay: () -> Unit,
    onDelete: () -> Unit,
    deleting: Boolean,
    error: String?,
    onBack: () -> Unit,
    snackbar: SnackbarHostState = remember { SnackbarHostState() },
    manage: Boolean = true,
) {
    val t = AppTheme.template
    AuthPage(
        title = brandString(R.string.delete_title),
        onBack = onBack,
        hero = false,
        titleTop = PageLayout.titleTopTight,
        snackbar = snackbar,
        actions = {
            PrimaryButton(brandString(R.string.delete_stay), onStay, enabled = !deleting)
            SecondaryButton(
                brandString(R.string.delete_confirm),
                onDelete,
                Modifier.padding(top = DeleteLayout.buttonGap),
                enabled = !deleting,
                destructive = true,
            )
        },
    ) {
        Column(Modifier.padding(top = DeleteLayout.rowsTop)) {
            Consequence(brandString(R.string.delete_now), divider = false)
            Consequence(brandString(R.string.delete_restore, restoreDate), divider = true)
            Consequence(brandString(R.string.delete_after), divider = true)
            if (subscription) {
                Column(Modifier.fillMaxWidth()) {
                    HorizontalDivider(thickness = 1.dp, color = t.colors.line)
                    FlowRow(
                        Modifier.padding(vertical = DeleteLayout.rowPad),
                        horizontalArrangement = Arrangement.spacedBy(DeleteLayout.manageGap),
                        itemVerticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(brandString(R.string.delete_sub), style = t.type.body, color = t.colors.text)
                        if (manage) {
                            Text(brandString(R.string.manage_subscription), style = t.type.link, color = t.colors.primary, modifier = Modifier.overhangingTarget(onManage))
                        }
                    }
                }
            }
        }
        TextAction(
            brandString(R.string.delete_export),
            onExport,
            Modifier.padding(top = DeleteLayout.exportTop).fillMaxWidth(),
            enabled = !exporting,
        )
        if (error != null) HelperLine(error, Modifier.padding(top = DeleteLayout.errorTop), error = true)
    }
}

/** One consequence: `--type-body` in `--text`, 13 dp above and below, a `--line` between rows. */
@Composable
private fun Consequence(text: String, divider: Boolean) {
    val t = AppTheme.template
    Column(Modifier.fillMaxWidth()) {
        if (divider) HorizontalDivider(thickness = 1.dp, color = t.colors.line)
        Text(text, style = t.type.body, color = t.colors.text, modifier = Modifier.padding(vertical = DeleteLayout.rowPad))
    }
}

private object DeleteLayout {
    val rowsTop: Dp = 20.dp
    val rowPad: Dp = 13.dp
    val exportTop: Dp = 10.dp
    val buttonGap: Dp = 10.dp
    val errorTop: Dp = 10.dp
    val manageGap: Dp = 6.dp
}
