package app.core.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import app.core.ui.theme.photoFilter
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.draw.drawBehind
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import kotlin.math.cos
import kotlin.math.sin

/**
 * A person's round photo, 36 / 48 / 56 / 64 dp. [photo] draws the picture
 * (null: the person silhouette on `--surface-3`, never initials). A new
 * match has a 2.5 dp `--ring-fill` ring with a 2.5 dp gap in the page
 * colour; online, a 13 dp `--online` dot at the bottom end ringed in the
 * page colour.
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
    val t = AppTheme.template
    val ring = if (newMatch) 2.5.dp else 0.dp
    val gap = if (newMatch) 2.5.dp else 0.dp
    val onlineLabel = stringResource(R.string.ui_online)
    val newLabel = stringResource(R.string.ui_new_match)
    val described = listOfNotNull(contentDescription, newLabel.takeIf { newMatch }, onlineLabel.takeIf { online }).joinToString("، ")
    Box(
        modifier
            .size(size + (ring + gap) * 2)
            .then(if (described.isNotEmpty()) Modifier.semantics { this.contentDescription = described } else Modifier),
    ) {
        if (newMatch) {
            Box(Modifier.fillMaxSize().background(t.paints.ringFill, CircleShape).padding(ring).background(t.colors.bg, CircleShape))
        }
        Box(
            Modifier
                .padding(ring + gap)
                .size(size)
                .clip(CircleShape)
                .background(t.colors.surface3, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (photo != null) photo() else PersonSilhouette(size)
        }
        if (online) {
            val dot = if (size <= 40.dp) 10.dp else 13.dp
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = ring + gap, bottom = ring + gap)
                    .size(dot + 6.dp)
                    .background(t.colors.bg, CircleShape)
                    .padding(3.dp)
                    .background(t.colors.online, CircleShape),
            )
        }
    }
}

/** The silhouette that stands in for a missing photo (`--text-3`). */
@Composable
fun PersonSilhouette(size: Dp, modifier: Modifier = Modifier) {
    Icon(AppIcons.Person, contentDescription = null, tint = AppTheme.template.colors.text3, modifier = modifier.size(size * 0.5f))
}

/**
 * A new match in the strip: the photo 76 × 100 (`--r-avatar-tile`), new or
 * seen alike. A fresh one is ringed outside the photo: a 2 dp gap in `--bg`,
 * then a solid 2 dp `--primary` ring, each corner grown by its spread. The
 * ring draws 4 dp past the tile, so the strip keeps 4 dp of room around its
 * tiles.
 */
@Composable
fun MatchTile(
    modifier: Modifier = Modifier,
    isNew: Boolean = false,
    contentDescription: String? = null,
    photo: (@Composable BoxScope.() -> Unit)? = null,
) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.avatarTile)
    Box(
        modifier
            .size(76.dp, 100.dp)
            .then(if (contentDescription != null) Modifier.semantics { this.contentDescription = contentDescription } else Modifier)
            .then(if (isNew) Modifier.drawBehind { ring(t.radii.avatarTile.toPx(), 2.dp.toPx(), t.colors.bg, t.colors.primary) } else Modifier)
            .clip(shape)
            .background(t.colors.surface3),
        contentAlignment = Alignment.Center,
    ) {
        if (photo != null) photo() else PersonSilhouette(56.dp)
    }
}

/** A ring outside the box: [gap] in [gapColor], then [gap] more in [ringColor]; each corner grows by its spread. */
private fun DrawScope.ring(radius: Float, gap: Float, gapColor: Color, ringColor: Color) {
    fun spread(by: Float, color: Color) = drawRoundRect(
        color,
        topLeft = Offset(-by, -by),
        size = Size(size.width + by * 2, size.height + by * 2),
        cornerRadius = CornerRadius(radius + by),
    )
    spread(gap * 2, ringColor)
    spread(gap, gapColor)
}

/**
 * A like you cannot see yet: the photo under `--photo-locked-filter`
 * (blurred on Android 12+, dimmed below), with the count over it («+۱۲»).
 */
