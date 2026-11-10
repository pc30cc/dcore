package app.core.feature.deck

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.feature.card.LikeTarget
import app.core.feature.card.intentionLabel
import app.core.feature.card.isolate
import app.core.feature.card.rememberNumbers
import app.core.feature.card.rememberTimeOfDay
import app.core.feature.paywall.LocalPaywall
import app.core.feature.paywall.PaywallEntry
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.Catalog
import app.core.model.DiscoveryPreferences
import app.core.model.FieldDef
import app.core.model.Intention
import app.core.model.ItemKind
import app.core.model.PreferencesPatch
import app.core.model.SwipeAction
import app.core.model.WalletItem
import app.core.ui.components.AppBottomSheet
import app.core.ui.components.AppIconButton
import app.core.ui.components.AppRangeSlider
import app.core.ui.components.AppSlider
import app.core.ui.components.AppSwitch
import app.core.ui.components.ChipRow
import app.core.ui.components.ChoiceChip
import app.core.ui.components.HelperLine
import app.core.ui.components.Pill
import app.core.ui.components.PillKind
import app.core.ui.components.PrimaryButton
import app.core.ui.components.PromptQuote
import app.core.ui.components.SecondaryButton
import app.core.ui.components.TextAction
import app.core.ui.components.TextActionKind
import app.core.ui.components.fieldFrame
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space
import java.time.Instant
import kotlin.math.roundToInt

/** A sheet's content in the 20 dp gutter, scrolling when large text makes it taller than the screen. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun Sheet(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    AppBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = Space.gutter, end = Space.gutter, bottom = SheetLayout.bottom),
            content = content,
        )
    }
}

@Composable
private fun SheetTitle(text: String, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    Text(text, style = t.type.h2, color = t.colors.text, modifier = modifier.semantics { heading() })
}

/**
 * Out of likes or super likes: when they come back, what includes more (the
 * paywall), and for super likes the packs.
 */
@Composable
fun QuotaSheet(action: SwipeAction, resetsAt: Instant?, onDismiss: () -> Unit) {
    val t = AppTheme.template
    val time = rememberTimeOfDay()
    val paywall = LocalPaywall.current
    Sheet(onDismiss) {
        val superlike = action == SwipeAction.Superlike
        SheetTitle(brandString(if (superlike) R.string.deck_out_of_superlikes_title else R.string.deck_out_of_likes_title))
        Text(
            if (resetsAt != null) brandString(R.string.deck_quota_resets, time(resetsAt)) else brandString(R.string.deck_quota_resets_soon),
            style = t.type.bodySm,
            color = t.colors.text2,
            modifier = Modifier.padding(top = SheetLayout.lineGap),
        )
        // No plan names: the config names every plan, also those not on sale or not giving more of this.
        Text(
            brandString(R.string.upsell_plans_generic),
            style = t.type.bodyStrong,
            color = t.colors.text,
            modifier = Modifier.padding(top = SheetLayout.lineGap),
        )
        Spacer(Modifier.height(SheetLayout.actionsGap))
        if (superlike) {
            PrimaryButton(
                brandString(R.string.quota_buy_superlikes),
                {
                    onDismiss()
                    paywall.packs(WalletItem.Superlike, PaywallEntry.OUT_OF_SUPERLIKES)
                },
            )
            Spacer(Modifier.height(SheetLayout.buttonsGap))
            SecondaryButton(
                brandString(R.string.upsell_see_plans),
                {
                    onDismiss()
                    paywall.plans(PaywallEntry.OUT_OF_SUPERLIKES)
                },
            )
        } else {
            PrimaryButton(
                brandString(R.string.quota_more_likes),
                {
                    onDismiss()
                    paywall.plans(PaywallEntry.OUT_OF_LIKES)
                },
            )
        }
        TextAction(brandString(R.string.upsell_not_now), onDismiss, kind = TextActionKind.Neutral, modifier = Modifier.align(Alignment.CenterHorizontally))
    }
}

/**
 * The like on one photo or one answer (m06): the title with a close at the
 * end, the photo (or the answer as a pull quote), «یادداشت (اختیاری)» over
 * a multi-line field with its count, «لایک رو بفرست», and, where the
 * account has any ([superlikesLeft]; null means no limit), the same as a
 * super like. It stays open until the server answered; a refused note can
 * be edited and sent again.
 */
