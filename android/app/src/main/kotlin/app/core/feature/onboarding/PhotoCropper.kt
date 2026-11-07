package app.core.feature.onboarding

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.core.R
import app.core.feature.auth.PrimaryButton
import app.core.i18n.brandString
import app.core.media.CropFrame
import app.core.media.PhotoPrep
import app.core.ui.theme.Space
import kotlin.math.roundToInt

/**
 * Framing a picked photo before it is uploaded: the profile's 4:5 window,
 * the picture under it moved with a finger and zoomed with two (or the
 * slider, which TalkBack can use), a double tap back to the whole picture.
 * "Use photo" with no gesture keeps the centred crop.
 */
@Composable
fun PhotoCropDialog(
    bitmap: Bitmap,
    index: Int,
    total: Int,
    onUse: (CropFrame) -> Unit,
    onSkip: () -> Unit,
) {
    val image = remember(bitmap) { bitmap.asImageBitmap() }
    var zoom by remember(bitmap) { mutableFloatStateOf(1f) }
    var dx by remember(bitmap) { mutableFloatStateOf(0f) }
    var dy by remember(bitmap) { mutableFloatStateOf(0f) }
    // The window's size in pixels, as last laid out: what "Use photo" crops against.
    var windowW by remember { mutableFloatStateOf(0f) }
    var windowH by remember { mutableFloatStateOf(0f) }
    val density = LocalDensity.current

    Dialog(onDismissRequest = onSkip, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
                .safeDrawingPadding()
                .padding(Space.gutter),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onSkip) { Text(brandString(R.string.action_cancel), color = Color.White) }
                Text(
                    if (total > 1) brandString(R.string.onboarding_crop_title_many, index + 1, total) else brandString(R.string.onboarding_crop_title),
                    color = Color.White,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
            }
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                val frameWidthDp = minOf(maxWidth, maxHeight * PhotoPrep.ASPECT)
                val frameW = with(density) { frameWidthDp.toPx() }
                val frameH = frameW / PhotoPrep.ASPECT
                SideEffect {
                    windowW = frameW
                    windowH = frameH
                    // The slider may have zoomed out under an offset that no longer fits.
                    val (maxX, maxY) = CropFrame.maxOffset(bitmap.width, bitmap.height, frameW, frameH, zoom)
                    dx = dx.coerceIn(-maxX, maxX)
                    dy = dy.coerceIn(-maxY, maxY)
                }
                val cover = maxOf(frameW / bitmap.width, frameH / bitmap.height) * zoom
                val label = brandString(R.string.onboarding_crop_area)
                Box(
                    Modifier
                        .size(frameWidthDp, frameWidthDp / PhotoPrep.ASPECT)
                        .clipToBounds()
                        .semantics { contentDescription = label }
                        .pointerInput(bitmap) {
                            detectTapGestures(onDoubleTap = {
                                zoom = 1f
                                dx = 0f
                                dy = 0f
                            })
                        }
                        .pointerInput(bitmap) {
                            detectTransformGestures { _, pan, gestureZoom, _ ->
                                zoom = (zoom * gestureZoom).coerceIn(1f, MAX_ZOOM)
                                val (mx, my) = CropFrame.maxOffset(bitmap.width, bitmap.height, frameW, frameH, zoom)
                                dx = (dx + pan.x).coerceIn(-mx, mx)
                                dy = (dy + pan.y).coerceIn(-my, my)
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    val shownW = with(density) { (bitmap.width * cover).toDp() }
                    val shownH = with(density) { (bitmap.height * cover).toDp() }
                    Image(
                        bitmap = image,
                        contentDescription = null,
                        contentScale = ContentScale.FillBounds,
                        modifier = Modifier
                            .requiredSize(shownW, shownH)
                            .graphicsLayer {
                                translationX = dx
                                translationY = dy
                            },
                    )
                    // Thirds, to place the face.
                    Canvas(Modifier.fillMaxSize()) {
                        val line = Color.White.copy(alpha = 0.35f)
                        for (i in 1..2) {
                            drawLine(line, Offset(size.width * i / 3, 0f), Offset(size.width * i / 3, size.height), strokeWidth = 1.dp.toPx())
                            drawLine(line, Offset(0f, size.height * i / 3), Offset(size.width, size.height * i / 3), strokeWidth = 1.dp.toPx())
                        }
                        drawRect(Color.White, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.dp.toPx()))
                    }
                }
            }
            val zoomLabel = brandString(R.string.onboarding_crop_zoom)
            Slider(
                value = zoom,
                onValueChange = { zoom = it },
                valueRange = 1f..MAX_ZOOM,
                modifier = Modifier.fillMaxWidth().semantics {
                    contentDescription = zoomLabel
                    stateDescription = "${(zoom * 100).roundToInt()}%"
                },
            )
            Text(brandString(R.string.onboarding_crop_hint), color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.bodySmall)
            PrimaryButton(brandString(R.string.onboarding_crop_use), onClick = {
                val frame = if (windowW > 0f && windowH > 0f) {
                    CropFrame.forView(bitmap.width, bitmap.height, windowW, windowH, zoom, dx, dy)
                } else {
                    CropFrame.centred(bitmap.width, bitmap.height, PhotoPrep.ASPECT)
                }
                onUse(frame)
            })
        }
    }
}

private const val MAX_ZOOM = 4f
