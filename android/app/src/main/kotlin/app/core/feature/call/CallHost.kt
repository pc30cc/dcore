package app.core.feature.call

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.LocalAppGraph
import app.core.model.CallKind
import app.core.push.CallNotifications
import app.core.push.OpenTarget
import app.core.push.IncomingCallLink
import app.core.realtime.RealtimeCoordinator
import app.core.ui.theme.BarIcons
import app.core.ui.theme.SystemBarsOverride
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * What the one activity does for calls, in four calls from its own
 * lifecycle: [onCreate], [onNewIntent], [onUserLeaveHint], [onDestroy].
 *
 * A ring's Answer or tap reaches the activity as an intent; only one that
 * names a call ringing on this phone right now is acted on (the activity is
 * exported, so any app could hand it an intent shaped like a ring's). Over the
 * lock screen only for the call, and only while it is on screen.
 */
class CallActivityHooks(
    private val activity: ComponentActivity,
    private val calls: CallGraph,
    /** The realtime socket the calls follow while the app is in front. */
    private val realtime: () -> RealtimeCoordinator,
) {

    val pictureInPicture = CallPictureInPicture(activity)

    fun onCreate(savedInstanceState: Bundle?) {
        pictureInPicture.attach()
        calls.listenTo(realtime())
        // A recreated activity's intent was already followed.
        if (savedInstanceState == null) handle(activity.intent)
    }

    /** True when [intent] was a ring's, handled or dropped. */
    fun onNewIntent(intent: Intent): Boolean {
        if (IncomingCallLink.from(intent) != null) pictureInPicture.notificationOpened()
        return handle(intent)
    }

    fun onUserLeaveHint() = pictureInPicture.onUserLeaveHint()

    fun onDestroy() = pictureInPicture.detach()

    private fun handle(intent: Intent?): Boolean {
        val link = runCatching { IncomingCallLink.from(intent) }.getOrNull() ?: return false
        // Reopened from Recents after the process died: that tap was followed.
        if (intent != null && intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return true
        val onScreen = calls.controller.session.value?.callId == link.callId
        if (!onScreen && !CallNotifications.isRinging(activity, link.callId)) return true
        showOverLockScreen(true)
        if (!calls.controller.openRing(link)) {
            showOverLockScreen(false)
            return true
        }
        if (link.answer) {
            calls.silenceRing(link.callId)
            calls.controller.requestAnswer(withVideo = link.kind == CallKind.Video)
        }
        return true
    }

    /**
     * Runs [then] with the phone unlocked: at once when it is not locked, else
     * once the person unlocks it (the system's bouncer, Android 8+). Cancelled
     * or refused, nothing runs and the call screen stays. Android 7 has no
     * such request: the screen leaves the lock screen first, so whatever
     * [then] opens is behind the keyguard until the phone is unlocked.
     */
    fun unlockThen(then: () -> Unit) {
        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        if (keyguard == null || !keyguard.isKeyguardLocked) {
            then()
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            showOverLockScreen(false)
            then()
            return
        }
        keyguard.requestDismissKeyguard(
            activity,
            object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() = activity.runOnUiThread(then)
            },
        )
    }

    /**
     * Over the lock screen, and waking it, while a call is on: a phone rings
     * and is answered without being unlocked. Off again when the call goes or
     * is minimised, so the rest of the app is never shown to whoever holds a
     * locked phone; leaving the call screen for the app goes through
     * [unlockThen].
     */
    fun showOverLockScreen(on: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            activity.setShowWhenLocked(on)
            activity.setTurnScreenOn(on)
        } else {
            @Suppress("DEPRECATION")
            val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            if (on) activity.window.addFlags(flags) else activity.window.clearFlags(flags)
        }
    }
}

/**
 * The call, drawn over the whole app: full screen, as a bubble while
 * minimised, or alone in the picture-in-picture window. Also where the
 * permissions a call needs are asked, at the moment of the call. Put after
 * the app's content, so it is on top and its Back comes first.
 */
