package app.core.feature.call

import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.LocalAppGraph
import app.core.R
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.card.isolate
import app.core.i18n.brandString
import app.core.model.CallKind
import app.core.model.CallSwitches
import app.core.model.Conversation
import app.core.model.ConversationPatch
import app.core.model.ConversationState
import app.core.model.Id
import app.core.net.ServerApi
import app.core.push.CallNotifications
import app.core.ui.theme.Space
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The match's call switch: "Allow calls with {name}", one per conversation
 * (`PATCH /v1/conversations/:id {allowCalls}`). A call is possible only when
 * both turned it on; the server folds each person's general "accept calls"
 * setting into the same pair, so this phone only reads `callsAllowed`.
 *
 * The switch moves at once and says "Saving…"; a refusal puts it back and
 * says so. The server's answer (and the realtime `conversation` event both
 * phones get) is the truth; [updated] carries the answer for the conversation
 * list to keep.
 */
class CallConsent(
    private val apiOf: () -> ServerApi,
    private val scope: CoroutineScope,
    private val onChanged: (Conversation) -> Unit = {},
) {
    sealed interface Save {
        data class Saving(val allow: Boolean) : Save
        data class Failed(val allow: Boolean) : Save
    }

    private val _saves = MutableStateFlow<Map<Id, Save>>(emptyMap())
    val saves: StateFlow<Map<Id, Save>> = _saves.asStateFlow()

    private val _updated = MutableSharedFlow<Conversation>(extraBufferCapacity = 8)
    val updated: SharedFlow<Conversation> = _updated.asSharedFlow()

    /** What this phone shows for its own side of the switch: the save in flight, else the conversation's. */
    fun shownAllow(conversation: Conversation, saves: Map<Id, Save>): Boolean = when (val save = saves[conversation.id]) {
        is Save.Saving -> save.allow
        else -> conversation.callsAllowed.me
    }

    fun set(conversation: Conversation, allow: Boolean) {
        if (_saves.value[conversation.id] is Save.Saving) return
        _saves.update { it + (conversation.id to Save.Saving(allow)) }
        scope.launch {
            runCatchingUnlessCancelled { apiOf().updateConversation(conversation.id, ConversationPatch(allowCalls = allow)) }
                .onSuccess { changed ->
                    _saves.update { it - conversation.id }
                    onChanged(changed)
                    _updated.tryEmit(changed)
                }
                .onFailure { _saves.update { it + (conversation.id to Save.Failed(allow)) } }
        }
    }

    fun clearFailure(conversationId: Id) {
        _saves.update { if (it[conversationId] is Save.Failed) it - conversationId else it }
    }
}

/** What the chat header's call buttons show. */
data class CallHeaderState(
    val peerName: String,
    val both: Boolean,
    val switches: CallSwitches,
    val active: Boolean,
) {
    val canAudio: Boolean get() = active && both && switches.audio
    val canVideo: Boolean get() = active && both && switches.video
}

/**
 * The call buttons of a conversation's header, with the match's call
 * settings: voice and video when both allow calls (and calls are on), else one
 * dimmed phone that opens the settings, where the switch is. [settingsOpen] can
 * be shared with the chat's own menu, which may open the same settings.
 */
