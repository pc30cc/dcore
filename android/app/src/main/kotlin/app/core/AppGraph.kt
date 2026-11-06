package app.core

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.compose.runtime.staticCompositionLocalOf
import app.core.brand.AppBrand
import app.core.cache.CacheDatabaseHolder
import app.core.common.Clock
import app.core.common.Diag
import app.core.i18n.AppLocales
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
}

val Context.appGraph: AppGraph get() = (applicationContext as CoreApp).graph

val LocalAppGraph = staticCompositionLocalOf<AppGraph> { error("AppGraph is provided by MainActivity") }
