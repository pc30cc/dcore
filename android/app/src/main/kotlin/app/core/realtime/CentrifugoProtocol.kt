package app.core.realtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Centrifugo's client protocol (v2, JSON), as far as this app speaks it.
 *
 * Commands are one JSON object with an `id`; replies carry the same `id`;
 * server pushes have no `id` and a `push` key; an empty object `{}` is a
 * ping and is answered with one. Several frames may share one WebSocket
 * message, separated by newlines.
 *
 * The app reads exactly one channel, the account's own `u:#<publicUid>`. It
 * is reached one of two ways, and the reply decides which:
 *
 *  - the server subscribes the connection itself (the channel is in the
 *    connection token, or the server's personal-channel option is on): the
 *    connect reply carries it under `subs`, with its recovery result, and the
 *    client does not subscribe again;
 *  - otherwise the client sends `subscribe` for its user-limited channel,
 *    with no subscription token.
 *
 * Pure functions, so every frame this app sends and every shape it can
 * receive is pinned by a JVM test with no socket in sight.
 */
object CentrifugoProtocol {

    private val json = Json { ignoreUnknownKeys = true }

    /** Where a subscription had read up to: what `recover` resumes from. */
    data class StreamPosition(val offset: Long, val epoch: String)

    /**
     * `connect`. [recover] maps a server-side channel to the position to
     * resume it from (connect-time recovery); empty when there is none.
     */
    fun connect(
        id: Int,
        token: String,
        name: String,
        version: String,
        recover: Map<String, StreamPosition> = emptyMap(),
    ): String =
        buildJsonObject {
            put("id", id)
            put(
                "connect",
                buildJsonObject {
                    put("token", token)
                    put("name", name)
                    put("version", version)
                    if (recover.isNotEmpty()) {
                        put(
                            "subs",
                            buildJsonObject {
                                recover.forEach { (channel, position) ->
                                    put(channel, recoverObject(position))
                                }
                            },
                        )
                    }
                },
            )
        }.toString()

    /**
     * `subscribe` to the user-limited channel: no token (the server checks
     * that the channel's user is the connection's). With [recover] the server
     * replays everything published since that position, when its history
     * still reaches it.
     */
    fun subscribe(id: Int, channel: String, recover: StreamPosition?): String =
        buildJsonObject {
            put("id", id)
            put(
                "subscribe",
                buildJsonObject {
                    put("channel", channel)
                    if (recover != null) {
                        put("recover", true)
                        put("offset", recover.offset)
                        put("epoch", recover.epoch)
                    }
                },
            )
        }.toString()

    /** `refresh`: a new connection token on the same socket, before the current one expires. */
    fun refresh(id: Int, token: String): String =
        buildJsonObject {
            put("id", id)
            put("refresh", buildJsonObject { put("token", token) })
        }.toString()

    private fun recoverObject(position: StreamPosition): JsonObject = buildJsonObject {
        put("recover", true)
        put("offset", position.offset)
        put("epoch", position.epoch)
    }

    /** The answer to a ping. */
    const val PONG: String = "{}"

    /** Every frame in one WebSocket message. A frame that will not parse is [Inbound.Unknown], never a crash. */
    fun parse(message: String): List<Inbound> =
        message.split('\n').map { it.trim() }.filter { it.isNotEmpty() }.map(::parseFrame)

    private fun parseFrame(text: String): Inbound {
        val frame = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return Inbound.Unknown
        if (frame.isEmpty()) return Inbound.Ping

        val id = frame["id"].int()
        if (id != null && id > 0) {
            val error = (frame["error"] as? JsonObject)?.let {
                ReplyError(code = it["code"].int() ?: 0, message = it["message"].string(), temporary = it["temporary"].bool() == true)
            }
            (frame["connect"] as? JsonObject)?.let { return Inbound.Reply(id, error, connect = connectResult(it)) }
            (frame["subscribe"] as? JsonObject)?.let { return Inbound.Reply(id, error, subscribe = subscribeResult(it)) }
            (frame["refresh"] as? JsonObject)?.let { return Inbound.Reply(id, error, refresh = expiry(it)) }
            return Inbound.Reply(id, error)
        }

        val push = frame["push"] as? JsonObject ?: return Inbound.Unknown
        val channel = push["channel"].string().orEmpty()
        (push["pub"] as? JsonObject)?.let { pub ->
            return Inbound.Publication(channel = channel, data = pub["data"], offset = pub["offset"].long())
        }
        (push["disconnect"] as? JsonObject)?.let {
            return Inbound.Disconnect(code = it["code"].int() ?: 0, reason = it["reason"].string())
        }
        (push["unsubscribe"] as? JsonObject)?.let {
            return Inbound.Unsubscribed(channel, it["code"].int() ?: 0)
        }
        (push["subscribe"] as? JsonObject)?.let {
            return Inbound.ServerSubscribed(channel, subscribeResult(it))
        }
        return Inbound.Unknown
    }

    private fun expiry(obj: JsonObject): Expiry = Expiry(
        expires = obj["expires"].bool() == true,
        ttlSeconds = obj["ttl"].long(),
    )

    private fun connectResult(obj: JsonObject): ConnectResult = ConnectResult(
        client = obj["client"].string(),
        expiry = expiry(obj),
        subs = (obj["subs"] as? JsonObject)
            ?.mapNotNull { (channel, value) -> (value as? JsonObject)?.let { channel to subscribeResult(it) } }
            ?.toMap()
            .orEmpty(),
    )

    private fun subscribeResult(obj: JsonObject): SubscribeResult = SubscribeResult(
        recoverable = obj["recoverable"].bool() == true,
        recovered = obj["recovered"].bool() == true,
        wasRecovering = obj["was_recovering"].bool() == true,
        epoch = obj["epoch"].string(),
        offset = obj["offset"].long(),
        publications = (obj["publications"] as? JsonArray)
            ?.mapNotNull { element ->
                val pub = element as? JsonObject ?: return@mapNotNull null
                Inbound.Publication(channel = "", data = pub["data"], offset = pub["offset"].long())
            }
            .orEmpty(),
    )

    /**
     * Whether a disconnect code asks the client not to come straight back.
     * Centrifugo's convention: 3500-3999 and 4500-4999 are terminal; the rest
     * mean "reconnect".
     */
    fun isTerminal(code: Int): Boolean = code in 3500..3999 || code in 4500..4999

    /** The server refused the connection token. */
    const val ERROR_UNAUTHORIZED = 101

    /** Already subscribed on this connection: harmless. */
    const val ERROR_ALREADY_SUBSCRIBED = 105

    /** The connection token expired before it was used or refreshed: fresh tokens fix it. */
    const val ERROR_TOKEN_EXPIRED = 109

    /** The position asked to recover from is gone from history; subscribe plainly. */
    const val ERROR_UNRECOVERABLE_POSITION = 112

    /** Disconnect: the connection token is invalid (`3500`); the next attempt asks for a new one. */
    const val DISCONNECT_INVALID_TOKEN = 3500

    /** Disconnect: the connection expired without a refresh (`3005`). */
    const val DISCONNECT_EXPIRED = 3005

    private fun JsonElement?.primitive(): JsonPrimitive? = this as? JsonPrimitive
    private fun JsonElement?.int(): Int? = primitive()?.intOrNull
    private fun JsonElement?.long(): Long? = primitive()?.longOrNull
    private fun JsonElement?.string(): String? = primitive()?.takeIf { it.isString }?.contentOrNull
    private fun JsonElement?.bool(): Boolean? = primitive()?.let { it.booleanOrNull ?: it.contentOrNull?.toBooleanStrictOrNull() }
}

/** One frame from the server. */
sealed interface Inbound {
    data object Ping : Inbound

    /** The answer to command [id]: one of the three results, or [error]. */
    data class Reply(
        val id: Int,
        val error: ReplyError?,
        val connect: ConnectResult? = null,
        val subscribe: SubscribeResult? = null,
        val refresh: Expiry? = null,
    ) : Inbound

    data class Publication(val channel: String, val data: JsonElement?, val offset: Long?) : Inbound
    data class Disconnect(val code: Int, val reason: String?) : Inbound
    data class Unsubscribed(val channel: String, val code: Int) : Inbound

    /** The server subscribed this connection to [channel] after the connect (a server-side subscription). */
    data class ServerSubscribed(val channel: String, val result: SubscribeResult) : Inbound
    data object Unknown : Inbound
}

data class ReplyError(val code: Int, val message: String?, val temporary: Boolean = false)

/** Whether the connection's token expires, and in how many seconds (the server's count). */
data class Expiry(val expires: Boolean, val ttlSeconds: Long?)

data class ConnectResult(
    val client: String?,
    val expiry: Expiry,
    /** Server-side subscriptions, by channel, with their recovery results. */
    val subs: Map<String, SubscribeResult>,
)

data class SubscribeResult(
    val recoverable: Boolean,
    val recovered: Boolean,
    val wasRecovering: Boolean,
    val epoch: String?,
    val offset: Long?,
    val publications: List<Inbound.Publication>,
)
