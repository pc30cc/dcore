package app.core.feature.onboarding

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridItemInfo
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Face
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
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
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.toOffset
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.R
import app.core.feature.auth.screenLanguage
import app.core.feature.auth.InlineMessage
import app.core.feature.auth.NoteCard
import app.core.feature.auth.PrimaryButton
import app.core.feature.auth.brandPlural
import app.core.i18n.Digits
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.media.PhotoPrep
import app.core.model.Photo
import app.core.model.PhotoStatus
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Radius
import app.core.ui.theme.Space
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * The photos: up to the catalogue's maximum, at least its minimum, picked
 * with the system photo picker (no storage permission), framed, compressed
 * and uploaded while the person carries on choosing. Long-press and drag to
 * reorder (TalkBack: the tile's actions); the first is the main photo.
 */
@Composable
fun PhotosStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val photos by model.photos.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prep = remember { PhotoPrep(context.applicationContext) }

    // Picked pictures waiting to be framed, one after the other.
    val queue = rememberSaveable(saver = uriListSaver) { mutableStateListOf<Uri>() }
    var queued by rememberSaveable { mutableIntStateOf(0) }
    var preparing by remember { mutableStateOf(false) }
    var failedToOpen by remember { mutableStateOf(false) }

    val pickMany = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(maxItems = MAX_PICK)) { uris ->
        val room = model.photos.state.value.free
        queue.addAll(uris.take(room))
        queued = queue.size
    }
    val pickOne = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            queue.add(uri)
            queued = queue.size
        }
    }
    val pick = {
        val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
        if (photos.free > 1) pickMany.launch(request) else if (photos.free == 1) pickOne.launch(request)
    }

    var selected by rememberSaveable { mutableStateOf<String?>(null) }

    OnboardingFrame(
        chrome = chrome,
        title = brandString(R.string.onboarding_photos_title),
        subtitle = brandString(R.string.onboarding_photos_body, photos.min),
        actions = {
            val language = screenLanguage()
            Text(
                Digits.localize(brandString(R.string.onboarding_photos_count, photos.usable.coerceAtMost(photos.max), photos.min), language),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            PrimaryButton(
                brandString(if (photos.uploading) R.string.onboarding_photos_wait else R.string.action_next),
                onClick = model::submitPhotos,
                enabled = photos.enough,
                busy = state.busy,
            )
        },
    ) {
        PhotoGridView(
            photos = photos,
            onAdd = pick,
            onOpen = { selected = it },
            onRetry = model.photos::retry,
            onMove = model.photos::move,
            onRemove = model.photos::remove,
        )
        InlineMessage(
            when {
                failedToOpen -> brandString(R.string.onboarding_photos_open_failed)
                photos.keepMinimum -> brandPlural(R.plurals.onboarding_photos_keep_min, photos.min, photos.min)
                photos.error == UploadError.Offline -> brandString(R.string.onboarding_photos_offline)
                photos.error == UploadError.TooMany -> brandPlural(R.plurals.onboarding_photos_too_many, photos.max, photos.max)
                photos.error == UploadError.Failed -> brandString(R.string.onboarding_photos_failed)
                else -> stepErrorText(state.error)
            },
        )
        NoteCard(icon = { Icon(Icons.Filled.Face, contentDescription = null, tint = MaterialTheme.colorScheme.primary) }) {
            Text(brandString(R.string.onboarding_photos_tips_title), style = MaterialTheme.typography.titleSmall)
            Text(brandString(R.string.onboarding_photos_tips), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }

    // Framing the next picked picture.
    val next = queue.firstOrNull()
    if (next != null) {
        val bitmap by produceState<Bitmap?>(null, next) {
            value = runCatching { prep.load(next) }.getOrNull()
            if (value == null) {
                failedToOpen = true
                queue.remove(next)
            }
        }
        val current = bitmap
        if (current != null && !preparing) {
            PhotoCropDialog(
                bitmap = current,
                index = (queued - queue.size).coerceAtLeast(0),
                total = queued,
                onUse = { frame ->
                    preparing = true
                    failedToOpen = false
                    scope.launch {
                        val prepared = runCatching { prep.prepare(current, frame) }.getOrNull()
                        if (prepared == null) failedToOpen = true else model.photos.add(prepared.bytes)
                        queue.remove(next)
                        preparing = false
                    }
                },
                onSkip = { queue.remove(next) },
            )
        }
    } else if (queued != 0) {
        queued = 0
    }

    val open = selected?.let { key -> photos.tiles.firstOrNull { it.key == key } }
    if (open != null) {
        PhotoSheet(
            tile = open,
            isMain = photos.uploaded.firstOrNull()?.let { "p:${it.id}" } == open.key,
            onMakeMain = {
                val index = photos.uploaded.indexOfFirst { "p:${it.id}" == open.key }
                if (index > 0) model.photos.move(index, 0)
                selected = null
            },
            onRemove = {
                model.photos.remove(open.key)
                selected = null
            },
            onRetry = {
                model.photos.retry(open.key)
                selected = null
            },
            onDismiss = { selected = null },
        )
    }
}

private const val MAX_PICK = 9

private val uriListSaver = androidx.compose.runtime.saveable.listSaver<androidx.compose.runtime.snapshots.SnapshotStateList<Uri>, String>(
    save = { list -> list.map { it.toString() } },
    restore = { saved -> mutableStateListOf<Uri>().apply { addAll(saved.map(Uri::parse)) } },
)

/**
 * The grid: the server's photos first (draggable), the uploads in flight,
 * then empty slots up to the maximum. Three columns, every tile 4:5.
 */
@Composable
private fun PhotoGridView(
    photos: PhotosState,
    onAdd: () -> Unit,
    onOpen: (String) -> Unit,
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
    val tiles: List<PhotoTile?> = shownUploaded.mapNotNull { byKey[it] } + others + List(photos.free) { null }

    fun itemAt(offset: Offset): LazyGridItemInfo? = gridState.layoutInfo.visibleItemsInfo.firstOrNull { info ->
        val x = offset.x - info.offset.x
        val y = offset.y - info.offset.y
        x >= 0 && y >= 0 && x <= info.size.width && y <= info.size.height
    }

    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val gap = Space.sm
        val tileWidth = (maxWidth - gap * 2) / 3
        val rows = (tiles.size + 2) / 3
        val height = tileWidth * 1.25f * rows + gap * (rows - 1)
        LazyVerticalGrid(
            columns = GridCells.Fixed(3),
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
                            val s = if (isDragged) 1.06f else 1f
                            scaleX = s
                            scaleY = s
                            shadowElevation = if (isDragged) 16f else 0f
                        },
                ) {
                    when (tile) {
                        null -> EmptyTile(primary = index == tiles.indexOfFirst { it == null }, onAdd = onAdd)
                        is PhotoTile.Uploaded -> UploadedTile(
                            tile = tile,
                            index = uploadedIndex,
                            count = shownUploaded.size,
                            onOpen = { onOpen(tile.key) },
                            onMove = onMove,
                            onRemove = { onRemove(tile.key) },
                        )
                        is PhotoTile.Uploading -> UploadingTile(tile)
                        is PhotoTile.Failed -> FailedTile(tile, onRetry = { onRetry(tile.key) }, onOpen = { onOpen(tile.key) })
                    }
                }
            }
        }
    }
}

