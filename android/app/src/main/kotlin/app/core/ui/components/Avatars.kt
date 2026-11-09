package app.core.ui.components

import android.os.Build
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.core.R
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppColors
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Radius
import kotlin.math.cos
import kotlin.math.sin

/**
 * A person's round photo, 36 / 48 / 56 / 64 dp. [photo] draws the picture
 * (null: the person silhouette on a grey disc, never initials). A new match
 * has a 3 dp gradient ring with a 2.5 dp gap; online, a lime dot at the
 * bottom end.
 */
@Composable
fun Avatar(
    size: Dp,
    modifier: Modifier = Modifier,
    newMatch: Boolean = false,
    online: Boolean = false,
    contentDescription: String? = null,
    photo: (@Composable BoxScope.() -> Unit)? = null,
) {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    val ring = if (newMatch) 3.dp else 0.dp
    val gap = if (newMatch) 2.5.dp else 0.dp
    val onlineLabel = stringResource(R.string.ui_online)
    val newLabel = stringResource(R.string.ui_new_match)
    val described = listOfNotNull(contentDescription, newLabel.takeIf { newMatch }, onlineLabel.takeIf { online }).joinToString("، ")
    Box(
        modifier
            .size(size + (ring + gap) * 2)
            .then(if (described.isNotEmpty()) Modifier.semantics { this.contentDescription = described } else Modifier),
    ) {
        if (newMatch) Box(Modifier.fillMaxSize().border(ring, colors.gradient, CircleShape))
        Box(
            Modifier
                .padding(ring + gap)
                .size(size)
                .clip(CircleShape)
                .background(scheme.surfaceContainerHighest, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (photo != null) photo() else PersonSilhouette(size)
        }
        if (online) {
            val dot = if (size <= 40.dp) 10.dp else 14.dp
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = ring + gap, bottom = ring + gap)
                    .size(dot + 6.dp)
                    .background(scheme.background, CircleShape)
                    .padding(3.dp)
                    .background(colors.alive, CircleShape),
            )
        }
    }
}

/** The silhouette that stands in for a missing photo. */
@Composable
fun PersonSilhouette(size: Dp, modifier: Modifier = Modifier) {
    Icon(AppIcons.Person, contentDescription = null, tint = AppTheme.colors.textTertiary, modifier = modifier.size(size * 0.5f))
}

/** A new match in the strip (76 × 100, radius 20); a fresh one has a 2 dp gradient ring. */
@Composable
fun MatchTile(
    modifier: Modifier = Modifier,
    isNew: Boolean = false,
    contentDescription: String? = null,
    photo: (@Composable BoxScope.() -> Unit)? = null,
) {
    val colors = AppTheme.colors
    val shape = RoundedCornerShape(Radius.matchTile)
    Box(
        modifier
            .size(76.dp, 100.dp)
            .then(if (contentDescription != null) Modifier.semantics { this.contentDescription = contentDescription } else Modifier)
            .then(if (isNew) Modifier.border(2.dp, colors.gradient, shape).padding(4.dp) else Modifier)
            .clip(if (isNew) RoundedCornerShape(Radius.matchTile - 4.dp) else shape)
            .background(MaterialTheme.colorScheme.surfaceContainerHighest),
        contentAlignment = Alignment.Center,
    ) {
        if (photo != null) photo() else PersonSilhouette(56.dp)
    }
}

/**
 * The likes teaser: someone's photo blurred (Android 12+; dimmed below),
 * with the count over it («+۱۲»).
 */
@Composable
fun LikesTeaserTile(count: String, modifier: Modifier = Modifier, photo: (@Composable BoxScope.() -> Unit)? = null) {
    val shape = RoundedCornerShape(Radius.matchTile)
    Box(
        modifier.size(76.dp, 100.dp).clip(shape).background(MaterialTheme.colorScheme.surfaceContainerHighest),
        contentAlignment = Alignment.Center,
    ) {
        if (photo != null) {
            Box(Modifier.fillMaxSize().then(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Modifier.blur(7.dp) else Modifier)) { photo() }
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) 0.25f else 0.55f)))
        }
        Text(count, style = MaterialTheme.typography.labelLarge.copy(fontSize = 16.sp, fontWeight = FontWeight.Bold), color = Color.White)
    }
}

/**
 * The verified mark: a 12-point rosette in the verified violet with a white
 * check (4.52:1), 16 / 20 / 24 / 28 dp; on a photo it gets a 1 dp white rim.
 * TalkBack reads it as «تأییدشده».
 */
@Composable
fun VerifiedBadge(size: Dp, modifier: Modifier = Modifier, onPhoto: Boolean = false) {
    val label = stringResource(R.string.ui_verified)
    Canvas(modifier.size(size).semantics { contentDescription = label }) {
        val c = Offset(this.size.width / 2, this.size.height / 2)
        val outer = this.size.minDimension / 2 * (if (onPhoto) 0.92f else 1f)
        val inner = outer * 0.84f
        val rosette = Path().apply {
            for (i in 0 until 24) {
                val r = if (i % 2 == 0) outer else inner
                val a = Math.PI * 2 * i / 24 - Math.PI / 2
                val p = Offset(c.x + (r * cos(a)).toFloat(), c.y + (r * sin(a)).toFloat())
                if (i == 0) moveTo(p.x, p.y) else lineTo(p.x, p.y)
            }
            close()
        }
        val rounding = PathEffect.cornerPathEffect(outer * 0.12f)
        if (onPhoto) drawPath(rosette, Color.White, style = Stroke(width = 2.dp.toPx(), pathEffect = rounding))
        drawPath(rosette, AppColors.Verified, style = Fill)
        drawPath(rosette, AppColors.Verified, style = Stroke(width = outer * 0.1f, pathEffect = rounding, join = StrokeJoin.Round))
        val check = Path().apply {
            moveTo(c.x - outer * 0.38f, c.y + outer * 0.02f)
            lineTo(c.x - outer * 0.1f, c.y + outer * 0.3f)
            lineTo(c.x + outer * 0.4f, c.y - outer * 0.26f)
        }
        drawPath(check, Color.White, style = Stroke(width = outer * 0.2f, cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}