@Composable
fun ItemLikeSheet(
    target: LikeTarget,
    state: ItemLikeState,
    commentMax: Int,
    onSend: (String) -> Unit,
    onDismiss: () -> Unit,
    superlikesLeft: Int? = 0,
    onSuperlike: ((String) -> Unit)? = null,
) {
    val t = AppTheme.template
    var comment by rememberSaveable(target.card.id, target.item.ref) { mutableStateOf("") }
    val number = rememberNumbers()
    Sheet(onDismiss) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SheetTitle(
                brandString(if (target.item.kind == ItemKind.Photo) R.string.like_item_photo_title else R.string.like_item_prompt_title, isolate(target.card.name)),
                Modifier.weight(1f),
            )
            AppIconButton(AppIcons.Close, brandString(R.string.action_close), onDismiss, modifier = Modifier.padding(start = Space.sm))
        }
        Spacer(Modifier.height(SheetLayout.titleGap))
        val photo = target.photoIndex?.let { target.card.photos.getOrNull(it) }
        if (target.item.kind == ItemKind.Photo && photo != null) {
            PhotoImage(
                photo,
                contentDescription = null,
                alignment = SheetLayout.likedAlignment,
                modifier = Modifier.fillMaxWidth().height(SheetLayout.liked).clip(RoundedCornerShape(t.radii.card)),
            )
        } else if (target.item.kind == ItemKind.Prompt) {
            PromptQuote(question = target.question.orEmpty(), answer = target.promptText.orEmpty())
        }
        Spacer(Modifier.height(SheetLayout.labelGap))
        NoteField(comment, { comment = it.take(commentMax) }, commentMax, number, enabled = !state.sending, error = state.error == ItemLikeError.Refused)
        state.error?.let { error ->
            HelperLine(
                brandString(
                    when (error) {
                        ItemLikeError.Refused -> R.string.like_item_refused
                        ItemLikeError.Offline -> R.string.like_item_offline
                        ItemLikeError.Failed -> R.string.like_item_failed
                    },
                ),
                error = true,
                modifier = Modifier.padding(top = SheetLayout.lineGap),
            )
        }
        Spacer(Modifier.height(SheetLayout.buttonGap))
        PrimaryButton(brandString(R.string.like_item_send), { onSend(comment) }, loading = state.sending)
        if (onSuperlike != null && superlikesLeft != 0) {
            Spacer(Modifier.height(SheetLayout.superGap))
            TextAction(
                if (superlikesLeft == null) brandString(R.string.like_item_super_any) else brandString(R.string.like_item_super, number(superlikesLeft)),
                { onSuperlike(comment) },
                enabled = !state.sending,
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )
        }
    }
}

/**
 * The note: its label above (`--type-section`, `--text-2`), a field of 112
 * dp at least (`--r-field`, `--field-line`; the 2 dp `--primary-ring` when
 * focused), the text in `--type-body` and the count at its bottom end.
 */
@Composable
private fun NoteField(value: String, onValue: (String) -> Unit, max: Int, number: (Int) -> String, enabled: Boolean, error: Boolean) {
    val t = AppTheme.template
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val label = brandString(R.string.like_item_comment_label)
    Text(label, style = t.type.section, color = t.colors.text2, modifier = Modifier.padding(bottom = SheetLayout.labelToField))
    BasicTextField(
        value = value,
        onValueChange = onValue,
        enabled = enabled,
        textStyle = t.type.body.copy(color = t.colors.text),
        cursorBrush = SolidColor(t.colors.caret),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        interactionSource = interaction,
        maxLines = 5,
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = label },
        decorationBox = { inner ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = SheetLayout.note)
                    .fieldFrame(t.radii.field, focused, error)
                    .padding(horizontal = SheetLayout.notePadH, vertical = SheetLayout.notePadV),
                verticalArrangement = Arrangement.spacedBy(SheetLayout.noteGap),
            ) {
                inner()
                Text(
                    brandString(R.string.like_item_counter, number(value.length), number(max)),
                    style = t.type.bodySm,
                    color = t.colors.text3,
                    modifier = Modifier.align(Alignment.End),
                )
            }
        },
    )
}

/**
 * Who the deck shows (m03): distance (or anywhere in the country), ages,
 * verified only, and the paid filters («بیشتر» with the «اشتراک» pill
 * when the plan lacks them): each filterable field as a row with its value
 * («هر چی» when unset) and a chevron, opening its options or, for a range
 * (height), a range slider; without the plan the row opens the paywall. «پیش‌فرض» puts every value back to the defaults. One `PATCH
 * /v1/me/preferences` on «نشونم بده», never one per slider move (the server
 * limits distance changes per day).
 */
