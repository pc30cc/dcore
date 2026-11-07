package app.core.realtime

import app.core.common.Diag
import app.core.model.RealtimeEvent
import app.core.model.RealtimeEvents
import app.core.model.RealtimeToken
import app.core.net.ApiError
import app.core.realtime.CentrifugoProtocol.StreamPosition
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/** How the realtime connection is doing, for the rest of the app: only this decides whether the sync layer polls. */
enum class RealtimeHealth {
    /** No socket wanted: the app is in the background, or nobody is signed in. */
    IDLE,

    /** Opening, or between attempts after a first failure. */
    CONNECTING,

    /** Up and subscribed: every change reaches the phone as it happens. */
    CONNECTED,

    /** Failing repeatedly: the sync layer reads on its own fallback timer until this clears. */
    DEGRADED,
}

/** Where the realtime client delivers what it hears: the sync layer, in the app. */
interface RealtimeSink {
    fun onEvent(event: RealtimeEvent)

    /**
     * A session is up and subscribed. [recovered] is true only when the
     * server replayed every publication missed since the previous session,
     * so nothing needs to be read over REST. [first] marks the first session
     * of this run: with no position to recover from, whatever was published
     * before the subscribe reached nobody, and only a read finds it.
     */
    fun onConnected(recovered: Boolean, first: Boolean)

    fun onHealth(health: RealtimeHealth)
}

/**
 * Where each channel had read up to, kept between runs of the client so a
 * return to the front within the server's history window (15 minutes) is
 * recovered from the stream instead of read again over REST. Cleared when
 * another account signs in.
 */
class RealtimePositions {
    private val positions = HashMap<String, StreamPosition>()

    @Volatile var account: String? = null
        private set

    /** Positions belong to one account; another one starts from nothing. */
    @Synchronized
    fun useFor(account: String?) {
        if (this.account != account) {
            positions.clear()
            this.account = account
        }
    }

    @Synchronized
    operator fun get(channel: String): StreamPosition? = positions[channel]

    @Synchronized
    operator fun set(channel: String, position: StreamPosition) {
        positions[channel] = position
    }

    @Synchronized
    fun remove(channel: String) {
        positions.remove(channel)
    }

    /** A publication moved the channel on; only a known stream (an epoch) is advanced. */
    @Synchronized
    fun advance(channel: String, offset: Long) {
        positions[channel]?.let { if (offset > it.offset) positions[channel] = it.copy(offset = offset) }
    }
}

/**
 * The account's realtime connection: one socket, one personal channel.
 *
 * Per attempt: a connection token (`POST /v1/realtime/token`, reused while
 * it has more than [RealtimeTiming.minTokenLeftMs] left), the socket at the
 * token's `wsUrl` (the server's Cloudflare-fronted host; the build's own
 * address when the answer names none), `connect`, then the channel, answering
 * every `{}` ping. What a phone adds on top:
 *
 *  - **Backoff with jitter** between attempts (1, 2, 4, 8, 15, 30 s, capped at
 *    60, times 0.8-1.2), at least 30 s after a terminal disconnect, cut short
 *    when the network comes back ([nudge]).
 *  - **In-band refresh**: two minutes before the token expires, a fresh one
 *    is fetched and sent as `refresh` on the same socket. No reconnect, no
 *    recovery traffic.
 *  - **Recovery**: the channel is resumed from its last offset and epoch, so a
 *    short drop replays what was missed instead of costing a REST reconcile.
 *    Only when the server says it could not ([RealtimeSink.onConnected] with
 *    `recovered = false`) does the sync layer read.
 *  - **Dedupe** of events by their id, bounded (512, oldest forgotten): a
 *    recovered replay can repeat what was already delivered.
 *  - **Stale detection**: nothing heard for 60 s (two missed pings) is a dead
 *    socket.
 *
 * [run] runs until cancelled, which is how the app turns realtime off when it
 * goes to the background, and closes the socket on the way out. It returns on
 * its own only when the session cannot get a token at all (signed out,
 * restricted).
 */
