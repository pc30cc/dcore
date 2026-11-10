package app.core.feature.onboarding

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridItemInfo
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.toOffset
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.common.runCatchingUnlessCancelled
import app.core.R
import app.core.feature.auth.brandPlural
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.i18n.screenLanguage
import app.core.media.PhotoImage
import app.core.media.PhotoPrep
import app.core.model.Photo
import app.core.model.PhotoStatus
import app.core.ui.components.AddPhotoTile
import app.core.ui.components.PhotoTile
import app.core.ui.components.PrimaryButton
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * The photos: up to the catalogue's maximum, at least its minimum, picked
 * with the system photo picker (no storage permission), framed, compressed
 * and uploaded while the person carries on choosing. Three columns of 3:4
 * tiles 10 dp apart: the first slot of an empty grid is the main one
 * (camera, «عکس اصلی»); a photo has its remove button, the first one the
 * «اصلی» tag, one the server is still deciding on «در حال بررسی». Long-press
 * and drag to reorder (TalkBack: the tile's actions); the first is the main
 * photo. Six slots show until they are filled, then the rest up to the maximum.
 */
@Composable
fun PhotosStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val photos by model.photos.state.collectAsStateWithLifecycle()
    val language = screenLanguage()
    var failedToOpen by remember { mutableStateOf(false) }

    PhotoPicking(model.photos, onOpenFailed = { failedToOpen = it }) { pick ->
        val rejected = photos.uploaded.firstOrNull { it.status == PhotoStatus.Rejected }
        OnboardingPage(
            chrome = chrome,
            title = brandString(R.string.onboarding_photos_title),
            subtitle = brandString(R.string.onboarding_photos_min, Numerals.format(photos.min, language)),
            error = when {
                failedToOpen -> brandString(R.string.onboarding_photos_open_failed)
                else -> photosErrorText(photos, rejected) ?: stepErrorText(state.error)
            },
            actions = {
                if (photos.tiles.isEmpty()) {
                    PrimaryButton(brandString(R.string.onboarding_photos_choose), pick, enabled = photos.free > 0)
                } else {
                    PrimaryButton(
                        brandString(R.string.onboarding_continue),
                        model::submitPhotos,
                        enabled = photos.enough,
                        loading = state.busy || photos.uploading,
                    )
                }
            },
        ) {
            Gap(OnboardingLayout.gridTop)
            PhotoGridView(
                photos = photos,
                onAdd = pick,
                onRetry = model.photos::retry,
                onMove = model.photos::move,
                onRemove = model.photos::remove,
            )
        }
    }
}

/** What the photo grid has to say: the minimum kept, the network, too many, a failed upload, a refused photo; null when nothing. */
@Composable
internal fun photosErrorText(photos: PhotosState, rejected: app.core.model.OwnPhoto? = photos.uploaded.firstOrNull { it.status == PhotoStatus.Rejected }): String? = when {
    photos.keepMinimum -> brandPlural(R.plurals.onboarding_photos_keep_min, photos.min, photos.min)
    photos.error == UploadError.Offline -> brandString(R.string.error_offline)
    photos.error == UploadError.TooMany -> brandPlural(R.plurals.onboarding_photos_too_many, photos.max, photos.max)
    photos.error == UploadError.Failed -> brandString(R.string.onboarding_photos_failed)
    rejected != null -> rejected.rejectReason?.takeIf { it.isNotBlank() } ?: brandString(R.string.photo_rejected)
    else -> null
}

/**
 * Picking and framing new photos for [controller]: [content] gets the
 * function that opens the system photo picker (several at once while there
 * is room, no storage permission); each picked picture is then framed in
 * turn ([PhotoCropDialog]), compressed and handed to the controller, which
 * uploads it while the next is framed. [onOpenFailed] says whether the last
 * picture could not be opened.
 */
