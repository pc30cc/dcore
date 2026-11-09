package app.core

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.compose.runtime.staticCompositionLocalOf
import app.core.brand.AppBrand
import app.core.cache.CacheDatabaseHolder
import app.core.cache.ChatMapping
import app.core.common.Clock
import app.core.common.Diag
import app.core.feature.auth.AuthGate
import app.core.feature.call.CallGraph
import app.core.feature.legal.LegalAcceptance
import app.core.i18n.AppLocales
import app.core.media.BlobTransport
import app.core.media.HttpBlobTransport
import app.core.media.LocalPhotoCache
import app.core.media.PhotoUploader
import app.core.net.AndroidDeviceIdentity
import app.core.net.ApiClient
import app.core.net.Backend
import app.core.net.ConfigRepository
import app.core.net.HttpServerApi
import app.core.net.ResponseCache
import app.core.net.RoomResponseCache
import app.core.net.ServerApi
import app.core.net.origins.FileOriginsStore
import app.core.net.origins.KtorOriginsTransport
import app.core.net.origins.OriginsRepository
import app.core.net.origins.OriginsTrust
import app.core.storage.Preferences
import app.core.storage.SecureStore
import app.core.storage.SessionStore
import app.core.billing.KnownPurchases
import app.core.billing.PurchaseOutbox
import app.core.billing.PurchaseSyncWorker
import app.core.billing.Purchases
import app.core.billing.ServerStoreApi
import app.core.feature.paywall.PaywallController
import app.core.model.SwipeOutcome
import app.core.store.AgeSignalsCheck
import app.core.store.RatingPacing
import app.core.store.StoreBilling
import app.core.store.StoreModule
import app.core.store.StoreServices
import app.core.store.UpdatePacing
import app.core.push.PushGraph
import app.core.realtime.KtorRealtimeTransport
import app.core.realtime.RealtimeCoordinator
import app.core.realtime.RealtimeTransport
import app.core.sync.CachedDeckSnapshotStore
import app.core.sync.ChatGraph
import app.core.sync.DeckRepository
import app.core.sync.EntitlementRepository
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import io.ktor.client.engine.okhttp.OkHttp
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Everything the app holds once, for the life of the process (plain
 * constructor injection, no DI framework).
 *
 * The parts that cost something to build (the database, the HTTP client, the
 * store connection) are lazy, so a cold start pays only for what its first
 * screen asks for, and a process started for a background job pays for none.
 * Screens reach it through [LocalAppGraph].
 */
class AppGraph(private val app: Application) {

    val diag: Diag = Diag.Android
    val clock: Clock = Clock.System

