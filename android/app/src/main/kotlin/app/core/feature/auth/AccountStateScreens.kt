package app.core.feature.auth

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
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
import app.core.billing.storePlan
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.onboarding.Skeleton
import app.core.feature.onboarding.StepError
import app.core.feature.onboarding.formatDate
import app.core.i18n.AppLanguage
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.model.AccountStatus
import app.core.model.AppealStatus
import app.core.model.AuthUser
import app.core.model.Entitlements
import app.core.model.ModerationAction
import app.core.model.ModerationHistory
import app.core.model.ModerationKind
import app.core.model.Problem
import app.core.model.ProblemCodes
import app.core.net.ApiError
import app.core.net.ServerApi
import app.core.store.Store
import app.core.ui.components.AppDialog
import app.core.ui.components.AppTextArea
import app.core.ui.components.HelperLine
import app.core.ui.components.PrimaryButton
import app.core.ui.components.SettingsGroup
import app.core.ui.components.TextAction
import app.core.ui.components.TextActionKind
import app.core.ui.components.overhangingTarget
import app.core.ui.theme.AppTheme
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** What the restricted, restore and review screens show and do. */
data class AccountStateUi(
    val loading: Boolean = true,
    val error: StepError? = null,
    val status: AccountStatus = AccountStatus.Unknown,
    /**
     * The suspension or ban in force, with its reason; or, while the account
     * still reads restricted just after one was lifted, that lifted one
     * (its [ModerationAction.revokedAt] set).
     */
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
                    val read = runCatchingUnlessCancelled { api.moderation() }
                    val history = read.getOrNull()
                    when {
                        history != null -> restrictingAction(history)
                        // `GET /v1/me` lists only the actions in force: it never replaces a lifted one on
                        // screen. The refresh fails instead, so the lifted state, the error line and the
                        // round of re-reads all stay.
                        _state.value.action?.revokedAt != null -> throw checkNotNull(read.exceptionOrNull())
                        else -> me.moderation.firstOrNull { it.restricts() && it.revokedAt == null }
                    }
                } else {
                    null
                }
                Triple(me, action, me.deletion?.purgeAt)
            }.onSuccess { (me, action, purgeAt) ->
                _state.update { it.copy(loading = false, status = me.status, action = action, purgeAt = purgeAt) }
                gate.accountChanged(AuthUser(me.id, me.status, me.onboardingStep))
                if (action?.revokedAt != null) recheckLifted() else stopLiftedRechecks()
            }.onFailure { e ->
                _state.update { it.copy(loading = false, error = if (e is ApiError.Network) StepError.Offline else StepError.Failed) }
                // A failed read (the account's or its moderation history) keeps the round going: the next wait, the same cap.
                if (_state.value.action?.revokedAt != null) recheckLifted()
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
                    val code = (e as? ApiError.Http)?.code
                    if (code == ProblemCodes.NOT_APPEALABLE) {
                        // Lifted or decided meanwhile: read again where it stands.
                        _state.update { it.copy(busy = false) }
                        refresh()
                        return@onFailure
                    }
                    val already = code == ProblemCodes.APPEAL_OPEN
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

    private var liftedRecheck: Job? = null
    private var liftedRechecks = 0

    /**
     * Lifted while the account still reads restricted: read again after each
     * of [LIFTED_RECHECK_MS], one at a time (a failed read counts as one),
     * then only on a tap or a resume.
     */
    private fun recheckLifted() {
        if (liftedRecheck?.isActive == true) return
        val wait = LIFTED_RECHECK_MS.getOrNull(liftedRechecks) ?: return
        liftedRechecks++
        liftedRecheck = viewModelScope.launch {
            delay(wait)
            liftedRecheck = null
            refresh()
        }
    }

    private fun stopLiftedRechecks() {
        liftedRecheck?.cancel()
        liftedRecheck = null
        liftedRechecks = 0
    }

    private var signingOut = false

    /** Once: a second tap while the first sign-out is on its way does nothing. */
    fun signOut() {
        if (signingOut) return
        signingOut = true
        viewModelScope.launch {
            try {
                gate.signOut()
            } finally {
                signingOut = false
            }
        }
    }
}

