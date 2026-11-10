package app.core.feature.call

import app.core.ui.theme.CallPalette
import android.content.Context
import android.os.PowerManager
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.add
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.vectorResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import app.core.R
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.brandString
import app.core.model.CallKind
import app.core.ui.components.CallButtonKind
import app.core.ui.components.PhotoToast
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.components.VerifiedBadge
import app.core.ui.theme.Space
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.delay
import java.time.Instant
import kotlin.math.roundToInt

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

    /** The chat with this person: the call goes on in its bubble (or, ringing, is declined first). */
    fun message()
}

/**
 * A call, from "Calling…" (or an incoming call) to "Call ended", voice or
 * video; the same in every template (m12, m13).
 *
 * The other person's photo blurred dark behind everything (`--photo-backdrop-filter`)
 * until their picture arrives; then it fills the screen under a 170 dp top
 * scrim (`--call-scrim-top`) with the name and the timer over it and this
 * phone's own picture in a card that can be dragged, pinched and tapped to
 * swap. Ringing here: the call's kind, the face in its ring, the name,
 * «با یه پیام جواب بده», and decline (left), voice only, answer (right).
 * Otherwise one row of round buttons: flip, microphone, end, camera and
 * message on a video call; speaker, microphone, end and message on a voice
 * call. The line above the face says each phase as it changes (read out by
 * TalkBack): calling, ringing, connecting, the timer, reconnecting, the
 * other person's connection dropping, and how the call ended. Nothing on it
 * is see-through to what is behind the call.
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
    val t = AppTheme.template
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

    Box(modifier.fillMaxSize().background(CallPalette.stage).testTag(CallTags.SCREEN)) {
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
        val big = room != null && stage.big != null
        BoxWithConstraints(Modifier.fillMaxSize().onGloballyPositioned { screenTop = it.boundsInRoot().top }) {
            val roomy = maxHeight >= COMPACT_CALL_HEIGHT
            CallPhotoBackdrop(state.peer.photoUrl, state.peer.blurhash)
            if (big) {
                stage.big?.let { VideoView(it.track, room!!, Modifier.fillMaxSize(), mirror = it.mirror) }
                VideoScrims()
            }
            Column(
                Modifier
                    .fillMaxSize()
                    .windowInsetsPadding(WindowInsets.statusBars.union(WindowInsets(top = CallLayout.statusBar)))
                    .padding(horizontal = Space.gutter),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // The buttons never shrink; what is above them takes what is left, and
                // scrolls on a short screen rather than push the red button off it.
                Column(
                    Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Column(
                        Modifier.fillMaxWidth().onGloballyPositioned { headerBottom = it.boundsInRoot().bottom },
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        if (big) {
                            VideoHeader(state, now)
                        } else {
                            FaceHeader(state, now, showFace = roomy)
                        }
                        CallNotices(state)
                    }
                }
                Column(
                    Modifier
                        .fillMaxWidth()
                        .onGloballyPositioned { controlsTop = it.boundsInRoot().top }
                        .windowInsetsPadding(
                            WindowInsets.navigationBars.add(WindowInsets(bottom = CallLayout.aboveNavigation))
                                .union(WindowInsets(bottom = if (state.ringingHere || phase.isOver) CallLayout.ringBottom else CallLayout.rowBottom)),
                        ),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    if (state.ringingHere) {
                        ReplyAction(actions::message)
                    }
                    if (big && state.muted && phase is CallPhase.Live) {
                        PhotoToast(brandString(R.string.call_mic_off), icon = AppIcons.MicOff, modifier = Modifier.padding(bottom = CallLayout.toastGap))
                    }
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

/**
 * Over the other person's picture (m13): the name (`--type-h3`) and under it
 * the timer or the phase (`--type-caption-strong`), both with
 * `--photo-text-shadow`.
 */
