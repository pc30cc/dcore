package app.core.net

import app.core.diag.Diag
import app.core.diag.runCatchingUnlessCancelled
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The server's `GET /config`, once per process.
 *
 * The stored copy is shown at once; then one conditional request
 * (`If-None-Match`) refreshes it. An unchanged document costs the server a
 * 304 and no query. A failed refresh keeps the stored copy (or, on a first
 * launch offline, the build's defaults): nothing on screen waits for it.
 */
class ConfigRepository(
    private val api: ApiClient,
    private val scope: CoroutineScope,
    private val diag: Diag,
) {
    private val _config = MutableStateFlow<ClientConfig?>(null)

    /** Null until a stored or fresh copy exists. */
    val config: StateFlow<ClientConfig?> = _config.asStateFlow()

    private val started = AtomicBoolean(false)

    fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch {
            api.cachedConfig()?.let { _config.value = it }
            runCatchingUnlessCancelled { api.config() }
                .onSuccess { _config.value = it }
                .onFailure { diag.info("Config", "refresh failed (${it.message}); keeping ${if (_config.value == null) "the build's defaults" else "the stored copy"}") }
        }
    }
}