@Composable
internal fun PhotoPicking(
    controller: PhotosController,
    onOpenFailed: (Boolean) -> Unit,
    /** Prepares a framed picture and adds it; the editor runs this where leaving the screen cannot cancel it. */
    add: suspend (prepare: suspend () -> ByteArray?) -> Boolean = { prepare -> prepare()?.let(controller::add) ?: false },
    content: @Composable (pick: () -> Unit) -> Unit,
) {
    val photos by controller.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prep = remember { PhotoPrep(context.applicationContext) }

    // Picked pictures waiting to be framed, one after the other.
    val queue = rememberSaveable(saver = uriListSaver) { mutableStateListOf<Uri>() }
    var queued by rememberSaveable { mutableIntStateOf(0) }
    var preparing by remember { mutableStateOf(false) }

    val pickMany = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(maxItems = MAX_PICK)) { uris ->
        val room = controller.state.value.free - queue.size
        queue.addAll(uris.take(room.coerceAtLeast(0)))
        queued = queue.size
    }
    val pickOne = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            queue.add(uri)
            queued += 1
        }
    }
    val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
    val pick = {
        val room = photos.free - queue.size
        if (room > 1) pickMany.launch(request) else if (room == 1) pickOne.launch(request)
    }

    content(pick)

    // Framing the next picked picture. Keyed by the picture, so a frame never shows the one before it.
    val next = queue.firstOrNull()
    if (next != null) {
        key(next) {
            val loaded by produceState<Bitmap?>(null) {
                value = runCatching { prep.load(next) }.getOrNull()
                if (value == null) {
                    onOpenFailed(true)
                    queue.remove(next)
                }
            }
            // Quarter turns asked for, kept across a configuration change; the turned picture is made from them
            // (the one shown stays until the next is ready).
            var turns by rememberSaveable { mutableIntStateOf(0) }
            val current by produceState<Bitmap?>(null, loaded, turns) {
                val base = loaded ?: return@produceState
                value = if (turns % QUARTERS == 0) base else withContext(Dispatchers.Default) { rotateLeft(base, turns) }
            }
            val shown = current
            if (shown != null && !preparing) {
                PhotoCropDialog(
                    bitmap = shown,
                    index = (queued - queue.size).coerceAtLeast(0),
                    total = queued,
                    onUse = { frame ->
                        preparing = true
                        onOpenFailed(false)
                        scope.launch {
                            var opened = true
                            add {
                                runCatchingUnlessCancelled { prep.prepare(shown, frame).bytes }.getOrNull().also { if (it == null) opened = false }
                            }
                            if (!opened) onOpenFailed(true)
                            queue.remove(next)
                            preparing = false
                        }
                    },
                    onRotate = { turns = (turns + 1) % QUARTERS },
                    onAnother = {
                        // This one goes; another is picked in its place.
                        queue.remove(next)
                        queued -= 1
                        if (photos.free - queue.size > 0) pickOne.launch(request)
                    },
                    // Close and back drop this picture only; the next one picked comes up («۲ از ۳»).
                    onClose = { queue.remove(next) },
                )
            }
        }
    } else if (queued != 0) {
        queued = 0
    }
}

/** [quarters] quarter turns to the left (the crop's rotate). */
private fun rotateLeft(bitmap: Bitmap, quarters: Int): Bitmap =
    Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(-QUARTER_DEGREES * quarters) }, true)

private const val QUARTERS = 4
private const val QUARTER_DEGREES = 90f

private const val MAX_PICK = 9

/** Slots in sight before they fill: two rows of three. */
private const val SLOTS_SHOWN = 6
private const val COLUMNS = 3

private val uriListSaver = androidx.compose.runtime.saveable.listSaver<androidx.compose.runtime.snapshots.SnapshotStateList<Uri>, String>(
    save = { list -> list.map { it.toString() } },
    restore = { saved -> mutableStateListOf<Uri>().apply { addAll(saved.map(Uri::parse)) } },
)

/**
 * The grid: the server's photos first (draggable), the uploads in flight,
 * then empty slots: six in all until those fill, then a row more at a
 * time up to the maximum (the editor's header still counts the maximum).
 */
