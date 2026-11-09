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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.core.R
import app.core.i18n.Numerals
import app.core.i18n.screenLanguage
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppColors
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Radius
import app.core.ui.theme.brushTint

/**
 * A numbered kicker, «۰۲ ── درباره‌ی من»: the number in the accent, a 24 dp
 * rule, the label. It numbers profile sections and paywall steps, and on a
 * photo ([onPhoto]) it says which photo this is. Read as a heading.
 */
@Composable
fun SectionKicker(number: Int, label: String, modifier: Modifier = Modifier, onPhoto: Boolean = false) {
    val language = screenLanguage()
    val style = AppTheme.type.kicker
    val numberColor = if (onPhoto) Color.White else MaterialTheme.colorScheme.primary
    val labelColor = if (onPhoto) Color.White.copy(alpha = 0.82f) else MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        modifier.semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(Numerals.twoDigits(number, language), style = style, color = numberColor)
        Box(Modifier.width(24.dp).height(1.dp).background(labelColor.copy(alpha = labelColor.alpha * 0.7f)))
        Text(label, style = style, color = labelColor)
    }
}

/** One column of a [FactRow]. */
data class Fact(val icon: ImageVector, val label: String, val value: String)

/**
 * Up to three facts between hairlines (height, education, what they look
 * for): an icon, a small label and the value, which wraps rather than
 * being cut. More facts go below as [FactChip]s.
 */
@Composable
fun FactRow(facts: List<Fact>, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val colors = AppTheme.colors
    Column(modifier.fillMaxWidth()) {
        HorizontalDivider(thickness = 1.dp, color = scheme.outlineVariant)
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            facts.take(3).forEachIndexed { index, fact ->
                if (index > 0) VerticalDivider(Modifier.fillMaxHeight(), thickness = 1.dp, color = scheme.outlineVariant)
                Column(
                    Modifier.weight(1f).padding(vertical = 16.dp, horizontal = 8.dp).semantics(mergeDescendants = true) {},
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(fact.icon, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
                    Text(fact.label, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Normal), color = colors.textTertiary, textAlign = TextAlign.Center)
                    Text(fact.value, style = MaterialTheme.typography.labelMedium, color = scheme.onSurface, textAlign = TextAlign.Center, maxLines = 2)
                }
            }
        }
        HorizontalDivider(thickness = 1.dp, color = scheme.outlineVariant)
    }
}

/**
 * A prompt and its answer as a pull quote: the question small after a
 * gradient quote mark, the answer large, and «لایک همین جواب» (a heart
 * stroked with the gradient) at the top end.
 */
@Composable
fun PromptCard(
    question: String,
    answer: String,
    modifier: Modifier = Modifier,
    onLike: (() -> Unit)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val colors = AppTheme.colors
    val shape = RoundedCornerShape(Radius.promptCard)
    Box(
        modifier
            .fillMaxWidth()
            .then(if (!colors.dark) Modifier.softShadow(shape, 0.12f) else Modifier)
            .background(scheme.surfaceContainerLow, shape)
            .border(1.dp, scheme.outlineVariant, shape)
            .padding(horizontal = 22.dp, vertical = 20.dp),
    ) {
        Column(Modifier.padding(end = if (onLike != null) 56.dp else 0.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(AppIcons.Quote, contentDescription = null, tint = Color.Black, modifier = Modifier.size(22.dp).brushTint(colors.textGradient))
                Text(question, style = MaterialTheme.typography.labelMedium, color = scheme.onSurfaceVariant)
            }
            Text(answer, style = MaterialTheme.typography.titleLarge, color = scheme.onSurface)
        }
        if (onLike != null) {
            Box(Modifier.align(Alignment.TopEnd)) {
                LikeAnswerButton(onLike)
            }
        }
    }
}

