package app.core.feature.splash

import android.os.SystemClock
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import app.core.BuildConfig
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.auth.AuthGate
import app.core.feature.auth.AuthPage
import app.core.i18n.brandString
import app.core.model.Config
import app.core.net.ConfigRepository
import app.core.store.UpdateCheck
import app.core.store.UpdateMode
import app.core.ui.components.BrandMark
import app.core.ui.components.PrimaryButton
import app.core.ui.components.TextAction
import app.core.ui.components.TextActionKind
import app.core.ui.theme.AppTheme
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The first screen: the mark alone (never a name beside it), in the same
 * colours as the system's launch window, for as long as reading the session
 * takes (a few milliseconds), so the hand-over from the system splash is
 * seamless.
 *
 * Where the launch goes is the auth gate's decision (`AuthGate`), from the
 * session stored on the phone: no request is made to get there.
 */
@Composable
fun SplashRoute() {
    val loading = brandString(R.string.ui_loading)
    Box(
        Modifier
            .fillMaxSize()
            .semantics { contentDescription = loading },
        contentAlignment = Alignment.Center,
    ) {
        BrandMark(size = SplashLayout.mark)
    }
}

/**
 * Whether this build is below its store's minimum: the config's (asked for
 * this build's store) or the one a 426 named; a 426 that named none counts
 * as below.
 */
internal fun updateRequired(config: Config?, upgrade: Int?, versionCode: Int = BuildConfig.VERSION_CODE): Boolean {
    val minimum = maxOf(config?.minVersion?.required ?: 0, upgrade ?: 0)
    return versionCode < minimum || upgrade == 0
}

/**
 * The way back from [UpdateRequiredScreen] once the minimum was lowered: the
 * config is read again on «دوباره امتحان کن» and when the screen comes back
 * to the front (at most every [RESUME_EVERY_MS]); when the fresh minimum no
 * longer holds this build back, the 426 latch lets go
 * ([AuthGate.upgradeCleared]) and the app follows the fresh config, with no
 * restart. The screen was just decided from what the app knew, so the first
 * resume does not read again.
 */
class UpgradeRecheck(
    private val config: ConfigRepository,
    private val gate: AuthGate,
    private val now: () -> Long = SystemClock::elapsedRealtime,
    private val versionCode: Int = BuildConfig.VERSION_CODE,
) {
    private var lastAt: Long = now()
    private val running = AtomicBoolean(false)

    /** Reads the config now (one read at a time); true when this build is no longer below the minimum. */
    suspend fun check(): Boolean {
        if (!running.compareAndSet(false, true)) return false
        try {
            lastAt = now()
            val fresh = config.refresh() ?: return false
            if (versionCode < fresh.minVersion.required) return false
            gate.upgradeCleared()
            return true
        } finally {
            running.set(false)
        }
    }

    /** Back in front: reads again unless the last read was under [RESUME_EVERY_MS] ago. */
    suspend fun resumed(): Boolean = if (now() - lastAt < RESUME_EVERY_MS) false else check()

    companion object {
        const val RESUME_EVERY_MS = 30_000L
    }
}

/**
 * This build is below the server's minimum for its store. Nothing else is
 * reachable until it is updated, from the store it came from: one title,
 * one line and «به‌روزرسانی» docked, as every page of sign-in; under it
 * «دوباره امتحان کن», for a minimum that was lowered since, and «حذف حساب»,
 * which opens the web deletion page ([deleteUrl]: the panel's, else the
 * brand's), so leaving never waits for an update.
 */
@Composable
fun UpdateRequiredScreen(deleteUrl: String?) {
    val graph = LocalAppGraph.current
    val activity = LocalActivity.current
    // Play's own immediate update where the store allows it, else the store's page.
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) {}
    val scope = rememberCoroutineScope()
    val recheck = remember(graph) { UpgradeRecheck(graph.config, graph.auth) }
    UpdateRequiredContent(recheck, deleteUrl = deleteUrl, onUpdate = update@{
        val host = activity ?: return@update
        scope.launch {
            val check = graph.store.updates.check()
            val started = check is UpdateCheck.Available && check.immediateAllowed &&
                graph.store.updates.start(host, launcher, check, UpdateMode.IMMEDIATE)
            if (!started) graph.store.info.openAppPage(host)
        }
    })
}

/** [UpdateRequiredScreen] over its [recheck]: the tap and the resume read the config again; [deleteUrl] opens in the browser. */
@Composable
internal fun UpdateRequiredContent(recheck: UpgradeRecheck, onUpdate: () -> Unit, deleteUrl: String? = null) {
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var checking by remember { mutableStateOf(false) }
    LifecycleResumeEffect(recheck) {
        val job = scope.launch { recheck.resumed() }
        onPauseOrDispose { job.cancel() }
    }
    UpdateRequiredPage(
        checking = checking,
        onUpdate = onUpdate,
        onDelete = deleteUrl?.let { url -> { runCatching { uri.openUri(url) } } },
        onRetry = {
            if (!checking) {
                checking = true
                scope.launch {
                    try {
                        recheck.check()
                    } finally {
                        checking = false
                    }
                }
            }
        },
    )
}

/**
 * The update page drawn from its parts: see [UpdateRequiredScreen]. «دوباره امتحان کن» waits, dimmed, while
 * [checking]; no [onDelete], no deletion link.
 */
@Composable
internal fun UpdateRequiredPage(checking: Boolean, onUpdate: () -> Unit, onRetry: () -> Unit, onDelete: (() -> Unit)? = null) {
    val t = AppTheme.template
    AuthPage(
        title = brandString(R.string.update_required_title),
        onBack = null,
        actions = {
            PrimaryButton(brandString(R.string.update_required_action), onClick = onUpdate)
            TextAction(
                brandString(R.string.action_try_again),
                onRetry,
                Modifier.padding(top = SplashLayout.actionGap),
                kind = TextActionKind.Neutral,
                enabled = !checking,
            )
            if (onDelete != null) {
                TextAction(
                    brandString(R.string.settings_delete),
                    onDelete,
                    Modifier.padding(top = SplashLayout.actionGap),
                    kind = TextActionKind.Destructive,
                )
            }
        },
    ) {
        Text(
            brandString(R.string.update_required_body),
            style = t.type.body,
            color = t.colors.text2,
            modifier = Modifier.fillMaxWidth().padding(top = SplashLayout.bodyTop),
        )
    }
}

private object SplashLayout {
    val mark = 96.dp
    /** Under the title, as the sign-in pages' one line. */
    val bodyTop = 8.dp
    /** Between the docked button and the text action under it, as the state screens. */
    val actionGap = 4.dp
}
