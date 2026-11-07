package app.core.push

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.core.BuildConfig
import app.core.common.Clock
import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.feature.auth.AuthGate
import app.core.feature.auth.Root
import app.core.i18n.AppLocales
import app.core.model.Config
import app.core.model.Id
import app.core.model.PublicUid
import app.core.net.ServerApi
import app.core.storage.SecretStore
import app.core.sync.ChatSync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Push for the process: the transport (FCM), the registration, the router
 * every push goes through, the notifications, and the places a tap opens.
 */
class PushGraph(
    private val context: Context,
    private val api: ServerApi,
    store: SecretStore,
    private val chat: ChatSync,
    private val scope: CoroutineScope,
    clock: Clock,
    private val diag: Diag,
    val transport: PushTransport = FirebasePush(context, diag),
) {
    val links = AppLinks()
    val notifications = Notifications(context)

    val registrar = PushRegistrar(
        api = api,
        transport = transport,
        state = StoredPushState(store),
        notificationsEnabled = { NotificationManagerCompat.from(context).areNotificationsEnabled() },
        appVersion = BuildConfig.VERSION_NAME,
        locale = { AppLocales.current(context).tag },
        clock = clock,
        diag = diag,
        scheduleRetry = { PushRegistrationWorker.enqueue(context, reason = "retry", replace = false) },
    )

    val router = PushRouter(
        notifications = notifications,
        chat = object : PushChatHooks {
            override suspend fun signedInAccount(): PublicUid? = runCatchingUnlessCancelled { api.sessionUser()?.id }.getOrNull()
            override fun isViewing(conversationId: Id): Boolean = chat.isViewing(conversationId)
            override suspend fun messageArrived(conversationId: Id) {
                val who = chat.account.value ?: return
                chat.messages.markStale(who, conversationId)
            }
            override suspend fun listChanged() {
                scope.launch { chat.reconcile("push") }
            }
        },
        diag = diag,
    )

    private val _availability = MutableStateFlow(PushAvailability.AVAILABLE)

    /** Whether pushes can reach this phone: the chat list says so when they cannot. */
    val availability: StateFlow<PushAvailability> = _availability.asStateFlow()

    private val started = AtomicBoolean(false)

    /**
     * Registers for the signed-in account and keeps it current; called once
     * the UI exists. [config] is the server's config: a build without a
     * Firebase project of its own takes the server's from it.
     */
    fun start(auth: AuthGate, config: Flow<Config?> = emptyFlow()) {
        if (!started.compareAndSet(false, true)) return
        scope.launch {
            config.map { it?.push?.firebase?.let(FirebaseClientConfig::of) }.filterNotNull().distinctUntilChanged().collect { firebase ->
                // True only when this just started Firebase: register now,
                // not at the next launch.
                if (PushConfig.adopt(context, firebase, diag)) {
                    _availability.value = transport.availability()
                    registrar.sync("push configured")
                }
            }
        }
        scope.launch {
            auth.root.collect { root ->
                if (root == Root.Splash) return@collect
                // Sign-up, review and the app may register a device;
                // restricted and deleting sessions may not.
                val registers = root == Root.Main || root == Root.Onboarding || root == Root.Review
                val account = if (registers) runCatchingUnlessCancelled { api.sessionUser()?.id }.getOrNull() else null
                _availability.value = transport.availability()
                if (account != null) registrar.bind(account, "signed in") else if (root == Root.SignIn) notifications.clearAll()
            }
        }
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                // Free unless something changed (the permission, the token,
                // the language, the version), or a week went by.
                override fun onStart(owner: LifecycleOwner) {
                    scope.launch {
                        _availability.value = transport.availability()
                        registrar.sync("foreground")
                    }
                }
            },
        )
        auth.onSignOut(
            before = { registrar.beforeSignOut() },
            after = {
                registrar.afterSignOut()
                PushRegistrationWorker.cancel(context)
                notifications.clearAll()
            },
        )
    }
}