    /** A failure nobody caught in one background job is logged and ends that job, never the process. */
    val appScope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate +
            CoroutineExceptionHandler { _, e -> diag.warn("App", "background job failed: ${e.javaClass.simpleName}") },
    )

    val secureStore = SecureStore(app, diag)
    val session = SessionStore(secureStore, clock, diag)
    val preferences = Preferences(secureStore)

    /** The cache database, opened on first use, rebuilt if damaged. */
    val cacheDatabase = CacheDatabaseHolder(app, diag = diag)

    val responseCache: ResponseCache = RoomResponseCache(cacheDatabase, diag)

    private fun language(): String = AppLocales.current(app).tag

    /**
     * The signed origins list (net/origins): where the API, realtime and the
     * website are now, cached, verified against the build's keys, followed
     * as the admin panel changes it.
     */
    val origins: OriginsRepository by lazy {
        OriginsRepository(
            trust = OriginsTrust.fromBuild(),
            compiledApi = AppBrand.apiBaseUrl,
            compiledBootstrap = OriginsTrust.buildBootstrap(),
            // A fixed neutral name, never the brand's.
            store = FileOriginsStore(java.io.File(app.noBackupFilesDir, "origins.json")),
            transport = KtorOriginsTransport(OkHttp.create()),
            clock = clock,
            diag = diag,
        )
    }

    /** The origins checks: now (the cold start, alongside the config), on every new config `v`, and every six hours in front. */
    fun startOrigins() {
        if (Backend.isSample(app)) return
        origins.start(
            scope = appScope,
            foreground = ProcessLifecycleOwner.get().lifecycle.currentStateFlow.map { it.isAtLeast(Lifecycle.State.STARTED) },
            configVersions = config.config.map { it?.v },
        )
    }

    private val http: ApiClient by lazy {
        ApiClient(
            baseUrl = AppBrand.apiBaseUrl,
            tokens = session,
            cache = responseCache,
            engine = OkHttp.create(),
            clientHeader = ApiClient.clientHeader(AppBrand.store.id, BuildConfig.VERSION_CODE),
            language = ::language,
            diag = diag,
            debugLog = if (BuildConfig.DEBUG) { message -> Log.d("App.Http", message) } else null,
            clock = clock,
            hosts = origins.apiHosts,
        )
    }

    /**
     * The server, or in a debug build started with the sample switch, the
     * in-memory sample backend ([Backend] decides; release builds cannot).
     */
    val api: ServerApi by lazy {
        Backend.create(app, clock) {
            HttpServerApi(
                client = http,
                session = session,
                device = AndroidDeviceIdentity(app, preferences),
                store = AppBrand.store.id,
                clock = clock,
            )
        }
    }

    val config: ConfigRepository by lazy { ConfigRepository(api, appScope, diag, ::language) }

    /** The store this build was made for: Cafe Bazaar or Google Play, from the flavor's `StoreModule`. */
    val store: StoreServices by lazy { StoreModule.create(app, diag) }

    /** Where the app's root is: signed out, signing up, restricted, in (feature/auth). */
    val auth: AuthGate by lazy {
        AuthGate(api, store.externalSignIn, store.smsCodes, appScope, diag).also { gate ->
            // Another account's plan, quotas and purchase in progress are never shown to the next one.
            gate.onSignOut(after = {
                entitlements.clear()
                if (purchasesHolder.isInitialized()) purchases.clear()
            })
        }
    }

    /** The privacy notice and terms accepted on this install, before an account exists. */
    val legal: LegalAcceptance by lazy { LegalAcceptance(secureStore, clock) }

    /** Where photo bytes go: the presigned URL, never the API (on the sample backend, the sample). */
    val blobs: BlobTransport by lazy { (api as? BlobTransport) ?: HttpBlobTransport(OkHttp.create()) }

    val photoUploader: PhotoUploader by lazy { PhotoUploader(api, blobs, clock, diag) }

    /** Photos this phone uploaded, shown while the server processes them. */
    val photoCache: LocalPhotoCache by lazy { LocalPhotoCache(java.io.File(app.cacheDir, "own-photos")) }

    /** Plan, features and quotas, read when a screen first needs them (sync/). */
    val entitlements: EntitlementRepository by lazy {
        EntitlementRepository(fetch = { api.entitlements() }, diag = diag)
    }

    /** The deck and the swipes on their way, for the deck and the likes list (sync/). */
    val deck: DeckRepository by lazy {
        DeckRepository(
            scope = appScope,
            fetchPage = { limit -> api.deck(limit) },
            // A match the answer carries is in the chat list (and its thread
            // opens) before any read.
            sendSwipes = { swipes ->
                api.swipe(swipes).also(chat.sync::onSwipes).also { result ->
                    if (result.results.any { it.result == SwipeOutcome.Matched }) appScope.launch { ratingPacing.noteMatch() }
                }
            },
            account = { api.sessionUser()?.id },
            store = CachedDeckSnapshotStore(responseCache, diag),
            onQuotas = { result -> entitlements.applyQuotas(result.quotas) },
            clock = clock,
            diag = diag,
        )
    }

    /** The store's billing: the flavor's, or in a debug build on the sample backend, the sample store's. */
    val billing: StoreBilling by lazy { Backend.billing(app) { store.billing } }

    /** The paywall and the packs sheets: what is open (feature/paywall). */
    val paywall = PaywallController()

    private val purchasesHolder = lazy {
        Purchases(
            billing = billing,
            api = ServerStoreApi(api),
            outbox = PurchaseOutbox(secureStore, diag),
            known = KnownPurchases(secureStore),
            entitlements = entitlements,
            account = { api.sessionUser()?.id },
            scope = appScope,
            clock = clock,
            diag = diag,
            retryInBackground = { PurchaseSyncWorker.enqueue(app) },
        )
    }

    /** Store purchases: verified by the server, queued until it answers, restored (billing/). */
    val purchases: Purchases by purchasesHolder

    /** When a rating or a recommended update may be asked for (store/). */
    val ratingPacing: RatingPacing by lazy { RatingPacing(secureStore, clock) }
    val updatePacing: UpdatePacing by lazy { UpdatePacing(secureStore, clock) }

    /** The store's age signal, once per install (the Play build only has one). */
    val ageCheck: AgeSignalsCheck by lazy { AgeSignalsCheck(store.ageSignals, secureStore, clock) }

    /** The realtime socket's transport: the real server's, or in a debug build on the sample backend, the sample's. */
    private val realtimeTransport: RealtimeTransport by lazy { (api as? RealtimeTransport) ?: KtorRealtimeTransport() }

    /** Conversations, messages, message requests and the realtime socket (sync/, realtime/). */
    val chat: ChatGraph by lazy {
        ChatGraph(
            app, api, cacheDatabase, realtimeTransport, auth, entitlements, config, appScope, clock, diag,
            realtimeAlternates = { origins.realtimeSockets() },
        )
    }

    /**
     * The one realtime connection, while the app is in front.
     * [RealtimeCoordinator.events] is the stream for any feature that needs it
     * (calls); [RealtimeCoordinator.health] says whether it is up.
     */
    val realtime: RealtimeCoordinator get() = chat.realtime

    /**
     * Calls between matched people (feature/call): the one call on this phone,
     * its ring from push and realtime, and the match's call switch. Cheap to
     * build: nothing in it opens a socket or sends a request until a call does.
     */
    val calls: CallGraph by lazy {
        CallGraph(
            app,
            apiOf = { api },
            scope = appScope,
            clock = clock,
            diag = diag,
            // A ring names the conversation; the chat's cache has the match's photo and its blurhash.
            cachedFace = { conversationId ->
                api.sessionUser()?.id?.let { account -> chat.conversations.get(account, conversationId) }
                    ?.let { row -> ChatMapping.conversation(row).peer.photo }
            },
        )
    }

    /** Push: the FCM transport, the registration, the router and the notification taps (push/). */
    val push: PushGraph by lazy {
        // Rings and their stops go to the calls, even for a push that cold-started the process.
        PushGraph(app, api, secureStore, chat.sync, appScope, clock, diag).also { it.router.calls = calls.pushHandler }
    }
}

val Context.appGraph: AppGraph get() = (applicationContext as CoreApp).graph

val LocalAppGraph = staticCompositionLocalOf<AppGraph> { error("AppGraph is provided by MainActivity") }
