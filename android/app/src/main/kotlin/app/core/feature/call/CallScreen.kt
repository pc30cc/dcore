package app.core.feature.call

import android.content.Context
import android.os.PowerManager
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import app.core.R
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.brandString
import app.core.model.CallKind
import app.core.ui.theme.Space
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.delay
import java.time.Instant

/** Everything the call screen draws, from the session's flows (or a test). */
data class CallScreenState(
    val phase: CallPhase,
    val incoming: Boolean,
    val kind: CallKind,
    val peer: CallPeer,
    val muted: Boolean = false,
    val cameraOn: Boolean = false,
    val frontCamera: Boolean = true,
    val speakerOn: Boolean = false,
    val routes: AudioRoutes = AudioRoutes(),
    val relayWarning: Boolean = false,
    val degraded: CallDegradation? = null,
    val weakNetwork: Boolean = false,
    val onHold: Boolean = false,
) {
    val ringingHere: Boolean get() = incoming && phase == CallPhase.Ringing
    val video: Boolean get() = kind == CallKind.Video
}

/** What the call screen's buttons do. */
interface CallScreenActions {
    fun answer()
    fun answerVoiceOnly()
    fun decline()
    fun hangUp()
    fun toggleMute()
    fun toggleCamera()
    fun switchCamera()
    fun toggleSpeaker()
    fun selectRoute(route: AudioRoute)
    fun minimise()
    fun done()
    fun retry()
    fun openSettings()
}

/**
 * A call, from "Calling…" (or "Incoming video call") to "Call ended", voice
 * or video.
 *
 * The match's face in the middle on the call's own dark backdrop, the
 * controls at the bottom where the thumb is, and on a video call the other
 * person's picture edge to edge with this phone's own in a card that can be
 * dragged, pinched and tapped to swap. Every phase has its own line under the
 * name, read out by TalkBack as it changes: calling, ringing, connecting,
 * the timer, reconnecting, the other person's connection dropping, and how
 * the call ended. Nothing on it is translucent: the lock screen never shows
 * through a call.
 */
@Composable
fun CallScreen(
    state: CallScreenState,
    actions: CallScreenActions,
    modifier: Modifier = Modifier,
    room: LiveKitRoom? = null,
    remoteVideo: VideoTrack? = null,
    localVideo: VideoTrack? = null,
    now: () -> Instant = Instant::now,
) {
    val phase = state.phase
    // A video call is watched, not touched: kept awake. A voice call at the
    // ear turns the screen off with the proximity sensor instead.
    val view = LocalView.current
    val awake = state.video && !phase.isOver
    DisposableEffect(view, awake) {
        if (awake) view.keepScreenOn = true
        onDispose { if (awake) view.keepScreenOn = false }
    }
    ProximityScreenOff(active = !state.video && !state.speakerOn && !state.routes.hasHeadset && !phase.isOver && !state.ringingHere)

    var routesOpen by remember { mutableStateOf(false) }
    BackHandler(enabled = routesOpen) { routesOpen = false }

    Box(modifier.fillMaxSize().background(CALL_BACKGROUND).testTag(CallTags.SCREEN)) {
        var screenTop by remember { mutableFloatStateOf(0f) }
        var headerBottom by remember { mutableFloatStateOf(0f) }
        var controlsTop by remember { mutableFloatStateOf(Float.MAX_VALUE) }
        val own = localVideo?.takeIf { room != null && state.cameraOn }
        var swapped by rememberStageSwap(own)
        val stage = CallStage.of(
            remote = remoteVideo?.takeIf { room != null },
            // A phone sends its camera's picture as the camera saw it.
            remoteMirror = false,
            own = own,
            // A front camera's own preview is a mirror; the back camera's is not.
            ownMirror = state.frontCamera,
            swapped = swapped,
        )
        CompositionLocalProvider(LocalContentColor provides Color.White) {
            BoxWithConstraints(Modifier.fillMaxSize().onGloballyPositioned { screenTop = it.boundsInRoot().top }) {
                val faceSize = callFaceSize(maxHeight, incoming = state.ringingHere)
                val roomy = maxHeight >= COMPACT_CALL_HEIGHT
                CallBackdrop()
                if (room != null) {
                    stage.big?.let {
                        VideoView(it.track, room, Modifier.fillMaxSize(), mirror = it.mirror)
                        VideoScrims()
                    }
                }
                Column(
                    Modifier
                        .fillMaxSize()
                        .statusBarsPadding()
                        .navigationBarsPadding()
                        .padding(horizontal = Space.gutter),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    TopBar(onMinimise = actions::minimise, show = !phase.isOver && !state.ringingHere)
                    // The controls never shrink; the name and the face take what
                    // is left, and scroll on a short screen rather than push the
                    // red button off it.
                    Column(
                        Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Column(
                            Modifier
                                .padding(top = if (stage.big == null) Space.xl else Space.sm)
                                .onGloballyPositioned { headerBottom = it.boundsInRoot().bottom },
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(Space.md),
                        ) {
                            AnimatedVisibility(
                                visible = stage.big == null && roomy,
                                enter = fadeIn() + scaleIn(initialScale = 0.9f),
                                exit = fadeOut() + scaleOut(targetScale = 0.9f),
                            ) {
                                CallHalo(ringing = phase.isRinging || phase == CallPhase.Connecting, faceSize = faceSize) {
                                    CallFace(state.peer.photoUrl, state.peer.blurhash, faceSize)
                                }
                            }
                            Text(
                                state.peer.name.ifBlank { brandString(R.string.call_peer_fallback) },
                                style = if (stage.big == null) MaterialTheme.typography.headlineMedium else MaterialTheme.typography.titleLarge,
                                textAlign = TextAlign.Center,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.fillMaxWidth().semantics { heading() },
                            )
                            CallStatus(state, now)
                            CallNotices(state)
                        }
                    }
                    Box(Modifier.onGloballyPositioned { controlsTop = it.boundsInRoot().top }) {
                        CallControls(state, actions, onOpenRoutes = { routesOpen = true })
                    }
                }
                if (room != null && stage.hasCard && controlsTop != Float.MAX_VALUE) {
                    SelfView(
                        areaTop = headerBottom - screenTop,
                        areaBottom = controlsTop - screenTop,
                        peerName = state.peer.name,
                        swapped = stage.swapped,
                        onSwap = { swapped = !swapped },
                    ) {
                        StageCardContent(stage.small, room) { size -> CallFace(state.peer.photoUrl, state.peer.blurhash, size) }
                    }
                }
                if (routesOpen && !phase.isOver) {
                    AudioRouteSheet(state.routes, onSelect = { route ->
                        routesOpen = false
                        actions.selectRoute(route)
                    }, onDismiss = { routesOpen = false })
                }
            }
        }
    }
}

