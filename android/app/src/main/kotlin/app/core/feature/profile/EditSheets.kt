@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package app.core.feature.profile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.feature.onboarding.FieldAnswer
import app.core.feature.onboarding.PromptPickSheet
import app.core.feature.onboarding.numberText
import app.core.i18n.AppLanguage
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.i18n.screenLanguage
import app.core.model.Catalog
import app.core.model.FieldDef
import app.core.model.OwnProfile
import app.core.model.ProfileFieldValue
import app.core.ui.components.AppBottomSheet
import app.core.ui.components.AppSlider
import app.core.ui.components.AppTextArea
import app.core.ui.components.AppTextField
import app.core.ui.components.ChipRow
import app.core.ui.components.ChoiceChip
import app.core.ui.components.ChoiceKind
import app.core.ui.components.HelperLine
import app.core.ui.components.SheetBody
import app.core.ui.components.SliderLabel
import app.core.ui.components.TextAction
import app.core.ui.components.TextActionKind
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** A field's answer as the editor lists it: «۱۷۸ سانت», an option's label, several joined, a text; null when not answered. */
@Composable
internal fun fieldValueText(field: FieldDef, value: ProfileFieldValue?, language: AppLanguage, separator: String): String? = when (field.kind) {
    "number" -> value?.number?.let { n ->
        if (field.isCentimetres()) brandString(R.string.profile_fact_cm, Numerals.format(n, language)) else numberText(field, n, language)
    }
    "single" -> field.options.firstOrNull { it.id == value?.option }?.label
    "multi" -> value?.options.orEmpty().mapNotNull { id -> field.options.firstOrNull { it.id == id }?.label }.takeIf { it.isNotEmpty() }?.joinToString(separator)
    else -> value?.text?.takeIf { it.isNotBlank() }
}

/**
 * The sheet [sheet] names, over the editor; [onSheet] opens another or
 * closes (null). A sheet that saves waits for the server with its button at
 * work, closes once saved, and otherwise says why under what was written,
 * which stays.
 */
@Composable
internal fun EditSheets(sheet: EditSheet?, model: EditProfileModel, profile: OwnProfile, catalog: Catalog, saving: Boolean, onSheet: (EditSheet?) -> Unit) {
    val close = { onSheet(null) }
    // A sheet whose save is on its way stays until the server answers: closed then, what was written would be lost unsaid.
    val dismiss = { if (!saving) close() }
    val questions = catalog.prompts.filter { it.category != VOICE_CATEGORY }
    val prompts = model.prompts()
    val answered = model.answered()
    val scope = rememberCoroutineScope()
    val open by rememberUpdatedState(sheet)
    // Why the last save of the open sheet did not go through; cleared when another sheet opens.
    var failed by remember(sheet) { mutableStateOf<Int?>(null) }
    val error = failed?.let { brandString(it) }
    fun saveThen(save: suspend () -> SaveOutcome) {
        val started = sheet
        scope.launch {
            val outcome = save()
            // Only the sheet that saved is closed or told: never one opened since.
            if (open != started) return@launch
            when (outcome) {
                SaveOutcome.Saved -> close()
                is SaveOutcome.Failed -> failed = outcome.text
                SaveOutcome.NotSent -> Unit
            }
        }
    }
    when (sheet) {
        null -> Unit
        EditSheet.Pick -> PromptPickSheet(
            catalog = questions,
            answered = answered.map { it.promptId }.toSet(),
            current = null,
            onPick = { id -> onSheet(EditSheet.Answer(id, null)) },
            onDismiss = close,
        )
        is EditSheet.Change -> {
            val current = prompts.firstOrNull { it.position == sheet.position }?.promptId
            PromptPickSheet(
                catalog = questions,
                answered = answered.map { it.promptId }.toSet() - setOfNotNull(current),
                current = current,
                onPick = { id -> onSheet(EditSheet.Answer(id, sheet.position)) },
                onDismiss = close,
            )
        }
        is EditSheet.Answer -> {
            val replacing = sheet.position?.let { p -> prompts.firstOrNull { it.position == p } }
            AnswerSheet(
                question = questions.firstOrNull { it.id == sheet.promptId }?.text.orEmpty(),
                initial = replacing?.takeIf { it.promptId == sheet.promptId }?.answer.orEmpty(),
                existing = replacing != null,
                saving = saving,
                error = error,
                onSave = { text -> saveThen { model.savePrompt(sheet.promptId, text, replacing) } },
                onChange = { sheet.position?.let { onSheet(EditSheet.Change(it)) } },
                onRemove = { replacing?.let { prompt -> saveThen { model.removePrompt(prompt) } } },
                onDismiss = dismiss,
            )
        }
        is EditSheet.Field -> {
            val field = model.fields().firstOrNull { it.id == sheet.fieldId }
            if (field == null) {
                close()
            } else {
                FieldSheet(field, profile.fields.firstOrNull { it.fieldId == field.id }, saving = saving, error = error, onDismiss = dismiss) { answer ->
                    saveThen { model.saveField(field, answer) }
                }
            }
        }
        EditSheet.Job -> TextSheet(brandString(R.string.edit_work), profile.job.orEmpty(), EditProfileModel.JOB_MAX, area = false, saving = saving, error = error, onDismiss = dismiss) {
            saveThen { model.saveJob(it) }
        }
        EditSheet.About -> TextSheet(brandString(R.string.edit_bio), profile.about.orEmpty(), model.aboutMax(), area = true, saving = saving, error = error, onDismiss = dismiss) {
            saveThen { model.saveAbout(it) }
        }
    }
}

