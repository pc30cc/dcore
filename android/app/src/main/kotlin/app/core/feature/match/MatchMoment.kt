package app.core.feature.match

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import app.core.model.Catalog
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.material3.ripple
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.indication
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Shader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import app.core.R
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.Id
import app.core.model.Photo
import app.core.model.ProfileCard
import app.core.ui.components.AppIconButton
import app.core.ui.components.ChipRow
import app.core.ui.components.IconButtonKind
import app.core.ui.components.TextAction
import app.core.ui.components.TextActionKind
import app.core.ui.components.fieldFrame
import app.core.ui.components.hairline
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.DialogBarIcons
import app.core.ui.theme.HeroStyle
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Scheme
import app.core.ui.theme.Space
import app.core.ui.theme.insetShadow
import app.core.ui.theme.outerShadow
import app.core.ui.theme.ShadowLayer
import kotlinx.coroutines.launch
import kotlin.math.min

/**
 * Hands a new match's first message to the chat (its outbox delivers it).
 * The main screen provides the real one; where none is provided (a screen
 * test, a preview) the match moment shows no composer, so nothing can look
 * sent while it was not.
 */
fun interface MatchMessages {
    fun send(conversationId: Id, text: String)
}

val LocalMatchMessages = staticCompositionLocalOf<MatchMessages?> { null }

/**
 * The match moment, above everything (the tab bar included). [openers] are
 * first messages to offer ([matchOpeners] builds them from the profile).
 */
@Composable
fun MatchMomentDialog(
    their: ProfileCard,
    myPhoto: Photo?,
    onSendMessage: () -> Unit,
    onDismiss: () -> Unit,
    conversationId: Id? = null,
    openers: List<String> = emptyList(),
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        DialogBarIcons()
        MatchMoment(their, myPhoto, onSendMessage, onDismiss, conversationId = conversationId, openers = openers)
    }
}

/**
 * "It's a match", by the template's hero switch: split portraits (bleed:
 * hers on the right, mine on the left, a 3 dp `--seam` between them, fading
 * into the page, a 120 dp `--match-scrim-top` under the status bar, a glass
 * close) or two rounded portrait cards on the page (framed: hers on the
 * right turned +3°, mine on the left turned -3°, a plain close). Then the
 * title, the [openers] (tapping one puts it in the composer), the composer
 * with its send and «بعداً». No medal, confetti or body line.
 *
 * Send hands the text to [LocalMatchMessages] for [conversationId] and then
 * calls [onSendMessage] (the thread opens). Without a [conversationId] (the
 * server left the conversation out) or a sender, nothing could be sent, so
 * there is no composer and no openers: the title and «بعداً» only. Everything settles in
 * with a spring; with less motion asked for, it is simply there.
 */
@Composable
fun MatchMoment(
    their: ProfileCard,
    myPhoto: Photo?,
    onSendMessage: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    conversationId: Id? = null,
    openers: List<String> = emptyList(),
) {
    val t = AppTheme.template
    val framed = t.switches.hero == HeroStyle.Framed
    val reduced = LocalReducedMotion.current
    val haptics = LocalHapticFeedback.current
    val messages = LocalMatchMessages.current
    val arrive = remember { Animatable(if (reduced) 1f else 0f) }
    val copy = remember { Animatable(if (reduced) 1f else 0f) }
    LaunchedEffect(Unit) {
        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        if (reduced) return@LaunchedEffect
        launch { arrive.animateTo(1f, spring(dampingRatio = 0.75f, stiffness = 240f)) }
        copy.animateTo(1f, spring(dampingRatio = 0.9f, stiffness = 200f))
    }
    var text by rememberSaveable { mutableStateOf("") }
    val canSend = conversationId != null && messages != null
    val send = {
        val body = text.trim()
        if (body.isNotEmpty() && conversationId != null && messages != null) {
            messages.send(conversationId, body)
            onSendMessage()
        }
    }
    val announcement = brandString(R.string.match_announcement, their.name)
    val statusTop = maxOf(WindowInsets.statusBars.asPaddingValues().calculateTopPadding(), MatchLayout.statusBar)

    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .background(t.colors.bg)
            .semantics { paneTitle = announcement },
    ) {
        // The design's board is 892 dp tall: a shorter window draws the photos and the copy proportionally higher.
        val k = min(1f, maxHeight / MatchLayout.board)
        if (framed) {
            PortraitCards(their.photos.firstOrNull(), myPhoto, k, arrive.value)
        } else {
            SplitPortraits(their.photos.firstOrNull(), myPhoto, k, arrive.value)
        }
        val window = maxHeight
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .heightIn(min = window)
                .windowInsetsPadding(WindowInsets.navigationBars)
                .imePadding(),
        ) {
            Spacer(Modifier.height((if (framed) MatchLayout.titleTopFramed else MatchLayout.titleTopBleed) * k))
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Space.gutter)
                    .graphicsLayer { alpha = copy.value.coerceIn(0f, 1f) },
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Title()
                if (canSend && openers.isNotEmpty()) {
                    Spacer(Modifier.height(if (framed) MatchLayout.openersGapFramed else MatchLayout.openersGapBleed))
                    ChipRow(Modifier.fillMaxWidth(), centered = true) {
                        openers.forEach { opener -> OpenerChip(opener) { text = opener } }
                    }
                }
            }
            Spacer(Modifier.weight(1f).heightIn(min = MatchLayout.minGap))
            if (canSend) {
                Composer(text, { text = it }, send, Modifier.padding(horizontal = Space.gutter))
                Spacer(Modifier.height(MatchLayout.composerToLater))
            }
            TextAction(
                brandString(R.string.match_later),
                onDismiss,
                kind = TextActionKind.Neutral,
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )
            Spacer(Modifier.height(MatchLayout.laterBottom))
        }
        // At the start, as the full profile's close: the right in Persian, the left in English.
        Box(
            Modifier
                .align(Alignment.TopStart)
                .padding(top = statusTop + MatchLayout.closeTop, start = if (framed) MatchLayout.closeSideFramed else MatchLayout.closeSideBleed),
        ) {
            AppIconButton(
                icon = AppIcons.Close,
                contentDescription = brandString(R.string.action_close),
                onClick = onDismiss,
                kind = if (framed) IconButtonKind.Plain else IconButtonKind.Glass,
            )
        }
    }
}

