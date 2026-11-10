package app.core.feature.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.selectableGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.JalaliDates
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.i18n.screenLanguage
import app.core.model.Gender
import app.core.model.Intention
import app.core.ui.components.AppDialog
import app.core.ui.components.OptionRow
import app.core.ui.components.PrimaryButton
import app.core.ui.theme.AppTheme
import java.time.LocalDate
import java.util.Locale

// MARK: - Name

/**
 * The first name, typed on a line (`--type-h1`) over a 2 dp
 * `--primary-fill` rule, the count («۳ / ۲۰») at its end; the keyboard
 * comes up at once and «ادامه» rides above it.
 */
@Composable
fun NameStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val t = AppTheme.template
    val language = screenLanguage()
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    val valid = model.nameValid(state.name)
    val showInvalid = state.name.isNotBlank() && !valid
    val title = brandString(R.string.onboarding_name_title)
    OnboardingPage(
        chrome = chrome,
        title = title,
        error = if (showInvalid) brandString(R.string.onboarding_name_invalid) else stepErrorText(state.error),
        actions = { PrimaryButton(brandString(R.string.onboarding_continue), model::submitName, enabled = valid, loading = state.busy) },
    ) {
        Gap(OnboardingLayout.nameTop)
        Box(Modifier.fillMaxWidth().height(NameLayout.height)) {
            Row(
                Modifier.fillMaxWidth().height(NameLayout.height).padding(bottom = NameLayout.ruleGap),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BasicTextField(
                    value = state.name,
                    onValueChange = model::nameChanged,
                    singleLine = true,
                    textStyle = t.type.h1.copy(color = t.colors.text),
                    cursorBrush = SolidColor(t.colors.caret),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { if (valid) model.submitName() }),
                    modifier = Modifier
                        .weight(1f)
                        .focusRequester(focus)
                        .semantics {
                            contentDescription = title
                            contentType = ContentType.PersonFirstName
                        },
                )
                Text(
                    brandString(
                        R.string.onboarding_name_count,
                        Numerals.format(state.name.trim().length, language),
                        Numerals.format(OnboardingViewModel.NAME_MAX, language),
                    ),
                    style = t.type.bodySm,
                    color = if (state.name.trim().length > OnboardingViewModel.NAME_MAX) t.colors.error else t.colors.text3,
                    modifier = Modifier.padding(start = NameLayout.countGap),
                )
            }
            // The rule under the name: the accent (the gradient in neon, ink in white); red while the name is refused.
            Box(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(NameLayout.rule)
                    .then(
                        if (showInvalid || state.error != null) {
                            Modifier.background(t.colors.error, CircleShape)
                        } else {
                            Modifier.background(t.paints.primaryFill, CircleShape)
                        },
                    ),
            )
        }
    }
}

private object NameLayout {
    val height = 68.dp
    val ruleGap = 4.dp
    val rule = 2.dp
    val countGap = 12.dp
}

// MARK: - Birth date

/**
 * The birth date on three wheels; once one has moved, the age and that it
 * is kept for good, in one line («۲۵ سالته. بعداً عوض نمی‌شه.»).
 * «ادامه» asks once more (the age and the date) before the date is kept: it
 * cannot be changed later, and an age under the minimum closes the account.
 */
@Composable
fun BirthDateStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val t = AppTheme.template
    val language = screenLanguage()
    val today = model.today()
    val age = state.age(today)
    var confirming by rememberSaveable { mutableStateOf(false) }
    OnboardingPage(
        chrome = chrome,
        title = brandString(R.string.onboarding_birthday_title),
        error = stepErrorText(state.error),
        actions = {
            PrimaryButton(
                brandString(R.string.onboarding_continue),
                onClick = { confirming = true },
                enabled = state.birthDate != null,
                loading = state.busy,
            )
        },
    ) {
        Gap(OnboardingLayout.wheelsTop)
        BirthdayWheels(date = state.birthDate, today = today, language = language, onChange = model::birthDateChanged)
        if (age != null) {
            Gap(BirthdayLayout.ageTop)
            val ageText = brandString(R.string.onboarding_birthday_age, Numerals.format(age, language))
            val locked = brandString(R.string.onboarding_locked)
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(color = t.colors.text, fontWeight = t.type.h3.fontWeight)) { append(ageText) }
                    append(" ")
                    append(locked)
                },
                style = t.type.bodyStrong,
                color = t.colors.text2,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
    val birth = state.birthDate
    if (confirming && birth != null && age != null) {
        AppDialog(
            title = brandString(R.string.onboarding_birthday_confirm_title, Numerals.format(age, language)),
            body = brandString(R.string.onboarding_birthday_confirm_body, formatDate(birth, language)),
            confirm = brandString(R.string.onboarding_birthday_confirm_yes),
            onConfirm = {
                confirming = false
                model.submitBirthDate()
            },
            dismiss = brandString(R.string.onboarding_birthday_confirm_edit),
            onDismiss = { confirming = false },
            destructive = false,
        )
    }
}