class RealtimeClient(
    private val tokens: suspend () -> RealtimeToken,
    private val transport: RealtimeTransport,
    private val sink: RealtimeSink,
    /** The build's socket address, used when a token names no usable one. */
    private val fallbackUrl: String,
    private val positions: RealtimePositions = RealtimePositions(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val random: Random = Random.Default,
    private val diag: Diag = Diag.Android,
    private val timing: RealtimeTiming = RealtimeTiming(),
    private val appVersion: String = "",
) {
    private val nudges = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    private val seen = SeenSet(timing.dedupeCapacity)
    private val commandIds = AtomicInteger(0)

    /** The token in hand, and when it stops being usable by the phone's clock. */
    private class HeldToken(val token: RealtimeToken, val deadline: Long)

    @Volatile private var held: HeldToken? = null

    /** The channel subscribed through the connect reply: then the connect carries its recovery position too. */
    @Volatile private var serverSide = false

    /** The network came back: skip what is left of the current backoff. */
    fun nudge() {
        nudges.tryEmit(Unit)
    }

    private sealed interface Outcome {
        data class Failed(val reason: String, val terminal: Boolean = false, val newToken: Boolean = false) : Outcome

        /** No token can be had: signed out, or the account may not use realtime now. */
        data object SignedOut : Outcome
    }

    suspend fun run() {
        var failures = 0
        var everConnected = false
        var forceToken = false
        sink.onHealth(RealtimeHealth.CONNECTING)
        try {
            while (true) {
                val outcome = session(forceToken, first = !everConnected) {
                    everConnected = true
                    failures = 0
                }
                when (outcome) {
                    Outcome.SignedOut -> {
                        diag.info(AREA, "no token: signed out or restricted; realtime off")
                        sink.onHealth(RealtimeHealth.DEGRADED)
                        return
                    }
                    is Outcome.Failed -> {
                        failures++
                        forceToken = outcome.newToken
                        if (outcome.newToken) held = null
                        sink.onHealth(if (failures >= timing.degradedAfter) RealtimeHealth.DEGRADED else RealtimeHealth.CONNECTING)
                        val wait = backoff(failures, outcome.terminal)
                        diag.info(AREA, "disconnected (${outcome.reason}); attempt $failures, retry in ${wait}ms")
                        waitOrNudge(wait)
                    }
                }
            }
        } finally {
            sink.onHealth(RealtimeHealth.IDLE)
        }
    }

    /** The delay before attempt [failures]+1, jittered so a fleet of phones does not reconnect in step. */
    internal fun backoff(failures: Int, terminal: Boolean): Long {
        val steps = timing.backoffStepsMs
        val base = steps[(failures - 1).coerceIn(0, steps.lastIndex)].coerceAtMost(timing.backoffCapMs)
        val jittered = (base * (0.8 + random.nextDouble() * 0.4)).toLong()
        return if (terminal) jittered.coerceAtLeast(timing.terminalFloorMs) else jittered
    }

    private suspend fun waitOrNudge(ms: Long) {
        withTimeoutOrNull(ms) { nudges.first() }
    }

    /**
     * How long a token is good for by the phone's clock. The expiry is the
     * server's clock and the phone's may be wrong by hours: a lifetime that
     * comes out implausible (under four minutes, or over three hours) is
     * replaced by a conservative guess rather than trusted, which keeps a
     * phone set an hour fast from refreshing every few seconds.
     */
    internal fun deadlineOf(token: RealtimeToken, receivedAt: Long): Long {
        var lifetime = token.expiresAt.toEpochMilli() - receivedAt
        if (lifetime < PLAUSIBLE_MIN_LIFETIME_MS || lifetime > PLAUSIBLE_MAX_LIFETIME_MS) lifetime = timing.assumedLifetimeMs
        return receivedAt + lifetime
    }

    /** When to send `refresh`: [RealtimeTiming.refreshBeforeExpiryMs] ahead of the deadline, never sooner than [RealtimeTiming.minSessionMs]. */
    internal fun refreshTime(deadline: Long): Long {
        val now = clock()
        return now + (deadline - now - timing.refreshBeforeExpiryMs).coerceAtLeast(timing.minSessionMs)
    }

    private suspend fun token(force: Boolean): HeldToken {
        val current = held
        if (!force && current != null && current.deadline - clock() > timing.minTokenLeftMs) return current
        val fresh = tokens()
        return HeldToken(fresh, deadlineOf(fresh, clock())).also { held = it }
    }

    /** The socket address: the token's when it is a WebSocket URL this build may use, else the build's. */
    internal fun socketUrl(token: RealtimeToken): String {
        val offered = token.wsUrl.trim()
        val allowed = offered.startsWith("wss://") || (offered.startsWith("ws://") && fallbackUrl.startsWith("ws://"))
        return if (allowed && offered.length > "wss://".length) offered else fallbackUrl
    }

    private fun nextId(): Int = commandIds.incrementAndGet()

    private suspend fun session(forceToken: Boolean, first: Boolean, connected: () -> Unit): Outcome {
        val held = try {
            token(forceToken)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError.Unauthorized) {
            return Outcome.SignedOut
        } catch (e: ApiError.Http) {
            if (e.isAccountState || e.status == 401) return Outcome.SignedOut
            return Outcome.Failed("token ${e.status}")
        } catch (e: Throwable) {
            return Outcome.Failed("token ${e.javaClass.simpleName}")
        }
        val channel = held.token.channel
        val socket = try {
            withTimeoutOrNull(timing.connectTimeoutMs) { transport.open(socketUrl(held.token)) }
                ?: return Outcome.Failed("open timed out")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            return Outcome.Failed("open ${e.javaClass.simpleName}")
        }

        try {
            val recoverAtConnect = if (serverSide) positions[channel]?.let { mapOf(channel to it) }.orEmpty() else emptyMap()
            val connectId = nextId()
            socket.send(CentrifugoProtocol.connect(connectId, held.token.token, CLIENT_NAME, appVersion, recoverAtConnect))
            val connectReply = awaitReply(socket, connectId, channel) ?: return Outcome.Failed("no connect reply")
            connectReply.error?.let { error ->
                return when (error.code) {
                    CentrifugoProtocol.ERROR_TOKEN_EXPIRED -> Outcome.Failed("token expired", newToken = true)
                    CentrifugoProtocol.ERROR_UNAUTHORIZED -> Outcome.Failed("token refused", terminal = true, newToken = true)
                    else -> Outcome.Failed("connect error ${error.code}", terminal = !error.temporary)
                }
            }
            val from = positions[channel]
            val result: SubscribeResult = connectReply.connect?.subs?.get(channel)?.also { serverSide = true }
                ?: subscribe(socket, channel)
                ?: return Outcome.Failed("subscribe refused")
            result.publications.forEach { deliver(channel, it, track = false) }
            if (result.epoch != null && result.offset != null) {
                positions[channel] = StreamPosition(result.offset, result.epoch)
            }
            val recovered = from != null && result.recovered

            connected()
            sink.onHealth(RealtimeHealth.CONNECTED)
            diag.info(AREA, "connected${if (serverSide) " (server-side channel)" else ""}${if (recovered) ", recovered" else ""}")
            sink.onConnected(recovered = recovered, first = first)

            return read(socket, channel, held.deadline)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            return Outcome.Failed("socket ${e.javaClass.simpleName}")
        } finally {
            // Closed even when the run is being cancelled, which is exactly
            // when it matters: the app went to the background.
            withContext(NonCancellable) { socket.close() }
        }
    }

    /**
     * Subscribes the user-limited channel, resuming from its last position
     * when there is one. Null when the server refused it.
     */
    private suspend fun subscribe(socket: RealtimeSocket, channel: String): SubscribeResult? {
        val from = positions[channel]
        var id = nextId()
        socket.send(CentrifugoProtocol.subscribe(id, channel, from))
        var reply = awaitReply(socket, id, channel) ?: return null
        if (reply.error?.code == CentrifugoProtocol.ERROR_UNRECOVERABLE_POSITION) {
            // History no longer reaches that far back. Subscribe plainly; the
            // sync layer reads over REST because this is not "recovered".
            positions.remove(channel)
            id = nextId()
            socket.send(CentrifugoProtocol.subscribe(id, channel, null))
            reply = awaitReply(socket, id, channel) ?: return null
        }
        val error = reply.error
        if (error != null && error.code != CentrifugoProtocol.ERROR_ALREADY_SUBSCRIBED) return null
        return reply.subscribe ?: SubscribeResult(false, false, false, null, null, emptyList())
    }

    /** Reads until the reply to [id], answering pings and delivering publications meanwhile. */
    private suspend fun awaitReply(socket: RealtimeSocket, id: Int, channel: String): Inbound.Reply? =
        withTimeoutOrNull(timing.replyTimeoutMs) {
            var reply: Inbound.Reply? = null
            var ended = false
            while (reply == null && !ended) {
                val text = socket.receive()
                if (text == null) {
                    ended = true
                } else {
                    for (frame in CentrifugoProtocol.parse(text)) {
                        when (frame) {
                            Inbound.Ping -> socket.send(CentrifugoProtocol.PONG)
                            is Inbound.Reply -> if (frame.id == id) reply = frame
                            is Inbound.Publication -> deliver(frame.channel.ifEmpty { channel }, frame, track = false)
                            is Inbound.Disconnect -> ended = true
                            else -> Unit
                        }
                    }
                }
            }
            reply
        }

    /** What the refresh job tells the read loop. */
    private class RefreshState {
        @Volatile var inFlightId: Int? = null
        @Volatile var pending: HeldToken? = null
        @Volatile var signedOut: Boolean = false
    }

    /**
     * The session proper: publications in, pings answered, the token
     * refreshed in band, until the socket closes or goes quiet for longer
     * than two ping intervals.
     */
    private suspend fun read(socket: RealtimeSocket, channel: String, initialDeadline: Long): Outcome = coroutineScope {
        val refresh = RefreshState()
        var deadline = initialDeadline
        var refreshAt = refreshTime(deadline)

        fun startRefresh(at: Long) = launch {
            delay((at - clock()).coerceAtLeast(0))
            var attempt = 0
            while (true) {
                try {
                    val fresh = tokens()
                    val next = HeldToken(fresh, deadlineOf(fresh, clock()))
                    val id = nextId()
                    refresh.pending = next
                    refresh.inFlightId = id
                    socket.send(CentrifugoProtocol.refresh(id, fresh.token))
                    return@launch
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiError.Unauthorized) {
                    refresh.signedOut = true
                    socket.close()
                    return@launch
                } catch (e: ApiError.Http) {
                    if (e.isAccountState) {
                        refresh.signedOut = true
                        socket.close()
                        return@launch
                    }
                } catch (e: Throwable) {
                    // A failed fetch is retried until the token runs out; then
                    // the server ends the connection and the next attempt
                    // starts with a fresh token.
                }
                attempt++
                diag.info(AREA, "token refresh failed; retry ${attempt}")
                delay(timing.refreshRetryMs)
            }
        }

        var refreshJob = startRefresh(refreshAt)
        var lastHeard = clock()
        try {
            while (true) {
                val quietFor = clock() - lastHeard
                val wait = (timing.staleAfterMs - quietFor).coerceAtLeast(1)
                val next: Any? = withTimeoutOrNull(wait) { socket.receive() ?: Closed }
                when (next) {
                    null -> return@coroutineScope Outcome.Failed("stale: nothing heard in ${timing.staleAfterMs / 1000}s")
                    Closed -> {
                        if (refresh.signedOut) return@coroutineScope Outcome.SignedOut
                        val code = socket.closeCode()
                        return@coroutineScope Outcome.Failed(
                            "closed ${code ?: "-"}",
                            terminal = code != null && CentrifugoProtocol.isTerminal(code),
                            newToken = code == CentrifugoProtocol.DISCONNECT_INVALID_TOKEN || code == CentrifugoProtocol.DISCONNECT_EXPIRED,
                        )
                    }
                    is String -> {
                        lastHeard = clock()
                        for (frame in CentrifugoProtocol.parse(next)) {
                            when (frame) {
                                Inbound.Ping -> socket.send(CentrifugoProtocol.PONG)
                                is Inbound.Publication -> deliver(frame.channel.ifEmpty { channel }, frame, track = true)
                                is Inbound.Reply -> if (frame.id == refresh.inFlightId) {
                                    refresh.inFlightId = null
                                    val adopted = refresh.pending
                                    refresh.pending = null
                                    if (frame.error != null) {
                                        return@coroutineScope Outcome.Failed("refresh refused ${frame.error.code}", newToken = true)
                                    }
                                    if (adopted != null) {
                                        held = adopted
                                        deadline = adopted.deadline
                                        refreshAt = refreshTime(deadline)
                                        refreshJob = startRefresh(refreshAt)
                                        diag.info(AREA, "token refreshed in band")
                                    }
                                }
                                is Inbound.Disconnect -> return@coroutineScope Outcome.Failed(
                                    "server disconnect ${frame.code}",
                                    terminal = CentrifugoProtocol.isTerminal(frame.code),
                                    newToken = frame.code == CentrifugoProtocol.DISCONNECT_INVALID_TOKEN ||
                                        frame.code == CentrifugoProtocol.DISCONNECT_EXPIRED,
                                )
                                is Inbound.Unsubscribed -> if (frame.channel == channel) {
                                    return@coroutineScope Outcome.Failed("unsubscribed ${frame.code}")
                                }
                                is Inbound.ServerSubscribed -> if (frame.channel == channel) {
                                    val result = frame.result
                                    if (result.epoch != null && result.offset != null) {
                                        positions[channel] = StreamPosition(result.offset, result.epoch)
                                    }
                                }
                                Inbound.Unknown -> Unit
                            }
                        }
                    }
                }
            }
            @Suppress("UNREACHABLE_CODE")
            Outcome.Failed("unreachable")
        } finally {
            refreshJob.cancel()
        }
    }

    /**
     * One publication: its position noted (when [track]), then, unless an
     * event with the same id was already delivered, decoded and handed on.
     * Anything this build cannot decode is dropped quietly: one odd
     * publication must not end the connection that carries the others.
     */
    private fun deliver(channel: String, publication: Inbound.Publication, track: Boolean) {
        if (track && publication.offset != null) positions.advance(channel, publication.offset)
        val data = publication.data ?: return
        val event = RealtimeEvents.decode(data) ?: return
        if (!seen.add(dedupeKey(event))) return
        sink.onEvent(event)
    }

    private fun dedupeKey(event: RealtimeEvent): String = "${event.javaClass.simpleName}:${event.id}"

    private companion object {
        const val AREA = "Realtime"
        const val PLAUSIBLE_MIN_LIFETIME_MS = 4 * 60_000L
        const val PLAUSIBLE_MAX_LIFETIME_MS = 3 * 60 * 60_000L

        /** Informational only; the server does not check it. Neutral, never the brand. */
        const val CLIENT_NAME = "app-android"
    }

    /** The socket's end, as distinct from a quiet socket. */
    private object Closed
}

/** The timings the client runs on; tests shrink them. */
data class RealtimeTiming(
    val backoffStepsMs: List<Long> = listOf(1_000, 2_000, 4_000, 8_000, 15_000, 30_000),
    val backoffCapMs: Long = 60_000,
    /** A server that said "do not come straight back" is not asked again for at least this long. */
    val terminalFloorMs: Long = 30_000,
    val connectTimeoutMs: Long = 10_000,
    val replyTimeoutMs: Long = 10_000,
    /** Two missed 25 s pings and a margin: the connection is dead. */
    val staleAfterMs: Long = 60_000,
    val refreshBeforeExpiryMs: Long = 120_000,
    /** What a token's lifetime is taken to be when the phone's clock cannot be trusted to say. */
    val assumedLifetimeMs: Long = 25 * 60_000L,
    val minSessionMs: Long = 10_000,
    /** A token with less than this left is not reused for a new connection. */
    val minTokenLeftMs: Long = 5 * 60_000L,
    val refreshRetryMs: Long = 30_000,
    /** Failures in a row before the sync layer's fallback reads take over. */
    val degradedAfter: Int = 2,
    val dedupeCapacity: Int = 512,
)

/** A bounded set that forgets its oldest entries: never an unbounded `Set`. */
internal class SeenSet(private val capacity: Int) {
    private val entries = object : LinkedHashMap<String, Unit>(capacity, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Unit>?): Boolean = size > capacity
    }

    /** True when [key] was not already present. */
    @Synchronized
    fun add(key: String): Boolean = entries.put(key, Unit) == null

    @get:Synchronized
    val size: Int get() = entries.size
}
