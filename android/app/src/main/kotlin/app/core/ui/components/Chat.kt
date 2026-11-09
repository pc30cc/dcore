package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Radius
import app.core.ui.theme.brushTint

/**
 * A chat bubble: theirs on the start side (the right in Persian) on the
 * high container, yours on the end side on the gradient with white text;
 * 22 dp corners with a 6 dp one at the top on the speaker's side. [meta] is
 * the time and state joined with «،» («۱۸:۲۵، دیده شد»), never a middle dot.
 */
@Composable
fun ChatBubble(text: String, meta: String?, mine: Boolean, modifier: Modifier = Modifier) {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    val shape = if (mine) {
        RoundedCornerShape(topStart = Radius.bubble, topEnd = Radius.bubbleTail, bottomEnd = Radius.bubble, bottomStart = Radius.bubble)
    } else {
        RoundedCornerShape(topStart = Radius.bubbleTail, topEnd = Radius.bubble, bottomEnd = Radius.bubble, bottomStart = Radius.bubble)
    }
    val ink = if (mine) colors.onGradient else scheme.onSurface
    Box(Modifier.fillMaxWidth(), contentAlignment = if (mine) Alignment.CenterEnd else Alignment.CenterStart) {
        Column(
            modifier
                .widthIn(max = 300.dp)
                .then(if (mine) Modifier.background(colors.gradient, shape) else Modifier.background(scheme.surfaceContainerHigh, shape))
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(text, style = MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp, lineHeight = 26.sp), color = ink)
            if (meta != null) {
                Text(meta, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Normal), color = ink.copy(alpha = 0.75f))
            }
        }
    }
}

/** A small centred line in a chat («۳ روز پیش مچ شدین») with a gradient mark. */
@Composable
fun ChatInfoChip(text: String, modifier: Modifier = Modifier, icon: ImageVector = AppIcons.Heart) {
    val colors = AppTheme.colors
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Row(
            modifier
                .background(MaterialTheme.colorScheme.surfaceContainerHigh, CircleShape)
                .padding(horizontal = 14.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(icon, contentDescription = null, tint = Color.Black, modifier = Modifier.size(16.dp).brushTint(colors.gradient))
            Text(text, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium), color = MaterialTheme.colorScheme.onSurface)
        }
    }
}
