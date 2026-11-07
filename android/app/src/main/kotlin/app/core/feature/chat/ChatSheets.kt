package app.core.feature.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.core.R
import app.core.i18n.brandString
import app.core.model.Catalog
import app.core.model.MessageKind
import app.core.model.ReportReason
import app.core.sync.ChatMessage
import app.core.ui.theme.Space

/** A sheet or dialog over the thread. */
sealed interface ChatSheet {
    data class Message(val item: ChatItem.Bubble) : ChatSheet
    data class Report(val message: ChatMessage?) : ChatSheet
    data class Unsend(val message: ChatMessage) : ChatSheet
    data object Block : ChatSheet
    data object Unmatch : ChatSheet
}

/** The quick reactions, in this order in every language. */
val QUICK_REACTIONS = listOf("❤️", "😂", "😮", "😢", "👍", "🔥")

@Composable
internal fun ChatSheets(
    sheet: ChatSheet?,
    state: ChatUiState,
    catalog: Catalog,
    actions: ChatActions,
    onEdit: (String) -> Unit,
    onDismiss: () -> Unit,
    onSheet: (ChatSheet) -> Unit,
) {
    val name = peerName(state)
    when (sheet) {
        null -> Unit
        is ChatSheet.Message -> MessageSheet(sheet.item, state, actions, onEdit, onDismiss, onSheet)
        is ChatSheet.Report -> ReportSheet(
            name = name,
            catalog = catalog,
            withMessage = sheet.message != null,
            onDismiss = onDismiss,
            onSend = { reason, details, block ->
                actions.report(reason, details, block, sheet.message)
                onDismiss()
            },
        )
        is ChatSheet.Unsend -> AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(brandString(R.string.chat_unsend_title)) },
            text = { Text(brandString(R.string.chat_unsend_body)) },
            confirmButton = {
                TextButton(onClick = { actions.unsend(sheet.message); onDismiss() }) { Text(brandString(R.string.chat_action_unsend)) }
            },
            dismissButton = { TextButton(onClick = onDismiss) { Text(brandString(R.string.action_cancel)) } },
        )
        ChatSheet.Block -> AlertDialog(
            onDismissRequest = onDismiss,
            icon = { Icon(painterResource(R.drawable.ic_chat_block), contentDescription = null) },
            title = { Text(brandString(R.string.chat_block_title, name)) },
            text = { Text(brandString(R.string.chat_block_body)) },
            confirmButton = {
                TextButton(onClick = { actions.block(); onDismiss() }) {
                    Text(brandString(R.string.chat_block), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = onDismiss) { Text(brandString(R.string.action_cancel)) } },
        )
        ChatSheet.Unmatch -> AlertDialog(
            onDismissRequest = onDismiss,
            icon = { Icon(painterResource(R.drawable.ic_chat_unmatch), contentDescription = null) },
            title = { Text(brandString(R.string.chat_unmatch_title, name)) },
            text = { Text(brandString(R.string.chat_unmatch_body)) },
            confirmButton = {
                TextButton(onClick = { actions.unmatch(); onDismiss() }) {
                    Text(brandString(R.string.chat_unmatch), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = onDismiss) { Text(brandString(R.string.action_cancel)) } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MessageSheet(
    item: ChatItem.Bubble,
    state: ChatUiState,
    actions: ChatActions,
    onEdit: (String) -> Unit,
    onDismiss: () -> Unit,
    onSheet: (ChatSheet) -> Unit,
) {
    val message = item.message
    val copy = rememberCopy(actions)
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val live = !state.ended && !state.gone
    val text = message.body?.takeIf { it.isNotBlank() && item.unsent == null && (message.kind == MessageKind.Text || message.kind == MessageKind.LikeNote) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = Space.lg)) {
            if (message.sent && item.unsent == null && live) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.sm),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                ) {
                    QUICK_REACTIONS.forEach { emoji ->
                        val selected = emoji == item.mine
                        val label = if (selected) brandString(R.string.chat_action_remove_reaction) else brandString(R.string.chat_action_react, emoji)
                        Box(
                            Modifier
                                .size(48.dp)
                                .clip(CircleShape)
                                .background(if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh)
                                .clickable(onClickLabel = label, role = Role.Button) {
                                    actions.react(message, emoji, item.mine)
                                    onDismiss()
                                }
                                .semantics { contentDescription = label },
                            contentAlignment = Alignment.Center,
                        ) { Text(emoji, fontSize = 24.sp) }
                    }
                }
            }
            when (message.state) {
                app.core.cache.SendState.FAILED -> {
                    if (message.errorCode != app.core.model.ProblemCodes.MESSAGE_REFUSED && message.errorCode != app.core.model.ProblemCodes.CONVERSATION_ENDED && live) {
                        SheetRow(R.drawable.ic_chat_pending, brandString(R.string.chat_action_retry)) { actions.retry(message); onDismiss() }
                    }
                    if (message.body != null) SheetRow(R.drawable.ic_chat_copy, brandString(R.string.chat_confirm_edit)) {
                        onEdit(message.body)
                        actions.delete(message)
                        onDismiss()
                    }
                    SheetRow(R.drawable.ic_chat_unsend, brandString(R.string.chat_action_delete), danger = true) { actions.delete(message); onDismiss() }
                }
                app.core.cache.SendState.PENDING -> {
                    SheetRow(R.drawable.ic_chat_unsend, brandString(R.string.chat_action_cancel_send), danger = true) { actions.delete(message); onDismiss() }
                }
                app.core.cache.SendState.CONFIRM -> {
                    SheetRow(R.drawable.ic_chat_sent, brandString(R.string.chat_confirm_send)) { actions.sendAnyway(message); onDismiss() }
                    SheetRow(R.drawable.ic_chat_unsend, brandString(R.string.chat_action_delete), danger = true) { actions.delete(message); onDismiss() }
                }
                app.core.cache.SendState.SENT -> Unit
            }
            if (text != null) SheetRow(R.drawable.ic_chat_copy, brandString(R.string.chat_action_copy)) { copy(text); onDismiss() }
            if (message.mine && message.sent && item.unsent == null && live) {
                SheetRow(R.drawable.ic_chat_unsend, brandString(R.string.chat_action_unsend)) { onSheet(ChatSheet.Unsend(message)) }
            }
            if (!message.mine && message.sent && live) {
                SheetRow(R.drawable.ic_chat_report, brandString(R.string.chat_action_report), danger = true) { onSheet(ChatSheet.Report(message)) }
            }
        }
    }
}