@Composable
private fun TopBar(onMinimise: () -> Unit, show: Boolean) {
    Row(Modifier.fillMaxWidth().padding(top = Space.sm), verticalAlignment = Alignment.CenterVertically) {
        if (show) {
            Surface(
                onClick = onMinimise,
                shape = CircleShape,
                color = Color.White.copy(alpha = 0.14f),
                contentColor = Color.White,
                modifier = Modifier.size(Space.minTouch).testTag(CallTags.MINIMISE),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.KeyboardArrowDown, contentDescription = brandString(R.string.call_action_minimise), modifier = Modifier.size(28.dp))
                }
            }
        } else {
            Spacer(Modifier.size(Space.minTouch))
        }
    }
}

/** The line under the name; a failure's short reason under it. Read out as it changes. */
@Composable
private fun CallStatus(state: CallScreenState, now: () -> Instant) {
    val phase = state.phase
    val name = state.peer.name.ifBlank { brandString(R.string.call_peer_fallback) }
    val text = when (phase) {
        CallPhase.Placing -> brandString(R.string.call_status_calling)
        CallPhase.Ringing -> when {
            !state.incoming -> brandString(R.string.call_status_ringing)
            state.video -> brandString(R.string.call_status_incoming_video)
            else -> brandString(R.string.call_status_incoming_audio)
        }
        CallPhase.Connecting -> brandString(R.string.call_status_connecting)
        is CallPhase.Live -> when {
            phase.reconnecting -> brandString(R.string.call_status_reconnecting)
            phase.peerAway -> brandString(R.string.call_status_peer_away, app.core.feature.card.isolate(name))
            else -> {
                var current by remember { mutableStateOf(now()) }
                LaunchedEffect(phase.since) {
                    while (true) {
                        current = now()
                        delay(1_000 - current.toEpochMilli() % 1_000)
                    }
                }
                callDuration(((current.toEpochMilli() - phase.since.toEpochMilli()) / 1000).coerceAtLeast(0), rememberLanguage())
            }
        }
        is CallPhase.Ended -> brandString(phase.end.title(state.kind))
    }
    val timer = phase is CallPhase.Live && !phase.reconnecting && !phase.peerAway
    val detail = (phase as? CallPhase.Ended)?.let { ended ->
        when {
            ended.end == CallEnd.NO_MICROPHONE -> brandString(R.string.call_end_no_microphone_body)
            else -> ended.detail?.takeIf { it.isNotBlank() && ended.end == CallEnd.FAILED }
        }
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs), modifier = Modifier.fillMaxWidth()) {
        // "Calling…" fades into "Ringing…", then into the timer, whose seconds
        // change in place. The timer is not a live region (it would be read
        // every second); every other change is.
        AnimatedContent(targetState = if (timer) "timer" else text, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "callStatus") { shown ->
            Text(
                if (shown == "timer") text else shown,
                style = MaterialTheme.typography.titleMedium.copy(fontFeatureSettings = "tnum"),
                color = Color.White.copy(alpha = 0.86f),
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(CallTags.STATUS)
                    .then(if (timer) Modifier else Modifier.semantics { liveRegion = LiveRegionMode.Polite }),
            )
        }
        if (detail != null) {
            Text(
                detail,
                style = MaterialTheme.typography.bodyMedium,
                color = Color.White.copy(alpha = 0.72f),
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(horizontal = Space.lg).testTag(CallTags.DETAIL),
            )
        }
    }
}

