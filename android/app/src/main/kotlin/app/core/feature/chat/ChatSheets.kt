package app.core.feature.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.i18n.brandString
import app.core.model.Catalog
import app.core.model.MessageKind
import app.core.model.ReportReason
import app.core.sync.ChatMessage
import app.core.ui.components.AppBottomSheet
import app.core.ui.components.AppCheckbox
import app.core.ui.components.AppDialog
import app.core.ui.components.AppTextField
import app.core.ui.components.PrimaryButton
import app.core.ui.components.SheetChoiceRow
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space

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
        is ChatSheet.Unsend -> AppDialog(
            title = brandString(R.string.chat_unsend_title),
            body = brandString(R.string.chat_unsend_body),
            confirm = brandString(R.string.chat_action_unsend),
            onConfirm = { actions.unsend(sheet.message); onDismiss() },
            dismiss = brandString(R.string.action_cancel),
            onDismiss = onDismiss,
        )
        ChatSheet.Block -> AppDialog(
            title = brandString(R.string.chat_block_title, name),
            body = brandString(R.string.chat_block_body),
            confirm = brandString(R.string.chat_block),
            onConfirm = { actions.block(); onDismiss() },
            dismiss = brandString(R.string.action_cancel),
            onDismiss = onDismiss,
        )
        ChatSheet.Unmatch -> AppDialog(
            title = brandString(R.string.chat_unmatch_title),
            body = brandString(R.string.chat_unmatch_body),
            confirm = brandString(R.string.chat_unmatch_confirm),
            onConfirm = { actions.unmatch(); onDismiss() },
            dismiss = brandString(R.string.chat_unmatch_keep),
            onDismiss = onDismiss,
        )
    }
}

/** What can be done with one message: the quick reactions, then plain rows (no icons). */
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
    val t = AppTheme.template
    val message = item.message
    val copy = rememberCopy(actions)
    val live = !state.ended && !state.gone
    val text = message.body?.takeIf { it.isNotBlank() && item.unsent == null && (message.kind == MessageKind.Text || message.kind == MessageKind.LikeNote) }
    AppBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(start = Space.gutter, end = Space.gutter, bottom = SheetLayout.bottom)) {
            if (message.sent && item.unsent == null && live) {
                Row(Modifier.fillMaxWidth().padding(bottom = SheetLayout.reactionsBottom), horizontalArrangement = Arrangement.SpaceBetween) {
                    QUICK_REACTIONS.forEach { emoji ->
                        val selected = emoji == item.mine
                        val label = if (selected) brandString(R.string.chat_action_remove_reaction) else brandString(R.string.chat_action_react, emoji)
                        Box(
                            Modifier
                                .size(SheetLayout.reaction)
                                .clip(CircleShape)
                                .background(if (selected) t.colors.primaryTint else t.colors.surface2)
                                .clickable(onClickLabel = label, role = Role.Button) {
                                    actions.react(message, emoji, item.mine)
                                    onDismiss()
                                }
                                .semantics { contentDescription = label },
                            contentAlignment = Alignment.Center,
                        ) { Text(emoji, style = t.type.h2) }
                    }
                }
            }
            val rows = buildList {
                when (message.state) {
                    app.core.cache.SendState.FAILED -> {
                        if (message.errorCode != app.core.model.ProblemCodes.MESSAGE_REFUSED && message.errorCode != app.core.model.ProblemCodes.CONVERSATION_ENDED && live) {
                            add(SheetAction(brandString(R.string.chat_action_retry)) { actions.retry(message); onDismiss() })
                        }
                        if (message.body != null) {
                            add(
                                SheetAction(brandString(R.string.chat_confirm_edit)) {
                                    onEdit(message.body)
                                    actions.delete(message)
                                    onDismiss()
                                },
                            )
                        }
                        add(SheetAction(brandString(R.string.chat_action_delete), danger = true) { actions.delete(message); onDismiss() })
                    }
                    app.core.cache.SendState.PENDING -> add(SheetAction(brandString(R.string.chat_action_cancel_send), danger = true) { actions.delete(message); onDismiss() })
                    app.core.cache.SendState.CONFIRM -> {
                        add(SheetAction(brandString(R.string.chat_confirm_send)) { actions.sendAnyway(message); onDismiss() })
                        add(SheetAction(brandString(R.string.chat_action_delete), danger = true) { actions.delete(message); onDismiss() })
                    }
                    app.core.cache.SendState.SENT -> Unit
                }
                if (text != null) add(SheetAction(brandString(R.string.chat_action_copy)) { copy(text); onDismiss() })
                if (message.mine && message.sent && item.unsent == null && live) add(SheetAction(brandString(R.string.chat_action_unsend)) { onSheet(ChatSheet.Unsend(message)) })
                if (!message.mine && message.sent && live) add(SheetAction(brandString(R.string.chat_action_report), danger = true) { onSheet(ChatSheet.Report(message)) })
            }
            rows.forEachIndexed { index, row -> SheetRow(row, divider = index > 0) }
        }
    }
}

