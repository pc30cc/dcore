package app.core.feature.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import app.core.LocalAppGraph
import app.core.R
import app.core.brand.AppBrand
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.onboarding.StepError
import app.core.feature.onboarding.formatDate
import app.core.i18n.brandString
import app.core.model.AccountStatus
import app.core.model.AppealStatus
import app.core.model.AuthUser
import app.core.model.ModerationAction
import app.core.model.ModerationKind
import app.core.model.Problem
import app.core.model.ProblemCodes
import app.core.net.ApiError
import app.core.net.ServerApi
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId

/** What the restricted, restore and review screens show and do. */
data class AccountStateUi(
    val loading: Boolean = true,
    val error: StepError? = null,
    val status: AccountStatus = AccountStatus.Unknown,
    /** The active suspension or ban, with its reason. */
    val action: ModerationAction? = null,
    /** The refusal that brought the app here, when no action could be read yet. */
    val problem: Problem? = null,
    val purgeAt: Instant? = null,
    val busy: Boolean = false,
    val appealSent: Boolean = false,
)

/**
 * The account's state when it is not "in": suspended or banned (the reason
 * the person sees and the in-app appeal), deleted inside its grace period
 * (restore), or waiting for a profile review. Only the routes such a
 * session may use are called (`GET /v1/me`, `GET /v1/me/moderation`,
 * `POST /v1/appeals`, `POST /v1/me/restore`, logout).
 */
class AccountStateViewModel(private val api: ServerApi, private val gate: AuthGate) : ViewModel() {
    private val _state = MutableStateFlow(AccountStateUi(problem = gate.accountProblem.value))
    val state: StateFlow<AccountStateUi> = _state.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        _state.update { it.copy(loading = it.status == AccountStatus.Unknown, error = null) }
        viewModelScope.launch {
            runCatchingUnlessCancelled {
                val me = api.me().value
                val action = if (me.status.isRestricted) {
                    runCatchingUnlessCancelled { api.moderation().active }.getOrNull()
                        ?.firstOrNull { it.kind != ModerationKind.Warning } ?: me.moderation.firstOrNull { it.kind != ModerationKind.Warning }
                } else {
                    null
                }
                Triple(me, action, me.deletion?.purgeAt)
            }.onSuccess { (me, action, purgeAt) ->
                _state.update { it.copy(loading = false, status = me.status, action = action, purgeAt = purgeAt) }
                gate.accountChanged(AuthUser(me.id, me.status, me.onboardingStep))
            }.onFailure { e ->
                _state.update { it.copy(loading = false, error = if (e is ApiError.Network) StepError.Offline else StepError.Failed) }
            }
        }
    }

    fun appeal(body: String) {
        val action = _state.value.action ?: return
        if (body.isBlank() || _state.value.busy) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatchingUnlessCancelled { api.appeal(action.id, body.trim()) }
                .onSuccess { appeal -> _state.update { it.copy(busy = false, appealSent = true, action = action.copy(appeal = appeal)) } }
                .onFailure { e ->
                    val already = (e as? ApiError.Http)?.code == ProblemCodes.APPEAL_OPEN
                    _state.update {
                        it.copy(busy = false, appealSent = already, error = if (already) null else if (e is ApiError.Network) StepError.Offline else StepError.Failed)
                    }
                }
        }
    }

    fun restore() {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatchingUnlessCancelled { api.restoreAccount() }
                .onSuccess { user ->
                    _state.update { it.copy(busy = false) }
                    gate.signedIn(user)
                }
                .onFailure { e -> _state.update { it.copy(busy = false, error = if (e is ApiError.Network) StepError.Offline else StepError.Failed) } }
        }
    }

    fun signOut() {
        viewModelScope.launch { gate.signOut() }
    }
}

@Composable
private fun accountModel(): AccountStateViewModel {
    val graph = LocalAppGraph.current
    return viewModel(factory = viewModelFactory { initializer { AccountStateViewModel(graph.api, graph.auth) } })
}

