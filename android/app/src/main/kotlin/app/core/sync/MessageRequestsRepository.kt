package app.core.sync

import app.core.common.Clock
import app.core.common.Diag
import app.core.model.Conversation
import app.core.model.Id
import app.core.model.IncomingRequest
import app.core.model.Message
import app.core.model.MessageRequest
import app.core.model.ProblemCodes
import app.core.model.PublicUid
import app.core.model.ReportContext
import app.core.model.ReportReason
import app.core.model.ReportRequest
import app.core.model.RequestBox
import app.core.model.RequestStatus
import app.core.model.SentRequest
import app.core.net.ApiError
import app.core.net.ServerApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant
import java.util.UUID

/** One box of message requests as a screen shows it. */
data class RequestsBox(
    val items: List<MessageRequest> = emptyList(),
    /** Read at least once in this process. */
    val loaded: Boolean = false,
    val loading: Boolean = false,
    val failed: Boolean = false,
    val offline: Boolean = false,
    /** Where the rest of the box starts (the server's `nextCursor`); null at its end. */
    val nextCursor: String? = null,
    val loadingMore: Boolean = false,
    /** The last read of more failed; the rest stays at [nextCursor]. */
    val moreFailed: Boolean = false,
    /**
     * The last read of more went [MessageRequestsRepository.MAX_PAGES] pages
     * without a request to show (every one of their senders is hidden): the
     * rest waits for the person to ask, instead of reading on unasked.
     */
    val moreHidden: Boolean = false,
)

/** What sending a message request came to. */
sealed interface RequestSendResult {
    data class Sent(val request: SentRequest) : RequestSendResult

    /** A pending one to that person already exists (or a recent one was declined: the same answer). */
    data object AlreadySent : RequestSendResult

    /** They matched in the meantime: write in the conversation instead. */
    data object AlreadyMatched : RequestSendResult

    /** Today's free requests, the week's gift and the wallet are used up (`quota_exceeded`, feature `dm`); [canBuy]: more can be bought. */
    data class OutOfQuota(val resetsAt: Instant?, val canBuy: Boolean) : RequestSendResult

    /** The day's hard cap is reached, whatever is left to spend (`rate_limited`): again in [retryAfterSeconds]. */
    data class TooMany(val retryAfterSeconds: Long?) : RequestSendResult

    /** The text was refused by the server's rules. */
    data object Refused : RequestSendResult

    /** That profile is not available (never says why). */
    data object Unavailable : RequestSendResult

    data class Failed(val offline: Boolean) : RequestSendResult
}

/**
 * Message requests: a first message to someone the account has not matched,
 * which the recipient accepts (it becomes a conversation), declines (the
 * sender is never told) or reports.
 *
 * Kept in memory for the process: the inbox is read the first time the chat
 * list shows it, realtime adds what arrives after, and a pull refreshes it.
 * The rest of a box comes a page at a time from the end of the list
 * ([loadMore]). The server pages over the requests it scanned, so a page can
 * be short, or empty, with more after it (a hidden sender is left out of it):
 * one read follows the cursor until a page has something to show, the box
 * ends, or [MAX_PAGES] pages were read.
 */