@Composable
private fun VideoHeader(state: CallScreenState, now: () -> Instant) {
    val t = AppTheme.template
    val shadow = t.shadows.photoTextShadow.firstOrNull()?.let {
        androidx.compose.ui.graphics.Shadow(it.color, androidx.compose.ui.geometry.Offset(0f, it.y.value * 2f), it.blur.value * 2f)
    }
    Text(
        state.peer.name.ifBlank { brandString(R.string.call_peer_fallback) },
        style = t.type.h3.copy(shadow = shadow),
        color = t.colors.onPhoto,
        textAlign = TextAlign.Center,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth().padding(top = CallLayout.videoNameTop).semantics { heading() },
    )
    CallStatus(state, now, t.type.captionStrong.copy(shadow = shadow), t.colors.onPhoto)
}

/**
 * The call's own page (m12): the phase or the kind of call above the face
 * (`--type-label-sm`, `--on-photo-2`), the 132 dp face in its ring, the name
 * (`--type-h1`).
 */
@Composable
private fun FaceHeader(state: CallScreenState, now: () -> Instant, showFace: Boolean) {
    val t = AppTheme.template
    Box(Modifier.padding(top = CallLayout.statusTop)) {
        CallStatus(state, now, t.type.labelSm, t.colors.onPhoto2)
    }
    if (showFace) {
        Box(Modifier.padding(top = CallLayout.faceTop)) {
            CallHalo(ringing = state.phase.isRinging || state.phase == CallPhase.Connecting, faceSize = CallLayout.face) {
                CallFace(state.peer.photoUrl, state.peer.blurhash, CallLayout.face)
            }
        }
    }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = if (showFace) CallLayout.nameTop else CallLayout.nameTopCompact, start = Space.gutter, end = Space.gutter)
            .semantics(mergeDescendants = true) { heading() },
        horizontalArrangement = Arrangement.spacedBy(CallLayout.badgeGap, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            state.peer.name.ifBlank { brandString(R.string.call_peer_fallback) },
            style = t.type.h1,
            color = t.colors.onPhoto,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        // The verified mark the conversation carries (`.cname .vf`, 26 px beside the h1).
        if (state.peer.verified) VerifiedBadge(CallLayout.badge)
    }
}

/** «با یه پیام جواب بده»: the call is declined and the chat opens. */
@Composable
private fun ReplyAction(onReply: () -> Unit) {
    val t = AppTheme.template
    Box(
        Modifier
            .padding(bottom = CallLayout.replyGap)
            .heightIn(min = CallLayout.target)
            .clickable(role = Role.Button, onClick = onReply)
            .testTag(CallTags.REPLY)
            .padding(horizontal = CallLayout.replyPad),
        contentAlignment = Alignment.Center,
    ) {
        Text(brandString(R.string.call_action_reply), style = t.type.link, color = t.colors.onPhoto)
    }
}

/** The line about the phase; a failure's short reason under it. Read out as it changes (not the timer). */
@Composable
private fun CallStatus(state: CallScreenState, now: () -> Instant, style: TextStyle, color: androidx.compose.ui.graphics.Color) {
    val t = AppTheme.template
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
                callTimer(((current.toEpochMilli() - phase.since.toEpochMilli()) / 1000).coerceAtLeast(0), rememberLanguage())
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
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
        // "Calling…" fades into "Ringing…", then into the timer, whose seconds
        // change in place. The timer is not a live region (it would be read
        // every second); every other change is.
        AnimatedContent(targetState = if (timer) "timer" else text, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "callStatus") { shown ->
            Text(
                if (shown == "timer") text else shown,
                style = style.copy(fontFeatureSettings = "tnum"),
                color = color,
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
                style = t.type.bodySm,
                color = t.colors.onPhoto2,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = CallLayout.detailTop, start = Space.lg, end = Space.lg).testTag(CallTags.DETAIL),
            )
        }
    }
}