/** One row of the message sheet. */
private class SheetAction(val text: String, val danger: Boolean = false, val onClick: () -> Unit)

@Composable
private fun SheetRow(action: SheetAction, divider: Boolean) {
    val t = AppTheme.template
    Column(Modifier.fillMaxWidth()) {
        if (divider) Box(Modifier.fillMaxWidth().height(1.dp).background(t.colors.line))
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = SheetLayout.row)
                .clickable(role = Role.Button, onClick = action.onClick),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(action.text, style = t.type.bodyStrong, color = if (action.danger) t.colors.error else t.colors.text)
        }
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
    AppDialog(
        title = brandString(R.string.chat_confirm_title),
        body = body,
        confirm = brandString(R.string.chat_confirm_send),
        onConfirm = onSend,
        dismiss = brandString(R.string.chat_confirm_edit),
        onDismiss = onEdit,
        destructive = false,
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
    val t = AppTheme.template
    var reason by rememberSaveable { mutableStateOf<String?>(null) }
    var details by rememberSaveable { mutableStateOf("") }
    var block by rememberSaveable { mutableStateOf(true) }
    val reasons = reportReasons(catalog)
    AppBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = Space.gutter, end = Space.gutter, bottom = SheetLayout.bottom),
        ) {
            Text(brandString(R.string.report_title, name), style = t.type.h2, color = t.colors.text, modifier = Modifier.semantics { heading() })
            Text(brandString(R.string.report_subtitle), style = t.type.bodySm, color = t.colors.text2, modifier = Modifier.padding(top = SheetLayout.lineTop))
            Column(Modifier.padding(top = SheetLayout.listTop).selectableGroup()) {
                reasons.forEachIndexed { index, (wire, label) ->
                    SheetChoiceRow(label, selected = reason == wire, onClick = { reason = wire }, divider = index < reasons.lastIndex)
                }
            }
            AppTextField(
                value = details,
                onValueChange = { details = it.take(DETAILS_MAX) },
                placeholder = brandString(R.string.report_details_hint),
                singleLine = false,
                modifier = Modifier.fillMaxWidth().padding(top = SheetLayout.fieldTop),
            )
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = SheetLayout.row)
                    .toggleable(value = block, role = Role.Checkbox, onValueChange = { block = it }),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(SheetLayout.checkGap),
            ) {
                AppCheckbox(block)
                Text(brandString(R.string.report_block), style = t.type.bodyStrong, color = t.colors.text)
            }
            Text(
                evidenceNote ?: brandString(if (withMessage) R.string.report_with_message else R.string.report_with_recent),
                style = t.type.bodySm,
                color = t.colors.text3,
            )
            Spacer(Modifier.height(SheetLayout.buttonTop))
            PrimaryButton(
                brandString(R.string.report_send),
                onClick = {
                    reason?.let { picked ->
                        val value = ReportReason.entries.firstOrNull { it.wire == picked && it != ReportReason.Unknown } ?: ReportReason.Other
                        onSend(value, details.trim().takeIf { it.isNotEmpty() }, block)
                    }
                },
                enabled = reason != null,
            )
            if (reason == null) {
                Text(
                    brandString(R.string.report_reason_required),
                    style = t.type.caption,
                    color = t.colors.text3,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = SheetLayout.lineTop),
                )
            }
        }
    }
}

/** The chat's sheets, laid out as the design's sheets are. */
private object SheetLayout {
    val bottom = 30.dp
    val reaction = 48.dp
    val reactionsBottom = 8.dp
    val row = 52.dp
    val lineTop = 4.dp
    val listTop = 8.dp
    val fieldTop = 12.dp
    val checkGap = 12.dp
    val buttonTop = 16.dp
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
