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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import app.core.R
import app.core.feature.auth.authDock
import app.core.feature.auth.authSideInsets
import app.core.feature.auth.authTopInsets
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.i18n.screenLanguage
import app.core.media.CropFrame
import app.core.media.PhotoPrep
import app.core.ui.components.AppIconButton
import app.core.ui.components.AppSlider
import app.core.ui.components.PrimaryButton
import app.core.ui.components.SecondaryButton
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.DialogBarIcons
import app.core.ui.theme.Scheme
import app.core.ui.theme.ShadowLayer
import app.core.ui.theme.Space
import app.core.ui.theme.insetShadow
import kotlin.math.roundToInt

/**
 * Framing a picked photo before it is uploaded, on the page (`--bg`): close
 * at the start of the top row, «قاب عکس» with «۱ از ۳» in the middle,
 * rotate at the end; the 3:4 window (`--r-tile`, a 2 dp `--crop-line`
 * edge, thirds) over the picture, moved with a finger and zoomed with two
 * or the slider (which TalkBack can use), a double tap back to the whole
 * picture; then «یکی دیگه» (pick another instead) and «انتخاب». «انتخاب»
 * with no gesture keeps the centred crop.
 */
@Composable
fun PhotoCropDialog(
    bitmap: Bitmap,
    index: Int,
    total: Int,
    onUse: (CropFrame) -> Unit,
    onRotate: () -> Unit,
    onAnother: () -> Unit,
    onClose: () -> Unit,
) {
    val t = AppTheme.template
    val language = screenLanguage()
    val image = remember(bitmap) { bitmap.asImageBitmap() }
    // Kept across a configuration change. The offset is a share of the window's width and height, so it frames
    // the same part of the picture in a window of another size.
    var zoom by rememberSaveable(bitmap) { mutableFloatStateOf(1f) }
    var panX by rememberSaveable(bitmap) { mutableFloatStateOf(0f) }
    var panY by rememberSaveable(bitmap) { mutableFloatStateOf(0f) }
    // The window's size in pixels, as last laid out: what «انتخاب» crops against.
    var windowW by remember { mutableFloatStateOf(0f) }
    var windowH by remember { mutableFloatStateOf(0f) }
    val density = LocalDensity.current

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        DialogBarIcons()
        Column(Modifier.fillMaxSize().background(t.colors.bg).authTopInsets().authSideInsets()) {
            Row(Modifier.fillMaxWidth().height(CropLayout.topRow).padding(horizontal = CropLayout.rowInset), verticalAlignment = Alignment.CenterVertically) {
                AppIconButton(AppIcons.Close, brandString(R.string.action_close), onClose)
                Row(Modifier.weight(1f), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    Text(brandString(R.string.onboarding_crop_title), style = t.type.h3, color = t.colors.text, maxLines = 1)
                    if (total > 1) {
                        Text(
                            brandString(R.string.onboarding_crop_count, Numerals.format(index + 1, language), Numerals.format(total, language)),
                            style = t.type.bodySm,
                            color = t.colors.text3,
                            maxLines = 1,
                            modifier = Modifier.padding(start = CropLayout.countGap),
                        )
                    }
                }
                AppIconButton(AppIcons.Rotate, brandString(R.string.onboarding_crop_rotate), onRotate)
            }
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                // The window: 32 dp from the sides on the design's phone, smaller when the screen is short.
                val room = maxHeight - CropLayout.frameTop - CropLayout.sliderTop - CropLayout.slider - CropLayout.below
                val frameWidthDp = minOf(maxWidth - CropLayout.frameInset * 2, room * PhotoPrep.ASPECT)
                val frameHeightDp = frameWidthDp / PhotoPrep.ASPECT
                val frameW = with(density) { frameWidthDp.toPx() }
                val frameH = with(density) { frameHeightDp.toPx() }
                SideEffect {
                    windowW = frameW
                    windowH = frameH
                    // The slider may have zoomed out under an offset that no longer fits.
                    val (maxX, maxY) = CropFrame.maxOffset(bitmap.width, bitmap.height, frameW, frameH, zoom)
                    if (frameW > 0f && frameH > 0f) {
                        panX = (panX * frameW).coerceIn(-maxX, maxX) / frameW
                        panY = (panY * frameH).coerceIn(-maxY, maxY) / frameH
                    }
                }
                val cover = maxOf(frameW / bitmap.width, frameH / bitmap.height) * zoom
                val label = brandString(R.string.onboarding_crop_area)
                val shape = RoundedCornerShape(t.radii.tile)
                Column(Modifier.fillMaxWidth().padding(top = CropLayout.frameTop), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(
                        Modifier
                            .size(frameWidthDp, frameHeightDp)
                            .clip(shape)
                            .background(t.colors.photoPlaceholder)
                            .semantics { contentDescription = label }
                            .pointerInput(bitmap) {
                                detectTapGestures(onDoubleTap = {
                                    zoom = 1f
                                    panX = 0f
                                    panY = 0f
                                })
                            }
                            .pointerInput(bitmap, frameW, frameH) {
                                detectTransformGestures { _, pan, gestureZoom, _ ->
                                    zoom = (zoom * gestureZoom).coerceIn(1f, MAX_ZOOM)
                                    val (mx, my) = CropFrame.maxOffset(bitmap.width, bitmap.height, frameW, frameH, zoom)
                                    if (frameW > 0f && frameH > 0f) {
                                        panX = (panX * frameW + pan.x).coerceIn(-mx, mx) / frameW
                                        panY = (panY * frameH + pan.y).coerceIn(-my, my) / frameH
                                    }
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
                                    translationX = panX * frameW
                                    translationY = panY * frameH
                                },
                        )
                        // Thirds, to place the face, and the window's edge.
                        Canvas(Modifier.fillMaxSize()) {
                            val line = t.colors.onPhoto.copy(alpha = GRID_ALPHA)
                            val stroke = CropLayout.grid.toPx()
                            for (i in 1..2) {
                                drawLine(line, Offset(size.width * i / 3, 0f), Offset(size.width * i / 3, size.height), strokeWidth = stroke)
                                drawLine(line, Offset(0f, size.height * i / 3), Offset(size.width, size.height * i / 3), strokeWidth = stroke)
                            }
                        }
                        Box(Modifier.fillMaxSize().insetShadow(shape, listOf(cropEdge(t.colors.cropLine))))
                    }
                    val zoomLabel = brandString(R.string.onboarding_crop_zoom)
                    AppSlider(
                        value = zoom,
                        onValueChange = { zoom = it },
                        valueRange = 1f..MAX_ZOOM,
                        modifier = Modifier
                            .padding(top = CropLayout.sliderTop)
                            .width(frameWidthDp - CropLayout.sliderInset * 2)
                            .semantics {
                                contentDescription = zoomLabel
                                stateDescription = Numerals.percent((zoom * 100).roundToInt(), language)
                            },
                    )
                }
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Space.gutter).authDock(CropLayout.dockBottom),
                horizontalArrangement = Arrangement.spacedBy(OnboardingLayout.buttonGap),
            ) {
                SecondaryButton(brandString(R.string.onboarding_crop_another), onAnother, Modifier.weight(1f))
                PrimaryButton(brandString(R.string.onboarding_crop_use), onClick = {
                    val frame = if (windowW > 0f && windowH > 0f) {
                        CropFrame.forView(bitmap.width, bitmap.height, windowW, windowH, zoom, panX * windowW, panY * windowH)
                    } else {
                        CropFrame.centred(bitmap.width, bitmap.height, PhotoPrep.ASPECT)
                    }
                    onUse(frame)
                }, modifier = Modifier.weight(1f))
            }
        }
    }
}

/** The window's 2 dp edge, drawn inside it. */
private fun cropEdge(color: androidx.compose.ui.graphics.Color) =
    ShadowLayer(x = 0.dp, y = 0.dp, blur = 0.dp, spread = CropLayout.edge, color = color, inset = true)

private const val MAX_ZOOM = 4f
private const val GRID_ALPHA = 0.35f

/** The crop page on the design's phone (dp below the 56 dp top row). */
private object CropLayout {
    val topRow = 56.dp
    val rowInset = 6.dp
    val countGap = 6.dp
    val frameTop = 24.dp
    val frameInset = 32.dp
    /** The slider's 48 dp target starts 26 dp under the window, so its track sits where the design draws it. */
    val sliderTop = 26.dp
    val slider = 48.dp
    val sliderInset = 12.dp
    /** The buttons and the room above them. */
    val below = 56.dp
    val dockBottom = 30.dp
    val grid = 1.dp
    val edge = 2.dp
}
