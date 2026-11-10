package app.core.feature.onboarding

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.drawBehind
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.i18n.screenLanguage
import app.core.model.FieldDef
import app.core.model.PromptDef
import app.core.ui.components.AppBottomSheet
import app.core.ui.components.AppRadio
import app.core.ui.components.AppSlider
import app.core.ui.components.AppTextField
import app.core.ui.components.ChipRow
import app.core.ui.components.ChoiceChip
import app.core.ui.components.ChoiceKind
import app.core.ui.components.PrimaryButton
import app.core.ui.components.SheetBody
import app.core.ui.components.overhangingTarget
import app.core.ui.components.templateCard
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import kotlin.math.roundToInt

// MARK: - Prompts

/** What the pick sheet is for: another question, or a different one in place of [promptId]. */
private sealed interface Picking {
    data object Add : Picking
    data class Change(val promptId: Int) : Picking
}

/** An open pick sheet, kept across a configuration change: the question it replaces, or [ADD_SAVED] for another one. */
private val PickingSaver = Saver<Picking?, Int>(
    save = { picking ->
        when (picking) {
            null -> null
            Picking.Add -> ADD_SAVED
            is Picking.Change -> picking.promptId
        }
    },
    restore = { if (it == ADD_SAVED) Picking.Add else Picking.Change(it) },
)

private const val ADD_SAVED = Int.MIN_VALUE

/**
 * Up to three answered questions: each a card (question, answer); the one
 * being written has the 2 dp ring, «عوض کن» (another question in its place)
 * and the count; «یه سؤال دیگه» as a dashed row while there is room.
 * Optional: «رد شو» at the top.
 */
@Composable
fun PromptsStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val catalog = state.config?.catalog?.prompts.orEmpty().filter { it.category != "voice" }
    val max = state.config?.limits?.promptsMax ?: 3
    val language = screenLanguage()
    var picking by rememberSaveable(stateSaver = PickingSaver) { mutableStateOf<Picking?>(null) }
    var editing by rememberSaveable { mutableStateOf<Int?>(null) }
    OnboardingPage(
        chrome = chrome,
        title = brandString(R.string.onboarding_prompts_title),
        subtitle = brandString(R.string.onboarding_prompts_max, Numerals.format(max, language)),
        onSkip = if (!state.busy) ({ model.submitPrompts(skip = true) }) else null,
        error = stepErrorText(state.error),
        actions = {
            PrimaryButton(
                brandString(R.string.onboarding_continue),
                { model.submitPrompts() },
                enabled = state.prompts.any { it.answer.isNotBlank() },
                loading = state.busy,
            )
        },
    ) {
        Gap(OnboardingLayout.cardsTop)
        Column(verticalArrangement = Arrangement.spacedBy(OnboardingLayout.cardGap)) {
            state.prompts.forEach { answer ->
                val prompt = catalog.firstOrNull { it.id == answer.promptId } ?: return@forEach
                PromptCard(
                    question = prompt.text,
                    answer = answer.answer,
                    editing = editing == prompt.id,
                    language = language,
                    onEdit = { editing = prompt.id },
                    onAnswer = { model.promptAnswered(prompt.id, it) },
                    onChange = { picking = Picking.Change(prompt.id) },
                    onRemove = {
                        model.promptRemoved(prompt.id)
                        if (editing == prompt.id) editing = null
                    },
                )
            }
            val left = catalog.filter { c -> state.prompts.none { it.promptId == c.id } }
            if (state.prompts.size < max && left.isNotEmpty()) {
                AddQuestionRow {
                    // Another question: the one being written is done with.
                    editing = null
                    picking = Picking.Add
                }
            }
        }
    }

    val open = picking
    if (open != null) {
        val current = (open as? Picking.Change)?.promptId
        PromptPickSheet(
            catalog = catalog,
            answered = state.prompts.map { it.promptId }.toSet() - setOfNotNull(current),
            current = current,
            onPick = { id ->
                when (open) {
                    Picking.Add -> model.promptAdded(id)
                    is Picking.Change -> model.promptReplaced(open.promptId, id)
                }
                editing = id
                picking = null
            },
            onDismiss = { picking = null },
        )
    }
}

