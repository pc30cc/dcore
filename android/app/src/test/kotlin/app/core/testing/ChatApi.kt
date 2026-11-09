package app.core.testing

import app.core.model.AuthUser
import app.core.model.AccountStatus
import app.core.model.Conversation
import app.core.model.ConversationPeer
import app.core.model.ConversationSource
import app.core.model.ConversationState
import app.core.model.ConversationsPage
import app.core.model.DeviceUpdate
import app.core.model.Id
import app.core.model.Message
import app.core.model.MessageKind
import app.core.model.MessagesPage
import app.core.model.Problem
import app.core.model.ReadCursors
import app.core.model.ReceiptsRequest
import app.core.model.SendMessageRequest
import app.core.model.SentMessage
import app.core.net.ApiError
import app.core.net.ApiEvent
import app.core.net.Fetched
import app.core.net.ServerApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import java.lang.reflect.Proxy
import java.time.Instant

/** A [ServerApi] whose every route throws: what a fake does not override, a test must not call. */
fun unsupportedApi(): ServerApi = Proxy.newProxyInstance(ServerApi::class.java.classLoader, arrayOf(ServerApi::class.java)) { _, method, _ ->
    throw UnsupportedOperationException("not in this fake: ${method.name}")
} as ServerApi

/**
 * The chat routes, in memory, with a request log: threads with messages,
 * the server's `syncCursor` held back on demand (write-behind lag), and
 * scripted failures.
 */
class ChatApi(val me: String = ME) : ServerApi by unsupportedApi() {

    override val events: Flow<ApiEvent> = emptyFlow()
    override suspend fun hasSession(): Boolean = true
    override suspend fun sessionUser(): AuthUser = AuthUser(me, AccountStatus.Active, 30)

    val log = mutableListOf<String>()
    val threads = linkedMapOf<Id, MutableList<Message>>()
    val conversations = linkedMapOf<Id, Conversation>()
    var listChanged = true

    /**
     * Messages still in the server's write-behind (a batch held by a slow
     * worker): not in any page yet, and the pages' `syncCursor` stays below
     * the oldest of them, as the server's watermark does.
     */
    val held = mutableSetOf<Long>()

    /** Thrown by the next message read (then cleared). */
    var nextReadError: ApiError? = null

    /** Thrown by every send while set. */
    var sendError: ApiError? = null

    /** The next send is made on the server, and its answer is lost on the way back. */
    var loseNextAnswer = false

    /** The `X-Write-Lag-Ms` every page reports. */
    var writeLagMs: Long? = null

    /** The server's clock, for the messages a send makes. */
    var now: () -> Instant = { Instant.parse("2026-11-06T10:00:00Z") }
    val sent = mutableListOf<SendMessageRequest>()
    val receipts = mutableListOf<Pair<Id, ReceiptsRequest>>()

    /** Thrown by the next receipts, one each (a 429 for one sent too soon, a 404 for an ended conversation). */
    val receiptErrors = ArrayDeque<ApiError>()
    val devices = mutableListOf<DeviceUpdate>()
    var typing = 0
    private var nextId = 2_000_000_000_000_000_000L
    private val byClientId = mutableMapOf<String, Message>()

    fun conversation(id: Id, last: Message? = null, unread: Int = 0, peer: String = PEER) = Conversation(
        id = id,
        peer = ConversationPeer(peer, "Negar"),
        state = ConversationState.Active,
        source = ConversationSource.Like,
        createdAt = Instant.parse("2026-11-01T10:00:00Z"),
        lastMessage = last,
        unread = unread,
    ).also { conversations[id] = it }

    fun message(conversationId: Id, id: Long, from: String = PEER, body: String = "m$id", kind: MessageKind = MessageKind.Text, refId: Id? = null) =
        Message(id.toString(), conversationId, from, kind = kind, body = body, refId = refId, at = Instant.parse("2026-11-06T09:00:00Z").plusSeconds(id % 100_000))

    /** Adds [count] messages from the peer to [conversationId], ids from [first] up. */
    fun fill(conversationId: Id, first: Long, count: Int): List<Message> {
        val list = threads.getOrPut(conversationId) { mutableListOf() }
        val added = (0 until count).map { message(conversationId, first + it) }
        list += added
        list.sortBy { it.id.toLong() }
        conversations[conversationId]?.let { conversations[conversationId] = it.copy(lastMessage = list.lastOrNull()) }
        return added
    }

