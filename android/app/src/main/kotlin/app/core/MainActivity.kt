package app.core

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.brand.AppBrand
import app.core.feature.call.CallActivityHooks
import app.core.feature.call.CallHost
import app.core.feature.call.ProvideCallsToChat
import app.core.i18n.AppLocales
import app.core.i18n.LocalAppName
import app.core.push.OpenTargets
import app.core.ui.nav.AppNavHost
import app.core.ui.theme.AppTheme

/**
 * The one activity. Compose draws everything, edge to edge, with predictive
 * back (`enableOnBackInvokedCallback` in the manifest; Navigation 3 animates
 * the pop as the finger moves).
 */
class MainActivity : ComponentActivity() {

    /** Rings' taps, the call over the lock screen and picture-in-picture (feature/call). */
    private lateinit var calls: CallActivityHooks

    /** The app's language, applied before anything reads a resource. */
    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(AppLocales.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val graph = appGraph
        graph.config.start()
        // The origins list is checked alongside the config.
        graph.startOrigins()
        calls = CallActivityHooks(this, graph.calls) { graph.realtime }.also { it.onCreate(savedInstanceState) }
        // Realtime follows the app to the front and the account in; push
        // registers the device for whoever signs in.
        graph.chat.start()
        graph.push.start(graph.auth, graph.config.config)
        if (savedInstanceState == null) openFrom(intent)

        setContent {
            val dark = isSystemInDarkTheme()
            // The bar icons follow the theme every time it changes, not only
            // the shade the phone had at launch.
            DisposableEffect(dark) {
                enableEdgeToEdge(
                    statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT) { dark },
                    navigationBarStyle = SystemBarStyle.auto(LIGHT_SCRIM, DARK_SCRIM) { dark },
                )
                onDispose {}
            }
            val config by graph.config.config.collectAsStateWithLifecycle()
            val appName = config?.appName?.takeIf { it.isNotBlank() } ?: AppBrand.appName

            AppTheme(dark = dark) {
                CompositionLocalProvider(LocalAppGraph provides graph, LocalAppName provides appName) {
                    Box(Modifier.fillMaxSize()) {
                        Surface(Modifier.fillMaxSize()) {
                            // The conversations' call buttons and call-back lines.
                            ProvideCallsToChat { AppNavHost(config = config) }
                        }
                        // Over everything, so a call survives every navigation.
                        CallHost(calls)
                    }
                }
            }
        }
    }

    /** A notification tap (the app's own, or one the system drew from a push) opens what it is about. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // A ring's Answer or tap is the call's; anything else opens what it is about.
        if (calls.onNewIntent(intent)) return
        openFrom(intent)
    }

    private fun openFrom(intent: Intent?) {
        OpenTargets.fromIntent(intent)?.let(appGraph.push.links::open)
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        calls.onUserLeaveHint()
    }

    override fun onDestroy() {
        calls.onDestroy()
        super.onDestroy()
    }

    private companion object {
        /** The scrims Android draws behind three-button navigation (androidx.activity's defaults). */
        val LIGHT_SCRIM = Color.argb(0xe6, 0xFF, 0xFF, 0xFF)
        val DARK_SCRIM = Color.argb(0x80, 0x1b, 0x1b, 0x1b)
    }
}