@Composable
private fun CallNotices(state: CallScreenState) {
    val phase = state.phase
    if (phase.isOver) return
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        if (state.onHold) CallNotice(brandString(R.string.call_notice_on_hold))
        if (phase is CallPhase.Live && state.weakNetwork && !phase.reconnecting) CallNotice(brandString(R.string.call_notice_weak))
        if (state.relayWarning) CallNotice(brandString(R.string.call_notice_relay))
        state.degraded?.let { CallNotice(brandString(it.title)) }
    }
}

@Composable
private fun CallControls(state: CallScreenState, actions: CallScreenActions, onOpenRoutes: () -> Unit) {
    val phase = state.phase
    if (state.ringingHere) {
        IncomingCallButtons(
            video = state.video,
            onDecline = actions::decline,
            onAnswer = actions::answer,
            onAnswerVoiceOnly = if (state.video) actions::answerVoiceOnly else null,
        )
        return
    }
    val live = phase is CallPhase.Live
    Column(
        Modifier.fillMaxWidth().padding(bottom = Space.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.xl),
    ) {
        if (!phase.isOver) {
            Row(Modifier.fillMaxWidth().widthIn(max = 440.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.Top) {
                CallButton(
                    icon = if (state.muted) R.drawable.ic_call_mic_off else R.drawable.ic_call_mic,
                    label = brandString(if (state.muted) R.string.call_action_unmute else R.string.call_action_mute),
                    tag = CallTags.MUTE,
                    on = state.muted,
                    toggle = true,
                    // Mute works before the answer too: the call starts muted.
                    enabled = !state.onHold,
                    onClick = actions::toggleMute,
                )
                if (state.video) {
                    CallButton(
                        icon = if (state.cameraOn) R.drawable.ic_call_videocam else R.drawable.ic_call_videocam_off,
                        label = brandString(if (state.cameraOn) R.string.call_action_camera_off else R.string.call_action_camera_on),
                        caption = brandString(R.string.call_action_camera),
                        tag = CallTags.CAMERA,
                        on = !state.cameraOn,
                        toggle = true,
                        enabled = live,
                        onClick = actions::toggleCamera,
                    )
                    CallButton(
                        icon = R.drawable.ic_call_flip,
                        label = brandString(R.string.call_action_flip_full),
                        caption = brandString(R.string.call_action_flip),
                        tag = CallTags.FLIP,
                        enabled = live && state.cameraOn,
                        onClick = actions::switchCamera,
                    )
                }
                if (state.routes.hasHeadset) {
                    CallButton(
                        icon = routeIcon(state.routes.selected),
                        label = brandString(R.string.call_route_title),
                        caption = brandString(R.string.call_action_audio),
                        tag = CallTags.AUDIO,
                        onClick = onOpenRoutes,
                    )
                } else if (!state.video) {
                    // Chosen while it rings too: the call starts where it says.
                    CallButton(
                        icon = R.drawable.ic_call_speaker,
                        label = brandString(R.string.call_action_speaker),
                        tag = CallTags.SPEAKER,
                        on = state.speakerOn,
                        toggle = true,
                        onClick = actions::toggleSpeaker,
                    )
                }
            }
            CallButton(
                icon = R.drawable.ic_call_end,
                label = brandString(R.string.call_action_hang_up_full),
                caption = brandString(R.string.call_action_hang_up),
                tag = CallTags.HANG_UP,
                tint = CALL_END_RED,
                onClick = actions::hangUp,
                diameter = PRIMARY_SIZE,
            )
        } else {
            EndedButtons(phase as CallPhase.Ended, state.incoming, actions)
        }
    }
}

/** A call that is over: Close, and what can be done about it (call again, open the settings). */
@Composable
private fun EndedButtons(ended: CallPhase.Ended, incoming: Boolean, actions: CallScreenActions) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.Top) {
        when {
            ended.end == CallEnd.NO_MICROPHONE -> CallButton(
                icon = R.drawable.ic_call_mic_off,
                label = brandString(R.string.action_open_settings),
                tag = CallTags.SETTINGS,
                onClick = actions::openSettings,
                diameter = PRIMARY_SIZE,
            )
            !incoming && ended.end.retryable -> CallButton(
                icon = R.drawable.ic_call_phone,
                label = brandString(R.string.call_action_retry),
                tag = CallTags.RETRY,
                tint = CALL_ANSWER_GREEN,
                onClick = actions::retry,
                diameter = PRIMARY_SIZE,
            )
        }
        CallButton(
            icon = R.drawable.ic_call_close,
            label = brandString(R.string.call_action_done),
            tag = CallTags.HANG_UP,
            tint = CALL_DONE_GREY,
            onClick = actions::done,
            diameter = PRIMARY_SIZE,
        )
    }
}