/** «مچ شدین!» in `--type-display`; the template's accent word (`--accent-text`) where it has one. */
@Composable
private fun Title() {
    val t = AppTheme.template
    val title = brandString(R.string.match_title)
    val accent = brandString(R.string.match_title_accent)
    val at = if (accent.isNotEmpty()) title.indexOf(accent) else -1
    // A span's brush covers the whole text; the design paints the gradient across the word only.
    var word by remember(title, at) { mutableStateOf<Rect?>(null) }
    val brush = t.paints.accentText.let { paint -> word?.let { box -> (paint as? ShaderBrush)?.let { WordBrush(it, box) } } ?: paint }
    val styled = buildAnnotatedString {
        append(title)
        if (at >= 0) addStyle(SpanStyle(brush = brush), at, at + accent.length)
    }
    Text(
        styled,
        style = t.type.display,
        color = t.colors.text,
        textAlign = TextAlign.Center,
        onTextLayout = { layout -> if (at >= 0) word = layout.getPathForRange(at, at + accent.length).getBounds() },
        // The dialog's pane title already announces the match; the title is a heading only.
        modifier = Modifier.semantics { heading() },
    )
}

/** [inner] laid over [box] (the accent word's bounds in the title) instead of the whole title. */
private class WordBrush(private val inner: ShaderBrush, private val box: Rect) : ShaderBrush() {
    override fun createShader(size: Size): Shader = inner.createShader(box.size).apply {
        setLocalMatrix(android.graphics.Matrix().apply { setTranslate(box.left, box.top) })
    }

    override fun equals(other: Any?): Boolean = other is WordBrush && other.inner == inner && other.box == box

    override fun hashCode(): Int = 31 * inner.hashCode() + box.hashCode()
}

/**
 * One opener: the interest chip's look (44 dp) in a 48 dp target that takes
 * the tap; the ripple stays inside the chip. A long one (large text) takes a
 * second line rather than losing its words.
 */
