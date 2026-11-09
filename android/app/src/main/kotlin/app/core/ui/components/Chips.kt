package app.core.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space

/**
 * Chips wrap onto whole rows (never clipped at the edge). Selected chips
 * are never the gradient: it stays reserved for "yes".
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChipRow(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    FlowRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(Space.chipGap),
        verticalArrangement = Arrangement.spacedBy(Space.chipGap),
    ) { content() }
}

@Composable
private fun ChipFrame(
    height: Dp,
    fill: Color,
    border: BorderStroke?,
    modifier: Modifier,
    horizontalPadding: Dp = 16.dp,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = modifier
            .heightIn(min = height)
            .clip(CircleShape)
            .background(fill, CircleShape)
            .then(if (border != null) Modifier.border(border, CircleShape) else Modifier)
            .padding(horizontal = horizontalPadding),
        contentAlignment = Alignment.Center,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) { content() }
    }
}

/**
 * An onboarding choice (single or multiple), 48 dp: outlined when off,
 * the inverse fill with a check when on.
 */
@Composable
fun ChoiceChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val content = if (selected) scheme.inverseOnSurface else scheme.onSurface
    ChipFrame(
        height = 48.dp,
        fill = if (selected) scheme.inverseSurface else Color.Transparent,
        border = if (selected) null else BorderStroke(1.dp, AppTheme.colors.hairlineStrong),
        modifier = modifier.toggleable(value = selected, role = Role.Checkbox, onValueChange = { onClick() }),
        horizontalPadding = 20.dp,
    ) {
        if (selected) Icon(AppIcons.Check, contentDescription = null, tint = content, modifier = Modifier.size(18.dp))
        else if (icon != null) Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(18.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium), color = content, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A filter (40 dp to see, 48 dp to touch): the secondary container with a check when on. */
@Composable
fun FilterChoiceChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val content = if (selected) scheme.onSecondaryContainer else scheme.onSurface
    // The 40 dp chip inside a 48 dp target: the whole target toggles.
    Box(modifier.heightIn(min = 48.dp).clip(CircleShape).toggleable(value = selected, role = Role.Checkbox, onValueChange = { onClick() }), contentAlignment = Alignment.Center) {
        ChipFrame(
            height = 40.dp,
            fill = if (selected) scheme.secondaryContainer else Color.Transparent,
            border = BorderStroke(1.dp, if (selected) scheme.primary.copy(alpha = 0.35f) else AppTheme.colors.hairlineStrong),
            modifier = Modifier,
        ) {
            when {
                selected -> Icon(AppIcons.Check, contentDescription = null, tint = content, modifier = Modifier.size(18.dp))
                icon != null -> Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(18.dp))
            }
            Text(label, style = MaterialTheme.typography.labelMedium, color = content, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * An interest on a profile, 40 dp. [shared] (both of you like it) is the
 * alive accent: lime tint, lime ring, lime text and a check.
 */
@Composable
fun InterestChip(
    label: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    shared: Boolean = false,
) {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    if (shared) {
        ChipFrame(40.dp, colors.aliveTint.compositeOverSafe(scheme.surfaceContainerLow), BorderStroke(1.5.dp, colors.aliveLine), modifier) {
            Icon(AppIcons.Check, contentDescription = null, tint = colors.aliveText, modifier = Modifier.size(18.dp))
            Text(label, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Bold), color = colors.aliveText, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    } else {
        ChipFrame(40.dp, scheme.surfaceContainerLow, BorderStroke(1.dp, colors.hairlineStrong), modifier) {
            if (icon != null) Icon(icon, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
            Text(label, style = MaterialTheme.typography.labelMedium, color = scheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A fun fact under the fact row (zodiac, pets, smoking): a line icon and a few words, 34 dp. */
@Composable
fun FactChip(label: String, icon: ImageVector, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    ChipFrame(34.dp, scheme.surfaceContainerLow, BorderStroke(1.dp, AppTheme.colors.hairlineStrong), modifier, horizontalPadding = 14.dp) {
        Icon(icon, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        Text(label, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium), color = scheme.onSurface, maxLines = 1)
    }
}

/** What leads a chip on a photo. */
enum class PhotoChipMark { None, Online, Shared }

/**
 * A chip on a photo (34 dp): dark glass in both themes, white text, a lime
 * dot for online or a lime sparkle for shared interests.
 */
@Composable
fun PhotoChip(
    label: String,
    modifier: Modifier = Modifier,
    mark: PhotoChipMark = PhotoChipMark.None,
    backdrop: GlassBackdrop? = null,
) {
    val colors = AppTheme.colors
    GlassBox(CircleShape, GlassStyle.ChipOnPhoto, modifier.heightIn(min = 34.dp), backdrop) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        ) {
            when (mark) {
                PhotoChipMark.Online -> Box(Modifier.size(9.dp).background(colors.alive, CircleShape))
                PhotoChipMark.Shared -> Icon(AppIcons.Sparkle, contentDescription = null, tint = colors.alive, modifier = Modifier.size(16.dp))
                PhotoChipMark.None -> Unit
            }
            Text(label, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium), color = Color.White, maxLines = 1)
        }
    }
}

/** [this] over [background] when translucent. */
internal fun Color.compositeOverSafe(background: Color): Color =
    if (alpha >= 1f) this else compositeOver(background)