@Composable
fun CallHost(hooks: CallActivityHooks?) {
    val calls = LocalAppGraph.current.calls
    val controller = calls.controller
    val session by controller.session.collectAsStateWithLifecycle()
    val minimised by controller.minimised.collectAsStateWithLifecycle()
    CallPermissionFlow(calls, hooks)

    val current = session
    LaunchedEffect(current == null) {
        if (current == null) {
            hooks?.showOverLockScreen(false)
            hooks?.pictureInPicture?.update(null)
        }
    }
    // The bubble is drawn over the app: never over the lock screen.
    LaunchedEffect(minimised) { if (minimised) hooks?.showOverLockScreen(false) }
    if (current == null) return

    val state = rememberCallScreenState(current)
    val room = current.room as? LiveKitRoom
    val none = remember { MutableStateFlow<io.livekit.android.room.track.VideoTrack?>(null) }
    val remote by (room?.remoteVideo ?: none).collectAsStateWithLifecycle()
    val local by (room?.localVideo ?: none).collectAsStateWithLifecycle()
    val actions = rememberCallActions(current, calls, hooks)

    // The picture-in-picture window: a video call placed or answered and not over.
    val pip = hooks?.pictureInPicture
    val aspect = rememberVideoAspect(remote)
    val windowed = state.video && !state.ringingHere && !state.phase.isOver
    // The screen turning re-measures where the window grows from.
    val screen = LocalWindowInfo.current.containerSize
    LaunchedEffect(pip, windowed, aspect, state.muted, state.phase is CallPhase.Live, screen) {
        pip?.onMute = current::toggleMute
        pip?.onHangUp = current::hangUp
        pip?.onRestored = controller::expand
        pip?.update(if (windowed) CallPictureInPicture.Spec(aspect ?: VOICE_PIP_ASPECT, state.muted, state.phase is CallPhase.Live) else null)
    }
    if (pip?.inWindow == true) {
        PipCallView(state, room, remote)
        LaunchedEffect(state.phase.isOver) { if (state.phase.isOver) pip.close() }
        return
    }

    if (minimised) {
        FloatingCallBubble(state, room, remote, onOpen = controller::expand)
        return
    }
    // The call is dark in every template: light bar icons while it covers the app.
    SystemBarsOverride(BarIcons(lightStatus = true, lightNavigation = true))
    BackHandler {
        when {
            state.ringingHere -> actions.decline()
            state.phase.isOver -> controller.dismiss()
            // The bubble leaves the rest of the app on screen: unlocked first.
            else -> actions.unlockThen(controller::minimise)
        }
    }
    CallScreen(state, actions, room = room, remoteVideo = remote, localVideo = local)
}

/** The session's flows as one state for the screen. */
@Composable
private fun rememberCallScreenState(session: MatchCallSession): CallScreenState {
    val phase by session.phase.collectAsStateWithLifecycle()
    val peer by session.peer.collectAsStateWithLifecycle()
    val muted by session.muted.collectAsStateWithLifecycle()
    val cameraOn by session.cameraOn.collectAsStateWithLifecycle()
    val frontCamera by session.frontCamera.collectAsStateWithLifecycle()
    val speakerOn by session.speakerOn.collectAsStateWithLifecycle()
    val routes by session.room.audioRoutes.collectAsStateWithLifecycle()
    val relayWarning by session.relayWarning.collectAsStateWithLifecycle()
    val degraded by session.degraded.collectAsStateWithLifecycle()
    val weak by session.weakNetwork.collectAsStateWithLifecycle()
    val onHold by session.onHold.collectAsStateWithLifecycle()
    return CallScreenState(
        phase = phase,
        incoming = session.direction == MatchCallSession.Direction.INCOMING,
        kind = session.kind,
        peer = peer,
        muted = muted,
        cameraOn = cameraOn,
        frontCamera = frontCamera,
        speakerOn = speakerOn,
        routes = routes,
        relayWarning = relayWarning,
        degraded = degraded,
        weakNetwork = weak,
        onHold = onHold,
    )
}

/** The screen's actions, plus the unlock that leaving the call screen for the app goes through. */
private interface HostCallActions : CallScreenActions {
    fun unlockThen(then: () -> Unit)
}