class MessageRequestsRepository(
    private val api: ServerApi,
    private val clock: Clock = Clock.System,
    private val newClientId: () -> String = { UUID.randomUUID().toString() },
    private val diag: Diag = Diag.Android,
) {
    private val lock = Mutex()
    private val _inbox = MutableStateFlow(RequestsBox())
    private val _sent = MutableStateFlow(RequestsBox())
    val inbox: StateFlow<RequestsBox> = _inbox.asStateFlow()
    val sent: StateFlow<RequestsBox> = _sent.asStateFlow()

    private fun box(which: RequestBox) = if (which == RequestBox.Inbox) _inbox else _sent

    /** Reads [which] once per process (and again on [refresh]). */
    suspend fun ensure(which: RequestBox) {
        if (!box(which).value.loaded && !box(which).value.loading) refresh(which)
    }

    suspend fun refresh(which: RequestBox) = lock.withLock {
        val flow = box(which)
        flow.update { it.copy(loading = true, failed = false, offline = false) }
        try {
            val read = pages(which, from = null)
            flow.value = RequestsBox(items = read.items, loaded = true, nextCursor = read.next, moreHidden = read.hidden)
        } catch (e: CancellationException) {
            flow.update { it.copy(loading = false) }
            throw e
        } catch (e: ApiError) {
            diag.info(AREA, "requests (${which.wire}) not read: ${e.code ?: e.javaClass.simpleName}")
            flow.update { it.copy(loading = false, failed = true, offline = e is ApiError.Network) }
        }
    }

    /**
     * The next part of [which], from where the last read stopped; nothing when
     * the box ended, or when [seen] (the cursor the screen asked from) is no
     * longer where it stands (a second ask for the same part, or a refresh).
     */
    suspend fun loadMore(which: RequestBox, seen: String? = null) = lock.withLock {
        val flow = box(which)
        val from = flow.value.nextCursor ?: return@withLock
        if (seen != null && seen != from) return@withLock
        flow.update { it.copy(loadingMore = true, moreFailed = false) }
        try {
            val read = pages(which, from)
            flow.update { box ->
                // Already shown (realtime puts new ones on top): not twice.
                val known = box.items.mapTo(HashSet()) { it.id }
                box.copy(
                    items = box.items + read.items.filterNot { it.id in known },
                    nextCursor = read.next,
                    loadingMore = false,
                    moreHidden = read.hidden,
                )
            }
        } catch (e: CancellationException) {
            flow.update { it.copy(loadingMore = false) }
            throw e
        } catch (e: ApiError) {
            diag.info(AREA, "more requests (${which.wire}) not read: ${e.code ?: e.javaClass.simpleName}")
            flow.update { it.copy(loadingMore = false, moreFailed = true) }
        }
    }

    private class PagesRead(val items: List<MessageRequest>, val next: String?, val hidden: Boolean)

    /**
     * Pages of [which] from [from] until one shows something, the box ends or
     * [MAX_PAGES] were read. A cursor the server hands back unchanged ends
     * the box (it would only ever read the same page again).
     */
    private suspend fun pages(which: RequestBox, from: String?): PagesRead {
        val items = ArrayList<MessageRequest>()
        var cursor = from
        var reads = 0
        while (true) {
            val page = api.messageRequests(which, cursor)
            reads++
            items += page.items.filter { it.status in shown(which) }
            val next = page.nextCursor?.takeIf { it != cursor }
            if (next == null || items.isNotEmpty() || reads >= MAX_PAGES) {
                return PagesRead(items, next, hidden = items.isEmpty() && next != null)
            }
            cursor = next
        }
    }

    /**
     * What a box shows: the inbox what waits for an answer; the sent box
     * also what went unanswered (the server shows a declined request to its
     * sender as pending, then as expired, never as declined).
     */
    private fun shown(which: RequestBox): Set<RequestStatus> =
        if (which == RequestBox.Inbox) setOf(RequestStatus.Pending) else setOf(RequestStatus.Pending, RequestStatus.Expired)

    /**
     * A request between this account and [peer] became a conversation
     * (`conversation` with reason `accepted`, on either side or on another
     * phone). Its [first] message (the request's text, from its sender) says
     * which: the inbox's request when [peer] sent it, the sent box's when this
     * account did. A request the other way stays: the server keeps it
     * pending, and accepting it adds its text to the same conversation.
     * Without a first message to tell, both boxes drop [peer]'s requests.
     */
    fun onAccepted(peer: PublicUid, first: Message? = null) {
        val which = when (first?.senderId) {
            null -> null
            peer -> _inbox
            else -> _sent
        }
        if (which == null) {
            _inbox.update { box -> box.copy(items = box.items.filterNot { it.peer.id == peer }) }
            _sent.update { box -> box.copy(items = box.items.filterNot { it.peer.id == peer }) }
            return
        }
        which.update { box ->
            val theirs = box.items.filter { it.peer.id == peer }
            // The one with that text when there is one; else every request of that direction with them.
            val accepted = theirs.filter { it.body == first?.body }.ifEmpty { theirs }.mapTo(HashSet()) { it.id }
            box.copy(items = box.items.filterNot { it.id in accepted })
        }
    }

    /** A request that just arrived over realtime. */
    fun onRealtime(request: IncomingRequest) {
        _inbox.update { box ->
            if (box.items.any { it.id == request.id }) box
            else box.copy(items = listOf(MessageRequest(request.id, request.from, request.body, RequestStatus.Pending, request.at)) + box.items)
        }
    }

    private fun drop(which: RequestBox, id: Id) {
        box(which).update { it.copy(items = it.items.filterNot { r -> r.id == id }) }
    }

    /** Accepts: the request becomes a conversation (its body is the first message). */
    suspend fun accept(id: Id): Result<Conversation> = attempt {
        api.acceptMessageRequest(id).also { drop(RequestBox.Inbox, id) }
    }.onFailure { if ((it as? ApiError.Http)?.status == 404) drop(RequestBox.Inbox, id) }

    /** Declines; the sender is never told. */
    suspend fun decline(id: Id): Result<Unit> = attempt {
        api.declineMessageRequest(id)
        drop(RequestBox.Inbox, id)
    }.onFailure { if ((it as? ApiError.Http)?.status == 404) drop(RequestBox.Inbox, id) }

    /** The sender takes it back. */
    suspend fun withdraw(id: Id): Result<Unit> = attempt {
        api.withdrawMessageRequest(id)
        drop(RequestBox.Sent, id)
    }.onFailure { if ((it as? ApiError.Http)?.status == 404) drop(RequestBox.Sent, id) }

    /**
     * Reports the sender for this request (with a block when [block]), then
     * declines it so it leaves the inbox. The request's text is the evidence;
     * there is no conversation to point at.
     */
    suspend fun report(request: MessageRequest, reason: ReportReason, details: String?, block: Boolean): Result<Unit> = attempt {
        api.report(
            ReportRequest(
                target = request.peer.id,
                context = ReportContext.Chat,
                reason = reason,
                details = details?.takeIf { it.isNotBlank() },
                block = block,
            ),
        )
        runCatching { api.declineMessageRequest(request.id) }
        drop(RequestBox.Inbox, request.id)
    }

    /** Sends a first message to [to]. One client id per attempt the person makes. */
    suspend fun send(to: PublicUid, body: String, clientId: String = newClientId()): RequestSendResult =
        try {
            val sent = api.sendMessageRequest(to, body.trim(), clientId)
            _sent.update { box ->
                box.copy(items = listOf(MessageRequest(sent.id, sent.to, sent.body, sent.status, sent.at)) + box.items.filterNot { it.id == sent.id })
            }
            RequestSendResult.Sent(sent)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError.Http) {
            when {
                e.code == ProblemCodes.ALREADY_REQUESTED -> RequestSendResult.AlreadySent
                e.code == ProblemCodes.ALREADY_MATCHED -> RequestSendResult.AlreadyMatched
                e.code == ProblemCodes.QUOTA_EXCEEDED -> RequestSendResult.OutOfQuota(e.problem.resetsAt, e.problem.canBuy == true)
                e.status == 429 -> RequestSendResult.TooMany(e.problem.retryAfterSeconds)
                e.code == ProblemCodes.TEXT_REFUSED || e.code == ProblemCodes.MESSAGE_REFUSED || e.code == ProblemCodes.FIELD_INVALID ->
                    RequestSendResult.Refused
                e.status == 404 -> RequestSendResult.Unavailable
                else -> RequestSendResult.Failed(offline = false)
            }
        } catch (e: ApiError) {
            RequestSendResult.Failed(offline = e is ApiError.Network)
        }

    /** Another account signed in, or nobody. */
    fun clear() {
        _inbox.value = RequestsBox()
        _sent.value = RequestsBox()
    }

    private suspend fun <T> attempt(block: suspend () -> T): Result<T> =
        try {
            Result.success(block())
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            Result.failure(e)
        }

    companion object {
        private const val AREA = "Requests"

        /** Pages one read follows past empty ones before it waits to be asked. */
        const val MAX_PAGES = 5
    }
}
