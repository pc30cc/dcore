package app.core

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
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
import app.core.template.TemplateStore
import app.core.ui.theme.AppTheme
import app.core.ui.theme.ApplySystemBars
import app.core.ui.theme.LocalSystemBars
import app.core.ui.theme.SystemBarRequests
import app.core.ui.theme.Templates
import androidx.compose.runtime.getValue

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
        // The window (and, from the next launch on Android 13+, the system
        // splash) in the template the last run drew, before the first frame.
        val launchTemplate = TemplateStore.get(this).effective.value
        setTheme(launchTheme(launchTemplate))
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val graph = appGraph
        graph.config.start()
        // The template follows config.ui and sends a choice left pending.
        graph.templates.start(graph.config.config, graph.config.fresh)
        // The origins list is checked alongside the config.
        graph.startOrigins()
        calls = CallActivityHooks(this, graph.calls) { graph.realtime }.also { it.onCreate(savedInstanceState) }
        // Realtime follows the app to the front and the account in; push
        // registers the device for whoever signs in.
        graph.chat.start()
        graph.push.start(graph.auth, graph.config.config)
        if (savedInstanceState == null) openFrom(intent)

        setContent {
            val templateId by graph.templates.effective.collectAsStateWithLifecycle()
            val template = remember(templateId) { Templates.of(templateId) }
            // The bar icons have one owner: the template's scheme (light
            // icons on a dark template, dark on a light one), unless a scene
            // or a call drawn over everything asks for its own.
            val bars = remember { SystemBarRequests() }
            ApplySystemBars(this, template, bars)
            // The next cold start's window and splash.
            LaunchedEffect(templateId) { rememberLaunchTemplate(templateId) }
            val config by graph.config.config.collectAsStateWithLifecycle()
            val appName = config?.appName?.takeIf { it.isNotBlank() } ?: AppBrand.appName

            AppTheme(template = template) {
                CompositionLocalProvider(LocalAppGraph provides graph, LocalAppName provides appName, LocalSystemBars provides bars) {
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

    /** The system splash of the next launch (Android 13+ keeps it for this activity). */
    private fun rememberLaunchTemplate(id: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            runCatching { splashScreen.setSplashScreenTheme(launchTheme(id)) }
        }
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
        /** The window theme drawn before the first frame for template [id]. */
        fun launchTheme(id: String): Int = if (Templates.of(id).dark) R.style.Theme_App else R.style.Theme_App_Light
    }
}
