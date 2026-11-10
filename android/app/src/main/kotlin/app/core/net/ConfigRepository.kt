package app.core.net

import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.model.Config
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The server's `GET /v1/config`, once per process.
 *
 * The stored copy is shown at once; then one conditional request
 * (`If-None-Match`) refreshes it. An unchanged document costs the server a 304
 * and nothing more. A failed refresh keeps the stored copy (or, on a first
 * launch offline, the build's defaults): nothing on screen waits for it.
 */
class ConfigRepository(
    private val api: ServerApi,
    private val scope: CoroutineScope,
    private val diag: Diag,
    private val locale: () -> String,
) {
    private val _config = MutableStateFlow<Config?>(null)

    /** Null until a stored or fresh copy exists. */
    val config: StateFlow<Config?> = _config.asStateFlow()

    private val _fresh = MutableStateFlow<Config?>(null)

    /** The last copy the server itself sent in this process; null until one arrived (never the stored copy). */
    val fresh: StateFlow<Config?> = _fresh.asStateFlow()

    private val started = AtomicBoolean(false)

    /** Asks again now (a "try again" on the maintenance screen): the fresh copy, or null when it could not be read. */
    suspend fun refresh(): Config? =
        runCatchingUnlessCancelled { api.config(locale()).value }.getOrNull()?.also(::received)

    private fun received(config: Config) {
        _config.value = config
        _fresh.value = config
    }

    fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch {
            val language = locale()
            runCatchingUnlessCancelled { api.cachedConfig(language) }.getOrNull()?.let { _config.value = it }
            runCatchingUnlessCancelled { api.config(language) }
                .onSuccess { received(it.value) }
                .onFailure {
                    val kept = if (_config.value == null) "the build's defaults" else "the stored copy"
                    diag.info("Config", "refresh failed (${it.javaClass.simpleName}); keeping $kept")
                }
        }
    }
}