/**
 * One question and its answer on a card (`--r-card`, `--surface-1`,
 * `--card-shadow`); a tap writes in it. Being written: the 2 dp
 * `--primary-ring`, the answer as a field (`--type-body-strong`), «عوض کن»
 * at the question's end and the count («۴۹ / ۱۵۰») under it.
 */
@Composable
private fun PromptCard(
    question: String,
    answer: String,
    editing: Boolean,
    language: AppLanguage,
    onEdit: () -> Unit,
    onAnswer: (String) -> Unit,
    onChange: () -> Unit,
    onRemove: () -> Unit,
) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.card)
    val remove = brandString(R.string.onboarding_prompts_remove, question)
    val change = brandString(R.string.onboarding_prompts_change)
    val actions = Modifier.semantics {
        customActions = listOf(
            CustomAccessibilityAction(change) { onChange(); true },
            CustomAccessibilityAction(remove) { onRemove(); true },
        )
    }
    if (!editing) {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(shape)
                .templateCard(shape)
                .clickable(onClick = onEdit)
                .then(actions)
                .padding(horizontal = PromptLayout.padX, vertical = PromptLayout.padY),
        ) {
            Text(question, style = t.type.section, color = t.colors.text2)
            if (answer.isNotBlank()) {
                Text(answer, style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.padding(top = PromptLayout.answerTop))
            }
        }
        return
    }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    val label = brandString(R.string.onboarding_prompts_answer)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .border(PromptLayout.ring, t.paints.primaryRing, shape)
            .then(actions)
            .padding(horizontal = PromptLayout.padX - PromptLayout.ring, vertical = PromptLayout.padY - PromptLayout.ring),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(question, style = t.type.section, color = t.colors.text2, modifier = Modifier.weight(1f))
            Text(
                change,
                style = t.type.link,
                color = t.colors.primary,
                maxLines = 1,
                modifier = Modifier.overhangingTarget(onChange).padding(start = PromptLayout.changeGap),
            )
        }
        BasicTextField(
            value = answer,
            onValueChange = onAnswer,
            textStyle = t.type.bodyStrong.copy(color = t.colors.text),
            cursorBrush = SolidColor(t.colors.caret),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = PromptLayout.answerTop)
                .focusRequester(focus)
                .semantics { contentDescription = label },
        )
        Text(
            brandString(R.string.onboarding_prompts_count, Numerals.format(answer.length, language), Numerals.format(OnboardingViewModel.PROMPT_MAX, language)),
            style = t.type.bodySm,
            color = if (answer.length > OnboardingViewModel.PROMPT_MAX) t.colors.error else t.colors.text3,
            textAlign = TextAlign.End,
            modifier = Modifier.fillMaxWidth().padding(top = PromptLayout.countTop),
        )
    }
}

/** «یه سؤال دیگه»: a dashed 56 dp row (`--line-strong`) with the add mark, in `--primary`. */
@Composable
private fun AddQuestionRow(onClick: () -> Unit) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.card)
    Row(
        Modifier
            .fillMaxWidth()
            .height(PromptLayout.addHeight)
            .clip(shape)
            .drawBehind {
                val stroke = PromptLayout.dash.toPx()
                drawRoundRect(
                    t.colors.lineStrong,
                    topLeft = Offset(stroke / 2, stroke / 2),
                    size = Size(size.width - stroke, size.height - stroke),
                    cornerRadius = CornerRadius(t.radii.card.toPx()),
                    style = Stroke(stroke, pathEffect = PathEffect.dashPathEffect(floatArrayOf(PromptLayout.dashOn.toPx(), PromptLayout.dashOff.toPx()))),
                )
            }
            .clickable(role = Role.Button, onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(AppIcons.Plus, contentDescription = null, tint = t.colors.primary, modifier = Modifier.size(PromptLayout.addIcon))
        Spacer(Modifier.width(PromptLayout.addGap))
        Text(brandString(R.string.onboarding_prompts_add), style = t.type.link, color = t.colors.primary)
    }
}