@Composable
private fun TileFrame(modifier: Modifier = Modifier, border: BorderStroke? = null, content: @Composable BoxScope.() -> Unit) {
    Surface(
        modifier = modifier.fillMaxWidth().aspectRatio(0.8f),
        shape = RoundedCornerShape(Radius.lg),
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = border,
    ) { Box(Modifier.fillMaxSize()) { content() } }
}

@Composable
private fun EmptyTile(primary: Boolean, onAdd: () -> Unit) {
    val label = brandString(R.string.onboarding_photos_add)
    val colors = MaterialTheme.colorScheme
    Surface(
        onClick = onAdd,
        modifier = Modifier.fillMaxWidth().aspectRatio(0.8f).semantics { contentDescription = label },
        shape = RoundedCornerShape(Radius.lg),
        color = if (primary) colors.primaryContainer else colors.surfaceContainerLow,
        border = BorderStroke(1.dp, if (primary) colors.primary else colors.outlineVariant),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.Add, contentDescription = null, tint = if (primary) colors.onPrimaryContainer else colors.onSurfaceVariant, modifier = Modifier.size(32.dp))
        }
    }
}

@Composable
private fun UploadedTile(tile: PhotoTile.Uploaded, index: Int, count: Int, onOpen: () -> Unit, onMove: (Int, Int) -> Unit, onRemove: () -> Unit) {
    val photo = tile.photo
    val statusText = when (photo.status) {
        PhotoStatus.Processing -> brandString(R.string.photo_status_processing)
        PhotoStatus.Review -> brandString(R.string.photo_status_review)
        PhotoStatus.Rejected -> brandString(R.string.photo_status_rejected)
        else -> brandString(R.string.photo_status_approved)
    }
    val description = buildString {
        append(brandString(R.string.photo_position, index + 1, count))
        if (index == 0) append(", ").append(brandString(R.string.photo_main))
        append(", ").append(statusText)
        photo.rejectReason?.takeIf { photo.status == PhotoStatus.Rejected }?.let { append(": ").append(it) }
    }
    val makeMain = brandString(R.string.photo_make_main)
    val earlier = brandString(R.string.photo_move_earlier)
    val later = brandString(R.string.photo_move_later)
    val remove = brandString(R.string.photo_remove)
    TileFrame(
        modifier = Modifier.semantics {
            contentDescription = description
            role = Role.Button
            onClick { onOpen(); true }
            customActions = buildList {
                if (index > 0) {
                    add(CustomAccessibilityAction(makeMain) { onMove(index, 0); true })
                    add(CustomAccessibilityAction(earlier) { onMove(index, index - 1); true })
                }
                if (index in 0 until count - 1) add(CustomAccessibilityAction(later) { onMove(index, index + 1); true })
                add(CustomAccessibilityAction(remove) { onRemove(); true })
            }
        },
        border = if (photo.status == PhotoStatus.Rejected) BorderStroke(2.dp, AppTheme.colors.danger) else null,
    ) {
        Surface(onClick = onOpen, color = Color.Transparent, modifier = Modifier.fillMaxSize()) {
            OwnPhotoImage(file = tile.preview, photo = photo)
        }
        when (photo.status) {
            PhotoStatus.Processing, PhotoStatus.Review -> StatusChip(statusText, spinner = photo.status == PhotoStatus.Processing, Modifier.align(Alignment.BottomCenter))
            PhotoStatus.Rejected -> {
                Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)))
                Column(Modifier.align(Alignment.Center).padding(Space.sm), horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Filled.Warning, contentDescription = null, tint = Color.White)
                    Text(statusText, color = Color.White, style = MaterialTheme.typography.labelMedium, textAlign = TextAlign.Center)
                }
            }
            else -> Unit
        }
        if (index == 0) {
            Surface(
                color = MaterialTheme.colorScheme.primary,
                shape = RoundedCornerShape(Radius.pill),
                modifier = Modifier.align(Alignment.TopStart).padding(Space.xs),
            ) {
                Text(
                    brandString(R.string.photo_main),
                    color = MaterialTheme.colorScheme.onPrimary,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(horizontal = Space.sm, vertical = Space.xxs),
                )
            }
        }
    }
}

