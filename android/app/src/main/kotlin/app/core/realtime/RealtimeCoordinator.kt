package app.core.realtime

import app.core.common.Diag
import app.core.model.RealtimeEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/** What the coordinator hands on besides the events everyone may watch: the sync layer. */
interface RealtimeListener {
    fun onEvent(event: RealtimeEvent)
    fun onConnected(recovered: Boolean, first: Boolean)
    fun onHealth(health: RealtimeHealth)

    /** The phone has a network again: whatever read is owed can be made now. */
    fun onNetworkAvailable() {}
}

/**
 * Decides WHEN there is a socket; [RealtimeClient] decides how.
 *
 * There is one exactly while the app is in front and an account that may use
 * the app is signed in. It is not kept alive in the background (no foreground
 * service, no wake lock, no socket held open in a pocket): once the app is out
 * of sight, news comes by push, which the system delivers through Doze where a
 * socket of ours would not survive anyway. Coming back to the front opens a
 * new socket that resumes the channel from where it was, so a short absence
 * costs one token request at most and no reconcile.
 *
 * Another account is a new socket too: `collectLatest` cancels the old run,
 * closing its socket, before the new one asks for its token, and the stream
 * positions of the old account are forgotten.
 *
 * [events] is every decoded event, for whoever else needs to watch the
 * stream (calls, likes, entitlements, the account state); the [listener]
 * (the chat sync) gets them first.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RealtimeCoordinator(
    private val clientFactory: (RealtimeSink, RealtimePositions) -> RealtimeClient,
    private val listener: RealtimeListener,
    scope: CoroutineScope,
    private val diag: Diag = Diag.Android,
) {
    private val foreground = MutableStateFlow(false)
    private val account = MutableStateFlow<String?>(null)
    private val positions = RealtimePositions()

    @Volatile private var client: RealtimeClient? = null

    private val _health = MutableStateFlow(RealtimeHealth.IDLE)
    val health: StateFlow<RealtimeHealth> = _health.asStateFlow()

    private val _events = MutableSharedFlow<RealtimeEvent>(extraBufferCapacity = 256, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Every event, after the sync layer has applied it. Nothing is replayed to a late collector. */
    val events: SharedFlow<RealtimeEvent> = _events.asSharedFlow()

    private val sink = object : RealtimeSink {
        override fun onEvent(event: RealtimeEvent) {
            listener.onEvent(event)
            _events.tryEmit(event)
        }

        override fun onConnected(recovered: Boolean, first: Boolean) = listener.onConnected(recovered, first)

        override fun onHealth(health: RealtimeHealth) {
            _health.value = health
            listener.onHealth(health)
        }
    }

    init {
        scope.launch {
            combine(foreground, account) { fg, who -> if (fg) who else null }
                .distinctUntilChanged()
                .collectLatest { who ->
                    if (who == null) {
                        sink.onHealth(RealtimeHealth.IDLE)
                        return@collectLatest
                    }
                    positions.useFor(who)
                    diag.info(AREA, "starting for ${Diag.id(who)}")
                    val running = clientFactory(sink, positions)
                    client = running
                    try {
                        running.run()
                    } finally {
                        if (client === running) client = null
                        diag.info(AREA, "stopped")
                    }
                }
        }
    }

    /** The app came to the front (true) or left it (false). */
    fun setForeground(value: Boolean) {
        foreground.value = value
    }

    /** The account a socket is for: null when signed out, restricted or not yet through sign-up. */
    fun setAccount(publicUid: String?) {
        account.value = publicUid
    }

    /**
     * The network came back: a client waiting out a backoff tries now, and a
     * read the sync layer owes is made now.
     */
    fun onNetworkAvailable() {
        client?.nudge()
        listener.onNetworkAvailable()
    }

    private companion object {
        const val AREA = "Realtime"
    }
}