/**
 * «یه سؤال انتخاب کن»: the catalogue's questions as rows with the radio at
 * the start, the answered ones greyed with «جواب دادی» at the end, then
 * «انتخاب». No subtitle.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PromptPickSheet(catalog: List<PromptDef>, answered: Set<Int>, current: Int?, onPick: (Int) -> Unit, onDismiss: () -> Unit) {
    val t = AppTheme.template
    var choice by rememberSaveable { mutableStateOf(current) }
    val open = catalog.filter { it.id !in answered }
    val done = catalog.filter { it.id in answered }
    AppBottomSheet(onDismissRequest = onDismiss) {
        SheetBody(
            title = brandString(R.string.onboarding_prompts_pick),
            action = brandString(R.string.onboarding_prompts_choose),
            onAction = { choice?.let(onPick) },
            actionEnabled = choice != null,
        ) {
            (open + done).forEachIndexed { index, prompt ->
                val taken = prompt.id in answered
                Row(
                    Modifier
                        .fillMaxWidth()
                        .topHairline(index > 0)
                        .heightIn(min = PromptLayout.pickRow)
                        .then(if (taken) Modifier else Modifier.selectable(selected = choice == prompt.id, role = Role.RadioButton) { choice = prompt.id }),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(PromptLayout.pickGap),
                ) {
                    if (taken) Spacer(Modifier.size(PromptLayout.radio)) else AppRadio(choice == prompt.id)
                    Text(prompt.text, style = t.type.bodyStrong, color = if (taken) t.colors.text3 else t.colors.text, modifier = Modifier.weight(1f))
                    if (taken) Text(brandString(R.string.onboarding_prompts_answered), style = t.type.bodySm, color = t.colors.text3)
                }
            }
        }
    }
}

private object PromptLayout {
    val padX = 18.dp
    val padY = 16.dp
    val ring = 2.dp
    val answerTop = 4.dp
    val countTop = 6.dp
    val changeGap = 12.dp
    val addHeight = 56.dp
    val addIcon = 20.dp
    val addGap = 8.dp
    /** The design's 1.5 dp dashed border as a browser draws it: dashes three times, gaps twice the line. */
    val dash = 1.5.dp
    val dashOn = 4.5.dp
    val dashOff = 3.dp
    val pickRow = 56.dp
    val pickGap = 12.dp
    val radio = 24.dp
}

/**
 * A button ([onClick]) at least 48 dp tall around a one-line link, centred
 * on it, while the link reports only its own height to the row it sits in
 * (the target reaches over the lines around it).
 */
@Composable
internal fun Modifier.overhangingTarget(onClick: () -> Unit): Modifier {
    val natural = remember { IntArray(1) }
    return layout { measurable, constraints ->
        val placeable = measurable.measure(constraints.copy(minHeight = 0, maxHeight = Constraints.Infinity))
        val height = natural[0]
        layout(placeable.width, height) { placeable.place(0, (height - placeable.height) / 2) }
    }.clickable(role = Role.Button, onClick = onClick).layout { measurable, constraints ->
        val placeable = measurable.measure(constraints.copy(minHeight = 0))
        natural[0] = placeable.height
        val height = maxOf(placeable.height, TOUCH_TARGET.roundToPx())
        layout(placeable.width, height) { placeable.place(0, (height - placeable.height) / 2) }
    }
}

private val TOUCH_TARGET = 48.dp

// MARK: - Fields

/**
 * The catalogue's fields, each a section split by hairlines: the label with
 * the value at its end, then a slider (numbers: the height in
 * «سانتی‌متر»/cm, nothing while not set) or chips (44 dp, a check when
 * chosen); a short text is a row with its value and a chevron, opening a
 * sheet. A field kept off the profile says so under its label. Optional
 * unless a field is required: «رد شو» at the top.
 */