@Composable
private fun UploadingTile(tile: PhotoTile.Uploading) {
    val label = brandString(R.string.photo_uploading)
    TileFrame(Modifier.semantics { contentDescription = label }) {
        LocalPreview(tile.preview, Modifier.fillMaxSize().graphicsLayer { alpha = 0.55f })
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            if (tile.progress in 0.001f..0.999f) {
                CircularProgressIndicator(progress = { tile.progress }, modifier = Modifier.size(40.dp))
            } else {
                CircularProgressIndicator(Modifier.size(40.dp))
            }
        }
    }
}

@Composable
private fun FailedTile(tile: PhotoTile.Failed, onRetry: () -> Unit, onOpen: () -> Unit) {
    val label = brandString(R.string.photo_upload_failed)
    val retry = brandString(R.string.action_try_again)
    TileFrame(
        Modifier.semantics {
            contentDescription = label
            customActions = listOf(CustomAccessibilityAction(retry) { onRetry(); true })
        },
        border = BorderStroke(2.dp, AppTheme.colors.danger),
    ) {
        Surface(onClick = onOpen, color = Color.Transparent, modifier = Modifier.fillMaxSize()) {
            LocalPreview(tile.preview, Modifier.fillMaxSize().graphicsLayer { alpha = 0.4f })
        }
        Surface(
            onClick = onRetry,
            shape = RoundedCornerShape(Radius.pill),
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier.align(Alignment.Center),
        ) {
            Row(Modifier.padding(horizontal = Space.md, vertical = Space.sm), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(retry, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = Space.xs))
            }
        }
    }
}

