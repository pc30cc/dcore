package app.core.feature.onboarding

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.feature.auth.screenLanguage
import app.core.feature.auth.FlowScaffold
import app.core.feature.auth.InlineMessage
import app.core.feature.auth.NoteCard
import app.core.feature.auth.PrimaryButton
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.JalaliDate
import app.core.i18n.JalaliDates
import app.core.i18n.brandString
import app.core.model.Gender
import app.core.model.Intention
import app.core.ui.theme.Radius
import app.core.ui.theme.Space
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale

/** A sign-up step's frame: progress, back, the menu, then the step. */
@Composable
fun OnboardingFrame(
    chrome: StepChrome,
    title: String,
    subtitle: String? = null,
    actions: @Composable ColumnScope.() -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    FlowScaffold(
        title = title,
        subtitle = subtitle,
        onBack = chrome.onBack,
        topBarExtra = { StepProgress(chrome) },
        trailingTopBar = { StepMenu(chrome) },
        actions = actions,
        content = content,
    )
}

// MARK: - Name

@Composable
fun NameStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    val valid = model.nameValid(state.name)
    val showInvalid = state.name.isNotBlank() && !valid
    OnboardingFrame(
        chrome = chrome,
        title = brandString(R.string.onboarding_name_title),
        subtitle = brandString(R.string.onboarding_name_body),
        actions = { PrimaryButton(brandString(R.string.action_next), onClick = model::submitName, enabled = valid, busy = state.busy) },
    ) {
        OutlinedTextField(
            value = state.name,
            onValueChange = model::nameChanged,
            singleLine = true,
            label = { Text(brandString(R.string.onboarding_name_label)) },
            isError = showInvalid || state.error != null,
            supportingText = {
                Text(Digits.localize("${state.name.trim().length}/${OnboardingViewModel.NAME_MAX}", screenLanguage()))
            },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (valid) model.submitName() }),
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(focus)
                .semantics { contentType = ContentType.PersonFirstName },
        )
        InlineMessage(if (showInvalid) brandString(R.string.onboarding_name_invalid) else stepErrorText(state.error))
    }
}

// MARK: - Birth date

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BirthDateStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val language = screenLanguage()
    val today = model.today()
    var confirm by rememberSaveable { mutableStateOf(false) }
    val age = state.age(today)
    OnboardingFrame(
        chrome = chrome,
        title = brandString(R.string.onboarding_birthday_title),
        subtitle = brandString(R.string.onboarding_birthday_body),
        actions = { PrimaryButton(brandString(R.string.action_next), onClick = { confirm = true }, enabled = state.birthDate != null && !state.busy) },
    ) {
        BirthDatePicker(date = state.birthDate, today = today, language = language, onChange = model::birthDateChanged)
        if (age != null) {
            NoteCard {
                Text(
                    brandString(R.string.onboarding_birthday_age, age),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(brandString(R.string.onboarding_birthday_fixed), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        InlineMessage(stepErrorText(state.error))
    }
    if (confirm && age != null) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(brandString(R.string.onboarding_birthday_confirm_title, age)) },
            text = { Text(brandString(R.string.onboarding_birthday_confirm_body, formatDate(state.birthDate!!, language))) },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    model.submitBirthDate()
                }) { Text(brandString(R.string.action_confirm)) }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(brandString(R.string.action_edit)) } },
        )
    }
}

/** A date for reading back: Jalali in Persian, the language's long form otherwise. */
fun formatDate(date: LocalDate, language: AppLanguage): String = if (language == AppLanguage.FA) {
    val j = JalaliDates.toJalali(date)
    Digits.localize("${j.day} ${JALALI_MONTHS[j.month - 1]} ${j.year}", language)
} else {
    java.time.format.DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.LONG).withLocale(Locale.forLanguageTag(language.tag)).format(date)
}

/** The Solar Hijri month names, Farvardin to Esfand (calendar data, the same in every UI language that shows them). */
internal val JALALI_MONTHS = listOf(
    "فروردین", "اردیبهشت", "خرداد",
    "تیر", "مرداد", "شهریور",
    "مهر", "آبان", "آذر",
    "دی", "بهمن", "اسفند",
)