@Composable
fun FiltersSheet(
    preferences: DiscoveryPreferences?,
    saving: Boolean,
    onApply: (PreferencesPatch) -> Unit,
    onDismiss: () -> Unit,
    /** The plan includes advanced filters; without it their rows open the paywall. */
    advanced: Boolean = false,
    /** The config's filterable fields: choices (single or multi) and ranges (number, with bounds); see [advancedFilterFields]. */
    advancedFields: List<FieldDef> = emptyList(),
    /** The account's country (ISO 3166), which «هر جای …» names in the reader's language. */
    country: String? = null,
    /** Names the intentions («دنبال چی باشه»), which every plan may filter by. */
    catalog: Catalog = Catalog(),
) {
    val t = AppTheme.template
    val number = rememberNumbers()
    val paywall = LocalPaywall.current
    val start = preferences ?: DiscoveryPreferences()
    val defaults = DiscoveryPreferences()
    var chosen by remember(preferences) { mutableStateOf(start.filters.mapValues { it.value.toSet() }) }
    var distance by remember(preferences) { mutableFloatStateOf(start.maxDistanceKm.coerceIn(MIN_KM, Widening.MAX_DISTANCE_KM).toFloat()) }
    var wholeCountry by remember(preferences) { mutableStateOf(start.wholeCountry) }
    var ages by remember(preferences) { mutableStateOf(start.ageMin.toFloat()..start.ageMax.toFloat()) }
    var verifiedOnly by remember(preferences) { mutableStateOf(start.verifiedOnly) }
    var intents by remember(preferences) { mutableStateOf(start.intents.toSet()) }
    var picking by remember { mutableStateOf<FieldDef?>(null) }
    var pickingRange by remember { mutableStateOf<FieldDef?>(null) }
    var pickingIntents by remember { mutableStateOf(false) }
    val any = brandString(R.string.filters_any)
    val separator = brandString(R.string.profile_list_separator)
    val intentions = Intention.entries.filter { it != Intention.Unknown }
        .filter { i -> catalog.intentions.isEmpty() || catalog.intentions.any { it.key == i.wire } }
        .mapNotNull { i -> intentionLabel(i, catalog)?.let { i to it } }

    Sheet(onDismiss) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            SheetTitle(brandString(R.string.filters_title), Modifier.weight(1f))
            TextAction(
                brandString(R.string.filters_reset),
                {
                    distance = defaults.maxDistanceKm.toFloat()
                    wholeCountry = defaults.wholeCountry
                    ages = defaults.ageMin.toFloat()..defaults.ageMax.toFloat()
                    verifiedOnly = defaults.verifiedOnly
                    intents = defaults.intents.toSet()
                    chosen = emptyMap()
                },
                kind = TextActionKind.Neutral,
            )
        }
        Spacer(Modifier.height(SheetLayout.titleToFilters))

        val distanceLabel = brandString(R.string.filters_distance)
        val distanceValue = brandString(R.string.filters_distance_value, number(distance.roundToInt()))
        SliderHeader(distanceLabel, distanceValue)
        AppSlider(
            value = distance,
            onValueChange = { distance = it },
            valueRange = MIN_KM.toFloat()..Widening.MAX_DISTANCE_KM.toFloat(),
            enabled = !wholeCountry,
            label = distanceLabel,
            valueText = distanceValue,
        )
        SwitchRow(
            countryName(country)?.let { brandString(R.string.filters_anywhere_in, it) } ?: brandString(R.string.filters_anywhere),
            wholeCountry,
        ) { wholeCountry = it }
        Separator()

        val ageLabel = brandString(R.string.filters_age)
        SliderHeader(ageLabel, brandString(R.string.filters_age_value, number(ages.start.roundToInt()), number(ages.endInclusive.roundToInt())))
        AppRangeSlider(
            value = ages,
            onValueChange = { range ->
                // Keep at least a few years between the two ends.
                ages = if (range.endInclusive - range.start < MIN_AGE_GAP) ages else range
            },
            valueRange = Widening.MIN_AGE.toFloat()..Widening.MAX_AGE.toFloat(),
            label = ageLabel,
            startText = number(ages.start.roundToInt()),
            endText = number(ages.endInclusive.roundToInt()),
        )
        SwitchRow(brandString(R.string.filters_verified_only), verifiedOnly) { verifiedOnly = it }

        if (advancedFields.isNotEmpty() || intentions.isNotEmpty()) {
            Separator()
            Row(Modifier.fillMaxWidth().padding(top = SheetLayout.moreTop, bottom = SheetLayout.moreBottom), verticalAlignment = Alignment.CenterVertically) {
                Text(brandString(R.string.filters_more), style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.weight(1f).semantics { heading() })
                if (!advanced && advancedFields.isNotEmpty()) Pill(brandString(R.string.filters_paid), kind = PillKind.Tint)
            }
            if (intentions.isNotEmpty()) {
                // The server takes intentions from every plan, so this row never opens the paywall.
                val value = intentions.filter { it.first in intents }.joinToString(separator) { it.second }
                    .ifEmpty { brandString(R.string.filters_any) }
                ChoiceRow(brandString(R.string.filters_looking_for), value) { pickingIntents = true }
            }
            advancedFields.forEachIndexed { index, field ->
                val picked = chosen[field.key].orEmpty()
                val value = if (field.kind == RANGE_KIND) {
                    rangeText(field, picked, number) ?: any
                } else {
                    field.options.filter { it.id in picked }.joinToString(separator) { it.label }.ifEmpty { any }
                }
                if (index > 0 || intentions.isNotEmpty()) HorizontalDivider(thickness = 1.dp, color = t.colors.line)
                ChoiceRow(field.label, value) {
                    if (advanced) {
                        if (field.kind == RANGE_KIND) pickingRange = field else picking = field
                    } else {
                        onDismiss()
                        paywall.plans(PaywallEntry.ADVANCED_FILTERS)
                    }
                }
            }
        }

        Spacer(Modifier.height(SheetLayout.applyGap))
        PrimaryButton(
            brandString(R.string.filters_apply),
            {
                val km = distance.roundToInt()
                val min = ages.start.roundToInt()
                val max = ages.endInclusive.roundToInt()
                onApply(
                    PreferencesPatch(
                        maxDistanceKm = km.takeIf { it != start.maxDistanceKm },
                        wholeCountry = wholeCountry.takeIf { it != start.wholeCountry },
                        ageMin = min.takeIf { it != start.ageMin },
                        ageMax = max.takeIf { it != start.ageMax },
                        verifiedOnly = verifiedOnly.takeIf { it != start.verifiedOnly },
                        intents = Intention.entries.filter { it in intents }.takeIf { intents != start.intents.toSet() },
                        filters = chosen.filterValues { it.isNotEmpty() }.mapValues { it.value.sorted() }
                            .takeIf { advanced && it != start.filters },
                    ),
                )
            },
            loading = saving,
        )
    }

    if (pickingIntents) {
        Sheet({ pickingIntents = false }) {
            SheetTitle(brandString(R.string.filters_looking_for))
            Spacer(Modifier.height(SheetLayout.titleGap))
            ChipRow {
                intentions.forEach { (intention, label) ->
                    val on = intention in intents
                    ChoiceChip(label = label, selected = on, onClick = { intents = if (on) intents - intention else intents + intention })
                }
            }
        }
    }

    pickingRange?.let { field ->
        val low = field.min ?: return@let
        val high = field.max ?: return@let
        val picked = chosen[field.key].orEmpty().sorted()
        var range by remember(field.key) {
            mutableStateOf((picked.getOrNull(0) ?: low).toFloat()..(picked.getOrNull(1) ?: high).toFloat())
        }
        Sheet({ pickingRange = null }) {
            SliderHeader(field.label, rangeText(field, chosen[field.key].orEmpty(), number) ?: any)
            AppRangeSlider(
                value = range,
                onValueChange = { next ->
                    val a = next.start.roundToInt()
                    val b = next.endInclusive.roundToInt()
                    // Two distinct ends: the server takes [min, max]; the whole span is no filter at all.
                    if (b > a) {
                        range = next
                        chosen = if (a <= low && b >= high) chosen - field.key else chosen + (field.key to setOf(a, b))
                    }
                },
                valueRange = low.toFloat()..high.toFloat(),
                label = field.label,
                startText = number(range.start.roundToInt()),
                endText = number(range.endInclusive.roundToInt()),
            )
        }
    }

    picking?.let { field ->
        val picked = chosen[field.key].orEmpty()
        Sheet({ picking = null }) {
            SheetTitle(field.label)
            Spacer(Modifier.height(SheetLayout.titleGap))
            ChipRow {
                field.options.forEach { option ->
                    val on = option.id in picked
                    ChoiceChip(
                        label = option.label,
                        selected = on,
                        onClick = { chosen = chosen + (field.key to if (on) picked - option.id else picked + option.id) },
                    )
                }
            }
        }
    }
}

