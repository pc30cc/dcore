package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp
import app.core.ui.theme.AppTheme
import app.core.ui.theme.insetShadow
import app.core.ui.theme.outerShadow

/**
 * The one selected treatment of every single or multiple choice (option
 * rows, period rows, plan cards, packs, chips, the template picker):
 * selected, a 2 dp border painted with `--primary-ring` and `--primary-tint`
 * over `--surface-1` inside it; at rest, [restFill] with a 1 dp [restLine]
 * inside the edge. The text and its colour never change.
 */
@Composable
fun Modifier.choiceFrame(
    selected: Boolean,
    shape: Shape,
    restLine: Color = AppTheme.template.colors.lineStrong,
    restFill: Color = AppTheme.template.colors.surfaceOption,
): Modifier {
    val t = AppTheme.template
    return if (selected) {
        this
            .background(t.colors.primaryTint.compositeOverSafe(t.colors.surface1), shape)
            .border(2.dp, t.paints.primaryRing, shape)
    } else {
        this.background(restFill, shape).border(1.dp, restLine, shape)
    }
}

/** A card or list group: `--surface-1` with `--card-shadow` (a hairline inside the edge). */
@Composable
fun Modifier.templateCard(shape: Shape): Modifier {
    val t = AppTheme.template
    return background(t.colors.surface1, shape).insetShadow(shape, t.shadows.cardShadow)
}

/** A raised layer (dialog, snackbar): `--raised-shadow` under it. */
@Composable
fun Modifier.raised(shape: Shape): Modifier = outerShadow(shape, AppTheme.template.shadows.raisedShadow)