@Composable
private fun OpenerChip(text: String, onClick: () -> Unit) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.chip)
    val interaction = remember { MutableInteractionSource() }
    Box(
        Modifier
            .heightIn(min = MatchLayout.chipTarget)
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .heightIn(min = MatchLayout.chip)
                .clip(shape)
                .background(t.colors.surface1, shape)
                .insetShadow(shape, listOf(hairline(t.colors.line)))
                .indication(interaction, ripple())
                .padding(horizontal = MatchLayout.chipPadding, vertical = MatchLayout.chipPadV),
            contentAlignment = Alignment.Center,
        ) {
            Text(text, style = t.type.labelSm.copy(textDirection = TextDirection.Content), color = t.colors.text, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * First messages to offer on the match screen: [card]'s short written
 * answers as questions back («دماوند، تابستون پارسال؟»), in the answer's
 * own script (voice answers have no words), then one plain opener in the
 * reader's language («چای یا قهوه؟») while there are fewer than three. An
 * answer longer than a chip's [OPENER_MAX] characters is left out rather
 * than cut. At most three.
 */
@Composable
fun matchOpeners(card: ProfileCard, catalog: Catalog): List<String> {
    val questions = catalog.prompts.associateBy { it.id }
    val fromAnswers = card.prompts.mapNotNull { prompt ->
        val def = questions[prompt.promptId] ?: return@mapNotNull null
        val answer = prompt.answer?.trim().orEmpty()
        if (def.category == VOICE || prompt.audioUrl != null || answer.isEmpty() || '\n' in answer) null else asQuestion(answer)
    }.filter { it.length <= OPENER_MAX }.distinct().take(MAX_OPENERS)
    val plain = brandString(R.string.match_opener_plain)
    return if (fromAnswers.size < MAX_OPENERS && plain !in fromAnswers) fromAnswers + plain else fromAnswers
}

/** [answer] as a question: its closing stop or «…» dropped, «؟» after Persian or Arabic script, "?" after any other. */
internal fun asQuestion(answer: String): String {
    val body = answer.trimEnd('.', '!', '…', '،', ',', ';', '؛', ' ')
    if (body.isEmpty()) return answer
    if (body.endsWith('?') || body.endsWith('؟')) return body
    val arabicScript = body.any { it in '\u0600'..'\u06FF' || it in '\uFB50'..'\uFDFF' || it in '\uFE70'..'\uFEFF' }
    return body + if (arabicScript) '؟' else '?'
}

private const val VOICE = "voice"
/** The longest opener a chip shows whole beside another one (the design draws chips of 12 to 28). */
private const val OPENER_MAX = 26
private const val MAX_OPENERS = 3

/**
 * The composer: a 56 dp `--surface-field` pill (`--r-button`, `--field-line`;
 * focus is the 2 dp `--primary-ring`), the placeholder at the start, the 48
 * dp send (`--primary-fill`) at the end. A longer message grows it up to
 * four lines, as the chat's composer does, with the same corners as the
 * one-line pill and the send kept at the bottom; the start of the message
 * stays in view.
 */
@Composable
private fun Composer(text: String, onText: (String) -> Unit, onSend: () -> Unit, modifier: Modifier) {
    val t = AppTheme.template
    val interaction = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val placeholder = brandString(R.string.match_composer)
    val sendLabel = brandString(R.string.match_send)
    // A pill's corners are half its height: a taller field keeps the one-line corners rather than turning into a stadium.
    val corner = minOf(t.radii.button, MatchLayout.composer / 2)
    BasicTextField(
        value = text,
        onValueChange = onText,
        singleLine = false,
        maxLines = MatchLayout.COMPOSER_LINES,
        textStyle = t.type.field.copy(color = t.colors.text, textDirection = TextDirection.Content),
        cursorBrush = SolidColor(t.colors.caret),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        interactionSource = interaction,
        modifier = modifier
            .fillMaxWidth()
            .semantics { contentDescription = placeholder },
        decorationBox = { inner ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = MatchLayout.composer)
                    .fieldFrame(corner, focused, false)
                    .padding(start = MatchLayout.composerStart, end = MatchLayout.composerEnd, top = MatchLayout.composerInset, bottom = MatchLayout.composerInset),
                verticalAlignment = Alignment.Bottom,
            ) {
                Box(
                    Modifier
                        .weight(1f)
                        .heightIn(min = MatchLayout.send)
                        .padding(vertical = MatchLayout.composerTextInset),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (text.isEmpty()) Text(placeholder, style = t.type.fieldPlaceholder, color = t.colors.text3, maxLines = 1)
                    inner()
                }
                Spacer(Modifier.width(Space.sm))
                Box(
                    Modifier
                        .size(MatchLayout.send)
                        .clip(CircleShape)
                        .background(t.paints.primaryFill, CircleShape)
                        .insetShadow(CircleShape, t.shadows.btnHighlight)
                        .clickable(enabled = text.isNotBlank(), role = Role.Button, onClick = onSend)
                        .semantics { contentDescription = sendLabel },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(AppIcons.Forward, contentDescription = null, tint = t.colors.onPrimary, modifier = Modifier.size(MatchLayout.sendIcon))
                }
            }
        },
    )
}

/**
 * Bleed: the two photos side by side across the top (hers on the right,
 * mine on the left, in every language), 520 dp tall, the seam between them,
 * the top scrim and the fade into the page at their foot.
 */
@Composable
private fun SplitPortraits(hers: Photo?, mine: Photo?, k: Float, arrive: Float) {
    val t = AppTheme.template
    Box(Modifier.fillMaxWidth().height(MatchLayout.split * k)) {
        // Physical sides: mine on the left, hers on the right, in Persian too.
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
            Row(Modifier.fillMaxSize()) {
                Half(mine, Modifier.weight(1f).graphicsLayer { translationX = -(1f - arrive) * size.width * 0.25f; alpha = arrive.coerceIn(0f, 1f) })
                Half(hers, Modifier.weight(1f).graphicsLayer { translationX = (1f - arrive) * size.width * 0.25f; alpha = arrive.coerceIn(0f, 1f) })
            }
        }
        Box(Modifier.fillMaxWidth().height(MatchLayout.scrimTop).background(t.paints.matchScrimTop))
        Box(
            Modifier
                .align(Alignment.TopCenter)
                .width(MatchLayout.seam)
                .fillMaxHeight()
                .padding(bottom = MatchLayout.seamShort * k)
                .background(t.paints.seam),
        )
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(MatchLayout.fade * k).background(t.paints.matchFade))
    }
}