/** Anything but a warning: a suspension, a ban, or a kind this build does not know yet. */
private fun ModerationAction.restricts(): Boolean = kind != ModerationKind.Warning

/**
 * What the restricted screen shows from `GET /v1/me/moderation`: the
 * suspension or ban in force; else, when the newest of them in the history
 * was lifted, that one (the account reads restricted until its state
 * catches up); else nothing, and the refusal's own reason stands.
 */
internal fun restrictingAction(read: ModerationHistory): ModerationAction? =
    read.active.firstOrNull { it.restricts() && it.revokedAt == null }
        ?: read.history.filter { it.restricts() }.maxByOrNull { it.startsAt }?.takeIf { it.revokedAt != null }

/**
 * «از حسابت خارج می‌شی؟» before a state screen signs out, as Settings asks:
 * the footer sits right under the thumb (above the keyboard while an appeal
 * is written), and a stray tap would throw the draft and the session away.
 */
@Composable
private fun rememberSignOut(signOut: () -> Unit): () -> Unit {
    var asking by rememberSaveable { mutableStateOf(false) }
    if (asking) {
        AppDialog(
            title = brandString(R.string.dialog_sign_out_title),
            body = null,
            confirm = brandString(R.string.dialog_sign_out_confirm),
            onConfirm = {
                asking = false
                signOut()
            },
            dismiss = brandString(R.string.dialog_sign_out_stay),
            onDismiss = { asking = false },
            destructive = false,
        )
    }
    return { asking = true }
}

@Composable
private fun accountModel(): AccountStateViewModel {
    val graph = LocalAppGraph.current
    return viewModel(factory = viewModelFactory { initializer { AccountStateViewModel(graph.api, graph.auth) } })
}

/**
 * Suspended or banned (m19): the title (no date in it), one line, a card
 * with the reason and, for a suspension, until when; the appeal (a field and
 * its button) while one can be sent, else where it stands (sent or
 * decided); the one line a store subscription that keeps renewing needs,
 * with «مدیریت اشتراک»; and at the bottom «خروج از حساب» and «حذف حساب»
 * (the in-app deletion, [onDelete]).
 * A lift the account has not caught up with yet shows none of that, only
 * its own title and line and a way to read again.
 */
@Composable
fun RestrictedRoute(onDelete: () -> Unit = {}) {
    val model = accountModel()
    val state by model.state.collectAsStateWithLifecycle()
    val language = screenLanguage()
    val graph = LocalAppGraph.current
    val activity = LocalActivity.current
    val entitlements by graph.entitlements.entitlements.collectAsStateWithLifecycle()
    LaunchedEffect(graph) { graph.entitlements.ensure() }
    var appealText by rememberSaveable { mutableStateOf("") }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { model.refresh() }
    // A suspension that ends while the screen is in front is read again then.
    val endsAt = state.action?.endsAt
    LaunchedEffect(endsAt) {
        val wait = endsAt?.let { java.time.Duration.between(Instant.now(), it).toMillis() } ?: return@LaunchedEffect
        if (wait > 0) {
            delay(wait + ENDED_GRACE_MS)
            model.refresh()
        }
    }
    val askSignOut = rememberSignOut(model::signOut)

    val action = state.action
    // Lifted while the account still reads restricted: the model reads again
    // until the gate catches up; the page says so in place of the restriction.
    val lifted = action?.revokedAt != null
    val banned = action?.kind == ModerationKind.Ban || state.status == AccountStatus.Banned ||
        (action == null && state.problem?.code == ProblemCodes.ACCOUNT_BANNED)
    val reason = action?.reasonText?.takeIf { it.isNotBlank() } ?: state.problem?.reasonText
    val until = if (lifted) null else action?.endsAt ?: state.problem?.until
    val appealable = !lifted && (action != null && action.appeal == null && !state.appealSent) && (state.problem?.appealable != false)
    val appealOpen = state.appealSent || action?.appeal?.status == AppealStatus.Open
    val renewing = renewingStorePlan(entitlements, graph.purchases.store)

    RestrictedPage(
        banned = banned,
        lifted = lifted,
        reason = reason,
        until = if (banned) null else until?.let { untilText(it, language) },
        loading = state.loading && reason == null,
        appeal = when {
            lifted -> AppealState.None
            appealOpen -> AppealState.Sent
            action?.appeal?.status == AppealStatus.Upheld -> AppealState.Upheld(action.appeal.decisionText)
            appealable -> AppealState.Open
            else -> AppealState.None
        },
        appealText = appealText,
        onAppealText = { appealText = it },
        onSend = { model.appeal(appealText) },
        busy = state.busy,
        error = stepErrorTextLocal(state.error),
        onRetry = model::refresh,
        renewing = renewing != null,
        onManage = { activity?.let { graph.store.info.openSubscriptions(it, null, renewing?.manageUrl) } },
        onSignOut = askSignOut,
        onDelete = onDelete,
    )
}

