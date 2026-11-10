package app.core.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
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
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme

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
 * tiles. [online]: a 12 dp `--online` dot 6 dp in from the bottom end
 * corner, ringed 2.5 dp in `--photo-chip-fill`.
 */
@Composable
fun MatchTile(
    modifier: Modifier = Modifier,
    isNew: Boolean = false,
    online: Boolean = false,
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
        if (online) {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 6.dp - 2.5.dp, bottom = 6.dp - 2.5.dp)
                    .size(12.dp + 5.dp)
                    .background(t.colors.photoChipFill, CircleShape)
                    .padding(2.5.dp)
                    .background(t.colors.online, CircleShape),
            )
        }
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
 * A photo slot (3:4, `--r-tile`) holding a photo: the remove button (32 dp
 * on `--photo-chip-fill`, its 48 dp target inside the tile) at the top end
 * corner, the [mainTag] pill at the bottom start, the [status] pill
 * («در حال بررسی») at the bottom centre. The corners follow the reading
 * direction (in Persian the remove sits top left, «اصلی» bottom right, as
 * drawn). The pills keep to one line inside the tile, 8 dp from its edges,
 * and grow with the text size only up to [PILL_FONT_SCALE_MAX] (a tile is
 * about 117 dp wide). [error] draws a 2 dp `--error` edge (a photo refused
 * or not uploaded).
 */
@Composable
fun PhotoTile(
    modifier: Modifier = Modifier,
    mainTag: String? = null,
    status: String? = null,
    onRemove: (() -> Unit)? = null,
    error: Boolean = false,
    photo: @Composable BoxScope.() -> Unit,
) {
    val t = AppTheme.template
    val remove = stringResource(R.string.ui_remove_photo)
    val shape = RoundedCornerShape(t.radii.tile)
    Box(
        modifier
            .aspectRatio(3f / 4f)
            .clip(shape)
            .background(t.colors.photoPlaceholder)
            .then(if (error) Modifier.border(2.dp, t.colors.error, shape) else Modifier),
    ) {
        photo()
        if (onRemove != null) {
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .size(48.dp)
                    .clip(CircleShape)
                    .clickable(role = Role.Button, onClick = onRemove)
                    .semantics { contentDescription = remove },
                contentAlignment = Alignment.Center,
            ) {
                GlassBox(CircleShape, GlassStyle.photoChip(), Modifier.size(32.dp)) {
                    Icon(AppIcons.CloseBold, contentDescription = null, tint = t.colors.onPhoto, modifier = Modifier.size(16.dp))
                }
            }
        }
        CappedFontScale(PILL_FONT_SCALE_MAX) {
            if (mainTag != null) Pill(mainTag, Modifier.align(Alignment.BottomStart).padding(8.dp))
            if (status != null) PhotoPill(status, Modifier.align(Alignment.BottomCenter).padding(start = 8.dp, end = 8.dp, bottom = 8.dp))
        }
    }
}

/** How far the pills on a photo tile follow the system text size. */
internal const val PILL_FONT_SCALE_MAX = 1.15f

/** [content] with the text size followed only up to [max]. */
@Composable
private fun CappedFontScale(max: Float, content: @Composable () -> Unit) {
    val density = LocalDensity.current
    if (density.fontScale <= max) {
        content()
    } else {
        CompositionLocalProvider(LocalDensity provides Density(density.density, max), content = content)
    }
}

/**
 * An empty photo slot (3:4, `--r-tile`, `--surface-empty`): a dashed
 * `--tile-empty-line` edge (none in white), a 40 dp `--surface-2` disc with
 * the add mark in `--primary`. The [main] slot has a dashed `--primary`
 * edge; with [mainLabel] it is the first slot of an empty grid, on
 * `--surface-1` like a filled tile: a 48 dp disc with the camera and the
 * label («عکس اصلی») under it. The dashes are the design's 1.5 dp dashed
 * border (4.5 dp on, 3 dp off).
 */
