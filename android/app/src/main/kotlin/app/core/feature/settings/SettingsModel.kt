package app.core.feature.settings

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.core.R
import app.core.common.Clock
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.auth.AuthGate
import app.core.model.Me
import app.core.model.NotificationPrefs
import app.core.model.NotificationPrefsPatch
import app.core.model.ProblemCodes
import app.core.model.Settings
import app.core.model.SettingsPatch
import app.core.net.ApiError
import app.core.net.ServerApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** What Settings draws: the account's switches as the server last said, while a write is out the value it asks for. */
data class SettingsUi(
    val me: Me? = null,
    val notifications: NotificationPrefs? = null,
    val settings: Settings? = null,
    /** The switches are the account's own (the first read answered): until then they are drawn but cannot be moved. */
    val loaded: Boolean = false,
    /** What the account was signed in with on this phone (E.164 or an address), when it saw the sign-in. */
    val signedInAs: String? = null,
    /** An export being asked for or read. */
    val exporting: Boolean = false,
)

/** What Settings tells the person once (a snackbar), or a link the screen opens. */
sealed interface SettingsEvent {
    data class Notice(@param:StringRes val text: Int) : SettingsEvent

    /** The data export is ready: open its link. */
    data class Open(val url: String) : SettingsEvent

    /** A plan feature is needed for this switch: the plans. */
    data object NeedsPlan : SettingsEvent
}

/**
 * Settings' account work: the notification groups (`PATCH
 * /v1/me/notifications`), the privacy switches (`PATCH /v1/me/settings`;
 * incognito needs the plan feature, the server answers
 * `entitlement_required` otherwise), the data export (`GET`/`POST
 * /v1/me/export`, once a week) and signing out here or everywhere. A switch
 * moves at once and goes back if the server refuses it. The switches wait
 * for the account's own values ([SettingsUi.loaded]); a read that failed is
 * tried again when a sheet with switches opens ([ensureLoaded]).
 */
class SettingsModel(
    private val api: ServerApi,
    private val gate: AuthGate,
    private val clock: Clock,
    private val signedInAs: suspend () -> String? = { null },
) : ViewModel() {
    private val _state = MutableStateFlow(SettingsUi())
    val state: StateFlow<SettingsUi> = _state.asStateFlow()
    private val _events = Channel<SettingsEvent>(Channel.BUFFERED)
    val events: Flow<SettingsEvent> = _events.receiveAsFlow()

    private var reading: Job? = null

    init {
        viewModelScope.launch {
            val identity = runCatchingUnlessCancelled { signedInAs() }.getOrNull()
            _state.update { it.copy(signedInAs = identity) }
        }
        load()
    }

    fun load() {
        if (reading?.isActive == true) return
        reading = viewModelScope.launch {
            runCatchingUnlessCancelled { api.me().value }.onSuccess { me ->
                _state.update {
                    it.copy(
                        me = me,
                        notifications = me.notifications ?: it.notifications,
                        settings = me.profile?.settings ?: it.settings,
                        loaded = true,
                    )
                }
            }
        }
    }

    /** A sheet with switches is opening: read the account again if the first read never answered. */
    fun ensureLoaded() {
        if (!_state.value.loaded) load()
    }

    /** «مچ‌ها و لایک‌ها» (matches and likes) and «پیام‌ها و تماس‌ها» (messages and calls), each one switch. */
    fun setNotifications(matches: Boolean? = null, messages: Boolean? = null) {
        val before = _state.value.notifications ?: NotificationPrefs()
        val patch = NotificationPrefsPatch(matches = matches, likes = matches, messages = messages, calls = messages)
        _state.update {
            it.copy(
                notifications = before.copy(
                    matches = matches ?: before.matches,
                    likes = matches ?: before.likes,
                    messages = messages ?: before.messages,
                    calls = messages ?: before.calls,
                ),
            )
        }
        viewModelScope.launch {
            runCatchingUnlessCancelled { api.updateNotifications(patch) }
                .onSuccess { saved -> _state.update { it.copy(notifications = saved) } }
                .onFailure { e ->
                    _state.update { it.copy(notifications = before) }
                    _events.send(SettingsEvent.Notice(failureText(e)))
                }
        }
    }

    /** One privacy switch; [patch] names it. */
    fun setPrivacy(patch: SettingsPatch) {
        val before = _state.value.settings ?: Settings()
        _state.update {
            it.copy(
                settings = before.copy(
                    incognito = patch.incognito ?: before.incognito,
                    hideAge = patch.hideAge ?: before.hideAge,
                    hideDistance = patch.hideDistance ?: before.hideDistance,
                    showOnline = patch.showOnline ?: before.showOnline,
                ),
            )
        }
        viewModelScope.launch {
            runCatchingUnlessCancelled { api.updateSettings(patch) }
                .onSuccess { saved -> _state.update { it.copy(settings = saved) } }
                .onFailure { e ->
                    _state.update { it.copy(settings = before) }
                    if ((e as? ApiError.Http)?.code == ProblemCodes.ENTITLEMENT_REQUIRED) {
                        _events.send(SettingsEvent.NeedsPlan)
                    } else {
                        _events.send(SettingsEvent.Notice(failureText(e)))
                    }
                }
        }
    }

    private val dataExport = DataExport(api, clock)

    /** The data export: see [DataExport]. */
    fun export() {
        if (_state.value.exporting) return
        _state.update { it.copy(exporting = true) }
        viewModelScope.launch {
            val event = dataExport.run()
            _state.update { it.copy(exporting = false) }
            _events.send(event)
        }
    }

    private var signingOut = false

    /**
     * Once: a second tap while the first sign-out is on its way does nothing.
     * [everywhere] that the server could not take keeps the person signed in
     * and says why.
     */
    fun signOut(everywhere: Boolean = false) {
        if (signingOut) return
        signingOut = true
        viewModelScope.launch {
            try {
                gate.signOut(allSessions = everywhere)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _events.send(SettingsEvent.Notice(if (e is ApiError.Network) R.string.error_offline else R.string.error_generic))
            } finally {
                signingOut = false
            }
        }
    }

    @StringRes
    private fun failureText(e: Throwable): Int = if (e is ApiError.Network) R.string.error_offline else R.string.settings_save_failed
}