/** Suspended or banned: why, until when, and the appeal. Support and deletion stay reachable. */
@Composable
fun RestrictedRoute() {
    val model = accountModel()
    val state by model.state.collectAsStateWithLifecycle()
    val language = screenLanguage()
    val uri = LocalUriHandler.current
    val graph = LocalAppGraph.current
    val config by graph.config.config.collectAsStateWithLifecycle()
    var appealText by rememberSaveable { mutableStateOf("") }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { model.refresh() }

    val action = state.action
    val banned = action?.kind == ModerationKind.Ban || state.status == AccountStatus.Banned ||
        (action == null && state.problem?.code == ProblemCodes.ACCOUNT_BANNED)
    val reason = action?.reasonText?.takeIf { it.isNotBlank() } ?: state.problem?.reasonText
    val until = action?.endsAt ?: state.problem?.until
    val appealable = (action != null && action.appeal == null && !state.appealSent) && (state.problem?.appealable != false)
    val appealOpen = state.appealSent || action?.appeal?.status == AppealStatus.Open

    FlowScaffold(
        title = brandString(if (banned) R.string.restricted_banned_title else R.string.restricted_suspended_title),
        subtitle = brandString(R.string.restricted_body),
        onBack = null,
        trailingTopBar = {
            androidx.compose.material3.IconButton(onClick = model::refresh) {
                Icon(Icons.Filled.Refresh, contentDescription = brandString(R.string.action_refresh))
            }
        },
        actions = {
            if (appealable) {
                PrimaryButton(brandString(R.string.restricted_appeal_send), onClick = { model.appeal(appealText) }, enabled = appealText.isNotBlank(), busy = state.busy)
            }
            val deleteUrl = config?.legal?.deleteAccountUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.deleteAccountUrl
            if (deleteUrl.isNotBlank()) TextButton(onClick = { uri.openUri(deleteUrl) }) { Text(brandString(R.string.restricted_delete)) }
            TextButton(onClick = model::signOut) { Text(brandString(R.string.action_sign_out)) }
        },
    ) {
        if (state.loading && reason == null) {
            app.core.feature.onboarding.Skeleton(Modifier.fillMaxWidth().height(96.dp))
        }
        if (reason != null) {
            StateRow(Icons.Filled.Info, brandString(R.string.restricted_reason), reason, danger = true)
        }
        if (!banned && until != null) {
            StateRow(Icons.Filled.DateRange, brandString(R.string.restricted_until), formatDate(until.atZone(ZoneId.systemDefault()).toLocalDate(), language))
        }
        when {
            appealOpen -> NoteCard { Text(brandString(R.string.restricted_appeal_open), style = MaterialTheme.typography.bodyMedium) }
            action?.appeal?.status == AppealStatus.Upheld -> NoteCard {
                Text(brandString(R.string.restricted_appeal_upheld), style = MaterialTheme.typography.bodyMedium)
                action.appeal.decisionText?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            appealable -> {
                Text(brandString(R.string.restricted_appeal_title), style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    value = appealText,
                    onValueChange = { appealText = it.take(APPEAL_MAX) },
                    minLines = 3,
                    placeholder = { Text(brandString(R.string.restricted_appeal_hint)) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        InlineMessage(stepErrorTextLocal(state.error))
    }
}

private const val APPEAL_MAX = 1000

/** Deleted, inside the grace period: restore, or leave it to finish. */
@Composable
fun RestoreRoute() {
    val model = accountModel()
    val state by model.state.collectAsStateWithLifecycle()
    val language = screenLanguage()
    val purgeAt = state.purgeAt ?: state.problem?.restorableUntil
    FlowScaffold(
        title = brandString(R.string.restore_title),
        subtitle = purgeAt?.let { brandString(R.string.restore_body_date, formatDate(it.atZone(ZoneId.systemDefault()).toLocalDate(), language)) }
            ?: brandString(R.string.restore_body),
        onBack = null,
        actions = {
            PrimaryButton(brandString(R.string.restore_action), onClick = model::restore, busy = state.busy)
            TextButton(onClick = model::signOut) { Text(brandString(R.string.action_sign_out)) }
        },
    ) {
        NoteCard(icon = { Icon(Icons.Filled.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.primary) }) {
            Text(brandString(R.string.restore_note), style = MaterialTheme.typography.bodyMedium)
        }
        InlineMessage(stepErrorTextLocal(state.error))
    }
}

/** Sign-up is done; new profiles are looked at before they are shown. Checked again whenever the app comes back. */
@Composable
fun ReviewRoute() {
    val model = accountModel()
    val state by model.state.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { model.refresh() }
    FlowScaffold(
        title = brandString(R.string.review_title),
        subtitle = brandString(R.string.review_body),
        onBack = null,
        actions = {
            PrimaryButton(brandString(R.string.review_check), onClick = model::refresh, busy = state.loading)
            TextButton(onClick = model::signOut) { Text(brandString(R.string.action_sign_out)) }
        },
    ) {
        NoteCard(icon = { Icon(Icons.Filled.Info, contentDescription = null, tint = MaterialTheme.colorScheme.primary) }) {
            Text(brandString(R.string.review_note), style = MaterialTheme.typography.bodyMedium)
        }
        InlineMessage(stepErrorTextLocal(state.error))
    }
}

/** The service is down for maintenance: the server's message, and a retry. */
@Composable
fun MaintenanceScreen(message: String?) {
    val graph = LocalAppGraph.current
    val scope = rememberCoroutineScope()
    var checking by rememberSaveable { mutableStateOf(false) }
    FlowScaffold(
        title = brandString(R.string.maintenance_title),
        subtitle = message?.takeIf { it.isNotBlank() } ?: brandString(R.string.maintenance_body),
        onBack = null,
        actions = {
            PrimaryButton(brandString(R.string.action_try_again), busy = checking, onClick = {
                checking = true
                scope.launch {
                    val fresh = graph.config.refresh()
                    if (fresh != null && !fresh.maintenance.enabled) graph.auth.maintenanceOver()
                    checking = false
                }
            })
        },
    ) {}
}

@Composable
private fun StateRow(icon: ImageVector, title: String, body: String, danger: Boolean = false) {
    androidx.compose.foundation.layout.Row(horizontalArrangement = Arrangement.spacedBy(Space.md), modifier = Modifier.fillMaxWidth()) {
        Box(
            Modifier.size(40.dp).clip(CircleShape).background(if (danger) AppTheme.colors.danger.copy(alpha = 0.14f) else MaterialTheme.colorScheme.primaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = if (danger) AppTheme.colors.danger else MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(22.dp))
        }
        Column(Modifier.weight(1f).padding(top = 2.dp), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
            Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(body, style = MaterialTheme.typography.bodyLarge)
        }
    }
}

@Composable
private fun stepErrorTextLocal(error: StepError?): String? = when (error) {
    null -> null
    StepError.Offline -> brandString(R.string.error_offline)
    else -> brandString(R.string.error_generic)
}