@Composable
internal fun PhotoGridView(
    photos: PhotosState,
    onAdd: () -> Unit,
    onRetry: (String) -> Unit,
    onMove: (Int, Int) -> Unit,
    onRemove: (String) -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val reduced = LocalReducedMotion.current
    val gridState = rememberLazyGridState()
    // While a drag is on, the order on screen; the controller's on drop.
    val order = remember { mutableStateListOf<String>() }
    var dragging by remember { mutableStateOf<String?>(null) }
    var dragStartIndex by remember { mutableIntStateOf(-1) }
    var dragOrigin by remember { mutableStateOf(Offset.Zero) }
    var dragDelta by remember { mutableStateOf(Offset.Zero) }

    val uploadedKeys = photos.uploaded.map { "p:${it.id}" }
    // The drag handler outlives recompositions: it reads the latest keys and callbacks through these.
    val latestKeys by rememberUpdatedState(uploadedKeys)
    val latestBusy by rememberUpdatedState(photos.busy)
    val latestOnMove by rememberUpdatedState(onMove)
    LaunchedEffect(uploadedKeys) { if (dragging == null) { order.clear(); order.addAll(uploadedKeys) } }
    val shownUploaded = if (dragging != null && order.toSet() == uploadedKeys.toSet()) order.toList() else uploadedKeys
    val byKey = photos.tiles.associateBy { it.key }
    val others = photos.tiles.filter { it !is PhotoTile.Uploaded }
    val filled = shownUploaded.mapNotNull { byKey[it] } + others
    val slots = minOf(photos.max, maxOf(SLOTS_SHOWN, (filled.size + 1 + COLUMNS - 1) / COLUMNS * COLUMNS)).coerceAtLeast(filled.size)
    val tiles: List<PhotoTile?> = filled + List(slots - filled.size) { null }
    val addLabel = brandString(R.string.onboarding_photos_add)
    val mainLabel = brandString(R.string.onboarding_photos_main)
    val mainTag = brandString(R.string.photo_main)

    fun itemAt(offset: Offset): LazyGridItemInfo? = gridState.layoutInfo.visibleItemsInfo.firstOrNull { info ->
        val x = offset.x - info.offset.x
        val y = offset.y - info.offset.y
        x >= 0 && y >= 0 && x <= info.size.width && y <= info.size.height
    }

    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val gap = OnboardingLayout.tileGap
        val tileWidth = (maxWidth - gap * (COLUMNS - 1)) / COLUMNS
        val rows = (tiles.size + COLUMNS - 1) / COLUMNS
        val height = tileWidth * TILE_HEIGHT * rows + gap * (rows - 1)
        LazyVerticalGrid(
            columns = GridCells.Fixed(COLUMNS),
            state = gridState,
            userScrollEnabled = false,
            horizontalArrangement = Arrangement.spacedBy(gap),
            verticalArrangement = Arrangement.spacedBy(gap),
            contentPadding = PaddingValues(0.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(height)
                .pointerInput(photos.uploaded.size) {
                    detectDragGesturesAfterLongPress(
                        onDragStart = { at ->
                            val info = itemAt(at) ?: return@detectDragGesturesAfterLongPress
                            val key = info.key as? String ?: return@detectDragGesturesAfterLongPress
                            if (key !in latestKeys || latestBusy) return@detectDragGesturesAfterLongPress
                            order.clear()
                            order.addAll(latestKeys)
                            dragging = key
                            dragStartIndex = info.index
                            dragOrigin = info.offset.toOffset()
                            dragDelta = Offset.Zero
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        },
                        onDrag = { change, amount ->
                            val key = dragging ?: return@detectDragGesturesAfterLongPress
                            change.consume()
                            dragDelta += amount
                            val current = gridState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == key } ?: return@detectDragGesturesAfterLongPress
                            val centre = dragOrigin + dragDelta + Offset(current.size.width / 2f, current.size.height / 2f)
                            val target = itemAt(centre) ?: return@detectDragGesturesAfterLongPress
                            val targetKey = target.key as? String ?: return@detectDragGesturesAfterLongPress
                            if (targetKey != key && targetKey in order) {
                                val from = order.indexOf(key)
                                val to = order.indexOf(targetKey)
                                order.add(to, order.removeAt(from))
                                haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                            }
                        },
                        onDragEnd = {
                            val key = dragging
                            val to = key?.let { order.indexOf(it) } ?: -1
                            if (key != null && to >= 0 && dragStartIndex >= 0 && to != dragStartIndex) latestOnMove(dragStartIndex, to)
                            dragging = null
                            dragDelta = Offset.Zero
                        },
                        onDragCancel = {
                            dragging = null
                            dragDelta = Offset.Zero
                            order.clear()
                            order.addAll(latestKeys)
                        },
                    )
                },
        ) {
            itemsIndexed(tiles, key = { index, tile -> tile?.key ?: "empty:$index" }) { index, tile ->
                val isDragged = tile != null && tile.key == dragging
                val uploadedIndex = shownUploaded.indexOf(tile?.key)
                Box(
                    Modifier
                        .then(if (reduced || isDragged) Modifier else Modifier.animateItem())
                        .zIndex(if (isDragged) 1f else 0f)
                        .graphicsLayer {
                            // Read while drawing, not composing: the grid's layout changes every frame of a drag.
                            val lift = if (isDragged) {
                                val current = gridState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == tile?.key }
                                dragOrigin + dragDelta - (current?.offset?.toOffset() ?: dragOrigin)
                            } else {
                                Offset.Zero
                            }
                            translationX = lift.x
                            translationY = lift.y
                            val s = if (isDragged) DRAG_SCALE else 1f
                            scaleX = s
                            scaleY = s
                            shadowElevation = if (isDragged) DRAG_ELEVATION else 0f
                        },
                ) {
                    when (tile) {
                        null -> {
                            val main = index == 0 && filled.isEmpty()
                            AddPhotoTile(onAdd, addLabel, Modifier.fillMaxWidth(), main = main, mainLabel = if (main) mainLabel else null)
                        }
                        is PhotoTile.Uploaded -> UploadedTile(
                            tile = tile,
                            index = uploadedIndex,
                            count = shownUploaded.size,
                            mainTag = mainTag,
                            onMove = onMove,
                            onRemove = { onRemove(tile.key) },
                        )
                        is PhotoTile.Uploading -> UploadingTile(tile, onRemove = { onRemove(tile.key) })
                        is PhotoTile.Failed -> FailedTile(tile, onRetry = { onRetry(tile.key) }, onRemove = { onRemove(tile.key) })
                    }
                }
            }
        }
    }
}

