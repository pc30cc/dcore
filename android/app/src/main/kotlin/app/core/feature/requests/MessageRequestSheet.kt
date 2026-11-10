package app.core.feature.requests

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
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
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.Id
import app.core.model.ProfileCard
import app.core.sync.RequestSendResult
import app.core.ui.components.AvatarFocus
import app.core.ui.components.AppBottomSheet
import app.core.ui.components.AppTextField
import app.core.ui.components.Avatar
import app.core.ui.components.PrimaryButton
import app.core.ui.theme.AppTheme
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
    val max = graph.config.config.value?.limits?.messageMax ?: BODY_MAX
    var text by rememberSaveable { mutableStateOf("") }
    var clientId by rememberSaveable { mutableStateOf(UUID.randomUUID().toString()) }
    var sending by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<RequestSendResult?>(null) }
    val name = isolate(card.name)
    val time = rememberTimeOfDay()
    val number = rememberNumbers()
    val t = AppTheme.template

    AppBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().imePadding().padding(start = Space.gutter, end = Space.gutter, bottom = RequestSheetLayout.bottom),
            verticalArrangement = Arrangement.spacedBy(RequestSheetLayout.gap),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(RequestSheetLayout.avatarGap)) {
                Avatar(RequestSheetLayout.avatar, photo = card.photos.firstOrNull()?.let { photo -> { PhotoImage(photo, null, Modifier.fillMaxSize(), alignment = AvatarFocus) } })
                Text(
                    brandString(R.string.request_send_title, name),
                    style = t.type.h2,
                    color = t.colors.text,
                    modifier = Modifier.weight(1f).semantics { heading() },
                )
            }
            val sent = result is RequestSendResult.Sent
            AppTextField(
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
                placeholder = brandString(R.string.request_send_hint),
                singleLine = false,
                helper = if (text.length > max - COUNTER_FROM) brandString(R.string.chat_counter, number(text.length), number(max)) else null,
                modifier = Modifier.fillMaxWidth(),
            )
            result?.let { r ->
                val message = when (r) {
                    is RequestSendResult.Sent -> brandString(R.string.request_sent)
                    RequestSendResult.AlreadySent -> brandString(R.string.request_already, name)
                    RequestSendResult.AlreadyMatched -> brandString(R.string.request_matched)
                    is RequestSendResult.OutOfQuota -> r.resetsAt?.let { brandString(R.string.request_quota_at, time(it)) } ?: brandString(R.string.request_quota)
                    is RequestSendResult.TooMany -> brandString(R.string.request_daily_cap)
                    RequestSendResult.Refused -> brandString(R.string.request_refused)
                    RequestSendResult.Unavailable -> brandString(R.string.request_unavailable)
                    is RequestSendResult.Failed -> brandString(if (r.offline) R.string.chat_action_offline else R.string.request_failed)
                }
                Text(
                    message,
                    style = t.type.bodySm,
                    color = if (r is RequestSendResult.Sent) t.colors.text2 else t.colors.error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
            val outOfQuota = result as? RequestSendResult.OutOfQuota
            if (outOfQuota?.canBuy == true) {
                // Out of today's requests: more come in packs.
                val paywall = app.core.feature.paywall.LocalPaywall.current
                PrimaryButton(
                    brandString(R.string.request_quota_buy),
                    onClick = { paywall.packs(app.core.model.WalletItem.Dm, app.core.feature.paywall.PaywallEntry.MESSAGES) },
                )
            }
            if (result is RequestSendResult.Sent || result == RequestSendResult.AlreadySent || result == RequestSendResult.Unavailable) {
                PrimaryButton(brandString(R.string.action_close), onClick = onDismiss)
            } else if (result == RequestSendResult.AlreadyMatched && onOpenChat != null) {
                PrimaryButton(
                    brandString(R.string.request_open_chat),
                    onClick = {
                        scope.launch {
                            val who = graph.chat.sync.account.value
                            val id = who?.let { graph.chat.sync.conversations.byPeer(it, card.id).firstOrNull() }
                            onDismiss()
                            id?.let(onOpenChat)
                        }
                    },
                )
            } else {
                PrimaryButton(
                    brandString(R.string.request_send),
                    onClick = {
                        sending = true
                        scope.launch {
                            result = graph.chat.sync.requests.send(card.id, text, clientId)
                            sending = false
                        }
                    },
                    enabled = text.isNotBlank() && !sending,
                    loading = sending,
                )
                // No cancel button: the sheet closes by dragging it down or tapping outside it.
            }
        }
    }
}

private const val BODY_MAX = 2_000

/** The counter shows in the last stretch before the limit. */
private const val COUNTER_FROM = 100

/** The sheet's layout (the same rhythm as the design's sheets). */
private object RequestSheetLayout {
    val avatar = 48.dp
    val avatarGap = 12.dp
    val gap = 14.dp
    val bottom = 20.dp
}
