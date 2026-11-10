package app.core.feature.splash

import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.auth.AuthPage
import app.core.i18n.brandString
import app.core.store.UpdateCheck
import app.core.store.UpdateMode
import app.core.ui.components.BrandMark
import app.core.ui.components.PrimaryButton
import app.core.ui.theme.AppTheme
import kotlinx.coroutines.launch

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
 * This build is below the server's minimum for its store. Nothing else is
 * reachable until it is updated, from the store it came from: one title,
 * one line and «به‌روزرسانی» docked, as every page of sign-in.
 */
@Composable
fun UpdateRequiredScreen() {
    val t = AppTheme.template
    val graph = LocalAppGraph.current
    val activity = LocalActivity.current
    // Play's own immediate update where the store allows it, else the store's page.
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) {}
    val scope = rememberCoroutineScope()
    AuthPage(
        title = brandString(R.string.update_required_title),
        onBack = null,
        actions = {
            PrimaryButton(brandString(R.string.update_required_action), onClick = {
                val host = activity ?: return@PrimaryButton
                scope.launch {
                    val check = graph.store.updates.check()
                    val started = check is UpdateCheck.Available && check.immediateAllowed &&
                        graph.store.updates.start(host, launcher, check, UpdateMode.IMMEDIATE)
                    if (!started) graph.store.info.openAppPage(host)
                }
            })
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
}