/** Why a save did not go through, under what was written (`--error`). */
@Composable
private fun SaveError(error: String?) {
    if (error != null) HelperLine(error, Modifier.padding(top = EditSheetLayout.errorTop), error = true)
}

/** A question's answer: the question as the title, the answer, «عوض کن» and «حذف» for one already there, «ذخیره». */
@Composable
private fun AnswerSheet(
    question: String,
    initial: String,
    existing: Boolean,
    saving: Boolean,
    error: String?,
    onSave: (String) -> Unit,
    onChange: () -> Unit,
    onRemove: () -> Unit,
    onDismiss: () -> Unit,
) {
    var text by rememberSaveable(question) { mutableStateOf(initial) }
    AppBottomSheet(onDismissRequest = onDismiss, dismissible = !saving) {
        SheetBody(
            title = question,
            action = brandString(R.string.edit_save),
            onAction = { onSave(text) },
            actionEnabled = text.isNotBlank(),
            actionLoading = saving,
        ) {
            AppTextArea(text, { text = it }, maxLength = EditProfileModel.PROMPT_MAX, placeholder = question, minHeight = EditSheetLayout.answerHeight)
            SaveError(error)
            if (existing) {
                Row(Modifier.fillMaxWidth().padding(top = EditSheetLayout.actionsTop), horizontalArrangement = Arrangement.spacedBy(EditSheetLayout.actionsGap)) {
                    TextAction(brandString(R.string.onboarding_prompts_change), onChange, enabled = !saving)
                    TextAction(brandString(R.string.edit_remove), onRemove, kind = TextActionKind.Destructive, enabled = !saving)
                }
            }
        }
    }
}

/** One catalogue field: a slider for a number, chips for choices (several for a multiple one), a field for a text; «ذخیره». */
@Composable
private fun FieldSheet(field: FieldDef, value: ProfileFieldValue?, saving: Boolean, error: String?, onDismiss: () -> Unit, onSave: (FieldAnswer) -> Unit) {
    val language = screenLanguage()
    val separator = brandString(R.string.profile_list_separator)
    var number by rememberSaveable(field.id) { mutableStateOf(value?.number) }
    var option by rememberSaveable(field.id) { mutableStateOf(value?.option) }
    var options by rememberSaveable(field.id) { mutableStateOf(value?.options.orEmpty()) }
    var text by rememberSaveable(field.id) { mutableStateOf(value?.text.orEmpty()) }
    AppBottomSheet(onDismissRequest = onDismiss, dismissible = !saving) {
        SheetBody(
            title = field.label,
            action = brandString(R.string.edit_save),
            onAction = { onSave(FieldAnswer(option = option, options = options.toSet(), number = number, text = text)) },
            actionLoading = saving,
        ) {
            when (field.kind) {
                "number" -> {
                    val min = field.min ?: 0
                    val max = (field.max ?: (min + 100)).coerceAtLeast(min + 1)
                    val shown = fieldValueText(field, ProfileFieldValue(field.id, number = number), language, separator)
                    SliderLabel(field.label, shown.orEmpty())
                    AppSlider(
                        value = (number ?: (min + max) / 2).toFloat(),
                        onValueChange = { number = it.roundToInt() },
                        valueRange = min.toFloat()..max.toFloat(),
                        filled = number != null,
                        modifier = Modifier.fillMaxWidth().semantics {
                            contentDescription = field.label
                            stateDescription = shown.orEmpty()
                        },
                    )
                }
                "single", "multi" -> ChipRow(Modifier.fillMaxWidth(), group = field.kind != "multi") {
                    val multi = field.kind == "multi"
                    field.options.forEach { o ->
                        val on = if (multi) o.id in options else option == o.id
                        ChoiceChip(o.label, on, kind = if (multi) ChoiceKind.Multi else ChoiceKind.Single, onClick = {
                            if (multi) options = if (on) options - o.id else options + o.id else option = if (on) null else o.id
                        })
                    }
                }
                else -> AppTextField(value = text, onValueChange = { text = it }, maxLength = FIELD_TEXT_MAX, placeholder = field.label)
            }
            SaveError(error)
        }
    }
}

/** The job or the about text: the field, «ذخیره» (an empty one clears it). */
@Composable
private fun TextSheet(title: String, initial: String, maxLength: Int, area: Boolean, saving: Boolean, error: String?, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var text by rememberSaveable(title) { mutableStateOf(initial) }
    AppBottomSheet(onDismissRequest = onDismiss, dismissible = !saving) {
        SheetBody(title = title, action = brandString(R.string.edit_save), onAction = { onSave(text) }, actionLoading = saving) {
            if (area) {
                AppTextArea(text, { text = it }, maxLength = maxLength, placeholder = title)
            } else {
                AppTextField(value = text, onValueChange = { text = it }, maxLength = maxLength, placeholder = title)
            }
            SaveError(error)
        }
    }
}

/** The sheets on the design's phone (dp). */
private object EditSheetLayout {
    val answerHeight = 96.dp
    val actionsTop = 8.dp
    val actionsGap = 4.dp
    val errorTop = 8.dp
}

private const val VOICE_CATEGORY = "voice"
private const val FIELD_TEXT_MAX = 60