private object BirthdayLayout {
    val ageTop = 26.dp
}

/** A date for reading back: Jalali in Persian, the language's long form otherwise. */
fun formatDate(date: LocalDate, language: AppLanguage): String = if (language == AppLanguage.FA) {
    val j = JalaliDates.toJalali(date)
    Digits.localize("${j.day} ${JALALI_MONTHS[j.month - 1]} ${j.year}", language)
} else {
    java.time.format.DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.LONG).withLocale(Locale.forLanguageTag(language.tag)).format(date)
}

// MARK: - Gender

/** Three plain rows with the radio at the start; the one line says the answer is kept for good. */
@Composable
fun GenderStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    OnboardingPage(
        chrome = chrome,
        title = brandString(R.string.onboarding_gender_title),
        subtitle = brandString(R.string.onboarding_locked),
        error = stepErrorText(state.error),
        actions = { PrimaryButton(brandString(R.string.onboarding_continue), model::submitBasics, enabled = state.gender != null, loading = state.busy) },
    ) {
        Options {
            GENDERS.forEach { gender ->
                Choice(brandString(gender.label()), selected = state.gender == gender) { model.genderChanged(gender) }
            }
        }
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

/** Who to meet: the same rows with a checkbox, one or more. */
@Composable
fun InterestedInStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    OnboardingPage(
        chrome = chrome,
        title = brandString(R.string.onboarding_interest_title),
        subtitle = brandString(R.string.onboarding_interest_body),
        error = stepErrorText(state.error),
        actions = {
            PrimaryButton(brandString(R.string.onboarding_continue), model::submitInterests, enabled = state.interestedIn.isNotEmpty(), loading = state.busy)
        },
    ) {
        Options {
            GENDERS.forEach { gender ->
                Choice(brandString(gender.peopleLabel()), selected = gender in state.interestedIn, multiple = true) { model.toggleInterest(gender) }
            }
        }
    }
}

// MARK: - Intention

/** Four plain rows, no descriptions. The catalogue's labels when the server has them, the app's own otherwise. */
@Composable
fun IntentionStep(state: OnboardingUiState, model: OnboardingViewModel, chrome: StepChrome) {
    val catalog = state.config?.catalog?.intentions.orEmpty().associate { it.key to it.label }
    OnboardingPage(
        chrome = chrome,
        title = brandString(R.string.onboarding_goal_title),
        error = stepErrorText(state.error),
        actions = { PrimaryButton(brandString(R.string.onboarding_continue), model::submitIntention, enabled = state.intention != null, loading = state.busy) },
    ) {
        Options {
            INTENTIONS.forEach { (intention, label) ->
                val text = catalog[intention.wire]?.takeIf { it.isNotBlank() } ?: brandString(label)
                Choice(text, selected = state.intention == intention) { model.intentionChanged(intention) }
            }
        }
    }
}

private val INTENTIONS: List<Pair<Intention, Int>> = listOf(
    Intention.Serious to R.string.intention_serious,
    Intention.Marriage to R.string.intention_marriage,
    Intention.Friendship to R.string.intention_friendship,
    Intention.NotSure to R.string.intention_not_sure,
)

// MARK: - The choice rows every choice step uses

/** The rows of a choice step: 28 dp under the title, 10 dp apart. */
@Composable
private fun Options(content: @Composable () -> Unit) {
    Gap(OnboardingLayout.optionsTop)
    Column(Modifier.fillMaxWidth().semantics { selectableGroup() }, verticalArrangement = Arrangement.spacedBy(OnboardingLayout.optionGap)) { content() }
}

/** One [OptionRow], with the light tick a choice gives. */
@Composable
private fun Choice(label: String, selected: Boolean, multiple: Boolean = false, onClick: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    OptionRow(label, selected, onClick = {
        haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
        onClick()
    }, multiple = multiple)
}