@Composable
fun MatchCallActions(conversation: Conversation, settingsOpen: MutableState<Boolean> = remember { mutableStateOf(false) }) {
    val graph = LocalAppGraph.current
    val calls = graph.calls
    val config by graph.config.config.collectAsStateWithLifecycle()
    val saves by calls.consent.saves.collectAsStateWithLifecycle()
    LaunchedEffect(conversation) { calls.remember(conversation) }
    val switches = config?.calls ?: CallSwitches()
    val shownMe = calls.consent.shownAllow(conversation, saves)
    val header = CallHeaderState(
        peerName = conversation.peer.name,
        both = shownMe && conversation.callsAllowed.peer && saves[conversation.id] == null,
        switches = switches,
        active = conversation.state == ConversationState.Active,
    )
    val peer = CallPeer(conversation.id, conversation.peer.name, conversation.peer.photo?.url, conversation.peer.photo?.blurhash)
    CallHeaderButtons(header, onCall = { kind -> calls.controller.requestCall(peer, kind) }, onOpenSettings = { settingsOpen.value = true })
    if (settingsOpen.value) {
        val context = LocalContext.current
        var ready by remember { mutableStateOf(CallReadiness.of(context)) }
        LifecycleResumeEffect(Unit) {
            ready = CallReadiness.of(context)
            onPauseOrDispose { }
        }
        CallSettingsSheet(
            state = CallSettingsState(
                peerName = conversation.peer.name,
                allowMe = shownMe,
                allowPeer = conversation.callsAllowed.peer,
                saving = saves[conversation.id] is CallConsent.Save.Saving,
                failed = saves[conversation.id] is CallConsent.Save.Failed,
                switches = switches,
                active = conversation.state == ConversationState.Active,
                readiness = ready,
            ),
            onToggle = { allow -> calls.consent.set(conversation, allow) },
            onCall = { kind ->
                settingsOpen.value = false
                calls.controller.requestCall(peer, kind)
            },
            onEnableNotifications = { openNotificationSettings(context) },
            onAllowFullScreen = { openFullScreenSettings(context) },
            onDismiss = {
                calls.consent.clearFailure(conversation.id)
                settingsOpen.value = false
            },
        )
    }
}

/** The header's buttons, from a state alone. */
@Composable
fun CallHeaderButtons(state: CallHeaderState, onCall: (CallKind) -> Unit, onOpenSettings: () -> Unit) {
    val name = isolate(state.peerName)
    if (state.canAudio || state.canVideo) {
        Row {
            if (state.canAudio) {
                IconButton(onClick = { onCall(CallKind.Audio) }, modifier = Modifier.testTag(CallTags.HEADER_AUDIO)) {
                    Icon(painterResource(R.drawable.ic_call_phone), contentDescription = brandString(R.string.call_header_audio, name))
                }
            }
            if (state.canVideo) {
                IconButton(onClick = { onCall(CallKind.Video) }, modifier = Modifier.testTag(CallTags.HEADER_VIDEO)) {
                    Icon(painterResource(R.drawable.ic_call_videocam), contentDescription = brandString(R.string.call_header_video, name))
                }
            }
        }
    } else if (state.active) {
        IconButton(onClick = onOpenSettings, modifier = Modifier.testTag(CallTags.HEADER_SETTINGS)) {
            Icon(
                painterResource(R.drawable.ic_call_phone),
                contentDescription = brandString(R.string.call_header_off, name),
                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
            )
        }
    }
}

/** What stands between this phone and a ring that is seen: notifications, and full-screen rings (Android 14+). */
data class CallReadiness(val notifications: Boolean, val fullScreen: Boolean) {
    companion object {
        fun of(context: android.content.Context) = CallReadiness(
            notifications = CallNotifications.canPost(context),
            fullScreen = CallNotifications.canUseFullScreen(context),
        )
    }
}

data class CallSettingsState(
    val peerName: String,
    val allowMe: Boolean,
    val allowPeer: Boolean,
    val saving: Boolean,
    val failed: Boolean,
    val switches: CallSwitches,
    val active: Boolean,
    val readiness: CallReadiness,
) {
    val anyKind: Boolean get() = switches.audio || switches.video
}

