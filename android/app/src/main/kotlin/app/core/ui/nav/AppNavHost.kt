package app.core.ui.nav

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.Composable
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.scene.Scene
import androidx.navigation3.ui.NavDisplay
import app.core.BuildConfig
import app.core.feature.auth.AuthRoute
import app.core.feature.main.MainRoute
import app.core.feature.onboarding.OnboardingRoute
import app.core.feature.splash.SplashRoute
import app.core.feature.splash.UpdateRequiredScreen
import app.core.model.Config
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Motion
import kotlinx.serialization.Serializable

/**
 * Every place the shell can be, as Navigation 3 keys. `@Serializable` so the
 * back stack survives the process being killed in the background.
 *
 * Only screens that exist have a key: a key for a screen nobody has written
 * navigates to nothing.
 */
@Serializable data object SplashKey : NavKey

@Serializable data object AuthKey : NavKey

@Serializable data object OnboardingKey : NavKey

@Serializable data object MainKey : NavKey

/**
 * The root of the app: one back stack the app owns. The main tabs keep their
 * own state inside [MainRoute]; when detail screens arrive, each tab gets its
 * own stack.
 *
 * A build below the server's minimum for its store (`GET /v1/config`) sees only
 * [UpdateRequiredScreen].
 */
@Composable
fun AppNavHost(config: Config?) {
    // The config is asked for this build's store, so its minimum is this store's.
    val minimum = config?.minVersion?.required ?: 0
    if (BuildConfig.VERSION_CODE < minimum) {
        UpdateRequiredScreen()
        return
    }

    val backStack = rememberNavBackStack(SplashKey)
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val reducedMotion = LocalReducedMotion.current

    NavDisplay(
        backStack = backStack,
        onBack = { backStack.removeLastOrNull() },
        entryDecorators = listOf(
            rememberSaveableStateHolderNavEntryDecorator(),
            rememberViewModelStoreNavEntryDecorator(),
        ),
        transitionSpec = { forward(rtl, reducedMotion) },
        popTransitionSpec = { backward(rtl, reducedMotion) },
        predictivePopTransitionSpec = { backward(rtl, reducedMotion) },
        entryProvider = entryProvider {
            entry<SplashKey> {
                SplashRoute(onResolved = { signedIn -> backStack.replaceAll(if (signedIn) MainKey else AuthKey) })
            }
            entry<AuthKey> {
                AuthRoute(onPreview = { backStack.add(OnboardingKey) })
            }
            entry<OnboardingKey> {
                OnboardingRoute(
                    onExit = { backStack.removeLastOrNull() },
                    onFinished = { backStack.replaceAll(MainKey) },
                )
            }
            entry<MainKey> { MainRoute() }
        },
    )
}

/** Makes [key] the only entry, in one snapshot so no frame sees the stack empty. */
private fun NavBackStack<NavKey>.replaceAll(key: NavKey) {
    Snapshot.withMutableSnapshot {
        add(key)
        removeAll { it != key }
    }
}

/**
 * Forward is toward the end of the line: right to left in English, left to
 * right in Persian, so a new screen always comes in from the reading
 * direction's far side. With "remove animations" on, a plain cut-fade.
 */
private fun AnimatedContentTransitionScope<Scene<NavKey>>.forward(rtl: Boolean, reduced: Boolean): ContentTransform =
    if (reduced) {
        fadeIn(tween(Motion.SHORT_MS)) togetherWith fadeOut(tween(Motion.SHORT_MS))
    } else {
        val sign = if (rtl) -1 else 1
        slideInHorizontally(Motion.screen) { width -> sign * width } togetherWith
            slideOutHorizontally(Motion.screen) { width -> -sign * width / 4 } + fadeOut(tween(Motion.MEDIUM_MS))
    }

private fun AnimatedContentTransitionScope<Scene<NavKey>>.backward(rtl: Boolean, reduced: Boolean): ContentTransform =
    if (reduced) {
        fadeIn(tween(Motion.SHORT_MS)) togetherWith fadeOut(tween(Motion.SHORT_MS))
    } else {
        val sign = if (rtl) -1 else 1
        slideInHorizontally(Motion.screen) { width -> -sign * width / 4 } + fadeIn(tween(Motion.MEDIUM_MS)) togetherWith
            slideOutHorizontally(Motion.screen) { width -> sign * width }
    }