@Composable
private fun StatusChip(text: String, spinner: Boolean, modifier: Modifier) {
    Surface(
        color = Color.Black.copy(alpha = 0.6f),
        shape = RoundedCornerShape(Radius.pill),
        modifier = modifier.padding(Space.xs),
    ) {
        Row(Modifier.padding(horizontal = Space.sm, vertical = Space.xxs), verticalAlignment = Alignment.CenterVertically) {
            if (spinner) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = Color.White)
            Text(text, color = Color.White, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = Space.xs))
        }
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
private fun LocalPreview(file: File?, modifier: Modifier) {
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
        Image(current, contentDescription = null, contentScale = ContentScale.Crop, modifier = modifier.clip(RoundedCornerShape(Radius.lg)))
    } else {
        Box(modifier.background(MaterialTheme.colorScheme.surfaceContainerHighest))
    }
}

private const val PREVIEW_SIDE = 480

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PhotoSheet(tile: PhotoTile, isMain: Boolean, onMakeMain: () -> Unit, onRemove: () -> Unit, onRetry: () -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = Space.xl)) {
            val rejected = (tile as? PhotoTile.Uploaded)?.photo?.takeIf { it.status == PhotoStatus.Rejected }
            if (rejected != null) {
                NoteCard(Modifier.padding(horizontal = Space.gutter, vertical = Space.sm)) {
                    Text(brandString(R.string.photo_rejected_title), style = MaterialTheme.typography.titleSmall, color = AppTheme.colors.danger)
                    Text(
                        rejected.rejectReason?.takeIf { it.isNotBlank() } ?: brandString(R.string.photo_rejected_generic),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            if (tile is PhotoTile.Uploaded && !isMain && tile.photo.status != PhotoStatus.Rejected) {
                ListItem(headlineContent = { Text(brandString(R.string.photo_make_main)) }, modifier = Modifier.clickableRow(onMakeMain))
            }
            if (tile is PhotoTile.Failed) {
                ListItem(headlineContent = { Text(brandString(R.string.action_try_again)) }, modifier = Modifier.clickableRow(onRetry))
            }
            ListItem(
                headlineContent = { Text(brandString(if (rejected != null) R.string.photo_replace else R.string.photo_remove), color = AppTheme.colors.danger) },
                modifier = Modifier.clickableRow(onRemove),
            )
        }
    }
}

private fun Modifier.clickableRow(onClick: () -> Unit): Modifier = clickable(onClick = onClick)