/**
 * Day, month and year as three lists: the Solar Hijri calendar in Persian,
 * the Gregorian one otherwise. Lists rather than a wheel or a calendar grid:
 * they read well with TalkBack and large text, and a birth year is one tap
 * away instead of decades of swiping. No year is hinted at or left out.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BirthDatePicker(date: LocalDate?, today: LocalDate, language: AppLanguage, onChange: (LocalDate?) -> Unit) {
    val jalali = language == AppLanguage.FA
    val locale = Locale.forLanguageTag(language.tag)
    // The three parts in the calendar shown; the date is set once all three are.
    var year by rememberSaveable { mutableStateOf(date?.let { if (jalali) JalaliDates.toJalali(it).year else it.year }) }
    var month by rememberSaveable { mutableStateOf(date?.let { if (jalali) JalaliDates.toJalali(it).month else it.monthValue }) }
    var day by rememberSaveable { mutableStateOf(date?.let { if (jalali) JalaliDates.toJalali(it).day else it.dayOfMonth }) }

    val thisYear = if (jalali) JalaliDates.toJalali(today).year else today.year
    val years = (thisYear downTo thisYear - 100).toList()
    val monthLength = when {
        year == null || month == null -> 31
        jalali -> JalaliDates.monthLength(year!!, month!!)
        else -> java.time.YearMonth.of(year!!, month!!).lengthOfMonth()
    }

    fun emit() {
        val y = year
        val m = month
        val d = day?.coerceAtMost(monthLength)
        if (d != day) day = d
        val result = if (y != null && m != null && d != null) {
            runCatching { if (jalali) JalaliDates.toGregorian(JalaliDate(y, m, d)) else LocalDate.of(y, m, d) }.getOrNull()
        } else {
            null
        }
        onChange(result?.takeIf { !it.isAfter(today) })
    }

    // Two rows: three menus with their arrows do not fit one phone-width row in English or
    // Turkish ("Day" and "Gün" were clipped to one letter, or "September" was). Reading order
    // stays day, month, year.
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            DropdownField(
                label = brandString(R.string.onboarding_birthday_day),
                value = day?.let { Digits.localize(it.toString(), language) },
                options = (1..monthLength).map { it to Digits.localize(it.toString(), language) },
                onPick = { day = it; emit() },
                modifier = Modifier.weight(1f),
            )
            DropdownField(
                label = brandString(R.string.onboarding_birthday_month),
                value = month?.let { monthName(it, jalali, locale) },
                options = (1..12).map { it to monthName(it, jalali, locale) },
                onPick = { month = it; emit() },
                modifier = Modifier.weight(2f),
            )
        }
        DropdownField(
            label = brandString(R.string.onboarding_birthday_year),
            value = year?.let { Digits.localize(it.toString(), language) },
            options = years.map { it to Digits.localize(it.toString(), language) },
            onPick = { year = it; emit() },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

private fun monthName(month: Int, jalali: Boolean, locale: Locale): String =
    if (jalali) JALALI_MONTHS[month - 1] else java.time.Month.of(month).getDisplayName(TextStyle.FULL_STANDALONE, locale)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DropdownField(label: String, value: String?, options: List<Pair<Int, String>>, onPick: (Int) -> Unit, modifier: Modifier = Modifier) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }, modifier = modifier) {
        OutlinedTextField(
            value = value.orEmpty(),
            onValueChange = {},
            readOnly = true,
            singleLine = true,
            label = { Text(label, maxLines = 1) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier.menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (id, text) ->
                DropdownMenuItem(text = { Text(text) }, onClick = {
                    open = false
                    onPick(id)
                })
            }
        }
    }
}

// MARK: - Gender

@Composable
fun GenderStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val language = screenLanguage()
    var confirm by rememberSaveable { mutableStateOf(false) }
    OnboardingFrame(
        chrome = chrome,
        title = brandString(R.string.onboarding_gender_title),
        subtitle = brandString(R.string.onboarding_gender_body),
        actions = { PrimaryButton(brandString(R.string.action_next), onClick = { confirm = true }, enabled = state.gender != null, busy = state.busy) },
    ) {
        GENDERS.forEach { gender ->
            OptionCard(
                title = brandString(gender.label()),
                selected = state.gender == gender,
                onClick = { model.genderChanged(gender) },
            )
        }
        InlineMessage(stepErrorText(state.error))
    }
    val birth = state.birthDate
    if (confirm && birth != null && state.gender != null) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(brandString(R.string.onboarding_basics_confirm_title)) },
            text = {
                Text(brandString(R.string.onboarding_basics_confirm_body, formatDate(birth, language), brandString(state.gender.label())))
            },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    model.submitBasics()
                }) { Text(brandString(R.string.action_confirm)) }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(brandString(R.string.action_edit)) } },
        )
    }
}

private val GENDERS = listOf(Gender.Woman, Gender.Man, Gender.Nonbinary)

fun Gender.label(): Int = when (this) {
    Gender.Woman -> R.string.gender_woman
    Gender.Man -> R.string.gender_man
    Gender.Nonbinary, Gender.Unknown -> R.string.gender_nonbinary
}

private fun Gender.peopleLabel(): Int = when (this) {
    Gender.Woman -> R.string.interest_women
    Gender.Man -> R.string.interest_men
    Gender.Nonbinary, Gender.Unknown -> R.string.interest_nonbinary
}

// MARK: - Interested in

@Composable
fun InterestedInStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    OnboardingFrame(
        chrome = chrome,
        title = brandString(R.string.onboarding_interest_title),
        subtitle = brandString(R.string.onboarding_interest_body),
        actions = { PrimaryButton(brandString(R.string.action_next), onClick = model::submitInterests, enabled = state.interestedIn.isNotEmpty(), busy = state.busy) },
    ) {
        GENDERS.forEach { gender ->
            OptionCard(
                title = brandString(gender.peopleLabel()),
                selected = gender in state.interestedIn,
                multiple = true,
                onClick = { model.toggleInterest(gender) },
            )
        }
        NoteCard(icon = { Icon(Icons.Filled.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.primary) }) {
            Text(brandString(R.string.onboarding_interest_consent), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        InlineMessage(stepErrorText(state.error))
    }
}

// MARK: - Intention

@Composable
fun IntentionStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    // The catalogue's labels when the server has them, the app's own otherwise.
    val catalog = state.config?.catalog?.intentions.orEmpty().associate { it.key to it.label }
    OnboardingFrame(
        chrome = chrome,
        title = brandString(R.string.onboarding_goal_title),
        subtitle = brandString(R.string.onboarding_goal_body),
        actions = { PrimaryButton(brandString(R.string.action_next), onClick = model::submitIntention, enabled = state.intention != null, busy = state.busy) },
    ) {
        INTENTIONS.forEach { (intention, icon, label) ->
            OptionCard(
                title = catalog[intention.wire]?.takeIf { it.isNotBlank() } ?: brandString(label),
                selected = state.intention == intention,
                icon = icon,
                onClick = { model.intentionChanged(intention) },
            )
        }
        Text(brandString(R.string.onboarding_goal_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        InlineMessage(stepErrorText(state.error))
    }
}

private val INTENTIONS: List<Triple<Intention, ImageVector, Int>> = listOf(
    Triple(Intention.Serious, Icons.Filled.Favorite, R.string.intention_serious),
    Triple(Intention.Marriage, Icons.Filled.Star, R.string.intention_marriage),
    Triple(Intention.Friendship, Icons.Filled.Person, R.string.intention_friendship),
    Triple(Intention.NotSure, Icons.Filled.Info, R.string.intention_not_sure),
)

// MARK: - The option card every choice step uses

/**
 * One choice: a large card, its state shown by the border, the fill and a
 * check, and read by TalkBack as a radio button or a checkbox ([multiple]).
 */