/** The match's call settings: the switch, where it stands for both, and what the phone still needs for a ring. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallSettingsSheet(
    state: CallSettingsState,
    onToggle: (Boolean) -> Unit,
    onCall: (CallKind) -> Unit,
    onEnableNotifications: () -> Unit,
    onAllowFullScreen: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        CallSettingsContent(state, onToggle, onCall, onEnableNotifications, onAllowFullScreen, onDismiss)
    }
}

/** The sheet's content, drawable on its own (tests, previews). */
@Composable
fun CallSettingsContent(
    state: CallSettingsState,
    onToggle: (Boolean) -> Unit,
    onCall: (CallKind) -> Unit,
    onEnableNotifications: () -> Unit,
    onAllowFullScreen: () -> Unit,
    onDismiss: () -> Unit,
) {
    val name = isolate(state.peerName)
    Column(
        Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = Space.xl).padding(bottom = Space.xl),
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Text(brandString(R.string.call_settings_title, name), style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        if (!state.anyKind) {
            Text(brandString(R.string.call_settings_unavailable), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .toggleable(value = state.allowMe, enabled = !state.saving && state.active, role = Role.Switch, onValueChange = onToggle)
                    .testTag(CallTags.CONSENT),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(brandString(R.string.call_settings_toggle, name), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                Switch(checked = state.allowMe, onCheckedChange = null, enabled = !state.saving && state.active)
            }
            val line = when {
                state.saving -> R.string.call_settings_saving
                state.failed -> R.string.call_settings_failed
                state.allowMe && state.allowPeer -> R.string.call_settings_both
                state.allowMe -> R.string.call_settings_waiting
                else -> R.string.call_settings_off
            }
            Text(
                if (line == R.string.call_settings_waiting) brandString(line, name) else brandString(line),
                style = MaterialTheme.typography.bodyMedium,
                color = if (state.failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag(CallTags.CONSENT_LINE),
            )
            Text(brandString(R.string.call_settings_body), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!state.readiness.notifications) {
                Readiness(brandString(R.string.call_ready_notifications), brandString(R.string.call_ready_notifications_action), onEnableNotifications)
            } else if (!state.readiness.fullScreen) {
                Readiness(brandString(R.string.call_ready_full_screen), brandString(R.string.call_ready_full_screen_action), onAllowFullScreen)
            }
            if (state.allowMe && state.allowPeer && !state.saving && state.active) {
                Row(horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                    if (state.switches.audio) {
                        FilledTonalButton(onClick = { onCall(CallKind.Audio) }) {
                            Icon(painterResource(R.drawable.ic_call_phone), contentDescription = null, modifier = Modifier.size(18.dp))
                            Text(brandString(R.string.call_settings_voice), modifier = Modifier.padding(start = Space.sm))
                        }
                    }
                    if (state.switches.video) {
                        FilledTonalButton(onClick = { onCall(CallKind.Video) }) {
                            Icon(painterResource(R.drawable.ic_call_videocam), contentDescription = null, modifier = Modifier.size(18.dp))
                            Text(brandString(R.string.call_settings_video), modifier = Modifier.padding(start = Space.sm))
                        }
                    }
                }
            }
        }
        TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) { Text(brandString(R.string.action_close)) }
    }
}

@Composable
private fun Readiness(text: String, action: String, onClick: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Text(text, style = MaterialTheme.typography.bodyMedium)
        OutlinedButton(onClick = onClick) { Text(action) }
    }
}

/** The app's notification settings, where notifications (and so rings) are turned on. */
internal fun openNotificationSettings(context: android.content.Context) {
    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
    } else {
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.fromParts("package", context.packageName, null))
    }
    runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

/**
 * Gives the conversation screens their call parts: the header's call buttons
 * (with the match's call settings) and "call back" on a call line. Wrapped
 * around the app's navigation, so every conversation on screen has them.
 */
@Composable
fun ProvideCallsToChat(content: @Composable () -> Unit) {
    val calls = LocalAppGraph.current.calls
    val callBack = remember(calls) {
        { conversation: Conversation, kind: CallKind ->
            calls.remember(conversation)
            calls.controller.requestCall(
                CallPeer(conversation.id, conversation.peer.name, conversation.peer.photo?.url, conversation.peer.photo?.blurhash),
                kind,
            )
            Unit
        }
    }
    androidx.compose.runtime.CompositionLocalProvider(
        app.core.feature.chat.LocalChatHeaderActions provides { conversation -> MatchCallActions(conversation) },
        app.core.feature.chat.LocalChatCallBack provides callBack,
        content = content,
    )
}
