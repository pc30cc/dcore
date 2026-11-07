package app.core.feature.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.core.media.PhotoImage
import app.core.model.Photo
import app.core.ui.theme.AppTheme

/**
 * A person's round photo, or the person silhouette when there is none (never
 * a letter). [online] adds the green dot, shown only when the server said so
 * (the person allows it).
 */
@Composable
fun PeerAvatar(
    photo: Photo?,
    size: Dp,
    modifier: Modifier = Modifier,
    online: Boolean = false,
    ring: Boolean = false,
) {
    Box(modifier.size(size)) {
        val ringModifier = if (ring) Modifier.border(2.dp, MaterialTheme.colorScheme.primary, CircleShape).padding(3.dp) else Modifier
        Box(
            Modifier
                .fillMaxSize()
                .then(ringModifier)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.surfaceContainerHighest),
            contentAlignment = Alignment.Center,
        ) {
            if (photo != null) {
                PhotoImage(photo = photo, contentDescription = null, modifier = Modifier.fillMaxSize())
            } else {
                Icon(
                    Icons.Filled.Person,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(size * 0.6f),
                )
            }
        }
        if (online) {
            val dot = (size.value * 0.26f).coerceIn(10f, 16f).dp
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .size(dot)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surface)
                    .padding(2.dp)
                    .clip(CircleShape)
                    .background(AppTheme.colors.success),
            )
        }
    }
}
