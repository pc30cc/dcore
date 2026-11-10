package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.core.ui.theme.AppTheme

/**
 * A chat bubble (`--type-body`, `--r-bubble`, at most 286 dp): theirs on the
 * start side (the right in Persian) in `--bubble-in`, yours on the end side
 * in `--bubble-out` with `--on-bubble-out`; the corner at the top on the
 * speaker's side is `--r-bubble-tail`. [meta] is the time and state joined
 * with «،» («۱۸:۲۵، دیده شد»), in `--on-bubble-out-2` on yours.
 */
@Composable
fun ChatBubble(text: String, meta: String?, mine: Boolean, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    Box(Modifier.fillMaxWidth(), contentAlignment = if (mine) Alignment.CenterEnd else Alignment.CenterStart) {
        ChatBubbleFrame(mine, modifier) {
            Text(text, style = t.type.body, color = if (mine) t.colors.onBubbleOut else t.colors.onBubbleIn)
            if (meta != null) ChatBubbleMeta(meta, mine)
        }
    }
}

/**
 * A bubble's frame with any content: `--bubble-in` or `--bubble-out`, 10 dp
 * 14 dp 9 dp inside, `--r-bubble` with the tail corner at the top on the
 * speaker's side ([tail]: the first of a run; the rest are round). [outline]
 * draws a message with no text left (unsent, removed): no fill, a `--line`
 * edge. [interaction] goes inside the shape (a click, a long press, its
 * semantics), so a press is clipped to the bubble.
 */
@Composable
fun ChatBubbleFrame(
    mine: Boolean,
    modifier: Modifier = Modifier,
    tail: Boolean = true,
    outline: Boolean = false,
    maxWidth: Dp = BUBBLE_MAX,
    interaction: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val t = AppTheme.template
    val r = t.radii.bubble
    val top = if (tail) t.radii.bubbleTail else r
    val shape = if (mine) {
        RoundedCornerShape(topStart = r, topEnd = top, bottomEnd = r, bottomStart = r)
    } else {
        RoundedCornerShape(topStart = top, topEnd = r, bottomEnd = r, bottomStart = r)
    }
    Column(
        modifier
            .widthIn(max = maxWidth)
            .clip(shape)
            .then(
                when {
                    outline -> Modifier.border(1.dp, t.colors.lineStrong, shape)
                    mine -> Modifier.background(t.paints.bubbleOut, shape)
                    else -> Modifier.background(t.colors.bubbleIn, shape)
                },
            )
            .then(interaction)
            .padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 9.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
        content = content,
    )
}

/** A bubble's time and state («۱۸:۲۵، دیده شد»): `--type-caption`, `--on-bubble-out-2` on yours, `--text-3` on theirs. */
@Composable
fun ChatBubbleMeta(text: String, mine: Boolean, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    Text(text, style = t.type.caption, color = if (mine) t.colors.onBubbleOut2 else t.colors.text3, modifier = modifier)
}

/** A system line in a chat («۳ روز پیش مچ شدین», «امروز»): centred, `--type-caption`, `--text-3`; no chip, no icon. */
@Composable
fun ChatSystemLine(text: String, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    Box(modifier.fillMaxWidth().padding(top = 10.dp, bottom = 6.dp), contentAlignment = Alignment.Center) {
        Text(text, style = t.type.caption, color = t.colors.text3, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
    }
}

/** The widest a bubble draws (`.bub{max-width:286px}`). */
val BUBBLE_MAX = 286.dp
