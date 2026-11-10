package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme

/**
 * The app bar of a pushed screen (`.appbar`): under the status bar (at
 * least the design's 32 dp), 56 dp tall (taller with large text), the back button 6 dp from the
 * start, then [content] (a title, or who the chat is with) and the
 * [actions] at the end, 8 dp from it. On `--surface-bar` with a `--line`
 * hairline under it, or [clear] (no fill, no line: a list under a plain
 * title).
 */
@Composable
fun PushedAppBar(
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    clear: Boolean = false,
    actions: @Composable RowScope.() -> Unit = {},
    content: @Composable RowScope.() -> Unit,
) {
    val t = AppTheme.template
    Row(
        modifier
            .fillMaxWidth()
            .then(
                if (clear) {
                    Modifier
                } else {
                    Modifier.background(t.colors.surfaceBar).drawBehind {
                        val line = 1.dp.toPx()
                        drawRect(t.colors.line, topLeft = Offset(0f, size.height - line), size = Size(size.width, line))
                    }
                },
            )
            .windowInsetsPadding(WindowInsets.statusBars.union(WindowInsets(top = APP_BAR_STATUS_MIN)))
            // At least 56 dp: larger text makes it taller rather than cut the name or «آنلاین».
            .heightIn(min = APP_BAR_HEIGHT)
            .padding(start = APP_BAR_START, end = APP_BAR_END),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(APP_BAR_GAP),
    ) {
        AppIconButton(AppIcons.Back, stringResource(R.string.action_back), onBack)
        content()
        actions()
    }
}

/** A pushed screen's title (`--type-h3`), one line, taking the bar's room. */
@Composable
fun RowScope.AppBarTitle(text: String) {
    val t = AppTheme.template
    Text(
        text,
        style = t.type.h3,
        color = t.colors.text,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f).padding(start = APP_BAR_TITLE_START).semantics { heading() },
    )
}

private val APP_BAR_STATUS_MIN = 32.dp
private val APP_BAR_HEIGHT = 56.dp
private val APP_BAR_START = 6.dp
private val APP_BAR_END = 8.dp
private val APP_BAR_GAP = 2.dp
private val APP_BAR_TITLE_START = 4.dp