@Composable
fun FieldsStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val fields = model.offeredFields()
    val language = screenLanguage()
    // The field whose sheet is open, by id (kept across a configuration change).
    var writing by rememberSaveable { mutableStateOf<Int?>(null) }
    OnboardingPage(
        chrome = chrome,
        title = brandString(R.string.onboarding_fields_title),
        onSkip = if (fields.none { it.required } && !state.busy) ({ model.submitFields(skip = true) }) else null,
        error = stepErrorText(state.error),
        actions = { PrimaryButton(brandString(R.string.onboarding_continue), { model.submitFields() }, enabled = model.fieldsComplete(), loading = state.busy) },
    ) {
        Gap(OnboardingLayout.sectionsTop)
        fields.forEachIndexed { index, field ->
            val answer = state.fields[field.id] ?: FieldAnswer()
            FieldSection(
                field = field,
                answer = answer,
                first = index == 0,
                last = index == fields.lastIndex,
                language = language,
                onChange = { model.fieldChanged(field.id, it) },
                onOpen = { writing = field.id },
            )
        }
    }
    val field = writing?.let { id -> fields.firstOrNull { it.id == id } }
    if (field != null) {
        TextFieldSheet(field, state.fields[field.id]?.text.orEmpty(), onDone = { text ->
            model.fieldChanged(field.id, (state.fields[field.id] ?: FieldAnswer()).copy(text = text))
            writing = null
        }, onDismiss = { writing = null })
    }
}

private const val TEXT_MAX = 60

@Composable
private fun FieldSection(
    field: FieldDef,
    answer: FieldAnswer,
    first: Boolean,
    last: Boolean,
    language: AppLanguage,
    onChange: (FieldAnswer) -> Unit,
    onOpen: () -> Unit,
) {
    val t = AppTheme.template
    Column(
        Modifier
            .fillMaxWidth()
            .padding(
                top = if (first) FieldLayout.firstTop else FieldLayout.padY,
                bottom = when (field.kind) {
                    "number" -> FieldLayout.sliderBottom
                    "single", "multi" -> FieldLayout.chipsBottom
                    else -> FieldLayout.padY
                },
            ),
    ) {
        when (field.kind) {
            "number" -> {
                val min = field.min ?: 0
                val max = (field.max ?: (min + 100)).coerceAtLeast(min + 1)
                val value = answer.number
                val shown = value?.let { numberText(field, it, language) }
                FieldHeader(
                    field,
                    shown,
                    Modifier.padding(bottom = FieldLayout.sliderTop),
                    onClear = if (value != null) ({ onChange(answer.copy(number = null)) }) else null,
                )
                AppSlider(
                    value = (value ?: (min + max) / 2).toFloat(),
                    onValueChange = { onChange(answer.copy(number = it.roundToInt())) },
                    valueRange = min.toFloat()..max.toFloat(),
                    filled = value != null,
                    modifier = Modifier.fillMaxWidth().semantics {
                        contentDescription = field.label
                        stateDescription = shown ?: ""
                    },
                )
            }
            "single", "multi" -> {
                FieldHeader(field, null, Modifier.padding(bottom = FieldLayout.chipsTop))
                val multi = field.kind == "multi"
                ChipRow(Modifier.fillMaxWidth(), group = !multi) {
                    field.options.forEach { option ->
                        val on = if (multi) option.id in answer.options else answer.option == option.id
                        ChoiceChip(option.label, on, kind = if (multi) ChoiceKind.Multi else ChoiceKind.Single, onClick = {
                            onChange(
                                if (multi) {
                                    answer.copy(options = if (on) answer.options - option.id else answer.options + option.id)
                                } else {
                                    answer.copy(option = if (on) null else option.id)
                                },
                            )
                        })
                    }
                }
            }
            else -> TextFieldRow(field, answer.text, onOpen)
        }
    }
    if (!last) HorizontalDivider(thickness = FieldLayout.hairline, color = t.colors.line)
}

/**
 * A section's label (`--type-body-strong`), the private line under it when
 * the field is not shown, the value at the end; [onClear] (a number once
 * set) adds a clear button after the value, a 48 dp target over the row's
 * own height so the slider under it does not move.
 */
