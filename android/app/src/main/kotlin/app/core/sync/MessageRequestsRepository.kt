package app.core.sync

import app.core.common.Clock
import app.core.common.Diag
import app.core.model.Conversation
import app.core.model.Id
import app.core.model.IncomingRequest
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
            val page = api.messageRequests(which)
            flow.value = RequestsBox(items = page.items.filter { it.status in shown(which) }, loaded = true)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            diag.info(AREA, "requests (${which.wire}) not read: ${e.code ?: e.javaClass.simpleName}")
            flow.update { it.copy(loading = false, failed = true, offline = e is ApiError.Network) }
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
     * phone): it leaves both boxes.
     */
    fun onAccepted(peer: PublicUid) {
        _inbox.update { box -> box.copy(items = box.items.filterNot { it.peer.id == peer }) }
        _sent.update { box -> box.copy(items = box.items.filterNot { it.peer.id == peer }) }
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

    private companion object {
        const val AREA = "Requests"
    }
}
