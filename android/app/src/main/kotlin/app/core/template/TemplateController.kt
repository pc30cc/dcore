package app.core.template

import app.core.common.Diag
import app.core.model.Config
import app.core.model.Settings
import app.core.net.ApiError
import app.core.net.SettingsTap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * The template choice, kept in step with the server:
 *
 * - [setChoice] applies at once (the theme recomposes, no restart), stores
 *   the choice as pending and sends `PATCH /v1/me/settings {template}`.
 * - A pending choice is sent again on the next start ([start]) and the next
 *   time an answer carries the settings, until the server has it; a
 *   permanent refusal (the server does not take the value) drops the
 *   pending flag and keeps the choice on this phone.
 * - The settings the server returns are adopted, except while a local
 *   choice is pending and from a request that left before the latest local
 *   change ([SettingsTap]); a server older than templates (no `template`)
 *   changes nothing. Only a completed send of the current choice clears
 *   the pending flag: an answer showing the server on that value proves
 *   nothing while an older send may still land after it.
 * - `config.ui` is kept as it arrives ([onConfig]); a config without one
 *   keeps the last one, and a stored copy older than the `ui` kept here
 *   (the config is cached per language) is skipped.
 * - Signing out drops a pending choice: it belonged to that account.
 */
class TemplateController(
    private val store: TemplateStore,
    /** Sends the choice: `PATCH /v1/me/settings {template}`. */
    private val send: suspend (String) -> Settings,
    /** Whether an account is signed in to send it to. */
    private val signedIn: suspend () -> Boolean,
    private val scope: CoroutineScope,
    private val diag: Diag,
) : SettingsTap {
    /** The stored choice, the last `ui` and the pending flag. */
    val state: StateFlow<TemplateState> get() = store.state

    /** The template drawn now. */
    val effective: StateFlow<String> get() = store.effective

    /** Bumped by every local change and every completed send: answers that left before it are stale. */
    private val epoch = AtomicLong(0)
    private val sending = Mutex()
    private val started = AtomicBoolean(false)

    /**
     * Sends a choice left pending by an earlier run (on every call: a new
     * activity is a new chance) and, on the first call only, follows
     * [configs] (any copy, the stored one included) and [fresh] (the copies
     * the server itself sent in this process) for `config.ui`.
     */
    fun start(configs: Flow<Config?>, fresh: Flow<Config?> = emptyFlow()) {
        scope.launch { sync() }
        if (!started.compareAndSet(false, true)) return
        scope.launch { configs.collect { onConfig(it) } }
        scope.launch { fresh.collect { if (it != null) onConfig(it, fresh = true) } }
    }

    /**
     * The person picks [choice] (`default` or a template this build ships):
     * drawn at once, stored, sent. Anything else is ignored.
     */
    fun setChoice(choice: String) {
        if (!TemplateRule.isChoice(choice)) {
            diag.warn(AREA, "ignored a choice this build does not ship")
            return
        }
        epoch.incrementAndGet()
        val before = store.state.value
        if (before.choice == choice && !before.pending) return
        store.update { it.copy(choice = choice, pending = true) }
        scope.launch { sync() }
    }

    /**
     * The config's `ui`, when it has one: always from a [fresh] answer (the
     * server's version counter can start over), otherwise only when the
     * config is not older than the `ui` kept here.
     */
    fun onConfig(config: Config?, fresh: Boolean = false) {
        val ui = config?.ui ?: return
        store.update {
            when {
                fresh || config.v >= it.uiVersion -> it.copy(ui = ui, uiVersion = config.v)
                else -> it
            }
        }
    }

    override fun begin(): Long = epoch.get()

    override fun received(begun: Long, settings: Settings) {
        val server = settings.template ?: return
        if (!TemplateRule.isWireChoice(server)) return
        val now = store.state.value
        if (now.pending) {
            // Never cleared here: an older send can still land after this
            // answer. Sending again is idempotent, and sync() clears the
            // flag once a send of the current choice has completed.
            scope.launch { sync() }
            return
        }
        if (begun < epoch.get()) return
        if (server != now.choice) store.update { if (it.pending) it else it.copy(choice = server) }
    }

    /** The account signed out: a choice not sent yet is not sent to the next one. */
    fun onSignedOut() {
        epoch.incrementAndGet()
        store.update { it.copy(pending = false) }
    }

    /** Sends the pending choice until the server has the latest one, or a send fails. */
    suspend fun sync() {
        sending.withLock {
            while (true) {
                val pending = store.state.value
                if (!pending.pending) return
                val signed = try {
                    signedIn()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    false
                }
                if (!signed) return
                val sent = pending.choice
                try {
                    send(sent)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiError.Http) {
                    if (isPermanent(e)) {
                        diag.warn(AREA, "the server refused the choice (${e.status}); kept on this phone only")
                        store.update { if (it.choice == sent) it.copy(pending = false) else it }
                    } else {
                        diag.info(AREA, "sending the choice failed (${e.status}); kept pending")
                    }
                    return
                } catch (e: Exception) {
                    diag.info(AREA, "sending the choice failed (${e.javaClass.simpleName}); kept pending")
                    return
                }
                epoch.incrementAndGet()
                store.update { if (it.choice == sent) it.copy(pending = false) else it }
                // A newer choice made while this one was on its way goes next.
            }
        }
    }

    /** A refusal that sending again cannot change: the value itself (validation), not the moment. */
    private fun isPermanent(e: ApiError.Http): Boolean =
        e.status in 400..499 && e.status != 408 && e.status != 429 && !e.isAccountState

    private companion object {
        const val AREA = "Template"
    }
}