@Composable
private fun FieldHeader(field: FieldDef, value: String?, modifier: Modifier = Modifier, onClear: (() -> Unit)? = null) {
    val t = AppTheme.template
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(field.label, style = t.type.bodyStrong, color = t.colors.text, modifier = Modifier.semantics { heading() })
            if (field.isPrivate) Text(brandString(R.string.onboarding_fields_private), style = t.type.bodySm, color = t.colors.text3)
        }
        if (value != null) Text(value, style = t.type.bodySm, color = t.colors.text2)
        if (onClear != null) {
            val clear = brandString(R.string.onboarding_fields_clear, field.label)
            Box(
                Modifier
                    .overhangingTarget(onClear)
                    .widthIn(min = FieldLayout.clearTarget)
                    .semantics { contentDescription = clear },
                contentAlignment = Alignment.CenterEnd,
            ) {
                Icon(AppIcons.Close, contentDescription = null, tint = t.colors.text3, modifier = Modifier.size(FieldLayout.clearIcon))
            }
        }
    }
}

/** A short text answer as a row: the label (and the private line), the value or «انتخاب نشده», a chevron. */
@Composable
private fun TextFieldRow(field: FieldDef, text: String, onOpen: () -> Unit) {
    val t = AppTheme.template
    Row(
        Modifier.fillMaxWidth().heightIn(min = FieldLayout.textRow).clickable(role = Role.Button, onClick = onOpen),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FieldLayout.rowGap),
    ) {
        Column(Modifier.weight(1f)) {
            Text(field.label, style = t.type.bodyStrong, color = t.colors.text)
            if (field.isPrivate) Text(brandString(R.string.onboarding_fields_private), style = t.type.bodySm, color = t.colors.text3)
        }
        Text(text.ifBlank { brandString(R.string.onboarding_fields_not_set) }, style = t.type.bodySm, color = t.colors.text2, maxLines = 1)
        Icon(AppIcons.ChevronEnd, contentDescription = null, tint = t.colors.text3, modifier = Modifier.size(FieldLayout.chevron))
    }
}

/** The sheet a short text is written in: the field's label, the field, «ادامه». */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TextFieldSheet(field: FieldDef, text: String, onDone: (String) -> Unit, onDismiss: () -> Unit) {
    var value by rememberSaveable { mutableStateOf(text) }
    AppBottomSheet(onDismissRequest = onDismiss) {
        SheetBody(title = field.label, action = brandString(R.string.onboarding_continue), onAction = { onDone(value.trim()) }) {
            AppTextField(value = value, onValueChange = { value = it }, maxLength = TEXT_MAX, placeholder = field.label)
        }
    }
}

/** A number with its unit: a height in the screen's language («۱۷۸ سانتی‌متر», "178 cm"), other units as the catalogue names them. */
@Composable
internal fun numberText(field: FieldDef, value: Int, language: AppLanguage): String {
    val number = Numerals.format(value, language)
    val unit = field.unit?.trim()
    return when {
        unit.equals("cm", ignoreCase = true) || (unit.isNullOrEmpty() && field.key == "height") -> brandString(R.string.onboarding_fields_height, number)
        unit.isNullOrEmpty() -> number
        else -> "$number ${Digits.localize(unit, language)}"
    }
}

private object FieldLayout {
    val firstTop = 6.dp
    val padY = 16.dp
    /** Chips sit in 48 dp targets, 2 dp past what is drawn: 12 dp from the label and 16 dp to the hairline, as drawn. */
    val chipsTop = 10.dp
    val chipsBottom = 14.dp
    /** The slider's 48 dp target: its track sits 26 dp under the label and 30 dp over the hairline, as drawn. */
    val sliderTop = 2.dp
    val sliderBottom = 6.dp
    val textRow = 44.dp
    val rowGap = 12.dp
    val chevron = 20.dp
    val hairline = 1.dp
    val clearTarget = 48.dp
    val clearIcon = 18.dp
}