@Composable
private fun CallNotices(state: CallScreenState) {
    val phase = state.phase
    if (phase.isOver) return
    Column(
        Modifier.padding(top = CallLayout.noticesTop),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(CallLayout.noticeGap),
    ) {
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
    if (phase.isOver) {
        EndedButtons(phase as CallPhase.Ended, state.incoming, actions)
        return
    }
    val live = phase is CallPhase.Live
    val routes: @Composable (Dp) -> Unit = { size ->
        CallControl(
            icon = routeIcon(state.routes.selected),
            label = brandString(R.string.call_route_title),
            tag = CallTags.AUDIO,
            size = size,
            onClick = onOpenRoutes,
        )
    }
    val mic: @Composable (Dp) -> Unit = { size ->
        CallControl(
            icon = if (state.muted) AppIcons.MicOff else AppIcons.Mic,
            label = brandString(R.string.call_action_mic),
            tag = CallTags.MUTE,
            on = state.muted,
            // A switch for TalkBack: "Microphone, on" while it hears.
            switchOn = !state.muted,
            // Mute works before the answer too: the call starts muted.
            enabled = !state.onHold,
            size = size,
            onClick = actions::toggleMute,
        )
    }
    val message: @Composable (Dp) -> Unit = { size ->
        CallControl(icon = AppIcons.Message, label = brandString(R.string.call_action_message), tag = CallTags.MESSAGE, size = size, onClick = actions::message)
    }
    val end: @Composable (Dp) -> Unit = { size ->
        CallControl(
            icon = AppIcons.PhoneDown,
            label = brandString(R.string.call_action_hang_up_full),
            tag = CallTags.HANG_UP,
            kind = CallButtonKind.End,
            size = size,
            onClick = actions::hangUp,
        )
    }
    if (state.video) {
        // Start to end, as m13 lays them out: flip, microphone, end, camera, message.
        // With a headset, where the sound goes takes the flip's place while
        // the camera is off, and joins the row while it is on.
        val flip: @Composable (Dp) -> Unit = { size ->
            CallControl(
                icon = AppIcons.FlipCamera,
                label = brandString(R.string.call_action_flip_full),
                tag = CallTags.FLIP,
                enabled = live && state.cameraOn,
                size = size,
                onClick = actions::switchCamera,
            )
        }
        val camera: @Composable (Dp) -> Unit = { size ->
            CallControl(
                icon = if (state.cameraOn) AppIcons.Video else AppIcons.VideoOff,
                label = brandString(R.string.call_action_camera),
                tag = CallTags.CAMERA,
                on = !state.cameraOn,
                switchOn = state.cameraOn,
                enabled = live,
                size = size,
                onClick = actions::toggleCamera,
            )
        }
        val headset = state.routes.hasHeadset
        CallControlRow(
            before = listOf(if (headset && !state.cameraOn) routes else flip, mic),
            end = end,
            after = if (headset && state.cameraOn) listOf(camera, routes, message) else listOf(camera, message),
        )
    } else {
        // A voice call: where the sound goes and the microphone, end in the middle, message.
        val speaker: @Composable (Dp) -> Unit = { size ->
            // Chosen while it rings too: the call starts where it says.
            CallControl(
                icon = AppIcons.Speaker,
                label = brandString(R.string.call_action_speaker),
                tag = CallTags.SPEAKER,
                on = state.speakerOn,
                switchOn = state.speakerOn,
                size = size,
                onClick = actions::toggleSpeaker,
            )
        }
        CallControlRow(before = listOf(if (state.routes.hasHeadset) routes else speaker, mic), end = end, after = listOf(message))
    }
}

/**
 * The live call's row: with as many buttons on each side, the end button in
 * the middle of the design's five slots (56 dp, end 68 dp, two each side).
 * Sides of different sizes (a voice call's four buttons, six with a headset
 * on a video call) are spread edge to edge with equal gaps, so no slot is
 * left empty. Where the width is short every button shrinks alike, never
 * under the 48 dp target.
 */
@Composable
private fun CallControlRow(
    before: List<@Composable (Dp) -> Unit>,
    end: @Composable (Dp) -> Unit,
    after: List<@Composable (Dp) -> Unit>,
) {
    BoxWithConstraints(Modifier.fillMaxWidth().widthIn(max = CallLayout.rowMax)) {
        val slotted = before.size == after.size && before.size <= 2
        val others = if (slotted) 4 else before.size + after.size
        val natural = CALL_ROW_BUTTON * others + CallLayout.end
        val room = maxWidth - CallLayout.rowMinGap * others
        val scale = if (natural <= room) 1f else maxOf(room / natural, CallLayout.target / CALL_ROW_BUTTON)
        val button = CALL_ROW_BUTTON * scale
        val endSize = CallLayout.end * scale
        Layout(
            content = {
                before.forEach { it(button) }
                end(endSize)
                after.forEach { it(button) }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { measurables, constraints ->
            val placeables = measurables.map { it.measure(Constraints()) }
            val width = constraints.maxWidth
            val height = placeables.maxOf { it.height }
            val centres: List<Float> = if (slotted) {
                val b = maxOf(button, CallLayout.target).toPx()
                val e = endSize.toPx()
                val gap = (width - 4 * b - e) / 4f
                val outer = b / 2f
                val inner = b + gap + b / 2f
                fun side(count: Int, edge: Float, near: Float) = when (count) {
                    2 -> listOf(edge, near)
                    1 -> listOf(near)
                    else -> emptyList()
                }
                side(before.size, outer, inner) + (width / 2f) + side(after.size, width - outer, width - inner).reversed()
            } else {
                val gap = (width - placeables.sumOf { it.width }).toFloat() / (placeables.size - 1).coerceAtLeast(1)
                var x = 0f
                placeables.map { p -> (x + p.width / 2f).also { x += p.width + gap } }
            }
            layout(width, height) {
                placeables.forEachIndexed { i, p ->
                    p.placeRelative((centres[i] - p.width / 2f).roundToInt(), (height - p.height) / 2)
                }
            }
        }
    }
}

/** A call that is over: what can be done about it (call again, open the settings), and Close. */
@Composable
private fun EndedButtons(ended: CallPhase.Ended, incoming: Boolean, actions: CallScreenActions) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.Top) {
        when {
            ended.end == CallEnd.NO_MICROPHONE -> LabelledCallButton(
                icon = AppIcons.MicOff,
                label = brandString(R.string.action_open_settings),
                tag = CallTags.SETTINGS,
                onClick = actions::openSettings,
            )
            !incoming && ended.end.retryable -> LabelledCallButton(
                icon = AppIcons.Phone,
                label = brandString(R.string.call_action_retry),
                tag = CallTags.RETRY,
                kind = CallButtonKind.Accept,
                onClick = actions::retry,
            )
        }
        LabelledCallButton(
            icon = AppIcons.Close,
            label = brandString(R.string.call_action_done),
            tag = CallTags.HANG_UP,
            onClick = actions::done,
        )
    }
}

@Composable
private fun routeIcon(route: AudioRoute?): ImageVector = when (route) {
    AudioRoute.Speaker -> AppIcons.Speaker
    AudioRoute.Wired -> ImageVector.vectorResource(R.drawable.ic_call_headset)
    is AudioRoute.Bluetooth -> ImageVector.vectorResource(R.drawable.ic_call_bluetooth)
    AudioRoute.Earpiece, null -> ImageVector.vectorResource(R.drawable.ic_call_handset)
}

/** Where the sound goes, when a headset makes it more than speaker or not: a sheet in the call's own colours. */
@Composable
private fun AudioRouteSheet(routes: AudioRoutes, onSelect: (AudioRoute) -> Unit, onDismiss: () -> Unit) {
    val t = AppTheme.template
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        // The scrim closes the list; a sibling of it, so its click does not swallow the list's own.
        Box(
            Modifier
                .fillMaxSize()
                .background(t.colors.scrim)
                .clickable(onClick = onDismiss, onClickLabel = brandString(R.string.action_close)),
        )
        Box(
            Modifier
                .fillMaxWidth()
                .widthIn(max = CallLayout.sheetMax)
                .background(CallPalette.tile, RoundedCornerShape(topStart = t.radii.sheet, topEnd = t.radii.sheet))
                // The sheet takes its own taps (its title, its padding): only the scrim around it closes the list.
                .pointerInput(Unit) {}
                .testTag(CallTags.ROUTES),
        ) {
            Column(Modifier.navigationBarsPadding().padding(start = Space.gutter, end = Space.gutter, top = CallLayout.sheetTop, bottom = CallLayout.sheetBottom)) {
                Text(
                    brandString(R.string.call_route_title),
                    style = t.type.h2,
                    color = t.colors.onPhoto,
                    modifier = Modifier.padding(bottom = CallLayout.sheetTitleGap).semantics { heading() },
                )
                routes.available.forEach { route ->
                    val selected = route == routes.selected
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = CallLayout.sheetRow)
                            .selectable(selected = selected, role = Role.RadioButton, onClick = { onSelect(route) }),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(CallLayout.sheetGap),
                    ) {
                        Icon(routeIcon(route), contentDescription = null, tint = t.colors.onPhoto)
                        Text(routeName(route), style = t.type.bodyStrong, color = t.colors.onPhoto, modifier = Modifier.weight(1f))
                        if (selected) Icon(AppIcons.Check, contentDescription = brandString(R.string.call_route_selected), tint = t.colors.onPhoto)
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

/** The call screen's layout, from the design's 412 × 892 boards (m12, m13; status bar 32 dp). */
internal object CallLayout {
    val statusBar = 32.dp

    /** m12: the kind of call at 132, the face's ring from 178, the name at 350. */
    val statusTop = 100.dp
    val badge = 26.dp
    val badgeGap = 8.dp
    val face = 132.dp
    val faceTop = 24.dp
    val nameTop = 26.dp
    val nameTopCompact = 16.dp
    val detailTop = 4.dp
    val noticesTop = 12.dp
    val noticeGap = 8.dp

    /** m13: the name 12 dp under the status bar. */
    val videoNameTop = 12.dp

    /** The ring's buttons end 64 dp from the bottom; a live call's row 44 dp. */
    val ringBottom = 64.dp
    val rowBottom = 44.dp
    val aboveNavigation = 16.dp
    val replyGap = 32.dp
    val replyPad = 12.dp
    val target = 48.dp
    val rowMinGap = 4.dp
    val toastGap = 38.dp
    val rowMax = 440.dp
    val end = 68.dp
    val sheetMax = 520.dp
    val sheetTop = 20.dp
    val sheetBottom = 16.dp
    val sheetTitleGap = 8.dp
    val sheetRow = 52.dp
    val sheetGap = 16.dp
}

/** The language on screen, for the reader's digits. */
@Composable
internal fun rememberLanguage(): AppLanguage {
    val locale = LocalConfiguration.current.locales[0]
    return remember(locale) { AppLanguage.fromTag(locale?.toLanguageTag()) ?: AppLanguage.EN }
}

/**
 * The call's timer: `mm:ss` (m13 «۰۴:۱۲»), or `h:mm:ss` from an hour on, in
 * the reader's digits.
 */
fun callTimer(seconds: Long, language: AppLanguage): String {
    val total = seconds.coerceAtLeast(0)
    if (total >= 3600) return callDuration(total, language)
    return Digits.localize("%02d:%02d".format(java.util.Locale.ROOT, total / 60, total % 60), language)
}

/**
 * `m:ss`, or `h:mm:ss` from an hour on, in the reader's digits: the length
 * of a voice message.
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
