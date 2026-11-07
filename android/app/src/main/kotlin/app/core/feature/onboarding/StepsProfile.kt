package app.core.feature.onboarding

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.feature.auth.screenLanguage
import app.core.feature.auth.InlineMessage
import app.core.feature.auth.PrimaryButton
import app.core.feature.auth.brandPlural
import app.core.i18n.Digits
import app.core.i18n.brandString
import app.core.model.FieldDef
import app.core.ui.theme.Radius
import app.core.ui.theme.Space
import kotlin.math.roundToInt

// MARK: - Prompts

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PromptsStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val catalog = state.config?.catalog?.prompts.orEmpty().filter { it.category != "voice" }
    val max = state.config?.limits?.promptsMax ?: 3
    var choosing by rememberSaveable { mutableStateOf(false) }
    val language = screenLanguage()
    val ready = state.prompts.isNotEmpty() && state.prompts.all { it.answer.isNotBlank() }
    OnboardingFrame(
        chrome = chrome,
        title = brandString(R.string.onboarding_prompts_title),
        subtitle = brandPlural(R.plurals.onboarding_prompts_body, max, max),
        actions = {
            PrimaryButton(brandString(R.string.action_next), onClick = { model.submitPrompts() }, enabled = ready, busy = state.busy)
            TextButton(onClick = { model.submitPrompts(skip = true) }, enabled = !state.busy) { Text(brandString(R.string.action_skip_for_now)) }
        },
    ) {
        state.prompts.forEach { answer ->
            val prompt = catalog.firstOrNull { it.id == answer.promptId } ?: return@forEach
            Surface(shape = RoundedCornerShape(Radius.lg), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(Space.lg), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(prompt.text, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f).semantics { heading() })
                        IconButton(onClick = { model.promptRemoved(prompt.id) }) {
                            Icon(Icons.Filled.Close, contentDescription = brandString(R.string.onboarding_prompts_remove, prompt.text))
                        }
                    }
                    OutlinedTextField(
                        value = answer.answer,
                        onValueChange = { model.promptAnswered(prompt.id, it) },
                        placeholder = { Text(brandString(R.string.onboarding_prompts_answer)) },
                        minLines = 2,
                        maxLines = 5,
                        supportingText = { Text(Digits.localize("${answer.answer.length}/${OnboardingViewModel.PROMPT_MAX}", language)) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
        val left = catalog.filter { c -> state.prompts.none { it.promptId == c.id } }
        if (state.prompts.size < max && left.isNotEmpty()) {
            OutlinedButton(onClick = { choosing = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp), shape = RoundedCornerShape(Radius.pill)) {
                Icon(Icons.Filled.Add, contentDescription = null)
                Text(brandString(R.string.onboarding_prompts_add), modifier = Modifier.padding(start = Space.sm))
            }
        }
        InlineMessage(stepErrorText(state.error))
        if (choosing) {
            ModalBottomSheet(onDismissRequest = { choosing = false }) {
                Text(
                    brandString(R.string.onboarding_prompts_pick),
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.padding(horizontal = Space.gutter, vertical = Space.sm),
                )
                Column(Modifier.padding(bottom = Space.xl)) {
                    left.forEach { prompt ->
                        ListItem(
                            headlineContent = { Text(prompt.text) },
                            modifier = Modifier.clickable {
                                model.promptAdded(prompt.id)
                                choosing = false
                            },
                        )
                    }
                }
            }
        }
    }
}

// MARK: - Fields

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FieldsStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val fields = model.offeredFields()
    val language = screenLanguage()
    OnboardingFrame(
        chrome = chrome,
        title = brandString(R.string.onboarding_fields_title),
        subtitle = brandString(R.string.onboarding_fields_body),
        actions = {
            PrimaryButton(brandString(R.string.action_next), onClick = { model.submitFields() }, enabled = model.fieldsComplete(), busy = state.busy)
            if (fields.none { it.required }) {
                TextButton(onClick = { model.submitFields(skip = true) }, enabled = !state.busy) { Text(brandString(R.string.action_skip_for_now)) }
            }
        },
    ) {
        fields.forEach { field ->
            val answer = state.fields[field.id] ?: FieldAnswer()
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm), modifier = Modifier.padding(vertical = Space.xs)) {
                Text(
                    if (field.required) brandString(R.string.onboarding_fields_required, field.label) else field.label,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.semantics { heading() },
                )
                when (field.kind) {
                    "single", "multi" -> FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                        val multi = field.kind == "multi"
                        field.options.forEach { option ->
                            val on = if (multi) option.id in answer.options else answer.option == option.id
                            FilterChip(
                                selected = on,
                                onClick = {
                                    val next = if (multi) {
                                        answer.copy(options = if (on) answer.options - option.id else answer.options + option.id)
                                    } else {
                                        answer.copy(option = if (on) null else option.id)
                                    }
                                    model.fieldChanged(field.id, next)
                                },
                                label = { Text(option.label) },
                                modifier = Modifier.heightIn(min = 40.dp),
                            )
                        }
                    }
                    "number" -> NumberField(field, answer, language) { model.fieldChanged(field.id, answer.copy(number = it)) }
                    else -> OutlinedTextField(
                        value = answer.text,
                        onValueChange = { model.fieldChanged(field.id, answer.copy(text = it.take(TEXT_MAX))) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
        InlineMessage(stepErrorText(state.error))
    }
}

private const val TEXT_MAX = 60

@Composable
private fun NumberField(field: FieldDef, answer: FieldAnswer, language: app.core.i18n.AppLanguage, onChange: (Int?) -> Unit) {
    val min = field.min ?: 0
    val max = (field.max ?: (min + 100)).coerceAtLeast(min + 1)
    val value = answer.number
    val shown = value?.let { Digits.localize(it.toString(), language) + (field.unit?.let { u -> " $u" } ?: "") }
        ?: brandString(R.string.onboarding_fields_not_set)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
        Slider(
            value = (value ?: (min + max) / 2).toFloat(),
            onValueChange = { onChange(it.roundToInt()) },
            valueRange = min.toFloat()..max.toFloat(),
            modifier = Modifier.weight(1f).semantics { stateDescription = shown },
        )
        Text(shown, style = MaterialTheme.typography.titleMedium)
        if (value != null) {
            IconButton(onClick = { onChange(null) }) { Icon(Icons.Filled.Close, contentDescription = brandString(R.string.onboarding_fields_clear, field.label)) }
        }
    }
}
