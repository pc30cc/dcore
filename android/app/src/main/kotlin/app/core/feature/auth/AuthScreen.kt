package app.core.feature.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.core.BuildConfig
import app.core.R
import app.core.brand.AppBrand
import app.core.i18n.brandString
import app.core.ui.components.BrandMark
import app.core.ui.theme.Space
import kotlinx.coroutines.launch

/**
 * Sign-in: phone number on both stores, Google on the Play build only
 * (`SUPPORTS_GOOGLE_SIGN_IN`: Cafe Bazaar's phones often lack Google Play
 * services).
 *
 * NOT CONNECTED YET: the server's auth endpoints (`POST /auth/otp/start`,
 * `/auth/otp/verify`, `/auth/google`) are not built, so each button says so
 * instead of pretending to sign in. Google sign-in will go through Android's
 * Credential Manager, added to the play flavor when the server side exists.
 *
 * A debug build has one more button that opens the onboarding and main
 * screens without an account, for looking at them; release builds do not
 * contain it (BuildConfig.DEBUG is a constant R8 folds away).
 */
@Composable
fun AuthRoute(onPreview: () -> Unit) {
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val notConnected = brandString(R.string.auth_not_connected)
    val explainNotConnected: () -> Unit = { scope.launch { snackbar.showSnackbar(notConnected) } }
    val uri = LocalUriHandler.current

    Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { padding ->
        BoxWithConstraints(Modifier.fillMaxSize().padding(padding)) {
            val viewport = maxHeight
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = viewport)
                    .padding(horizontal = Space.gutter, vertical = Space.xl),
                horizontalAlignment = Alignment.CenterHorizontally,
                // The welcome in the middle of what is left above the
                // buttons; on a short screen, or with large text, it scrolls.
                verticalArrangement = Arrangement.SpaceBetween,
            ) {
                Spacer(Modifier)
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    BrandMark(size = 80.dp)
                    Spacer(Modifier.heightIn(min = Space.lg))
                    Text(
                        brandString(R.string.auth_title),
                        style = MaterialTheme.typography.headlineMedium,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.semantics { heading() },
                    )
                    Text(
                        brandString(R.string.auth_subtitle),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                }
                Column(
                    modifier = Modifier.fillMaxWidth().widthIn(max = 480.dp).padding(top = Space.xl),
                    verticalArrangement = Arrangement.spacedBy(Space.md),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Button(
                        onClick = explainNotConnected,
                        modifier = Modifier.fillMaxWidth().heightIn(min = Space.minTouch),
                    ) { Text(brandString(R.string.auth_continue_phone)) }
                    if (AppBrand.supportsGoogleSignIn) {
                        OutlinedButton(
                            onClick = explainNotConnected,
                            modifier = Modifier.fillMaxWidth().heightIn(min = Space.minTouch),
                        ) { Text(brandString(R.string.auth_continue_google)) }
                    }
                    if (BuildConfig.DEBUG) {
                        TextButton(onClick = onPreview, modifier = Modifier.fillMaxWidth()) {
                            Text(brandString(R.string.auth_preview_debug), textAlign = TextAlign.Center)
                        }
                    }
                    Text(
                        brandString(R.string.auth_legal_notice),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = Space.sm),
                    )
                    FlowRow(horizontalArrangement = Arrangement.Center, modifier = Modifier.fillMaxWidth()) {
                        if (AppBrand.Legal.termsUrl.isNotEmpty()) {
                            TextButton(onClick = { uri.openUri(AppBrand.Legal.termsUrl) }) { Text(brandString(R.string.legal_terms)) }
                        }
                        if (AppBrand.Legal.privacyUrl.isNotEmpty()) {
                            TextButton(onClick = { uri.openUri(AppBrand.Legal.privacyUrl) }) { Text(brandString(R.string.legal_privacy)) }
                        }
                    }
                }
            }
        }
    }
}
