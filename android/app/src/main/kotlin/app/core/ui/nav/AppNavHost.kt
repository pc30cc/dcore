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
import app.core.LocalAppGraph
import app.core.feature.auth.MaintenanceScreen
import app.core.feature.auth.RestoreRoute
import app.core.feature.auth.RestrictedRoute
import app.core.feature.auth.ReviewRoute
import app.core.feature.auth.Root
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.feature.auth.AuthRoute
import app.core.feature.chat.ChatRoute
import app.core.feature.main.MainRoute
import app.core.feature.main.MainTab
import app.core.feature.requests.RequestsRoute
import app.core.push.OpenTarget
import androidx.compose.runtime.remember
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

@Serializable data object ReviewKey : NavKey

@Serializable data object RestrictedKey : NavKey

@Serializable data object RestoreKey : NavKey

/** One conversation's thread, over the tabs. */
@Serializable data class ChatKey(val conversationId: String) : NavKey

/** The message requests, over the tabs. */
@Serializable data object RequestsKey : NavKey

/** The root key for each place [AuthGate] can put the app. */
private fun Root.key(): NavKey = when (this) {
    Root.Splash -> SplashKey
    Root.SignIn -> AuthKey
    Root.Onboarding -> OnboardingKey
    Root.Review -> ReviewKey
    Root.Restricted -> RestrictedKey
    Root.Restore -> RestoreKey
    Root.Main -> MainKey
}

/**
 * The root of the app: one back stack the app owns. The main tabs keep their
 * own state inside [MainRoute]; when detail screens arrive, each tab gets its
 * own stack.
 *
 * Which root is shown (sign-in, sign-up, review, restricted, restore, the
 * app) is [AuthGate]'s decision; this follows it. A build below the server's
 * minimum for its store (`GET /v1/config`, or a 426 from any request) sees
 * only [UpdateRequiredScreen]; maintenance shows [MaintenanceScreen].
 */
@Composable
fun AppNavHost(config: Config?) {
    val gate = LocalAppGraph.current.auth
    LaunchedEffect(gate) { gate.start() }
    val root by gate.root.collectAsStateWithLifecycle()
    val upgrade by gate.upgrade.collectAsStateWithLifecycle()
    val maintenance by gate.maintenance.collectAsStateWithLifecycle()

    // The config is asked for this build's store, so its minimum is this store's.
    val minimum = maxOf(config?.minVersion?.required ?: 0, upgrade ?: 0)
    if (BuildConfig.VERSION_CODE < minimum || (upgrade != null && upgrade == 0)) {
        UpdateRequiredScreen()
        return
    }
    if (config?.maintenance?.enabled == true || maintenance != null) {
        MaintenanceScreen(maintenance ?: config?.maintenance?.message)
        return
    }

    val backStack = rememberNavBackStack(SplashKey)
    LaunchedEffect(root) {
        val key = root.key()
        if (root != Root.Splash && backStack.firstOrNull() != key) backStack.replaceAll(key)
    }
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val reducedMotion = LocalReducedMotion.current

    // A notification tap, once the app is in: the thread or the requests
    // over the tabs, or a tab.
    val links = LocalAppGraph.current.push.links
    val tabs = remember { kotlinx.coroutines.flow.MutableSharedFlow<MainTab>(extraBufferCapacity = 1) }
    LaunchedEffect(root) {
        if (root != Root.Main) return@LaunchedEffect
        links.pending.collect { target ->
            target ?: return@collect
            when (target) {
                is OpenTarget.Thread -> backStack.openOver(ChatKey(target.conversationId))
                OpenTarget.Requests -> backStack.openOver(RequestsKey)
                OpenTarget.Chats -> { backStack.backToMain(); tabs.tryEmit(MainTab.CHATS) }
                OpenTarget.Likes -> { backStack.backToMain(); tabs.tryEmit(MainTab.LIKES) }
                else -> backStack.backToMain()
            }
            links.taken(target)
        }
    }

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
            entry<SplashKey> { SplashRoute() }
            entry<AuthKey> { AuthRoute() }
            entry<OnboardingKey> { OnboardingRoute() }
            entry<ReviewKey> { ReviewRoute() }
            entry<RestrictedKey> { RestrictedRoute() }
            entry<RestoreKey> { RestoreRoute() }
            entry<MainKey> {
                MainRoute(
                    onOpenChat = { id -> backStack.add(ChatKey(id)) },
                    onOpenRequests = { backStack.add(RequestsKey) },
                    tabRequests = tabs,
                )
            }
            entry<ChatKey> { key -> ChatRoute(key.conversationId, onBack = { backStack.removeLastOrNull() }) }
            entry<RequestsKey> {
                RequestsRoute(
                    onBack = { backStack.removeLastOrNull() },
                    onOpenChat = { id ->
                        backStack.removeLastOrNull()
                        backStack.add(ChatKey(id))
                    },
                )
            }
        },
    )
}

/** Opens [key] over the main tabs, replacing any thread or list already open over them. */
private fun NavBackStack<NavKey>.openOver(key: NavKey) {
    if (lastOrNull() == key) return
    Snapshot.withMutableSnapshot {
        removeAll { it is ChatKey || it is RequestsKey }
        add(key)
    }
}

/** Back to the tabs, closing what is open over them. */
private fun NavBackStack<NavKey>.backToMain() {
    Snapshot.withMutableSnapshot { removeAll { it is ChatKey || it is RequestsKey } }
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
