package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
    val r = t.radii.bubble
    val tail = t.radii.bubbleTail
    val shape = if (mine) {
        RoundedCornerShape(topStart = r, topEnd = tail, bottomEnd = r, bottomStart = r)
    } else {
        RoundedCornerShape(topStart = tail, topEnd = r, bottomEnd = r, bottomStart = r)
    }
    Box(Modifier.fillMaxWidth(), contentAlignment = if (mine) Alignment.CenterEnd else Alignment.CenterStart) {
        Column(
            modifier
                .widthIn(max = 286.dp)
                .then(if (mine) Modifier.background(t.paints.bubbleOut, shape) else Modifier.background(t.colors.bubbleIn, shape))
                .padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 9.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(text, style = t.type.body, color = if (mine) t.colors.onBubbleOut else t.colors.onBubbleIn)
            if (meta != null) {
                Text(meta, style = t.type.caption, color = if (mine) t.colors.onBubbleOut2 else t.colors.text3)
            }
        }
    }
}

/** A system line in a chat («۳ روز پیش مچ شدین»): centred, `--type-caption`, `--text-3`; no chip, no icon. */
@Composable
fun ChatSystemLine(text: String, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    Box(modifier.fillMaxWidth().padding(vertical = 4.dp), contentAlignment = Alignment.Center) {
        Text(text, style = t.type.caption, color = t.colors.text3)
    }
}
