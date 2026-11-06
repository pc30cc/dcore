package app.core

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.compose.runtime.staticCompositionLocalOf
import app.core.brand.AppBrand
import app.core.data.AppDatabase
import app.core.diag.Diag
import app.core.i18n.AppLocales
import app.core.net.ApiClient
import app.core.net.ConfigRepository
import app.core.net.ResponseCache
import app.core.net.RoomResponseCache
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

    /** A failure nobody caught in one background job is logged and ends that job, never the process. */
    val appScope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate +
            CoroutineExceptionHandler { _, e -> diag.warn("App", "background job failed: ${e.javaClass.simpleName}") },
    )

    val secureStore = SecureStore(app, diag)
    val session = SessionStore(secureStore)

    private val database: AppDatabase by lazy { AppDatabase.build(app) }

    val responseCache: ResponseCache = RoomResponseCache { database.cachedResponses() }

    val api: ApiClient by lazy {
        ApiClient(
            baseUrl = AppBrand.apiBaseUrl,
            tokens = session,
            cache = responseCache,
            engine = OkHttp.create(),
            clientDescriptor = "android; store=${AppBrand.store.id}; version=${BuildConfig.VERSION_NAME}; build=${BuildConfig.VERSION_CODE}",
            language = { AppLocales.current(app).tag },
            diag = diag,
            debugLog = if (BuildConfig.DEBUG) { message -> Log.d("App.Http", message) } else null,
        )
    }

    val config: ConfigRepository by lazy { ConfigRepository(api, appScope, diag) }

    /** The store this build was made for: Cafe Bazaar or Google Play, from the flavor's `StoreModule`. */
    val store: StoreServices by lazy { StoreModule.create(app, diag) }
}

val Context.appGraph: AppGraph get() = (applicationContext as CoreApp).graph

val LocalAppGraph = staticCompositionLocalOf<AppGraph> { error("AppGraph is provided by MainActivity") }