@Composable
private fun Half(photo: Photo?, modifier: Modifier) {
    PhotoImage(photo, contentDescription = null, modifier = modifier.fillMaxHeight(), alignment = MatchLayout.faceAlignment)
}

/**
 * Framed: two rounded portrait cards on the page (196 × 262, `--r-card`, a
 * 4 dp ring in the page colour and `--float-shadow`), overlapping 24 dp:
 * hers on the right turned +3° and in front, mine on the left turned -3°,
 * 14 dp lower.
 */
@Composable
private fun PortraitCards(hers: Photo?, mine: Photo?, k: Float, arrive: Float) {
    val t = AppTheme.template
    // Physical sides (from the left edge): mine on the left, hers on the right, in Persian too.
    // The cards scale with the window as the title's place does, so a short phone never draws the title over them.
    BoxWithConstraints(
        Modifier.fillMaxWidth().padding(top = MatchLayout.cardsTop * k).height(MatchLayout.cardsArea * k).testTag(MATCH_PORTRAITS_TAG),
        contentAlignment = AbsoluteAlignment.TopLeft,
    ) {
        val centre = maxWidth / 2
        Portrait(
            mine,
            k,
            Modifier
                .absoluteOffset(x = centre - MatchLayout.cardReach * k, y = MatchLayout.cardMineLower * k)
                .graphicsLayer { translationX = -(1f - arrive) * size.width * 0.3f; alpha = arrive.coerceIn(0f, 1f) }
                .rotate(-MatchLayout.cardTurn),
        )
        Portrait(
            hers,
            k,
            Modifier
                .absoluteOffset(x = centre + (MatchLayout.cardReach - MatchLayout.cardWidth) * k)
                .graphicsLayer { translationX = (1f - arrive) * size.width * 0.3f; alpha = arrive.coerceIn(0f, 1f) }
                .rotate(MatchLayout.cardTurn),
        )
    }
}

@Composable
private fun Portrait(photo: Photo?, k: Float, modifier: Modifier) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.card)
    val ring = listOf(ShadowLayer(0.dp, 0.dp, 0.dp, MatchLayout.cardRing, t.colors.bg)) + t.shadows.floatShadow
    Box(
        modifier
            .size(MatchLayout.cardWidth * k, MatchLayout.cardHeight * k)
            .outerShadow(shape, ring)
            .clip(shape)
            .background(t.colors.photoPlaceholder, shape),
    ) {
        PhotoImage(photo, contentDescription = null, modifier = Modifier.fillMaxSize(), alignment = MatchLayout.cardAlignment)
    }
}

/** The framed portraits' area, for tests that check what lies under it. */
internal const val MATCH_PORTRAITS_TAG = "match-portraits"

/** The match screen's layout, from the design's 412 × 892 board. */
private object MatchLayout {
    val board = 892.dp
    val statusBar = 32.dp
    val split = 520.dp
    val scrimTop = 120.dp
    val seam = 3.dp
    val seamShort = 90.dp
    val fade = 230.dp
    val faceAlignment = BiasAlignment(0f, -0.8f)
    val cardAlignment = BiasAlignment(0f, -0.68f)
    val cardsTop = 176.dp
    val cardsArea = 280.dp
    val cardWidth = 196.dp
    val cardHeight = 262.dp
    val cardReach = 184.dp
    val cardMineLower = 14.dp
    val cardRing = 4.dp
    const val cardTurn = 3f
    val titleTopBleed = 446.dp
    val titleTopFramed = 478.dp
    val openersGapBleed = 30.dp
    val openersGapFramed = 26.dp
    val chip = 44.dp
    val chipTarget = 48.dp
    val chipPadding = 16.dp
    val chipPadV = 8.dp
    val minGap = 24.dp
    val composer = 56.dp
    const val COMPOSER_LINES = 4
    val composerStart = 20.dp
    val composerEnd = 4.dp
    val composerInset = 4.dp
    val composerTextInset = 10.dp
    val send = 48.dp
    val sendIcon = 22.dp
    val composerToLater = 18.dp
    val laterBottom = 34.dp
    val closeTop = 12.dp
    val closeSideBleed = 12.dp
    val closeSideFramed = 8.dp
}