/** A store subscription of this build's store that keeps renewing (the restricted screen says so); null otherwise. */
internal fun renewingStorePlan(entitlements: Entitlements?, store: Store): Entitlements? =
    entitlements?.takeIf { it.storePlan(store) && it.autoRenew != false }

/** Where the appeal stands. */
sealed interface AppealState {
    /** One can be written and sent. */
    data object Open : AppealState

    /** Sent; the answer comes here. */
    data object Sent : AppealState

    /** Answered: the decision stands, with what the team wrote. */
    data class Upheld(val decision: String?) : AppealState

    /** Nothing to appeal (or not yet read). */
    data object None : AppealState
}

/**
 * The restricted screen drawn from its parts: see [RestrictedRoute]. While
 * [lifted] (the action is lifted and the account has not caught up yet) it
 * draws none of the restriction: its own title and line, the way to read
 * again, and the footer; [reason], [until], [appeal] and [renewing] are not
 * shown then.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RestrictedPage(
    banned: Boolean,
    lifted: Boolean,
    reason: String?,
    until: String?,
    loading: Boolean,
    appeal: AppealState,
    appealText: String,
    onAppealText: (String) -> Unit,
    onSend: () -> Unit,
    busy: Boolean,
    error: String?,
    onRetry: () -> Unit,
    renewing: Boolean,
    onManage: () -> Unit,
    onSignOut: () -> Unit,
    onDelete: () -> Unit,
) {
    val t = AppTheme.template
    val title = when {
        lifted -> R.string.restricted_lifted_title
        banned -> R.string.restricted_banned_title
        else -> R.string.restricted_suspended_title
    }
    val body = when {
        lifted -> R.string.restricted_lifted
        banned -> R.string.restricted_body_banned
        else -> R.string.restricted_body
    }
    AuthPage(
        title = brandString(title),
        onBack = null,
        hero = false,
        titleTop = 0.dp,
        actions = {
            Row(horizontalArrangement = Arrangement.spacedBy(StateLayout.footerGap)) {
                TextAction(brandString(R.string.action_sign_out), onSignOut, kind = TextActionKind.Neutral)
                TextAction(brandString(R.string.settings_delete), onDelete, kind = TextActionKind.Destructive)
            }
        },
    ) {
        Sub(brandString(body))
        if (!lifted) {
            if (loading) {
                Skeleton(Modifier.padding(top = StateLayout.cardTop).fillMaxWidth().height(StateLayout.skeleton))
            } else if (reason != null || until != null) {
                SettingsGroup(Modifier.padding(top = StateLayout.cardTop)) {
                    if (reason != null) Fact(brandString(R.string.restricted_reason), reason, divider = false)
                    if (until != null) Fact(brandString(R.string.restricted_until), until, divider = reason != null)
                }
            }
        }
        if (!lifted) when (appeal) {
            AppealState.Open -> {
                Text(
                    brandString(R.string.restricted_appeal_title),
                    style = t.type.section,
                    color = t.colors.text2,
                    modifier = Modifier.padding(top = StateLayout.labelTop, bottom = StateLayout.labelBottom),
                )
                val field = remember { FocusRequester() }
                AppTextArea(
                    value = appealText,
                    onValueChange = onAppealText,
                    maxLength = APPEAL_MAX,
                    placeholder = brandString(R.string.restricted_appeal_hint),
                    enabled = !busy,
                    modifier = Modifier.focusRequester(field),
                )
                // Nothing written yet: the button takes the person to the field.
                PrimaryButton(
                    brandString(R.string.restricted_appeal_send),
                    { if (appealText.isBlank()) runCatching { field.requestFocus() } else onSend() },
                    Modifier.padding(top = StateLayout.buttonTop),
                    loading = busy,
                )
            }
            AppealState.Sent -> Line(brandString(R.string.restricted_appeal_open), Modifier.padding(top = StateLayout.labelTop))
            is AppealState.Upheld -> {
                Line(brandString(R.string.restricted_appeal_upheld), Modifier.padding(top = StateLayout.labelTop))
                appeal.decision?.takeIf { it.isNotBlank() }?.let { Text(it, style = t.type.body, color = t.colors.text, modifier = Modifier.padding(top = StateLayout.decisionTop)) }
            }
            AppealState.None -> Unit
        }
        if (error != null) HelperLine(error, Modifier.padding(top = StateLayout.errorTop), error = true)
        // A read that failed, nothing read yet, or a lift the account has not
        // caught up with: asked again from here, not only on the way back to the app.
        if (lifted || error != null || (!loading && reason == null)) {
            TextAction(
                brandString(R.string.action_try_again),
                onRetry,
                Modifier.padding(top = if (lifted && error == null) StateLayout.liftedRetryTop else StateLayout.retryTop),
            )
        }
        if (renewing && !lifted) {
            FlowRow(
                Modifier.padding(top = StateLayout.billingTop),
                horizontalArrangement = Arrangement.spacedBy(StateLayout.manageGap),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                Text(brandString(R.string.restricted_billing), style = t.type.bodySm, color = t.colors.text2)
                Text(brandString(R.string.manage_subscription), style = t.type.link, color = t.colors.primary, modifier = Modifier.overhangingTarget(onManage))
            }
        }
    }
}

/** The line under a title: `--type-body-sm`, `--text-2`. */
@Composable
internal fun Sub(text: String, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    Text(text, style = t.type.bodySm, color = t.colors.text2, modifier = modifier.padding(top = StateLayout.subTop))
}

