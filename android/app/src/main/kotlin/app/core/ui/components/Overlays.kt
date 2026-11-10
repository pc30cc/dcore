package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetState
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import app.core.R
import app.core.ui.theme.Space
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.dismiss
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import app.core.ui.theme.AppTheme
import app.core.ui.theme.insetShadow
import app.core.ui.theme.outerShadow
import kotlinx.coroutines.launch

/** The sheet's 36 × 4 grabber (`--line-strong`). */
@Composable
fun SheetGrabber(modifier: Modifier = Modifier) {
    Box(
        modifier
            .padding(top = 12.dp, bottom = 14.dp)
            .size(36.dp, 4.dp)
            .background(AppTheme.template.colors.lineStrong, CircleShape),
    )
}

/**
 * What a bottom sheet holds: the title (`--type-h2`) and at most one short
 * line under it, then [content] (rows), then at most one primary action.
 */
@Composable
fun SheetBody(
    title: String,
    modifier: Modifier = Modifier,
    body: String? = null,
    action: String? = null,
    onAction: (() -> Unit)? = null,
    actionEnabled: Boolean = true,
    content: @Composable ColumnScope.() -> Unit = {},
) {
    val t = AppTheme.template
    Column(modifier.fillMaxWidth().padding(start = Space.gutter, end = Space.gutter, bottom = 30.dp)) {
        Text(title, style = t.type.h2, color = t.colors.text, modifier = Modifier.semantics { heading() })
        if (body != null) {
            Text(body, style = t.type.bodySm, color = t.colors.text2, modifier = Modifier.padding(top = 2.dp))
        }
        Spacer(Modifier.height(12.dp))
        content()
        if (action != null && onAction != null) {
            Spacer(Modifier.height(16.dp))
            PrimaryButton(action, onAction, enabled = actionEnabled)
        }
    }
}

/** A choice in a sheet: the radio at the start, the label, a `--line` hairline between rows (52 dp). */
@Composable
fun SheetChoiceRow(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, divider: Boolean = true) {
    val t = AppTheme.template
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 52.dp)
                .selectable(selected = selected, role = Role.RadioButton, onClick = onClick),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            AppRadio(selected)
            Text(label, style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.weight(1f))
        }
        if (divider) HorizontalDivider(thickness = 1.dp, color = t.colors.line)
    }
}

/**
 * A sheet's surface: `--surface-sheet` with `--r-sheet` top corners and
 * `--sheet-shadow`, its outer layers outside the edge and its inset layer
 * (neon's 1 dp top highlight) inside it. For a sheet drawn in place; the
 * modal one ([AppBottomSheet]) draws the same.
 */
@Composable
fun Modifier.sheetSurface(): Modifier {
    val t = AppTheme.template
    val shape = RoundedCornerShape(topStart = t.radii.sheet, topEnd = t.radii.sheet)
    return outerShadow(shape, t.shadows.sheetShadow).background(t.colors.surfaceSheet, shape).insetShadow(shape, t.shadows.sheetShadow)
}

/**
 * A modal bottom sheet in the template's look: `--r-sheet` top corners,
 * `--surface-sheet`, `--sheet-shadow` (outside the sheet and its inset
 * layer inside), the grabber, the `--scrim` behind; drag down to close.
 * The grabber is drawn with the content, under the inset layer, and closes
 * the sheet from TalkBack (its dismiss action).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppBottomSheet(
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    sheetState: SheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    content: @Composable ColumnScope.() -> Unit,
) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(topStart = t.radii.sheet, topEnd = t.radii.sheet)
    val scope = rememberCoroutineScope()
    val close = stringResource(R.string.action_close)
    ModalBottomSheet(
        onDismissRequest = onDismissRequest,
        // The outer layers, outside the sheet's own clip.
        modifier = modifier.outerShadow(shape, t.shadows.sheetShadow),
        sheetState = sheetState,
        shape = shape,
        containerColor = t.colors.surfaceSheet,
        contentColor = t.colors.text,
        scrimColor = t.colors.scrim,
        tonalElevation = 0.dp,
        dragHandle = null,
    ) {
        Column(Modifier.fillMaxWidth().insetShadow(shape, t.shadows.sheetShadow).navigationBarsPadding()) {
            SheetGrabber(
                Modifier
                    .align(Alignment.CenterHorizontally)
                    .semantics {
                        contentDescription = close
                        dismiss {
                            scope.launch { sheetState.hide() }.invokeOnCompletion { if (!sheetState.isVisible) onDismissRequest() }
                            true
                        }
                    },
            )
            content()
        }
    }
}

/**
 * A dialog's card (`--surface-dialog`, `--r-dialog`, `--raised-shadow`):
 * the title is a question (`--type-h3`), the body says what happens
 * (`--type-body-sm`, `--text-2`), the buttons are verbs at the end, the
 * confirming one first; a destructive one is `--error` text.
 */
@Composable
fun DialogCard(
    title: String,
    body: String,
    confirm: String,
    onConfirm: () -> Unit,
    dismiss: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    destructive: Boolean = true,
) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.dialog)
    Column(
        modifier
            .widthIn(max = 400.dp)
            .fillMaxWidth()
            .raised(shape)
            .background(t.colors.surfaceDialog, shape)
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = t.type.h3, color = t.colors.text, modifier = Modifier.semantics { heading() })
        Text(body, style = t.type.bodySm, color = t.colors.text2)
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End)) {
            TextAction(confirm, onConfirm, kind = if (destructive) TextActionKind.Destructive else TextActionKind.Primary)
            TextAction(dismiss, onDismiss, kind = TextActionKind.Neutral)
        }
    }
}

/** [DialogCard] in a window of its own. */
@Composable
fun AppDialog(
    title: String,
    body: String,
    confirm: String,
    onConfirm: () -> Unit,
    dismiss: String,
    onDismiss: () -> Unit,
    destructive: Boolean = true,
) {
    Dialog(onDismissRequest = onDismiss) {
        DialogCard(title, body, confirm, onConfirm, dismiss, onDismiss, destructive = destructive)
    }
}

/**
 * A snackbar (52 dp, `--r-button`): `--inverse` with `--on-inverse` text and
 * an optional action in `--inverse-action`; no icon. It sits 12 dp above
 * the tab bar; 3 s, or 5 s with an action.
 */
@Composable
fun AppSnackbar(
    message: String,
    modifier: Modifier = Modifier,
    action: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.button)
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .raised(shape)
            .background(t.colors.inverse, shape)
            .padding(start = 20.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(message, style = t.type.labelSm, color = t.colors.onInverse, modifier = Modifier.weight(1f), maxLines = 2)
        if (action != null && onAction != null) {
            Box(
                Modifier
                    .heightIn(min = 48.dp)
                    .clip(shape)
                    .clickable(role = Role.Button, onClick = onAction)
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(action, style = t.type.chipStrong, color = t.colors.inverseAction)
            }
        }
    }
}

/** A short notice on a photo (44 dp, `--r-button`): `--photo-chip-fill`, a hairline, `--on-photo`; no icon. */
@Composable
fun PhotoToast(text: String, modifier: Modifier = Modifier, backdrop: GlassBackdrop? = null) {
    val t = AppTheme.template
    GlassBox(RoundedCornerShape(t.radii.button), GlassStyle.photoChip(), modifier.height(44.dp), backdrop) {
        Text(text, style = t.type.labelSm, color = t.colors.onPhoto, maxLines = 1, modifier = Modifier.padding(horizontal = 16.dp))
    }
}