@Composable
fun LikesTeaserTile(count: String, modifier: Modifier = Modifier, photo: (@Composable BoxScope.() -> Unit)? = null) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.avatarTile)
    Box(
        modifier.size(76.dp, 100.dp).clip(shape).background(t.colors.photoPlaceholder),
        contentAlignment = Alignment.Center,
    ) {
        if (photo != null) {
            Box(Modifier.fillMaxSize().photoFilter(t.filters.photoLockedFilter)) { photo() }
        }
        Text(count, style = t.type.h3, color = t.colors.onPhoto)
    }
}

/**
 * A photo slot (3:4, `--r-tile`) holding a photo: the remove button (32 dp
 * on `--photo-chip-fill`, its 48 dp target inside the tile) at the
 * top-start corner, the [mainTag] pill at the bottom start, the
 * [status] pill («در حال بررسی») at the bottom centre.
 */
@Composable
fun PhotoTile(
    modifier: Modifier = Modifier,
    mainTag: String? = null,
    status: String? = null,
    onRemove: (() -> Unit)? = null,
    photo: @Composable BoxScope.() -> Unit,
) {
    val t = AppTheme.template
    val remove = stringResource(R.string.ui_remove_photo)
    Box(modifier.aspectRatio(3f / 4f).clip(RoundedCornerShape(t.radii.tile)).background(t.colors.photoPlaceholder)) {
        photo()
        if (onRemove != null) {
            Box(
                Modifier
                    .align(Alignment.TopStart)
                    .size(48.dp)
                    .clip(CircleShape)
                    .clickable(role = Role.Button, onClick = onRemove)
                    .semantics { contentDescription = remove },
                contentAlignment = Alignment.Center,
            ) {
                GlassBox(CircleShape, GlassStyle.photoChip(), Modifier.size(32.dp)) {
                    Icon(AppIcons.Close, contentDescription = null, tint = t.colors.onPhoto, modifier = Modifier.size(16.dp))
                }
            }
        }
        if (mainTag != null) Pill(mainTag, Modifier.align(Alignment.BottomStart).padding(8.dp))
        if (status != null) PhotoPill(status, Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp))
    }
}

/**
 * An empty photo slot (3:4, `--r-tile`, `--surface-empty`): a dashed
 * `--tile-empty-line` edge (none in white), a 40 dp `--surface-2` disc with
 * the add mark in `--primary`; the [main] slot has a dashed `--primary`
 * edge.
 */
@Composable
fun AddPhotoTile(onClick: () -> Unit, contentDescription: String, modifier: Modifier = Modifier, main: Boolean = false) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.tile)
    val edge = if (main) t.colors.primary else t.colors.tileEmptyLine
    Box(
        modifier
            .aspectRatio(3f / 4f)
            .clip(shape)
            .background(t.colors.surfaceEmpty, shape)
            .drawBehind {
                if (edge.alpha > 0f) {
                    val stroke = 1.5.dp.toPx()
                    drawRoundRect(
                        edge,
                        topLeft = Offset(stroke / 2, stroke / 2),
                        size = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke),
                        cornerRadius = androidx.compose.ui.geometry.CornerRadius(t.radii.tile.toPx()),
                        style = Stroke(stroke, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()))),
                    )
                }
            }
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { this.contentDescription = contentDescription },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(40.dp).background(t.colors.surface2, CircleShape), contentAlignment = Alignment.Center) {
            Icon(AppIcons.Plus, contentDescription = null, tint = t.colors.primary, modifier = Modifier.size(22.dp))
        }
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
    val template = AppTheme.template
    val fill = template.paints.verified
    val check = template.colors.onVerified
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
        drawPath(rosette, fill, style = Fill)
        drawPath(rosette, fill, style = Stroke(width = outer * 0.1f, pathEffect = rounding, join = StrokeJoin.Round))
        val tick = Path().apply {
            moveTo(c.x - outer * 0.38f, c.y + outer * 0.02f)
            lineTo(c.x - outer * 0.1f, c.y + outer * 0.3f)
            lineTo(c.x + outer * 0.4f, c.y - outer * 0.26f)
        }
        drawPath(tick, check, style = Stroke(width = outer * 0.2f, cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}