/** A quiet line on a state screen (`--type-body-sm`, `--text-2`). */
@Composable
private fun Line(text: String, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    Text(text, style = t.type.bodySm, color = t.colors.text2, modifier = modifier)
}

/** One fact in the card: its label (`--type-section`, `--text-3`) over its value (`--type-body-strong`). */
@Composable
private fun Fact(label: String, value: String, divider: Boolean) {
    val t = AppTheme.template
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) { }) {
        if (divider) HorizontalDivider(thickness = 1.dp, color = t.colors.line)
        Column(Modifier.padding(vertical = StateLayout.factPad)) {
            Text(label, style = t.type.section, color = t.colors.text3, modifier = Modifier.padding(bottom = 2.dp))
            Text(value, style = t.type.bodyStrong, color = t.colors.text)
        }
    }
}

/** «۲۵ آبان ۱۴۰۵، ساعت ۱۸:۰۰» / "November 16, 2026, 6:00 PM": the day and the time of day, here. */
@Composable
internal fun untilText(at: Instant, language: AppLanguage): String {
    val local = at.atZone(ZoneId.systemDefault())
    val date = formatDate(local.toLocalDate(), language)
    val time = if (language == AppLanguage.FA) {
        Numerals.digits(String.format(Locale.ROOT, "%02d:%02d", local.hour, local.minute), language)
    } else {
        DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(Locale.forLanguageTag(language.tag)).format(local)
    }
    return brandString(R.string.restricted_until_value, date, time)
}

/** An appeal's limit: the server's, so nothing it takes is cut from a paste. */
internal const val APPEAL_MAX = 2000

/** How long after a suspension's end it is read again (the server lifts it on its own clock). */
private const val ENDED_GRACE_MS = 5_000L

