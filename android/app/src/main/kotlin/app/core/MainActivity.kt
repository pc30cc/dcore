package app.core

import android.content.Context
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.brand.AppBrand
import app.core.i18n.AppLocales
import app.core.i18n.LocalAppName
import app.core.ui.nav.AppNavHost
import app.core.ui.theme.AppTheme

/**
 * The one activity. Compose draws everything, edge to edge, with predictive
 * back (`enableOnBackInvokedCallback` in the manifest; Navigation 3 animates
 * the pop as the finger moves).
 */
class MainActivity : ComponentActivity() {

    /** The app's language, applied before anything reads a resource. */
    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(AppLocales.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val graph = appGraph
        graph.config.start()

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
                    Surface(Modifier.fillMaxSize()) {
                        AppNavHost(config = config)
                    }
                }
            }
        }
    }

    private companion object {
        /** The scrims Android draws behind three-button navigation (androidx.activity's defaults). */
        val LIGHT_SCRIM = Color.argb(0xe6, 0xFF, 0xFF, 0xFF)
        val DARK_SCRIM = Color.argb(0x80, 0x1b, 0x1b, 0x1b)
    }
}