/** A filter's label (`--type-body-strong`) with its value at the end (`--type-body-sm`, `--text-2`). */
@Composable
private fun SliderHeader(label: String, value: String) {
    val t = AppTheme.template
    Row(
        Modifier.fillMaxWidth().padding(top = SheetLayout.sectionTop).semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.weight(1f))
        Text(value, style = t.type.bodySm, color = t.colors.text2)
    }
}

/** A 52 dp row whose whole width is the switch, for a large target and one TalkBack stop. */
@Composable
private fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    val t = AppTheme.template
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = SheetLayout.row)
            .toggleable(value = checked, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.weight(1f))
        AppSwitch(checked = checked, onCheckedChange = null)
    }
}

/** A paid filter's row: its label, its value in `--text-3` and a chevron (52 dp). */
@Composable
private fun ChoiceRow(label: String, value: String, onClick: () -> Unit) {
    val t = AppTheme.template
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = SheetLayout.row)
            .clickable(role = Role.Button, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.weight(1f))
        Text(value, style = t.type.bodySm, color = t.colors.text3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = Space.md))
        Icon(AppIcons.ChevronEnd, contentDescription = null, tint = t.colors.text3, modifier = Modifier.padding(start = Space.sm).size(SheetLayout.chevron))
    }
}

@Composable
private fun Separator() {
    HorizontalDivider(Modifier.padding(vertical = SheetLayout.separator), thickness = 1.dp, color = AppTheme.template.colors.line)
}