/** Tiles are 3:4: their height per unit of width. */
private const val TILE_HEIGHT = 4f / 3f
private const val DRAG_SCALE = 1.06f
private const val DRAG_ELEVATION = 16f
private const val UPLOADING_ALPHA = 0.55f
private const val FAILED_ALPHA = 0.4f

@Composable
private fun UploadedTile(tile: PhotoTile.Uploaded, index: Int, count: Int, mainTag: String, onMove: (Int, Int) -> Unit, onRemove: () -> Unit) {
    val photo = tile.photo
    val statusText = when (photo.status) {
        PhotoStatus.Processing, PhotoStatus.Review -> brandString(R.string.photo_status_review)
        PhotoStatus.Rejected -> brandString(R.string.photo_status_rejected)
        else -> null
    }
    val description = buildString {
        append(brandString(R.string.photo_position, index + 1, count))
        if (index == 0) append(", ").append(mainTag)
        append(", ").append(statusText ?: brandString(R.string.photo_status_approved))
        photo.rejectReason?.takeIf { photo.status == PhotoStatus.Rejected }?.let { append(": ").append(it) }
    }
    val makeMain = brandString(R.string.photo_make_main)
    val earlier = brandString(R.string.photo_move_earlier)
    val later = brandString(R.string.photo_move_later)
    val remove = brandString(R.string.ui_remove_photo)
    PhotoTile(
        modifier = Modifier.fillMaxWidth().semantics {
            contentDescription = description
            customActions = buildList {
                if (index > 0) {
                    add(CustomAccessibilityAction(makeMain) { onMove(index, 0); true })
                    add(CustomAccessibilityAction(earlier) { onMove(index, index - 1); true })
                }
                if (index in 0 until count - 1) add(CustomAccessibilityAction(later) { onMove(index, index + 1); true })
                add(CustomAccessibilityAction(remove) { onRemove(); true })
            }
        },
        mainTag = if (index == 0) mainTag else null,
        status = statusText,
        onRemove = onRemove,
        error = photo.status == PhotoStatus.Rejected,
    ) {
        OwnPhotoImage(file = tile.preview, photo = photo)
    }
}

