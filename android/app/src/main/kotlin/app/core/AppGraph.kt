package app.core

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.compose.runtime.staticCompositionLocalOf
import app.core.brand.AppBrand
import app.core.cache.CacheDatabaseHolder
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
import app.core.storage.Preferences
import app.core.storage.SecureStore
import app.core.storage.SessionStore
import app.core.store.StoreModule
import app.core.store.StoreServices
import app.core.push.PushGraph
import app.core.realtime.KtorRealtimeTransport
import app.core.realtime.RealtimeCoordinator
import app.core.realtime.RealtimeTransport
import app.core.sync.CachedDeckSnapshotStore
import app.core.sync.ChatGraph
import app.core.sync.DeckRepository
import app.core.sync.EntitlementRepository
import io.ktor.client.engine.okhttp.OkHttp
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

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
    val auth: AuthGate by lazy { AuthGate(api, store.externalSignIn, store.smsCodes, appScope, diag) }

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
            sendSwipes = { swipes -> api.swipe(swipes).also(chat.sync::onSwipes) },
            account = { api.sessionUser()?.id },
            store = CachedDeckSnapshotStore(responseCache, diag),
            onQuotas = { result -> entitlements.applyQuotas(result.quotas) },
            clock = clock,
            diag = diag,
        )
    }

    /** The realtime socket's transport: the real server's, or in a debug build on the sample backend, the sample's. */
    private val realtimeTransport: RealtimeTransport by lazy { (api as? RealtimeTransport) ?: KtorRealtimeTransport() }

    /** Conversations, messages, message requests and the realtime socket (sync/, realtime/). */
    val chat: ChatGraph by lazy {
        ChatGraph(app, api, cacheDatabase, realtimeTransport, auth, entitlements, config, appScope, clock, diag)
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
    val calls: CallGraph by lazy { CallGraph(app, apiOf = { api }, scope = appScope, clock = clock, diag = diag) }

    /** Push: the FCM transport, the registration, the router and the notification taps (push/). */
    val push: PushGraph by lazy {
        // Rings and their stops go to the calls, even for a push that cold-started the process.
        PushGraph(app, api, secureStore, chat.sync, appScope, clock, diag).also { it.router.calls = calls.pushHandler }
    }
}

val Context.appGraph: AppGraph get() = (applicationContext as CoreApp).graph

val LocalAppGraph = staticCompositionLocalOf<AppGraph> { error("AppGraph is provided by MainActivity") }