/**
 * While a lifted action is shown, the waits before each automatic read
 * (each read asks for the moderation history too, so they stop after these).
 */
internal val LIFTED_RECHECK_MS = listOf(3_000L, 10_000L, 30_000L)

/** Deleted, inside the grace period: restore, or sign out and leave it to finish. */
@Composable
fun RestoreRoute() {
    val model = accountModel()
    val state by model.state.collectAsStateWithLifecycle()
    val language = screenLanguage()
    val purgeAt = state.purgeAt ?: state.problem?.restorableUntil
    val askSignOut = rememberSignOut(model::signOut)
    AuthPage(
        title = brandString(R.string.restore_title),
        onBack = null,
        hero = false,
        titleTop = 0.dp,
        actions = {
            PrimaryButton(brandString(R.string.restore_action), onClick = model::restore, loading = state.busy)
            TextAction(brandString(R.string.action_sign_out), askSignOut, kind = TextActionKind.Neutral, modifier = Modifier.padding(top = StateLayout.actionGap))
        },
    ) {
        Sub(purgeAt?.let { brandString(R.string.restore_body_date, formatDate(it.atZone(ZoneId.systemDefault()).toLocalDate(), language)) } ?: brandString(R.string.restore_body))
        stepErrorTextLocal(state.error)?.let { HelperLine(it, Modifier.padding(top = StateLayout.errorTop), error = true) }
    }
}

/** Sign-up is done; new profiles are looked at before they are shown. Checked again whenever the app comes back. */
@Composable
fun ReviewRoute() {
    val model = accountModel()
    val state by model.state.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { model.refresh() }
    val askSignOut = rememberSignOut(model::signOut)
    AuthPage(
        title = brandString(R.string.review_title),
        onBack = null,
        hero = false,
        titleTop = 0.dp,
        actions = {
            PrimaryButton(brandString(R.string.review_check), onClick = model::refresh, loading = state.loading)
            TextAction(brandString(R.string.action_sign_out), askSignOut, kind = TextActionKind.Neutral, modifier = Modifier.padding(top = StateLayout.actionGap))
        },
    ) {
        Sub(brandString(R.string.review_body))
        stepErrorTextLocal(state.error)?.let { HelperLine(it, Modifier.padding(top = StateLayout.errorTop), error = true) }
    }
}

/** The service is down for maintenance: the server's message, and a retry. */
@Composable
fun MaintenanceScreen(message: String?) {
    val graph = LocalAppGraph.current
    val scope = rememberCoroutineScope()
    var checking by rememberSaveable { mutableStateOf(false) }
    AuthPage(
        title = brandString(R.string.maintenance_title),
        onBack = null,
        hero = false,
        titleTop = 0.dp,
        actions = {
            PrimaryButton(brandString(R.string.action_try_again), loading = checking, onClick = {
                checking = true
                scope.launch {
                    val fresh = graph.config.refresh()
                    if (fresh != null && !fresh.maintenance.enabled) graph.auth.maintenanceOver()
                    checking = false
                }
            })
        },
    ) {
        Sub(message?.takeIf { it.isNotBlank() } ?: brandString(R.string.maintenance_body))
    }
}

@Composable
private fun stepErrorTextLocal(error: StepError?): String? = when (error) {
    null -> null
    StepError.Offline -> brandString(R.string.error_offline)
    else -> brandString(R.string.error_generic)
}

/** The state screens on the design's phone (dp). */
private object StateLayout {
    val subTop: Dp = 6.dp
    val cardTop: Dp = 22.dp
    val factPad: Dp = 12.dp
    val skeleton: Dp = 120.dp
    val labelTop: Dp = 24.dp
    val labelBottom: Dp = 8.dp
    val buttonTop: Dp = 14.dp
    val billingTop: Dp = 18.dp
    val footerGap: Dp = 8.dp
    val actionGap: Dp = 4.dp
    val decisionTop: Dp = 4.dp
    val errorTop: Dp = 10.dp
    val retryTop: Dp = 4.dp
    val liftedRetryTop: Dp = 14.dp
    val manageGap: Dp = 6.dp
}
