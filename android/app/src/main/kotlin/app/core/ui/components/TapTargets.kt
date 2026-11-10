package app.core.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * A button ([onClick]) at least [target] tall around a one-line link,
 * centred on it, while the link reports only its own height to the row it
 * sits in: the target reaches over the lines around it (a link inside a
 * line of text, «زنگ بزن» on a call line).
 */
@Composable
fun Modifier.overhangingTarget(onClick: () -> Unit, target: Dp = 48.dp, onClickLabel: String? = null): Modifier {
    val natural = remember { IntArray(1) }
    return layout { measurable, constraints ->
        val placeable = measurable.measure(constraints.copy(minHeight = 0, maxHeight = Constraints.Infinity))
        val height = natural[0]
        layout(placeable.width, height) { placeable.place(0, (height - placeable.height) / 2) }
    }.clickable(role = Role.Button, onClickLabel = onClickLabel, onClick = onClick).layout { measurable, constraints ->
        val placeable = measurable.measure(constraints.copy(minHeight = 0))
        natural[0] = placeable.height
        val height = maxOf(placeable.height, target.roundToPx())
        layout(placeable.width, height) { placeable.place(0, (height - placeable.height) / 2) }
    }
}