@Composable
private fun rememberCallActions(session: MatchCallSession, calls: CallGraph, hooks: CallActivityHooks?): HostCallActions {
    val context = LocalContext.current
    val controller = calls.controller
    val links = LocalAppGraph.current.push.links
    val hold = { hooks?.pictureInPicture?.holdForPermission() ?: Unit }
    val toggleMic = rememberPermissionToggle(CallPermissions.MICROPHONE, asksWhen = { session.muted.value }, beforeAsk = hold, toggle = session::toggleMute)
    val toggleCamera = rememberPermissionToggle(CallPermissions.CAMERA, asksWhen = { !session.cameraOn.value }, beforeAsk = hold, toggle = session::toggleCamera)
    return remember(session, toggleMic, toggleCamera, links, hooks) {
        object : HostCallActions {
            override fun unlockThen(then: () -> Unit) {
                if (hooks != null) hooks.unlockThen(then) else then()
            }

            override fun answer() = answerWith(true)
            override fun answerVoiceOnly() = answerWith(false)

            private fun answerWith(video: Boolean) {
                // Pressed: the ring stops at once, before any permission dialog.
                session.callId?.let(calls::silenceRing)
                controller.requestAnswer(withVideo = video)
            }

            override fun decline() {
                session.callId?.let(calls::silenceRing)
                session.hangUp()
                controller.dismiss()
            }

            override fun hangUp() = session.hangUp()
            override fun toggleMute() = toggleMic()
            override fun toggleCamera() = toggleCamera()
            override fun switchCamera() = session.switchCamera()
            override fun toggleSpeaker() = session.toggleSpeaker()
            override fun selectRoute(route: AudioRoute) = session.selectRoute(route)
            override fun minimise() = controller.minimise()
            override fun done() = controller.dismiss()
            override fun retry() = controller.retry()
            override fun openSettings() = openAppSettings(context)

            override fun message() {
                fun ringing() = session.direction == MatchCallSession.Direction.INCOMING && session.phase.value == CallPhase.Ringing
                // The ring goes quiet while the phone is being unlocked.
                if (ringing()) session.callId?.let(calls::silenceRing)
                // The chat is the rest of the app: never over the lock screen.
                unlockThen {
                    val conversationId = session.peer.value.conversationId
                    when {
                        ringing() -> decline()
                        session.phase.value.isOver -> controller.dismiss()
                        else -> controller.minimise()
                    }
                    if (conversationId.isNotBlank()) links.open(OpenTarget.Thread(conversationId))
                }
            }
        }
    }
}

/**
 * Asks for what the pending call needs (microphone, camera for video,
 * Bluetooth on Android 12+), then places or answers it with what was granted.
 * Placing without the microphone rings nobody; answering without it goes
 * ahead muted, since the other person is already waiting.
 */
@Composable
private fun CallPermissionFlow(calls: CallGraph, hooks: CallActivityHooks?) {
    val context = LocalContext.current
    val controller = calls.controller
    val pending by controller.pending.collectAsStateWithLifecycle()
    fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    fun proceed(request: CallRequest, results: Map<String, Boolean>) {
        val got = CallPermissions.outcome(results, ::granted)
        when (request) {
            is CallRequest.Place -> controller.place(request.peer, request.kind, microphone = got.microphone, camera = got.camera)
            is CallRequest.Answer -> controller.answer(withVideo = request.withVideo && got.camera)
        }
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        controller.pending.value?.let { proceed(it, results) }
    }
    LaunchedEffect(pending) {
        val request = pending ?: return@LaunchedEffect
        val needed = when (request) {
            is CallRequest.Place -> CallPermissions.needed(request.kind, withVideo = true)
            is CallRequest.Answer -> CallPermissions.needed(controller.liveSession?.kind ?: CallKind.Audio, withVideo = request.withVideo)
        }
        val missing = CallPermissions.missing(needed, ::granted)
        if (missing.isEmpty()) {
            proceed(request, emptyMap())
        } else {
            hooks?.pictureInPicture?.holdForPermission()
            runCatching { launcher.launch(missing.toTypedArray()) }.onFailure { proceed(request, emptyMap()) }
        }
    }
}

/**
 * A call control that needs [permission] in one direction ([asksWhen]):
 * asked for first when missing, then the toggle. The other direction asks nothing.
 */
@Composable
private fun rememberPermissionToggle(permission: String, asksWhen: () -> Boolean, beforeAsk: () -> Unit, toggle: () -> Unit): () -> Unit {
    val context = LocalContext.current
    val currentToggle by rememberUpdatedState(toggle)
    val currentAsks by rememberUpdatedState(asksWhen)
    val currentBefore by rememberUpdatedState(beforeAsk)
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) currentToggle() }
    return remember(context, permission) {
        {
            val granted = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
            if (currentAsks() && !granted) {
                // The dialog is not the person leaving the app: no window for it.
                currentBefore()
                ask.launch(permission)
            } else {
                currentToggle()
            }
        }
    }
}

/** The app's page in the phone's settings, where a refused permission can be allowed. */
internal fun openAppSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
}

/** The settings page that lets this app ring full screen (Android 14+), else the app's notification settings. */
internal fun openFullScreenSettings(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        // Android 7 has no notification settings page of its own: the app's page.
        openNotificationSettings(context)
        return
    }
    val intent = Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.fromParts("package", context.packageName, null))
    // A phone without that page (some vendors leave it out): the notification settings, never a dead button.
    if (runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isFailure) openNotificationSettings(context)
}