private fun routeIcon(route: AudioRoute?): Int = when (route) {
    AudioRoute.Speaker -> R.drawable.ic_call_speaker
    AudioRoute.Wired -> R.drawable.ic_call_headset
    is AudioRoute.Bluetooth -> R.drawable.ic_call_bluetooth
    AudioRoute.Earpiece, null -> R.drawable.ic_call_handset
}

/** Where the sound goes, when a headset makes it more than speaker or not. */
@Composable
private fun AudioRouteSheet(routes: AudioRoutes, onSelect: (AudioRoute) -> Unit, onDismiss: () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        // The scrim closes the list; a sibling of it, so its click does not swallow the list's own.
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.55f))
                .clickable(onClick = onDismiss, onClickLabel = brandString(R.string.action_close)),
        )
        Surface(
            color = CALL_TILE,
            contentColor = Color.White,
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
            modifier = Modifier.fillMaxWidth().widthIn(max = 520.dp).testTag(CallTags.ROUTES),
        ) {
            Column(Modifier.navigationBarsPadding().padding(vertical = Space.lg)) {
                Text(
                    brandString(R.string.call_route_title),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(horizontal = Space.xl, vertical = Space.sm).semantics { heading() },
                )
                routes.available.forEach { route ->
                    val selected = route == routes.selected
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 56.dp)
                            .selectable(selected = selected, role = Role.RadioButton, onClick = { onSelect(route) })
                            .padding(horizontal = Space.xl),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Space.lg),
                    ) {
                        Icon(painterResource(routeIcon(route)), contentDescription = null)
                        Text(routeName(route), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                        if (selected) Icon(Icons.Filled.Check, contentDescription = brandString(R.string.call_route_selected))
                    }
                }
            }
        }
    }
}

@Composable
private fun routeName(route: AudioRoute): String = when (route) {
    AudioRoute.Earpiece -> brandString(R.string.call_route_earpiece)
    AudioRoute.Speaker -> brandString(R.string.call_route_speaker)
    AudioRoute.Wired -> brandString(R.string.call_route_wired)
    is AudioRoute.Bluetooth -> route.name.ifBlank { "Bluetooth" }
}

/** The language on screen, for the reader's digits. */
@Composable
internal fun rememberLanguage(): AppLanguage {
    val locale = LocalConfiguration.current.locales[0]
    return remember(locale) { AppLanguage.fromTag(locale?.toLanguageTag()) ?: AppLanguage.EN }
}

/**
 * `m:ss`, or `h:mm:ss` from an hour on, in the reader's digits: the call's
 * timer and the length of a call in the chat.
 */
fun callDuration(seconds: Long, language: AppLanguage): String {
    val total = seconds.coerceAtLeast(0)
    val hours = total / 3600
    val minutes = (total % 3600) / 60
    val secs = total % 60
    val text = if (hours > 0) "%d:%02d:%02d".format(java.util.Locale.ROOT, hours, minutes, secs) else "%d:%02d".format(java.util.Locale.ROOT, minutes, secs)
    return Digits.localize(text, language)
}

/**
 * The screen off while the phone is at the ear on a voice call on the
 * earpiece: a cheek on the glass must not mute or hang up the call. The
 * platform's own proximity lock, held only while [active].
 */
@Composable
private fun ProximityScreenOff(active: Boolean) {
    val context = LocalContext.current
    DisposableEffect(context, active) {
        val lock = if (active) proximityLock(context)?.also { runCatching { it.acquire(PROXIMITY_MAX_MS) } } else null
        onDispose {
            lock?.let { held -> runCatching { if (held.isHeld) held.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY) } }
        }
    }
}

private fun proximityLock(context: Context): PowerManager.WakeLock? {
    val power = ContextCompat.getSystemService(context, PowerManager::class.java) ?: return null
    if (!power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return null
    return runCatching { power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, PROXIMITY_TAG).apply { setReferenceCounted(false) } }.getOrNull()
}

/** For the system's diagnostics: what holds the lock, never who is on the call. */
private const val PROXIMITY_TAG = "app:call-proximity"

/** Longer than any call; released at its end. A bound so a lock is never held for ever. */
private const val PROXIMITY_MAX_MS = 4 * 60 * 60 * 1000L
