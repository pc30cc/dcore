package app.core.sync

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.core.BuildConfig
import app.core.brand.AppBrand
import app.core.cache.CacheDatabaseHolder
import app.core.cache.ChatStore
import app.core.common.Clock
import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.auth.AuthGate
import app.core.feature.auth.Root
import app.core.model.AuthUser
import app.core.model.RealtimeEvent
import app.core.model.StoreName
import app.core.net.ConfigRepository
import app.core.net.ServerApi
import app.core.net.internetAvailability
import app.core.realtime.RealtimeClient
import app.core.realtime.RealtimeCoordinator
import app.core.realtime.RealtimeTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The chat and its realtime connection, built once for the process: the
 * repositories over the cache, the sync that routes every change, and the one
 * socket while the app is in front.
 *
 * [start] connects it to the app's life: the process coming to the front or
 * leaving it, the account signing in, out or changing state, the network
 * returning. Nothing here runs at a cold start until [start] is called, and
 * no socket exists until an account that may use the app is signed in and the
 * app is in front.
 */
class ChatGraph(
    private val context: Context,
    private val api: ServerApi,
    holder: CacheDatabaseHolder,
    transport: RealtimeTransport,
    private val auth: AuthGate,
    private val entitlements: EntitlementRepository,
    private val config: ConfigRepository,
    private val scope: CoroutineScope,
    clock: Clock,
    private val diag: Diag,
    /** Realtime sockets to fall back on (the signed origins list's realtime hosts). */
    realtimeAlternates: () -> List<String> = { emptyList() },
    /** The store this build is for: an `entitlement` event of another store's build is only a hint ([EntitlementEvents]). */
    buildStore: StoreName = StoreName.fromWire(AppBrand.store.id),
) {
    val store = ChatStore(holder, diag)
    val conversations = ConversationRepository(api, store, clock, diag)
    val messages = MessageRepository(api, store, clock, diag = diag)
    val requests = MessageRequestsRepository(api, clock, diag = diag)

    val sync = ChatSync(
        api = api,
        conversations = conversations,
        messages = messages,
        requests = requests,
        scope = scope,
        clearStore = store::clearAll,
        keepOnly = store::keepOnly,
        clock = clock,
        diag = diag,
    )

    /** The socket. [RealtimeCoordinator.events] and [RealtimeCoordinator.health] are for any feature that needs the stream. */
    val realtime = RealtimeCoordinator(
        clientFactory = { sink, positions ->
            RealtimeClient(
                tokens = { api.realtimeToken() },
                transport = transport,
                sink = sink,
                fallbackUrl = AppBrand.realtimeUrl,
                positions = positions,
                clock = clock::nowMillis,
                diag = diag,
                appVersion = BuildConfig.VERSION_NAME,
                alternates = realtimeAlternates,
            )
        },
        listener = sync,
        scope = scope,
        diag = diag,
    )

    private val entitlementEvents = EntitlementEvents(entitlements, buildStore, scope, diag)

    private val started = AtomicBoolean(false)

    fun start() {
        if (!started.compareAndSet(false, true)) return
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) = setForeground(true)
                override fun onStop(owner: LifecycleOwner) = setForeground(false)
            },
        )
        scope.launch {
            auth.root.collect { root -> follow(root) }
        }
        scope.launch {
            // The first value is the state at registration, not news.
            context.internetAvailability().drop(1).filter { it }.collect {
                realtime.onNetworkAvailable()
                entitlementEvents.retryPending()
            }
        }
        scope.launch {
            realtime.events.collect { event -> sideEffects(event) }
        }
    }

    private fun setForeground(value: Boolean) {
        sync.setForeground(value)
        realtime.setForeground(value)
        if (value) entitlementEvents.retryPending()
    }

    private suspend fun follow(root: Root) {
        if (root == Root.Splash) return
        val user = if (root == Root.SignIn) null else runCatchingUnlessCancelled { api.sessionUser() }.getOrNull()
        val active = root == Root.Main && user != null
        sync.setAccount(user?.id, active)
        realtime.setAccount(if (active) user.id else null)
        if (user == null) {
            entitlements.clear()
            entitlementEvents.reset()
        }
    }

    /** What the rest of the app does about events that are not the chat's. */
    private suspend fun sideEffects(event: RealtimeEvent) {
        when (event) {
            is RealtimeEvent.EntitlementsChanged -> entitlementEvents.onEvent(event)
            is RealtimeEvent.ConfigChanged -> config.refresh()
            is RealtimeEvent.AccountChanged -> runCatchingUnlessCancelled { api.me().value }.getOrNull()?.let { me ->
                auth.accountChanged(AuthUser(me.id, me.status, me.onboardingStep))
            }
            else -> Unit
        }
    }
}
