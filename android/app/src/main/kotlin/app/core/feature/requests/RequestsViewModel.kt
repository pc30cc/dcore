package app.core.feature.requests

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.core.model.Id
import app.core.model.MessageRequest
import app.core.model.ReportReason
import app.core.model.RequestBox
import app.core.net.ApiError
import app.core.sync.ChatSync
import app.core.sync.RequestsBox
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Something to say once, then forget. */
sealed interface RequestsNotice {
    val id: Long

    data class Declined(override val id: Long) : RequestsNotice
    data class Withdrawn(override val id: Long) : RequestsNotice
    data class Reported(override val id: Long) : RequestsNotice
    data class Failed(override val id: Long, val offline: Boolean) : RequestsNotice
}

data class RequestsUiState(
    val box: RequestBox = RequestBox.Inbox,
    val inbox: RequestsBox = RequestsBox(),
    val sent: RequestsBox = RequestsBox(),
    /** Requests with an answer on its way (their buttons wait). */
    val working: Set<Id> = emptySet(),
    /** An accepted request's conversation, to open. */
    val opened: Id? = null,
    val notice: RequestsNotice? = null,
) {
    val current: RequestsBox get() = if (box == RequestBox.Inbox) inbox else sent
}

class RequestsViewModel(private val sync: ChatSync) : ViewModel() {

    private val ui = MutableStateFlow(RequestsUiState())
    private var noticeIds = 0L

    val state: StateFlow<RequestsUiState> =
        combine(ui, sync.requests.inbox, sync.requests.sent) { base, inbox, sent -> base.copy(inbox = inbox, sent = sent) }
            .stateIn(viewModelScope, SharingStarted.Eagerly, RequestsUiState())

    init {
        viewModelScope.launch { sync.requests.ensure(RequestBox.Inbox) }
    }

    fun select(box: RequestBox) {
        ui.update { it.copy(box = box) }
        viewModelScope.launch { sync.requests.ensure(box) }
    }

    fun refresh() {
        viewModelScope.launch { sync.requests.refresh(ui.value.box) }
    }

    fun accept(request: MessageRequest) = work(request.id) {
        sync.requests.accept(request.id).onSuccess { conversation ->
            sync.adopt(conversation)
            ui.update { it.copy(opened = conversation.id) }
        }.map { }
    }

    fun decline(request: MessageRequest) = work(request.id, done = { RequestsNotice.Declined(it) }) {
        sync.requests.decline(request.id)
    }

    fun withdraw(request: MessageRequest) = work(request.id, done = { RequestsNotice.Withdrawn(it) }) {
        sync.requests.withdraw(request.id)
    }

    fun report(request: MessageRequest, reason: ReportReason, details: String?, block: Boolean) =
        work(request.id, done = { RequestsNotice.Reported(it) }) { sync.requests.report(request, reason, details, block) }

    fun openedShown() = ui.update { it.copy(opened = null) }

    fun noticeShown(id: Long) = ui.update { if (it.notice?.id == id) it.copy(notice = null) else it }

    private fun work(id: Id, done: ((Long) -> RequestsNotice)? = null, block: suspend () -> Result<Unit>) {
        if (id in ui.value.working) return
        ui.update { it.copy(working = it.working + id) }
        viewModelScope.launch {
            val result = block()
            ui.update { state ->
                val notice = result.fold(
                    onSuccess = { done?.invoke(++noticeIds) },
                    onFailure = { e -> RequestsNotice.Failed(++noticeIds, offline = e is ApiError.Network) },
                )
                state.copy(working = state.working - id, notice = notice ?: state.notice)
            }
        }
    }
}
