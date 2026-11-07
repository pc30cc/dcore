package app.core.testing

import app.core.realtime.RealtimeSocket
import app.core.realtime.RealtimeTransport
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * A scripted Centrifugo server for the realtime client's tests: connect,
 * subscribe with recovery from a bounded history with epochs and offsets,
 * in-band refresh, pings, publications, server disconnects and dropped
 * sockets, all on whatever clock the test runs.
 */
class FakeCentrifugo(val channel: String = CHANNEL) : RealtimeTransport {

    var epoch = "epoch-1"
    var historySize = 100

    /** Reply `recovered: false` to every recovery, as after a history TTL. */
    var refuseRecovery = false

    /** Answer a recovery with error 112 instead. */
    var unrecoverableError = false

    /** Subscribe the channel server-side: it comes in the connect reply, and a client subscribe is an error 105. */
    var serverSide = false

    /** An error code for the next connect replies (e.g. 109 expired). */
    var connectError: Int? = null

    /** An error code for the next refresh replies. */
    var refreshError: Int? = null

    /** How many of the next opens fail at once. */
    var failOpens = 0

    private val history = ArrayList<Pair<Long, String>>()
    private var offset = 0L

    /** Every command a client sent, in order, as parsed JSON. */
    val commands = mutableListOf<JsonObject>()
    val sockets = mutableListOf<Socket>()
    val current: Socket? get() = sockets.lastOrNull { !it.closed }

    override suspend fun open(url: String): RealtimeSocket {
        opens += url
        if (failOpens > 0) {
            failOpens--
            error("refused")
        }
        return Socket().also { sockets += it }
    }

    val opens = mutableListOf<String>()

    /** Publishes an envelope (JSON) on the channel: stored in history, pushed to subscribed sockets. */
    fun publish(envelope: String): Long {
        offset++
        history += offset to envelope
        while (history.size > historySize) history.removeAt(0)
        sockets.filter { it.subscribed && !it.closed }.forEach { it.push(publication(offset, envelope)) }
        return offset
    }

    /** A publication that is not kept in history (typing). */
    fun publishEphemeral(envelope: String) {
        sockets.filter { it.subscribed && !it.closed }.forEach { it.push("""{"push":{"channel":"$channel","pub":{"data":$envelope}}}""") }
    }

    fun ping() {
        current?.push("{}")
    }

    /** The server restarted without its history: a new epoch. */
    fun newEpoch() {
        epoch = "epoch-${epoch.removePrefix("epoch-").toInt() + 1}"
        history.clear()
    }

    /** The server ends the connection with [code] (a `disconnect` push, then the socket closes). */
    fun disconnect(code: Int) {
        current?.let {
            it.push("""{"push":{"disconnect":{"code":$code,"reason":"test"}}}""")
            it.serverClose(code)
        }
    }

    /** The network drops the socket under the client. */
    fun drop() {
        current?.serverClose(null)
    }

    fun commandsOf(kind: String): List<JsonObject> = commands.filter { it.containsKey(kind) }

    private fun publication(offset: Long, envelope: String) =
        """{"push":{"channel":"$channel","pub":{"data":$envelope,"offset":$offset}}}"""

    private fun since(from: Long, epoch: String): List<Pair<Long, String>>? {
        if (epoch != this.epoch) return null
        val first = history.firstOrNull()?.first ?: (offset + 1)
        if (from + 1 < first) return null
        return history.filter { it.first > from }
    }

    private fun subscribeResult(recover: Boolean, from: Long?, epoch: String?): String {
        val missed = if (recover && from != null && epoch != null && !refuseRecovery) since(from, epoch) else null
        val pubs = missed.orEmpty().joinToString(",") { (o, e) -> """{"data":$e,"offset":$o}""" }
        return """{"recoverable":true,"epoch":"${this.epoch}","offset":$offset,"recovered":${missed != null},"was_recovering":$recover,"publications":[$pubs]}"""
    }

