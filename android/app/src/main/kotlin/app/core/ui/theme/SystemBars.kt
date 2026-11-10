package app.core.ui.theme

import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf

/** The system bars' icons: light ([lightStatus], [lightNavigation]) on a dark backdrop, dark on a light one. */
@Immutable
data class BarIcons(val lightStatus: Boolean, val lightNavigation: Boolean) {
    companion object {
        /** What a template asks for: light icons on a dark template, dark on a light one. */
        fun of(template: AppTemplate): BarIcons = BarIcons(template.dark, template.dark)
    }
}

/**
 * The window's bar icons, with one owner: the drawn template decides them
 * unless a screen drawn over it asks for its own ([SystemBarsOverride]).
 * Requests are kept in the order they were made; the last one still shown
 * wins, and when the last one goes the template's icons, as the template
 * is then, come back. Nothing is remembered from before a request, so a
 * template change underneath one is never undone when it ends.
 */
@Stable
class SystemBarRequests {
    internal class Request(icons: BarIcons) {
        var icons by mutableStateOf(icons)
    }

    private val requests = mutableStateListOf<Request>()

    /** The icons to show over [template]: the latest request's, or the template's. */
    fun icons(template: AppTemplate): BarIcons = requests.lastOrNull()?.icons ?: BarIcons.of(template)

    internal fun add(request: Request) {
        requests += request
    }

    internal fun remove(request: Request) {
        requests -= request
    }
}

/** The activity's [SystemBarRequests]; null outside one (previews, component tests), where requests do nothing. */
val LocalSystemBars = staticCompositionLocalOf<SystemBarRequests?> { null }

/**
 * While this is in the composition, the bars show [icons] instead of the
 * template's (a scene or a call drawn over everything). Changing [icons]
 * keeps the request's place.
 */
@Composable
fun SystemBarsOverride(icons: BarIcons) {
    val bars = LocalSystemBars.current ?: return
    val request = remember(bars) { SystemBarRequests.Request(icons) }
    SideEffect { request.icons = icons }
    DisposableEffect(bars, request) {
        bars.add(request)
        onDispose { bars.remove(request) }
    }
}

/**
 * Applies [bars]' icons over [template] to [activity]'s window, again each
 * time either changes: transparent bars edge to edge, the system's own
 * scrim behind three-button navigation.
 */
@Composable
fun ApplySystemBars(activity: ComponentActivity, template: AppTemplate, bars: SystemBarRequests) {
    val icons = bars.icons(template)
    DisposableEffect(activity, icons) {
        activity.enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT) { icons.lightStatus },
            navigationBarStyle = SystemBarStyle.auto(LIGHT_SCRIM, DARK_SCRIM) { icons.lightNavigation },
        )
        onDispose {}
    }
}

/** The scrims Android draws behind three-button navigation (androidx.activity's defaults). */
private val LIGHT_SCRIM = Color.argb(0xe6, 0xFF, 0xFF, 0xFF)
private val DARK_SCRIM = Color.argb(0x80, 0x1b, 0x1b, 0x1b)