@Composable
fun AddPhotoTile(
    onClick: () -> Unit,
    contentDescription: String,
    modifier: Modifier = Modifier,
    main: Boolean = false,
    mainLabel: String? = null,
) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.tile)
    val edge = if (main) t.colors.primary else t.colors.tileEmptyLine
    val firstOfEmpty = main && mainLabel != null
    Box(
        modifier
            .aspectRatio(3f / 4f)
            .clip(shape)
            .background(if (firstOfEmpty) t.colors.surface1 else t.colors.surfaceEmpty, shape)
            .drawBehind {
                if (edge.alpha > 0f) {
                    val stroke = 1.5.dp.toPx()
                    drawRoundRect(
                        edge,
                        topLeft = Offset(stroke / 2, stroke / 2),
                        size = Size(size.width - stroke, size.height - stroke),
                        cornerRadius = CornerRadius(t.radii.tile.toPx()),
                        style = Stroke(stroke, pathEffect = PathEffect.dashPathEffect(floatArrayOf(DASH_ON.toPx(), DASH_OFF.toPx()))),
                    )
                }
            }
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { this.contentDescription = contentDescription },
        contentAlignment = Alignment.Center,
    ) {
        if (firstOfEmpty) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(48.dp).background(t.colors.surface2, CircleShape), contentAlignment = Alignment.Center) {
                    Icon(AppIcons.Camera, contentDescription = null, tint = t.colors.primary, modifier = Modifier.size(22.dp))
                }
                Text(mainLabel.orEmpty(), style = t.type.captionStrong, color = t.colors.text, maxLines = 1)
            }
        } else {
            Box(Modifier.size(40.dp).background(t.colors.surface2, CircleShape), contentAlignment = Alignment.Center) {
                Icon(AppIcons.Plus, contentDescription = null, tint = t.colors.primary, modifier = Modifier.size(22.dp))
            }
        }
    }
}

/**
 * Where a portrait photo is cropped to a circle: the upper part, where the
 * face is, as the design frames every avatar.
 */
val AvatarFocus: Alignment = BiasAlignment(0f, -0.6f)

/**
 * A portrait in a large circle (about 100 dp and more, cropped at
 * [AvatarFocus]): drawn 30 % closer around a point a quarter down, so the
 * face fills more of the circle and stays in it whatever the framing (a
 * closer zoom loses the face of a photo taken from further away).
 */
fun Modifier.closerFace(): Modifier = graphicsLayer {
    scaleX = FACE_ZOOM
    scaleY = FACE_ZOOM
    transformOrigin = TransformOrigin(0.5f, FACE_ZOOM_ORIGIN_Y)
}

private const val FACE_ZOOM = 1.3f
private const val FACE_ZOOM_ORIGIN_Y = 0.25f

/** A 1.5 dp dashed edge as a browser draws it: dashes three times, gaps twice the line's width. */
private val DASH_ON = 4.5.dp
private val DASH_OFF = 3.dp

/**
 * The verified mark (`#vf`): the design's 12-bump seal in the verified
 * violet, 1.2 to 22.8 of its 24 box, with the check (2.4 wide) in
 * `--on-verified` (4.52:1); 16 / 20 / 24 / 26 / 28 dp. The same on a photo
 * and on the page. TalkBack reads it as «تأییدشده».
 */
@Composable
fun VerifiedBadge(size: Dp, modifier: Modifier = Modifier) {
    val label = stringResource(R.string.ui_verified)
    val template = AppTheme.template
    val fill = template.paints.verified
    val check = template.colors.onVerified
    Canvas(modifier.size(size).semantics { contentDescription = label }) {
        scale(this.size.minDimension / VERIFIED_BOX, pivot = Offset.Zero) {
            drawPath(VerifiedSeal, fill, style = Fill)
            drawPath(VerifiedCheck, check, style = Stroke(width = 2.4f, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}

private const val VERIFIED_BOX = 24f

/** `#vf`'s seal and check, in its 24 box. */
private val VerifiedSeal: Path by lazy {
    PathParser().parsePathString(
        "M10.81 2.16Q12.00 1.20 13.19 2.16Q14.38 3.11 15.89 2.88Q17.40 2.65 17.95 4.07Q18.51 5.49 19.93 6.05" +
            "Q21.35 6.60 21.12 8.11Q20.89 9.62 21.84 10.81Q22.80 12.00 21.84 13.19Q20.89 14.38 21.12 15.89" +
            "Q21.35 17.40 19.93 17.95Q18.51 18.51 17.95 19.93Q17.40 21.35 15.89 21.12Q14.38 20.89 13.19 21.84" +
            "Q12.00 22.80 10.81 21.84Q9.62 20.89 8.11 21.12Q6.60 21.35 6.05 19.93Q5.49 18.51 4.07 17.95" +
            "Q2.65 17.40 2.88 15.89Q3.11 14.38 2.16 13.19Q1.20 12.00 2.16 10.81Q3.11 9.62 2.88 8.11" +
            "Q2.65 6.60 4.07 6.05Q5.49 5.49 6.05 4.07Q6.60 2.65 8.11 2.88Q9.62 3.11 10.81 2.16Z",
    ).toPath()
}
private val VerifiedCheck: Path by lazy { PathParser().parsePathString("m8 12.2 2.8 2.8 5.4-5.6").toPath() }
