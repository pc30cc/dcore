package app.core.feature.requests

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.card.isolate
import app.core.feature.card.rememberNumbers
import app.core.feature.card.rememberTimeOfDay
import app.core.feature.chat.PeerAvatar
import app.core.i18n.brandString
import app.core.model.Id
import app.core.model.ProfileCard
import app.core.sync.RequestSendResult
import app.core.ui.theme.Space
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Write to someone before matching: a message request. One client id per
 * text the person settles on, so a resend after a lost answer is the same
 * request. Every answer the server can give has its own words.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageRequestSheet(card: ProfileCard, onDismiss: () -> Unit, onOpenChat: ((Id) -> Unit)? = null) {
    val graph = LocalAppGraph.current
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val max = graph.config.config.value?.limits?.messageMax ?: BODY_MAX
    var text by rememberSaveable { mutableStateOf("") }
    var clientId by rememberSaveable { mutableStateOf(UUID.randomUUID().toString()) }
    var sending by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<RequestSendResult?>(null) }
    val name = isolate(card.name)
    val time = rememberTimeOfDay()
    val number = rememberNumbers()

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = Space.xl, vertical = Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                PeerAvatar(card.photos.firstOrNull(), size = 48.dp)
                Text(brandString(R.string.request_send_title, name), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
            }
            Text(brandString(R.string.request_send_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val sent = result is RequestSendResult.Sent
            OutlinedTextField(
                value = text,
                onValueChange = {
                    if (it != text) {
                        text = it.take(max)
                        // A new text is a new request; a resend of the same text keeps its id.
                        clientId = UUID.randomUUID().toString()
                        if (result !is RequestSendResult.Sent) result = null
                    }
                },
                enabled = !sending && !sent,
                placeholder = { Text(brandString(R.string.request_send_hint)) },
                minLines = 3,
                maxLines = 6,
                supportingText = if (text.length > max - 100) {
                    { Text(brandString(R.string.chat_counter, number(text.length), number(max))) }
                } else {
                    null
                },
                modifier = Modifier.fillMaxWidth(),
            )
            result?.let { r ->
                val message = when (r) {
                    is RequestSendResult.Sent -> brandString(R.string.request_sent)
                    RequestSendResult.AlreadySent -> brandString(R.string.request_already, name)
                    RequestSendResult.AlreadyMatched -> brandString(R.string.request_matched)
                    is RequestSendResult.OutOfQuota -> r.resetsAt?.let { brandString(R.string.request_quota_at, time(it)) } ?: brandString(R.string.request_quota)
                    RequestSendResult.Refused -> brandString(R.string.request_refused)
                    RequestSendResult.Unavailable -> brandString(R.string.request_unavailable)
                    is RequestSendResult.Failed -> brandString(if (r.offline) R.string.chat_action_offline else R.string.request_failed)
                }
                Text(
                    message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (r is RequestSendResult.Sent) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
            if (result is RequestSendResult.Sent || result == RequestSendResult.AlreadySent || result == RequestSendResult.Unavailable) {
                Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth().heightIn(min = Space.minTouch)) { Text(brandString(R.string.action_close)) }
            } else if (result == RequestSendResult.AlreadyMatched && onOpenChat != null) {
                Button(
                    onClick = {
                        scope.launch {
                            val who = graph.chat.sync.account.value
                            val id = who?.let { graph.chat.sync.conversations.byPeer(it, card.id).firstOrNull() }
                            onDismiss()
                            id?.let(onOpenChat)
                        }
                    },
                    modifier = Modifier.fillMaxWidth().heightIn(min = Space.minTouch),
                ) { Text(brandString(R.string.request_open_chat)) }
            } else {
                Button(
                    onClick = {
                        sending = true
                        scope.launch {
                            result = graph.chat.sync.requests.send(card.id, text, clientId)
                            sending = false
                        }
                    },
                    enabled = text.isNotBlank() && !sending,
                    modifier = Modifier.fillMaxWidth().heightIn(min = Space.minTouch),
                ) {
                    if (sending) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text(brandString(R.string.request_send))
                }
                TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text(brandString(R.string.action_cancel)) }
            }
        }
    }
}

private const val BODY_MAX = 2_000