@Composable
private fun UploadingTile(tile: PhotoTile.Uploading, onRemove: () -> Unit) {
    val t = AppTheme.template
    val label = brandString(R.string.photo_uploading)
    PhotoTile(Modifier.fillMaxWidth().semantics { contentDescription = label }, onRemove = onRemove) {
        LocalPreview(tile.preview, Modifier.fillMaxSize().graphicsLayer { alpha = UPLOADING_ALPHA })
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            val track = t.colors.onPhoto.copy(alpha = SPINNER_TRACK)
            if (tile.progress in 0.001f..0.999f) {
                CircularProgressIndicator(progress = { tile.progress }, color = t.colors.onPhoto, trackColor = track, strokeWidth = SpinnerSize.stroke, modifier = Modifier.size(SpinnerSize.disc))
            } else {
                CircularProgressIndicator(color = t.colors.onPhoto, trackColor = track, strokeWidth = SpinnerSize.stroke, modifier = Modifier.size(SpinnerSize.disc))
            }
        }
    }
}

private const val SPINNER_TRACK = 0.3f

private object SpinnerSize {
    val disc = 28.dp
    val stroke = 2.5.dp
}

/** An upload that failed: the picture faded in a red edge; a tap sends it again. */
@Composable
private fun FailedTile(tile: PhotoTile.Failed, onRetry: () -> Unit, onRemove: () -> Unit) {
    val label = brandString(R.string.photo_upload_failed)
    val retry = brandString(R.string.action_try_again)
    PhotoTile(
        Modifier.fillMaxWidth().semantics {
            contentDescription = label
            role = Role.Button
            customActions = listOf(CustomAccessibilityAction(retry) { onRetry(); true })
        },
        onRemove = onRemove,
        error = true,
    ) {
        LocalPreview(tile.preview, Modifier.fillMaxSize().graphicsLayer { alpha = FAILED_ALPHA }.clickable(onClickLabel = retry, onClick = onRetry))
    }
}

/** The picture of one of the account's photos: the copy this phone uploaded, else the server's once it has a URL. */
@Composable
private fun OwnPhotoImage(file: File?, photo: app.core.model.OwnPhoto) {
    if (file != null) {
        LocalPreview(file, Modifier.fillMaxSize())
    } else {
        PhotoImage(
            photo = Photo(photo.id, photo.w, photo.h, photo.blurhash, photo.url.orEmpty()),
            contentDescription = null,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

/** A local JPEG, decoded small off the main thread. */
@Composable
internal fun LocalPreview(file: File?, modifier: Modifier) {
    val image by produceState<ImageBitmap?>(null, file) {
        value = file?.let { f ->
            withContext(Dispatchers.IO) {
                runCatching {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(f.path, bounds)
                    val sample = PhotoPrep.sampleSize(bounds.outWidth, bounds.outHeight, PREVIEW_SIDE)
                    BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
                }.getOrNull()
            }
        }
    }
    val current = image
    if (current != null) {
        Image(current, contentDescription = null, contentScale = ContentScale.Crop, modifier = modifier)
    } else {
        Box(modifier.background(AppTheme.template.colors.photoPlaceholder))
    }
}

private const val PREVIEW_SIDE = 480