    inner class Socket : RealtimeSocket {
        private val inbox = Channel<String>(Channel.UNLIMITED)
        var subscribed = false
            private set
        var closed = false
            private set
        private var code: Int? = null

        fun push(frame: String) {
            inbox.trySend(frame)
        }

        fun serverClose(code: Int?) {
            this.code = code
            closed = true
            inbox.close()
        }

        override suspend fun receive(): String? = inbox.receiveCatching().getOrNull()

        override suspend fun send(text: String) {
            if (closed) error("closed")
            if (text == "{}") {
                pongs++
                return
            }
            val frame = json.parseToJsonElement(text).jsonObject
            commands += frame
            val id = frame["id"]?.jsonPrimitive?.longOrNull ?: return
            when {
                frame["connect"] != null -> {
                    val error = connectError
                    if (error != null) {
                        push("""{"id":$id,"error":{"code":$error,"message":"no"}}""")
                        return
                    }
                    val subs = if (serverSide) {
                        val requested = (frame["connect"] as JsonObject)["subs"] as? JsonObject
                        val position = requested?.get(channel) as? JsonObject
                        val from = position?.get("offset")?.jsonPrimitive?.longOrNull
                        val e = position?.get("epoch")?.jsonPrimitive?.content
                        subscribed = true
                        ""","subs":{"$channel":${subscribeResult(position != null, from, e)}}"""
                    } else {
                        ""
                    }
                    push("""{"id":$id,"connect":{"client":"c1","version":"6.0.0","expires":true,"ttl":3600,"ping":25,"pong":true$subs}}""")
                }
                frame["subscribe"] != null -> {
                    val sub = frame["subscribe"] as JsonObject
                    if (serverSide) {
                        push("""{"id":$id,"error":{"code":105,"message":"already subscribed"}}""")
                        return
                    }
                    val recover = sub["recover"]?.jsonPrimitive?.content == "true"
                    if (recover && unrecoverableError) {
                        push("""{"id":$id,"error":{"code":112,"message":"unrecoverable position"}}""")
                        return
                    }
                    val from = sub["offset"]?.jsonPrimitive?.longOrNull
                    val e = sub["epoch"]?.jsonPrimitive?.content
                    subscribed = true
                    push("""{"id":$id,"subscribe":${subscribeResult(recover, from, e)}}""")
                }
                frame["refresh"] != null -> {
                    val error = refreshError
                    if (error != null) {
                        push("""{"id":$id,"error":{"code":$error,"message":"no"}}""")
                    } else {
                        push("""{"id":$id,"refresh":{"client":"c1","version":"6.0.0","expires":true,"ttl":3600}}""")
                    }
                }
            }
        }

        var pongs = 0
            private set

        override suspend fun close() {
            closed = true
            inbox.close()
        }

        override suspend fun closeCode(): Int? = code
    }

    companion object {
        const val CHANNEL = "u:#abcdefghijklm"
        private val json = Json { ignoreUnknownKeys = true }

        /** A `message` envelope for [id] in conversation [conversation]. */
        fun message(id: Long, conversation: String = "1287390234923400001", from: String = "cn5wy6l3naf5b", clientId: String? = null, body: String = "Hello $id"): String =
            """{"t":"message","v":1,"id":"$id","at":"2026-11-06T09:14:03.120Z","d":{"id":"$id","conversationId":"$conversation","senderId":"$from",""" +
                (clientId?.let { """"clientId":"$it",""" } ?: "") +
                """"kind":"text","body":"$body","at":"2026-11-06T09:14:03.120Z"}}"""

        fun typing(id: Long, conversation: String = "1287390234923400001", from: String = "cn5wy6l3naf5b"): String =
            """{"t":"typing","v":1,"id":"$id","at":"2026-11-06T09:14:03.120Z","d":{"conversationId":"$conversation","by":"$from"}}"""
    }
}
