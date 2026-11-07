package app.core.realtime

import app.core.common.Clock
import app.core.model.Id
import app.core.model.Message
import app.core.model.RealtimeEnvelope
import app.core.model.RealtimeTypes
import app.core.model.Wire
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlin.random.Random

/**
 * The sample backend's personal channel: what it publishes, with offsets and
 * an epoch, and a history of the last [HISTORY] publications for recovery,
 * like the server's Centrifugo namespace. **Debug build only.**
 */
class SampleChannel(private val clock: Clock) {
    val epoch: String = "sample-" + Random.nextInt(1_000_000)

    private val history = ArrayDeque<Pair<Long, String>>()
    private var offset = 0L
    private val _live = MutableSharedFlow<Pair<Long, String>>(extraBufferCapacity = 256)
    val live: SharedFlow<Pair<Long, String>> = _live.asSharedFlow()

    /** Messages from the signed-in account, for the sample peer to answer. */
    private val _mine = MutableSharedFlow<Message>(extraBufferCapacity = 16)
    val mine: SharedFlow<Message> = _mine.asSharedFlow()

    fun <T> publish(type: String, id: Id, serializer: KSerializer<T>, payload: T, ephemeral: Boolean = false) {
        val envelope = RealtimeEnvelope(t = type, v = 1, id = id, at = clock.now(), d = Wire.json.encodeToJsonElement(serializer, payload))
        val text = Wire.json.encodeToString(RealtimeEnvelope.serializer(), envelope)
        val entry = synchronized(history) {
            if (ephemeral) {
                -1L to text
            } else {
                offset++
                history.addLast(offset to text)
                while (history.size > HISTORY) history.removeFirst()
                offset to text
            }
        }
        _live.tryEmit(entry)
    }

    fun mine(message: Message) {
        _mine.tryEmit(message)
    }

    val top: Long get() = synchronized(history) { offset }

    /** Everything after [from], or null when history no longer reaches back that far. */
    fun since(from: Long, epoch: String): List<Pair<Long, String>>? = synchronized(history) {
        if (epoch != this.epoch || from > offset) return null
        val first = history.firstOrNull()?.first ?: (offset + 1)
        if (from + 1 < first) return null
        history.filter { it.first > from }
    }

    private companion object {
        const val HISTORY = 100
    }
}

/** What the sample's "other person" can do, for a chat that feels alive on screen. */
interface SamplePeer {
    suspend fun peerDelivered(conversationId: Id, upTo: Id)
    suspend fun peerRead(conversationId: Id, upTo: Id)
    suspend fun peerTyping(conversationId: Id)
    suspend fun peerSays(conversationId: Id): Boolean
}

/**
 * A Centrifugo server in memory, speaking the same JSON frames as the real
 * one, over [SampleChannel]: connect, subscribe with recovery, refresh, pings
 * every 25 s. The debug build on the sample backend runs the real
 * [RealtimeClient] against it. **Debug build only.**
 *
 * The sample's other person answers: a message sent to them is delivered at
 * once, read a moment later, then they type and reply.
 */
class SampleRealtime(
    private val channel: SampleChannel,
    private val peer: SamplePeer,
    private val channelName: () -> String?,
) : RealtimeTransport {

    override suspend fun open(url: String): RealtimeSocket = Socket()

    private inner class Socket : RealtimeSocket {
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        private val inbox = Channel<String>(Channel.UNLIMITED)
        @Volatile private var subscribed = false
        @Volatile private var closed = false
        private val answering = HashSet<Id>()

        init {
            scope.launch {
                while (true) {
                    delay(PING_MS)
                    inbox.trySend("{}")
                }
            }
            scope.launch {
                channel.live.collect { (offset, text) ->
                    if (!subscribed) return@collect
                    inbox.trySend(publication(offset, text))
                }
            }
            scope.launch {
                channel.mine.collect { message -> answer(message) }
            }
        }

        private fun publication(offset: Long, text: String): String = buildJsonObject {
            put(
                "push",
                buildJsonObject {
                    put("channel", channelName().orEmpty())
                    put(
                        "pub",
                        buildJsonObject {
                            put("data", Wire.json.parseToJsonElement(text))
                            if (offset > 0) put("offset", offset)
                        },
                    )
                },
            )
        }.toString()

        private fun answer(message: Message) {
            val conversation = message.conversationId
            synchronized(answering) { if (!answering.add(conversation)) return }
            scope.launch {
                try {
                    delay(600)
                    peer.peerDelivered(conversation, message.id)
                    delay(1_800)
                    peer.peerRead(conversation, message.id)
                    delay(900)
                    peer.peerTyping(conversation)
                    delay(2_600)
                    peer.peerSays(conversation)
                } finally {
                    synchronized(answering) { answering.remove(conversation) }
                }
            }
        }

        override suspend fun receive(): String? = if (closed) null else inbox.receiveCatching().getOrNull()

        override suspend fun send(text: String) {
            if (text == "{}") return
            val frame = runCatching { Wire.json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
            val id = frame["id"]?.jsonPrimitive?.longOrNull ?: return
            val reply = when {
                frame["connect"] != null -> """{"id":$id,"connect":{"client":"sample","version":"6","expires":true,"ttl":3600,"ping":25,"pong":true}}"""
                frame["refresh"] != null -> """{"id":$id,"refresh":{"client":"sample","version":"6","expires":true,"ttl":3600}}"""
                frame["subscribe"] != null -> subscribe(id, frame["subscribe"] as JsonObject)
                else -> """{"id":$id,"error":{"code":104,"message":"method not found"}}"""
            }
            inbox.trySend(reply)
        }

        private fun subscribe(id: Long, request: JsonObject): String {
            val recover = request["recover"]?.jsonPrimitive?.content == "true"
            val from = request["offset"]?.jsonPrimitive?.longOrNull
            val epoch = request["epoch"]?.jsonPrimitive?.content
            val missed = if (recover && from != null && epoch != null) channel.since(from, epoch) else null
            subscribed = true
            val pubs = missed.orEmpty().joinToString(",") { (offset, text) -> """{"data":$text,"offset":$offset}""" }
            return """{"id":$id,"subscribe":{"recoverable":true,"epoch":"${channel.epoch}","offset":${channel.top},""" +
                """"recovered":${missed != null},"was_recovering":$recover,"publications":[$pubs]}}"""
        }

        override suspend fun close() {
            closed = true
            inbox.close()
            scope.cancel()
        }

        override suspend fun closeCode(): Int? = null
    }

    private companion object {
        const val PING_MS = 25_000L
    }
}

