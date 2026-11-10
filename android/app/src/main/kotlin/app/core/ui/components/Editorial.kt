package app.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import app.core.ui.theme.outerShadow
import app.core.ui.theme.ShadowLayer
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.core.R
import app.core.i18n.screenLanguage
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue

/** One cell of a [FactRow]: a small label over a short value; no icon. */
data class Fact(val label: String, val value: String)

/**
 * Facts in rows of three (height, education, what they look for): the
 * label (`--type-caption`, `--text-3`) over the value (`--type-body-strong`),
 * hairlines between cells; values wrap rather than being cut.
 */
@Composable
fun FactRow(facts: List<Fact>, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    Column(modifier.fillMaxWidth()) {
        HorizontalDivider(thickness = 1.dp, color = t.colors.line)
        facts.chunked(3).forEach { row ->
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                row.forEachIndexed { index, fact ->
                    if (index > 0) VerticalDivider(Modifier.fillMaxHeight(), thickness = 1.dp, color = t.colors.line)
                    Column(
                        Modifier.weight(1f).padding(top = 12.dp, bottom = 11.dp, start = 6.dp, end = 6.dp).semantics(mergeDescendants = true) {},
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text(fact.label, style = t.type.caption, color = t.colors.text3, textAlign = TextAlign.Center)
                        Text(fact.value, style = t.type.bodyStrong, color = t.colors.text, textAlign = TextAlign.Center, maxLines = 2)
                    }
                }
                repeat(3 - row.size) {
                    VerticalDivider(Modifier.fillMaxHeight(), thickness = 1.dp, color = t.colors.line)
                    Box(Modifier.weight(1f))
                }
            }
            HorizontalDivider(thickness = 1.dp, color = t.colors.line)
        }
    }
}

/**
 * A prompt and its answer as a pull quote: a 3 dp `--quote-bar` at the
 * start, the question (`--type-section`, `--text-2`), the answer
 * (`--type-quote`), and the like (a 48 dp `--line-strong` ring with the
 * `--like` heart) at the end.
 */
@Composable
fun PromptQuote(
    question: String,
    answer: String,
    modifier: Modifier = Modifier,
    onLike: (() -> Unit)? = null,
) {
    val t = AppTheme.template
    Row(modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.padding(vertical = 4.dp).width(3.dp).fillMaxHeight().clip(CircleShape).background(t.paints.quoteBar))
        Column(Modifier.weight(1f).padding(start = 15.dp, end = 12.dp, top = 2.dp, bottom = 2.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(question, style = t.type.section, color = t.colors.text2)
            Text(answer, style = t.type.quote, color = t.colors.text)
        }
        if (onLike != null) LikeAnswerButton(onLike)
    }
}

/** «لایک همین جواب»: a 48 dp ring (1.5 dp `--line-strong`) with the heart in `--like`. */
@Composable
private fun LikeAnswerButton(onClick: () -> Unit) {
    val t = AppTheme.template
    val label = stringResource(R.string.ui_like_answer)
    Box(
        Modifier
            .size(48.dp)
            .clip(CircleShape)
            .border(1.5.dp, t.colors.lineStrong, CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Icon(AppIcons.HeartLine, contentDescription = null, tint = t.colors.like, modifier = Modifier.size(22.dp))
    }
}

/** A prompt over a photo: a 3 dp `--seam` bar at the start, the question in `--on-photo-2`, the answer in `--on-photo`. */
@Composable
fun PhotoPullQuote(question: String, answer: String, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    Row(modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(15.dp)) {
        Box(Modifier.padding(vertical = 4.dp).width(3.dp).fillMaxHeight().clip(CircleShape).background(t.paints.seam))
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(question, style = t.type.section, color = t.colors.onPhoto2)
            Text(answer, style = t.type.quote, color = t.colors.onPhoto)
        }
    }
}

/**
 * The story bars over a photo: one segment per photo, filling from the
 * start (the right in Persian): `--story-fill` over `--story-track`, each
 * with a 1 dp `--story-edge` around it so they read on the brightest photo.
 * [progress] is how far the current one has filled.
 */
