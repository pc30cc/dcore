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
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetState
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Radius

/** The sheet's 36 × 4 grabber. */
@Composable
fun SheetGrabber(modifier: Modifier = Modifier) {
    Box(
        modifier
            .padding(top = 12.dp, bottom = 8.dp)
            .size(36.dp, 4.dp)
            .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f), CircleShape),
    )
}

/**
 * What a bottom sheet holds: the title (and a line under it), then
 * [content] (rows), then at most one primary action, flat: no glow in sheets.
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
    val scheme = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 24.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = scheme.onSurface, modifier = Modifier.semantics { heading() })
        if (body != null) {
            Text(body, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
        }
        Spacer(Modifier.height(12.dp))
        content()
        if (action != null && onAction != null) {
            Spacer(Modifier.height(16.dp))
            GradientButton(action, onAction, glow = false, enabled = actionEnabled)
        }
    }
}

/** A choice in a sheet: the label and a gradient radio at the end, a hairline between rows. */
@Composable
fun SheetChoiceRow(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, divider: Boolean = true) {
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .selectable(selected = selected, role = Role.RadioButton, onClick = onClick),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Medium), color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
            GradientRadio(selected)
        }
        if (divider) HorizontalDivider(thickness = 1.dp, color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/**
 * A modal bottom sheet in the app's look: 32 dp top corners, the low
 * container (white in light), the grabber, a 56 % black scrim; drag down
 * to close.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppBottomSheet(
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    sheetState: SheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismissRequest,
        modifier = modifier,
        sheetState = sheetState,
        shape = RoundedCornerShape(topStart = Radius.sheet, topEnd = Radius.sheet),
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        contentColor = MaterialTheme.colorScheme.onSurface,
        scrimColor = Color.Black.copy(alpha = 0.56f),
        tonalElevation = 0.dp,
        dragHandle = { SheetGrabber() },
    ) {
        Column(Modifier.navigationBarsPadding()) { content() }
    }
}

/**
 * A dialog's card: the title is a question, the body says what happens,
 * the buttons are verbs at the end; a destructive one is red text, never
 * the gradient.
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
    val scheme = MaterialTheme.colorScheme
    Column(
        modifier
            .widthIn(max = 400.dp)
            .fillMaxWidth()
            .background(if (AppTheme.colors.dark) scheme.surfaceContainerHigh else scheme.surfaceContainerLowest, RoundedCornerShape(Radius.dialog))
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleLarge.copy(fontSize = 20.sp), color = scheme.onSurface, modifier = Modifier.semantics { heading() })
        Text(body, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.5.sp, lineHeight = 25.sp), color = scheme.onSurfaceVariant)
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End)) {
            TextAction(dismiss, onDismiss, kind = TextActionKind.Neutral)
            TextAction(confirm, onConfirm, kind = if (destructive) TextActionKind.Destructive else TextActionKind.Primary)
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

/** What a snackbar reports. */
enum class SnackbarKind { Neutral, Success, Error }

/**
 * A snackbar (52 dp, the inverse pill): a 36 dp icon tile (violet for
 * neutral, lime for success, red for errors), the message and an optional
 * action. It sits 12 dp above the tab bar; 3 s, or 5 s with an action.
 */
@Composable
fun AppSnackbar(
    message: String,
    modifier: Modifier = Modifier,
    kind: SnackbarKind = SnackbarKind.Neutral,
    action: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    val (tile, iconTint, icon) = when (kind) {
        SnackbarKind.Neutral -> Triple(colors.gradientStops.start.copy(alpha = 0.18f), colors.gradientStops.start, AppIcons.Close)
        SnackbarKind.Success -> Triple(colors.alive, colors.onAlive, AppIcons.Check)
        SnackbarKind.Error -> Triple(if (colors.dark) scheme.error else colors.like, colors.onSemantic, AppIcons.WifiOff)
    }
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .background(scheme.inverseSurface, CircleShape)
            .padding(start = 8.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(36.dp).background(tile, CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(20.dp))
        }
        Text(message, style = MaterialTheme.typography.labelMedium, color = scheme.inverseOnSurface, modifier = Modifier.weight(1f), maxLines = 2)
        if (action != null && onAction != null) {
            Box(
                Modifier
                    .heightIn(min = 48.dp)
                    .clip(CircleShape)
                    .clickable(role = Role.Button, onClick = onAction)
                    .padding(horizontal = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(action, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Bold), color = colors.snackbarAction)
            }
        } else {
            Spacer(Modifier.size(8.dp))
        }
    }
}
