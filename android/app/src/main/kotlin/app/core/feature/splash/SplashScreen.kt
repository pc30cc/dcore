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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import app.core.LocalAppGraph
import app.core.R
import app.core.i18n.LocalAppName
import app.core.i18n.brandString
import app.core.net.ServerApi
import app.core.ui.components.BrandMark
import app.core.ui.theme.Space
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Decides where a launch goes: signed in or not. Reads only the session on the phone, never the network. */
class SplashViewModel(private val api: ServerApi) : ViewModel() {
    private val _signedIn = MutableStateFlow<Boolean?>(null)

    /** Null while reading. */
    val signedIn: StateFlow<Boolean?> = _signedIn.asStateFlow()

    init {
        viewModelScope.launch { _signedIn.value = api.hasSession() }
    }
}

/**
 * The first screen: the mark and the name, in the same colours as the
 * system's launch window, for as long as reading the session takes (a few
 * milliseconds), so the hand-over from the system splash is seamless.
 *
 * Signed in goes to the main tabs. Whether a signed-in account still has
 * onboarding steps left is the server's to say (`GET /v1/me`).
 */
@Composable
fun SplashRoute(onResolved: (signedIn: Boolean) -> Unit) {
    val graph = LocalAppGraph.current
    val model: SplashViewModel = viewModel(factory = viewModelFactory { initializer { SplashViewModel(graph.api) } })
    val signedIn by model.signedIn.collectAsStateWithLifecycle()
    val resolved by rememberUpdatedState(onResolved)
    LaunchedEffect(signedIn) {
        signedIn?.let { resolved(it) }
    }
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