/** A range filter's value, «۱۶۰ تا ۱۸۰ سانت» (or «{a} تا {b}» without a unit), or null when unset. */
@Composable
private fun rangeText(field: FieldDef, picked: Set<Int>, number: (Int) -> String): String? {
    if (picked.size != 2) return null
    val (a, b) = picked.sorted()
    val cm = field.unit.equals(CM, ignoreCase = true) || (field.unit.isNullOrEmpty() && field.key == HEIGHT)
    return brandString(if (cm) R.string.filters_cm_range else R.string.filters_age_value, number(a), number(b))
}

private const val RANGE_KIND = "number"
private const val CM = "cm"
private const val HEIGHT = "height"
private const val MIN_KM = 2
private const val MIN_AGE_GAP = 2f

/**
 * The country's name in the screen's language, or null when the code names
 * none. Turkish puts it in the genitive («İran’ın», «Türkiye’nin») for
 * «… her yeri».
 */
@Composable
private fun countryName(iso: String?): String? {
    if (iso.isNullOrBlank() || iso.length != 2) return null
    val language = java.util.Locale.forLanguageTag(app.core.i18n.screenLanguage().tag)
    val name = runCatching { java.util.Locale.Builder().setRegion(iso).build().getDisplayCountry(language) }.getOrNull()
        ?.takeIf { it.isNotBlank() && !it.equals(iso, ignoreCase = true) }
        ?: return null
    return if (language.language == TURKISH) turkishGenitive(name) else name
}

private const val TURKISH = "tr"

/**
 * A Turkish proper name in the genitive, with its apostrophe: the suffix's
 * vowel follows the name's last vowel (ı/a → ın, i/e → in, u/o → un, ü/ö →
 * ün), and an `n` joins it after a final vowel: «İran’ın», «Türkiye’nin»,
 * «Irak’ın», «Almanya’nın».
 */
fun turkishGenitive(name: String): String {
    val lower = name.lowercase(java.util.Locale.forLanguageTag(TURKISH))
    val last = lower.lastOrNull { it in TR_VOWELS } ?: return name
    val vowel = when (last) {
        'a', 'ı' -> 'ı'
        'e', 'i' -> 'i'
        'o', 'u' -> 'u'
        else -> 'ü'
    }
    val joiner = if (lower.last() in TR_VOWELS) "n" else ""
    return "$name’$joiner${vowel}n"
}

private const val TR_VOWELS = "aeıioöuü"

/** The deck sheets' layout, from the design's sheets (m03, m06). */
private object SheetLayout {
    val bottom = 30.dp
    val titleGap = 12.dp
    val lineGap = 6.dp
    val actionsGap = 20.dp
    val buttonsGap = 10.dp
    val titleToFilters = 4.dp
    val sectionTop = 14.dp
    val separator = 6.dp
    val moreTop = 16.dp
    val moreBottom = 2.dp
    val applyGap = 18.dp
    val row = 52.dp
    val chevron = 20.dp
    val liked = 228.dp
    val likedAlignment = androidx.compose.ui.BiasAlignment(0f, -0.64f)
    val labelGap = 16.dp
    val labelToField = 8.dp
    val note = 112.dp
    val notePadH = 18.dp
    val notePadV = 14.dp
    val noteGap = 6.dp
    val buttonGap = 16.dp
    val superGap = 4.dp
}
