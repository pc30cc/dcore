package app.core.feature.splash

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.core.LocalAppGraph
import app.core.R
import app.core.i18n.LocalAppName
import app.core.i18n.brandString
import app.core.ui.components.BrandMark
import app.core.ui.theme.Space

/**
 * The first screen: the mark and the name, in the same colours as the
 * system's launch window, for as long as reading the session takes (a few
 * milliseconds), so the hand-over from the system splash is seamless.
 *
 * Where the launch goes is the auth gate's decision (`AuthGate`), from the
 * session stored on the phone: no request is made to get there.
 */
@Composable
fun SplashRoute() {
    val loading = brandString(R.string.splash_loading)
    Box(
        Modifier
            .fillMaxSize()
            .semantics { contentDescription = loading },
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.lg)) {
            BrandMark(size = 96.dp)
            Text(LocalAppName.current, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
        }
    }
}

/**
 * This build is below the server's minimum for its store. Nothing else is
 * reachable until it is updated, from the store it came from.
 */
@Composable
fun UpdateRequiredScreen() {
    val graph = LocalAppGraph.current
    val activity = LocalActivity.current
    Box(Modifier.fillMaxSize().safeDrawingPadding().padding(Space.xl), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.lg)) {
            BrandMark(size = 72.dp)
            Text(
                brandString(R.string.update_required_title),
                style = MaterialTheme.typography.headlineSmall,
                textAlign = TextAlign.Center,
            )
            Text(
                brandString(R.string.update_required_body),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Button(onClick = { activity?.let { graph.store.info.openAppPage(it) } }) {
                Text(brandString(R.string.update_required_action))
            }
        }
    }
}