    private fun page(conversationId: Id, items: List<Message>, hasMore: Boolean): MessagesPage {
        val newest = items.maxOfOrNull { it.id.toLong() }
        val watermark = held.minOrNull()?.minus(1)
        val sync = when {
            newest == null -> null
            watermark == null -> newest
            else -> minOf(newest, watermark)
        }
        // History rows carry no client id: only a send's answer and its realtime copy do.
        return MessagesPage(items.map { it.copy(clientId = null) }, hasMore, syncCursor = sync?.toString(), readCursors = ReadCursors(), writeLagMs = writeLagMs)
    }

    private fun readable(conversationId: Id): List<Message> {
        nextReadError?.let {
            nextReadError = null
            throw it
        }
        if (conversationId !in threads && conversationId !in conversations) throw ApiError.Http(404, Problem.of(404, "not_found"))
        return threads[conversationId].orEmpty().filter { it.id.toLong() !in held }
    }

    override suspend fun messagesBefore(conversationId: Id, before: Id?, limit: Int): MessagesPage {
        log += "before:$conversationId:${before ?: "-"}"
        val all = readable(conversationId).filter { before == null || it.id.toLong() < before.toLong() }
        val items = all.takeLast(limit)
        return page(conversationId, items, hasMore = all.size > items.size)
    }

    override suspend fun messagesAfter(conversationId: Id, after: Id, limit: Int): MessagesPage {
        log += "after:$conversationId:$after"
        val all = readable(conversationId).filter { it.id.toLong() > after.toLong() }
        val items = all.take(limit)
        return page(conversationId, items, hasMore = all.size > items.size)
    }

    override suspend fun sendMessage(conversationId: Id, request: SendMessageRequest): SentMessage {
        log += "send:$conversationId"
        sent += request
        sendError?.let { throw it }
        byClientId[request.clientId]?.let { return SentMessage(it, replayed = true) }
        val message = Message((nextId++).toString(), conversationId, me, request.clientId, request.kind, request.body, request.refId, at = now())
        byClientId[request.clientId] = message
        threads.getOrPut(conversationId) { mutableListOf() } += message
        if (loseNextAnswer) {
            loseNextAnswer = false
            throw ApiError.Network(java.io.IOException("answer lost"))
        }
        return SentMessage(message, replayed = false)
    }

    /** The server's records of sends ran out (`idem:msg` lives 15 minutes): a client id is new to it again. */
    fun forgetSendRecords() = byClientId.clear()

    /**
     * Requests from the peer whose conversation already exists (one each way, the other one accepted first):
     * request id to (conversation, its text). Accepting one adds the text to that conversation, read by the
     * one who accepted, and answers (201) with it.
     */
    val acceptInto = mutableMapOf<Id, Pair<Id, String>>()

    override suspend fun acceptMessageRequest(requestId: Id): Conversation {
        log += "accept:$requestId"
        val (conversationId, body) = acceptInto.remove(requestId) ?: throw ApiError.Http(404, Problem.of(404, "not_found"))
        val list = threads.getOrPut(conversationId) { mutableListOf() }
        val id = (list.maxOfOrNull { it.id.toLong() } ?: 1_000L) + 1
        val first = message(conversationId, id, body = body)
        list += first
        val conversation = conversations.getValue(conversationId).copy(lastMessage = first, unread = 0, myReadId = first.id)
        conversations[conversationId] = conversation
        listChanged = true
        return conversation
    }

    override suspend fun sendReceipts(conversationId: Id, receipts: ReceiptsRequest) {
        log += "receipts:$conversationId"
        receiptErrors.removeFirstOrNull()?.let { throw it }
        this.receipts += conversationId to receipts
    }

    override suspend fun sendTyping(conversationId: Id) {
        log += "typing:$conversationId"
        typing++
    }

    override suspend fun conversations(cursor: String?, limit: Int): Fetched<ConversationsPage> {
        log += "conversations"
        val page = ConversationsPage(conversations.values.toList(), null)
        val changed = listChanged
        listChanged = false
        return Fetched(page, changed)
    }

    override suspend fun updateDevice(update: DeviceUpdate) {
        log += "devices.current"
        devices += update
    }

    companion object {
        const val ME = "aaaaaaaaaaaaa"
        const val PEER = "cn5wy6l3naf5b"
    }
}