@Composable
private fun SheetRow(icon: Int, text: String, danger: Boolean = false, onClick: () -> Unit) {
    val color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = Space.xl),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.lg),
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = color)
        Text(text, style = MaterialTheme.typography.bodyLarge, color = color)
    }
}

/** The server's "are you sure?" about a message, before it is sent. */
@Composable
internal fun ConfirmSendDialog(message: ChatMessage, onSend: () -> Unit, onEdit: () -> Unit) {
    val body = when (message.errorCode) {
        "money", "payment", "scam" -> brandString(R.string.chat_confirm_money)
        "contact", "contacts", "phone", "links" -> brandString(R.string.chat_confirm_contact)
        else -> brandString(R.string.chat_confirm_generic)
    }
    AlertDialog(
        onDismissRequest = onEdit,
        icon = { Icon(painterResource(R.drawable.ic_chat_error), contentDescription = null) },
        title = { Text(brandString(R.string.chat_confirm_title)) },
        text = { Text(body) },
        confirmButton = { TextButton(onClick = onSend) { Text(brandString(R.string.chat_confirm_send)) } },
        dismissButton = { TextButton(onClick = onEdit) { Text(brandString(R.string.chat_confirm_edit)) } },
    )
}

/**
 * Report someone: a reason (the panel's list when the config has one, else
 * the app's), optional details, and "also block" (on by default). Used from a
 * thread and from a message request.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReportSheet(
    name: String,
    catalog: Catalog,
    withMessage: Boolean,
    onDismiss: () -> Unit,
    onSend: (ReportReason, String?, Boolean) -> Unit,
    evidenceNote: String? = null,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var reason by rememberSaveable { mutableStateOf<String?>(null) }
    var details by rememberSaveable { mutableStateOf("") }
    var block by rememberSaveable { mutableStateOf(true) }
    val reasons = reportReasons(catalog)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = Space.xl, vertical = Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Text(brandString(R.string.report_title, name), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
            Text(brandString(R.string.report_subtitle), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.selectableGroup()) {
                reasons.forEach { (wire, label) ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = Space.minTouch)
                            .selectable(selected = reason == wire, role = Role.RadioButton, onClick = { reason = wire }),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = reason == wire, onClick = null)
                        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = Space.md))
                    }
                }
            }
            OutlinedTextField(
                value = details,
                onValueChange = { details = it.take(DETAILS_MAX) },
                label = { Text(brandString(R.string.report_details_hint)) },
                minLines = 2,
                maxLines = 5,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = Space.minTouch)
                    .toggleable(value = block, role = Role.Checkbox, onValueChange = { block = it }),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = block, onCheckedChange = null)
                Text(brandString(R.string.report_block), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = Space.md))
            }
            Text(
                evidenceNote ?: brandString(if (withMessage) R.string.report_with_message else R.string.report_with_recent),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(
                onClick = {
                    val picked = reason ?: return@Button
                    val value = ReportReason.entries.firstOrNull { it.wire == picked && it != ReportReason.Unknown } ?: ReportReason.Other
                    onSend(value, details.trim().takeIf { it.isNotEmpty() }, block)
                },
                enabled = reason != null,
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
                modifier = Modifier.fillMaxWidth().heightIn(min = Space.minTouch),
            ) { Text(brandString(R.string.report_send)) }
            if (reason == null) {
                Text(
                    brandString(R.string.report_reason_required),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

private const val DETAILS_MAX = 500

/** The reasons, as (wire value, label): the panel's words for the known ones, the app's otherwise. */
@Composable
private fun reportReasons(catalog: Catalog): List<Pair<String, String>> {
    val panel = catalog.reportReasons.associate { it.key to it.label }
    return ReportReason.entries.filter { it != ReportReason.Unknown }.map { reason ->
        val label = panel[reason.wire]?.takeIf { it.isNotBlank() } ?: brandString(
            when (reason) {
                ReportReason.Fake -> R.string.report_reason_fake
                ReportReason.Harassment -> R.string.report_reason_harassment
                ReportReason.Inappropriate -> R.string.report_reason_inappropriate
                ReportReason.Scam -> R.string.report_reason_scam
                ReportReason.Under18 -> R.string.report_reason_under_18
                ReportReason.Threat -> R.string.report_reason_threat
                ReportReason.Spam -> R.string.report_reason_spam
                ReportReason.ChildSafety -> R.string.report_reason_child_safety
                else -> R.string.report_reason_other
            },
        )
        reason.wire to label
    }
}