/** «لایک همین جواب»: a 44 dp ring (48 dp to touch) with a heart stroked in the gradient. */
@Composable
private fun LikeAnswerButton(onClick: () -> Unit) {
    val colors = AppTheme.colors
    val label = stringResource(R.string.ui_like_answer)
    Box(
        Modifier
            .size(48.dp)
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(44.dp).border(1.5.dp, colors.hairlineStrong, CircleShape), contentAlignment = Alignment.Center) {
            Icon(AppIcons.HeartLine, contentDescription = null, tint = Color.Black, modifier = Modifier.size(22.dp).brushTint(colors.gradient))
        }
    }
}

/** A prompt over a photo: a gradient rule at the start, the question small, the answer in white. */
@Composable
fun PhotoPullQuote(question: String, answer: String, modifier: Modifier = Modifier) {
    val colors = AppTheme.colors
    Row(modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(Modifier.width(3.dp).fillMaxHeight().clip(CircleShape).background(colors.gradient))
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(question, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium), color = Color.White.copy(alpha = 0.76f))
            Text(answer, style = MaterialTheme.typography.titleMedium.copy(fontSize = 19.sp, lineHeight = 30.sp), color = Color.White)
        }
    }
}

/**
 * The story bars over a photo: one segment per photo, filling from the
 * start (the right in Persian), white over a 32 % track, each with a thin
 * dark edge so they read on the brightest photo (3:1 at worst, under the
 * top scrim). [progress] is how far the current one has filled.
 */
@Composable
fun StoryProgress(count: Int, current: Int, modifier: Modifier = Modifier, progress: Float = 1f) {
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
                    .border(1.dp, AppColors.StoryEdge, RoundedCornerShape(2.dp))
                    .clip(RoundedCornerShape(2.dp))
                    .background(AppColors.StoryTrack),
            ) {
                if (fill > 0f) Box(Modifier.fillMaxWidth(fill).fillMaxHeight().background(AppColors.StoryFill))
            }
        }
    }
}

/** The top scrim (200 dp) under a photo's chrome and story bars. */
@Composable
fun PhotoScrimTop(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(200.dp).background(AppColors.PhotoScrimTop))
}

/** The bottom scrim under a name and its lines; give it 62-66 % of the photo's height. */
@Composable
fun PhotoScrimBottom(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().background(AppColors.PhotoScrimBottom))
}

/** A short glass notice at the top of a photo: «سوپرلایک فرستاده شد». */
@Composable
fun PhotoToast(text: String, modifier: Modifier = Modifier, icon: ImageVector? = AppIcons.Star, iconTint: Color = AppTheme.colors.alive, backdrop: GlassBackdrop? = null) {
    GlassBox(CircleShape, GlassStyle.ToastOnPhoto, modifier.height(48.dp), backdrop) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 20.dp),
        ) {
            if (icon != null) Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(20.dp))
            Text(text, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Medium), color = Color.White, maxLines = 1)
        }
    }
}

/**
 * A name on a photo: «ترانه، ۲۲» in white, the name bold and the age
 * regular, on one line. A long name shrinks down to 28 sp (the age with it),
 * then ends in an ellipsis; the age always shows. [verified] adds the mark
 * with its white rim.
 */
@Composable
fun PhotoNameLine(name: String, age: String?, modifier: Modifier = Modifier, verified: Boolean = false) {
    val style = MaterialTheme.typography.displaySmall.copy(color = Color.White)
    var size by androidx.compose.runtime.remember(name) { androidx.compose.runtime.mutableStateOf(style.fontSize) }
    val comma = if (screenLanguage() == app.core.i18n.AppLanguage.FA) "، " else ", "
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        androidx.compose.foundation.text.BasicText(
            text = name + if (age != null) comma else "",
            style = style,
            maxLines = 1,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            autoSize = androidx.compose.foundation.text.TextAutoSize.StepBased(minFontSize = 28.sp, maxFontSize = style.fontSize),
            onTextLayout = { size = it.layoutInput.style.fontSize },
            modifier = Modifier.weight(1f, fill = false),
        )
        if (age != null) {
            Text(age, style = style.copy(fontSize = size, fontWeight = FontWeight.Normal), maxLines = 1)
        }
        if (verified) VerifiedBadge(24.dp, Modifier.padding(start = 8.dp), onPhoto = true)
    }
}