@Composable
fun OptionCard(
    title: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    icon: ImageVector? = null,
    multiple: Boolean = false,
) {
    val haptics = LocalHapticFeedback.current
    val colors = MaterialTheme.colorScheme
    val border by animateColorAsState(if (selected) colors.primary else colors.outlineVariant, label = "optionBorder")
    val fill by animateColorAsState(if (selected) colors.primaryContainer else colors.surfaceContainerLow, label = "optionFill")
    val select = {
        haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
        onClick()
    }
    val interaction = if (multiple) {
        Modifier.toggleable(value = selected, role = Role.Checkbox, onValueChange = { select() })
    } else {
        Modifier.selectable(selected = selected, role = Role.RadioButton, onClick = select)
    }
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp),
        shape = RoundedCornerShape(Radius.lg),
        color = fill,
        border = BorderStroke(if (selected) 2.dp else 1.dp, border),
    ) {
        Row(
            interaction.padding(horizontal = Space.lg, vertical = Space.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            if (icon != null) Icon(icon, contentDescription = null, tint = if (selected) colors.onPrimaryContainer else colors.primary)
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = if (selected) colors.onPrimaryContainer else colors.onSurface)
                if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
            }
            if (selected) Icon(Icons.Filled.Check, contentDescription = null, tint = colors.primary, modifier = Modifier.size(24.dp))
        }
    }
}