@Composable
fun StoryProgress(count: Int, current: Int, modifier: Modifier = Modifier, progress: Float = 1f) {
    val t = AppTheme.template
    Row(modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for (i in 0 until count) {
            val fill = when {
                i < current -> 1f
                i == current -> progress.coerceIn(0f, 1f)
                else -> 0f
            }
            Box(
                Modifier
                    .weight(1f)
                    .height(3.5.dp)
                    .outerShadow(CircleShape, listOf(ShadowLayer(0.dp, 0.dp, 0.dp, 1.dp, t.colors.storyEdge)))
                    .clip(CircleShape)
                    .background(t.colors.storyTrack),
            ) {
                if (fill > 0f) Box(Modifier.fillMaxWidth(fill).fillMaxHeight().background(t.colors.storyFill))
            }
        }
    }
}

/** The top scrim (190 dp, `--photo-scrim-top`) on every photo that runs under the status bar. */
@Composable
fun PhotoScrimTop(modifier: Modifier = Modifier, height: Dp = 190.dp) {
    Box(modifier.fillMaxWidth().height(height).background(AppTheme.template.paints.photoScrimTop))
}

/** The bottom scrim (`--photo-scrim-bottom`) under a name on a photo; give it 56 % of the photo's height. */
@Composable
fun PhotoScrimBottom(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().background(AppTheme.template.paints.photoScrimBottom))
}

/**
 * A name line: «ترانه، ۲۲», the name bold and the age regular, the
 * verified badge after it and a plain online dot. [onPhoto]: on a photo in
 * `--type-name-photo` and `--on-photo` (28 dp badge, 12 dp dot ringed in
 * `--photo-chip-fill`); otherwise under a card photo in `--type-h1` and
 * `--text` (24 dp badge, 10 dp dot). A long name shrinks (down to 28 sp on
 * a photo), then ends in an ellipsis; the age always shows.
 */
@Composable
fun NameLine(
    name: String,
    age: String?,
    modifier: Modifier = Modifier,
    verified: Boolean = false,
    online: Boolean = false,
    onPhoto: Boolean = true,
) {
    val t = AppTheme.template
    val style = (if (onPhoto) t.type.namePhoto else t.type.h1).copy(color = if (onPhoto) t.colors.onPhoto else t.colors.text)
    val ageStyle = if (onPhoto) t.type.namePhotoAge else t.type.h1.copy(fontWeight = FontWeight.Normal)
    var size by androidx.compose.runtime.remember(name) { androidx.compose.runtime.mutableStateOf(style.fontSize) }
    val comma = if (screenLanguage() == app.core.i18n.AppLanguage.FA) "، " else ", "
    val onlineLabel = stringResource(R.string.ui_online)
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        androidx.compose.foundation.text.BasicText(
            text = name + if (age != null) comma else "",
            style = style,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            autoSize = androidx.compose.foundation.text.TextAutoSize.StepBased(minFontSize = if (onPhoto) 28.sp else 22.sp, maxFontSize = style.fontSize),
            onTextLayout = { size = it.layoutInput.style.fontSize },
            modifier = Modifier.weight(1f, fill = false),
        )
        if (age != null) {
            Text(age, style = ageStyle.copy(fontSize = size, color = style.color), maxLines = 1)
        }
        if (verified) VerifiedBadge(if (onPhoto) 28.dp else 24.dp, Modifier.padding(start = if (onPhoto) 10.dp else 8.dp))
        if (online) {
            val dot = if (onPhoto) 12.dp else 10.dp
            Box(
                Modifier
                    .padding(start = 10.dp)
                    .semantics { contentDescription = onlineLabel }
                    .then(if (onPhoto) Modifier.outerShadow(CircleShape, listOf(ShadowLayer(0.dp, 0.dp, 0.dp, 3.dp, t.colors.photoChipFill))) else Modifier),
            ) {
                OnlineDot(size = dot)
            }
        }
    }
}

/** The older name of [NameLine] on a photo. */
@Composable
fun PhotoNameLine(name: String, age: String?, modifier: Modifier = Modifier, verified: Boolean = false) {
    NameLine(name, age, modifier, verified = verified, onPhoto = true)
}
