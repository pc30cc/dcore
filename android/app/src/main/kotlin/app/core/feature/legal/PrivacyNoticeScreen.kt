package app.core.feature.legal

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.LocalAppGraph
import app.core.R
import app.core.brand.AppBrand
import app.core.feature.auth.AuthPage
import app.core.feature.auth.Gap
import app.core.feature.auth.PageLayout
import app.core.i18n.brandString
import app.core.ui.components.PrimaryButton
import app.core.ui.components.TextAction
import app.core.ui.components.TextActionKind
import app.core.ui.components.templateCard
import app.core.ui.theme.AppTheme

/**
 * The privacy summary, inside the app, before anything is asked: who sees
 * what (a two-column card), the two rows that add something (photos,
 * deletion), «قبول دارم», and the full policy and the terms one tap away.
 * Accepting it is what the basics later send as the accepted versions.
 * Sign-in shows it as its first page; onboarding as a step when it was not
 * accepted on this install.
 */
@Composable
fun PrivacyNoticeScreen(
    onBack: (() -> Unit)?,
    onAccept: () -> Unit,
    busy: Boolean = false,
) {
    val t = AppTheme.template
    val graph = LocalAppGraph.current
    val config by graph.config.config.collectAsStateWithLifecycle()
    val uri = LocalUriHandler.current
    val privacyUrl = config?.legal?.privacyUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.privacyUrl
    val termsUrl = config?.legal?.termsUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.termsUrl
    AuthPage(
        title = brandString(R.string.privacy_title),
        onBack = onBack,
        hero = false,
        titleTop = PageLayout.titleTopTight,
        actions = {
            PrimaryButton(brandString(R.string.privacy_accept), onAccept, loading = busy)
            // Wraps to a second line before a link is cut (long Turkish words, large text).
            FlowRow(
                Modifier.fillMaxWidth().padding(top = Summary.linksTop),
                horizontalArrangement = Arrangement.spacedBy(Summary.linksGap, Alignment.CenterHorizontally),
            ) {
                if (privacyUrl.isNotBlank()) {
                    TextAction(brandString(R.string.privacy_full), { uri.openUri(privacyUrl) }, kind = TextActionKind.Neutral, style = t.type.legalLink)
                }
                if (termsUrl.isNotBlank()) {
                    TextAction(brandString(R.string.legal_terms), { uri.openUri(termsUrl) }, kind = TextActionKind.Neutral, style = t.type.legalLink)
                }
            }
        },
    ) {
        Gap(Summary.cardTop)
        WhoSeesWhat()
        Gap(Summary.rowsTop)
        SummaryRow(R.string.privacy_photos_title, R.string.privacy_photos_body)
        Box(Modifier.fillMaxWidth().height(Summary.hairline).background(t.colors.line))
        SummaryRow(R.string.privacy_deletion_title, R.string.privacy_deletion_body)
    }
}

private val OthersSee = listOf(R.string.privacy_others_1, R.string.privacy_others_2, R.string.privacy_others_3)
private val OnlyUs = listOf(R.string.privacy_only_us_1, R.string.privacy_only_us_2, R.string.privacy_only_us_3)

/**
 * «بقیه می‌بینن» beside «فقط پیش ما», in one card split by a hairline. An
 * item may take two lines in its half; when one would need more (very large
 * text), the two groups stack, each the card's full width.
 */
@Composable
private fun WhoSeesWhat() {
    val t = AppTheme.template
    val measurer = rememberTextMeasurer()
    val headings = listOf(brandString(R.string.privacy_others_see), brandString(R.string.privacy_only_us))
    val items = (OthersSee + OnlyUs).map { brandString(it) }
    val card = Modifier.fillMaxWidth().templateCard(RoundedCornerShape(t.radii.card))
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val half = with(LocalDensity.current) { ((maxWidth - Summary.hairline) / 2 - Summary.cellPad * 2).roundToPx() }
        val lines = items.map { if (half > 0) measurer.measure(it, t.type.bodyStrong, constraints = Constraints(maxWidth = half)).lineCount else Int.MAX_VALUE }
        val fits = half > 0 &&
            headings.all { measurer.measure(it, t.type.section, constraints = Constraints(maxWidth = half)).lineCount == 1 } &&
            lines.all { it <= Summary.itemLinesMax }
        if (fits) {
            // An item on two lines keeps its lines together and the items further apart, so it still reads as one.
            val gap = if (lines.any { it > 1 }) Summary.itemGapStacked else Summary.itemGap
            Row(card.height(IntrinsicSize.Min)) {
                Column(Modifier.weight(1f)) { WhoColumn(R.string.privacy_others_see, OthersSee, gap) }
                Box(Modifier.width(Summary.hairline).fillMaxHeight().background(t.colors.line))
                Column(Modifier.weight(1f)) { WhoColumn(R.string.privacy_only_us, OnlyUs, gap) }
            }
        } else {
            Column(card) {
                WhoColumn(R.string.privacy_others_see, OthersSee, Summary.itemGapStacked)
                Box(Modifier.fillMaxWidth().height(Summary.hairline).background(t.colors.line))
                WhoColumn(R.string.privacy_only_us, OnlyUs, Summary.itemGapStacked)
            }
        }
    }
}

/**
 * A group's heading and its items, [gap] apart; a wrapped item keeps its
 * lines closer than that, so it reads as one.
 */
@Composable
private fun WhoColumn(@StringRes heading: Int, @StringRes items: List<Int>, gap: Dp) {
    val t = AppTheme.template
    Column(
        Modifier.fillMaxWidth().padding(start = Summary.cellPad, end = Summary.cellPad, top = Summary.cellPad, bottom = Summary.cellPadBottom),
        verticalArrangement = Arrangement.spacedBy(gap),
    ) {
        Text(
            brandString(heading),
            style = t.type.section,
            color = t.colors.text3,
            modifier = Modifier.padding(bottom = (Summary.headingGap - gap).coerceAtLeast(0.dp)).semantics { heading() },
        )
        for (item in items) {
            Text(brandString(item), style = t.type.bodyStrong.copy(lineBreak = LineBreak.Paragraph), color = t.colors.text)
        }
    }
}

@Composable
private fun SummaryRow(@StringRes title: Int, @StringRes body: Int) {
    val t = AppTheme.template
    Column(Modifier.fillMaxWidth().padding(vertical = Summary.rowPad)) {
        Text(brandString(title), style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.semantics { heading() })
        Text(brandString(body), style = t.type.bodySm.copy(lineBreak = LineBreak.Paragraph), color = t.colors.text2, modifier = Modifier.padding(top = Summary.rowBodyGap))
    }
}

/** The summary's layout (dp), as the design draws it. */
private object Summary {
    val cardTop = 22.dp
    val cellPad = 16.dp
    /** The design's 14 dp, plus the 3 dp its last item keeps under it. */
    val cellPadBottom = 17.dp
    /** Heading to the first item's text: 8 dp, plus the 3 dp above an item. */
    val headingGap = 11.dp
    /** Between two one-line items (the design's 3 dp above and below each). */
    val itemGap = 6.dp
    /** Stacked groups may still wrap at very large text: items further apart than a wrapped item's lines. */
    val itemGapStacked = 12.dp
    /** The most lines an item may take in a half before the groups stack. */
    const val itemLinesMax = 2
    val hairline = 1.dp
    val rowsTop = 18.dp
    val rowPad = 12.dp
    val rowBodyGap = 2.dp
    val linksTop = 6.dp
    val linksGap = 4.dp
}
