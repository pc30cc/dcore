package app.core.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.keyframes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.offset
import app.core.R
import app.core.i18n.AppLanguage
import app.core.i18n.Numerals
import app.core.i18n.screenLanguage
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.insetShadow
import androidx.compose.runtime.getValue

/**
 * A field's frame: `--surface-field`, the 1 dp `--field-line` at rest; when
 * focused a 2 dp `--primary-ring` border and nothing else (no halo); in
 * error a 2 dp `--error` border.
 */
@Composable
fun Modifier.fieldFrame(radius: Dp, focused: Boolean, error: Boolean): Modifier {
    val t = AppTheme.template
    val shape = RoundedCornerShape(radius)
    return this
        .background(t.colors.surfaceField, shape)
        .then(
            when {
                error -> Modifier.border(2.dp, t.colors.error, shape)
                focused -> Modifier.border(2.dp, t.paints.primaryRing, shape)
                else -> Modifier.insetShadow(shape, t.shadows.fieldLine)
            },
        )
}

/** A helper or error line under a field: `--type-body-sm`, `--text-3` (or `--error`); never an icon. */
@Composable
fun HelperLine(text: String, modifier: Modifier = Modifier, error: Boolean = false) {
    val t = AppTheme.template
    // An error is announced as it appears (a live region); a hint is read with its field.
    val live = if (error) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier
    Text(text, style = t.type.bodySm, color = if (error) t.colors.error else t.colors.text3, modifier = modifier.then(live))
}

/** The clear button inside a field: a 36 dp `--surface-2` disc with a 16 dp ✕, 48 dp to touch. */
@Composable
private fun ClearButton(onClick: () -> Unit) {
    val t = AppTheme.template
    val clear = stringResource(R.string.ui_clear)
    Box(
        Modifier
            .size(48.dp)
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = clear },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(36.dp).background(t.colors.surface2, CircleShape), contentAlignment = Alignment.Center) {
            Icon(AppIcons.Close, contentDescription = null, tint = t.colors.text2, modifier = Modifier.size(16.dp))
        }
    }
}

/**
 * A text field: 60 dp, `--r-field`; its label above (`--type-section`,
 * `--text-2`); the value in `--type-field`, the placeholder in `--text-3`;
 * the counter («۴ / ۲۰») or, when [clearable], the clear button at the
 * end; a helper or the error under it. The caret is `--caret`.
 */
@Composable
fun AppTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String? = null,
    helper: String? = null,
    error: String? = null,
    maxLength: Int? = null,
    clearable: Boolean = false,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    interactionSource: MutableInteractionSource = remember { MutableInteractionSource() },
) {
    val t = AppTheme.template
    val language = screenLanguage()
    val focused by interactionSource.collectIsFocusedAsState()
    val isError = error != null
    val textStyle = t.type.field.copy(color = t.colors.text).let { style ->
        if (keyboardOptions.keyboardType in DigitKeyboards) {
            // Digits read left to right («۰۹۱۲ ۳۴۵») and stay on the field's start side.
            val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
            style.copy(textDirection = TextDirection.Ltr, textAlign = if (rtl) TextAlign.Right else TextAlign.Left)
        } else {
            style
        }
    }
    val description = label ?: placeholder
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (label != null) {
            Text(label, style = t.type.section, color = t.colors.text2)
        }
        BasicTextField(
            value = value,
            onValueChange = { next -> onValueChange(if (maxLength != null) keepTyped(next, value, maxLength) else next) },
            enabled = enabled,
            singleLine = singleLine,
            textStyle = textStyle,
            cursorBrush = SolidColor(t.colors.caret),
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            visualTransformation = visualTransformation,
            interactionSource = interactionSource,
            modifier = Modifier
                .fillMaxWidth()
                .semantics {
                    if (description != null) contentDescription = description
                    if (error != null) error(error)
                },
            decorationBox = { inner ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 60.dp)
                        .fieldFrame(t.radii.field, focused, isError)
                        .padding(start = 18.dp, end = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.weight(1f).padding(vertical = 14.dp)) {
                        if (value.isEmpty() && placeholder != null) {
                            Text(placeholder, style = t.type.fieldPlaceholder, color = t.colors.text3, maxLines = 1)
                        }
                        inner()
                    }
                    if (maxLength != null) {
                        Text(
                            Numerals.digits("${value.length} / $maxLength", language),
                            style = t.type.bodySm,
                            color = t.colors.text3,
                            modifier = Modifier.padding(horizontal = 12.dp),
                        )
                    } else if (clearable && value.isNotEmpty() && enabled) {
                        ClearButton { onValueChange("") }
                    }
                }
            },
        )
        when {
            error != null -> HelperLine(error, error = true)
            helper != null -> HelperLine(helper)
        }
    }
}

/**
 * A text area (`.field.area`): at least [minHeight], the field's frame, the
 * text in `--type-body` from the top, the placeholder in `--text-3`, and the
 * count («۰ / ۵۰۰») under the text at the end. TalkBack reads it by its
 * placeholder.
 */
@Composable
fun AppTextArea(
    value: String,
    onValueChange: (String) -> Unit,
    maxLength: Int,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    enabled: Boolean = true,
    minHeight: Dp = 120.dp,
    interactionSource: MutableInteractionSource = remember { MutableInteractionSource() },
) {
    val t = AppTheme.template
    val language = screenLanguage()
    val focused by interactionSource.collectIsFocusedAsState()
    BasicTextField(
        value = value,
        onValueChange = { next -> onValueChange(keepTyped(next, value, maxLength)) },
        enabled = enabled,
        textStyle = t.type.body.copy(color = t.colors.text),
        cursorBrush = SolidColor(t.colors.caret),
        interactionSource = interactionSource,
        modifier = modifier
            .fillMaxWidth()
            .semantics { if (placeholder != null) contentDescription = placeholder },
        decorationBox = { inner ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = minHeight)
                    .fieldFrame(t.radii.field, focused, error = false)
                    .padding(horizontal = 18.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Box(Modifier.fillMaxWidth()) {
                    if (value.isEmpty() && placeholder != null) Text(placeholder, style = t.type.body, color = t.colors.text3)
                    inner()
                }
                Text(
                    Numerals.digits("${value.length} / $maxLength", language),
                    style = t.type.bodySm,
                    // Text written under an older, longer limit is kept whole; the count says it is over.
                    color = if (value.length > maxLength) t.colors.error else t.colors.text3,
                    modifier = Modifier.align(Alignment.End),
                )
            }
        },
    )
}

/**
 * What a field keeps of an edit [next] of [current] under [limit]: typing or
 * pasting past the limit is cut at it, but text that is already longer (kept
 * from an older, larger limit) is never shortened by the field; it can only
 * be made shorter by the person.
 */
fun keepTyped(next: String, current: String, limit: Int): String = when {
    next.length <= limit -> next
    current.length <= limit -> next.take(limit)
    next.length <= current.length -> next
    else -> current
}

/** Keyboards whose text is figures only: laid out left to right in every language. */
private val DigitKeyboards = setOf(KeyboardType.Phone, KeyboardType.Number, KeyboardType.NumberPassword, KeyboardType.Decimal)

/**
 * The phone number field: left to right inside a Persian page, the country
 * pill first (44 dp, `--r-sm`, `--surface-2`; a 48 dp target that opens the
 * country list), the digits in the reader's numerals («۹۱۲ ۳۴۵ ۶۷۸۹»
 * through [visualTransformation]), the clear button at the far right.
 * [errorFrame] draws the error border (by default whenever there is an
 * [error] line; off for an error about something other than the number);
 * [fieldModifier] reaches the text field itself (focus, autofill).
 */
@Composable
fun PhoneField(
    value: String,
    onValueChange: (String) -> Unit,
    dialCode: String,
    onCountryClick: () -> Unit,
    contentDescription: String,
    modifier: Modifier = Modifier,
    flag: @Composable () -> Unit = {},
    placeholder: String? = null,
    helper: String? = null,
    error: String? = null,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    imeAction: ImeAction = ImeAction.Done,
    errorFrame: Boolean = error != null,
    fieldModifier: Modifier = Modifier,
    interactionSource: MutableInteractionSource = remember { MutableInteractionSource() },
) {
    val t = AppTheme.template
    val focused by interactionSource.collectIsFocusedAsState()
    val textStyle = t.type.field.copy(color = t.colors.text)
    val countryLabel = stringResource(R.string.ui_country_code, dialCode)
    val pill = RoundedCornerShape(t.radii.sm)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = textStyle,
                cursorBrush = SolidColor(t.colors.caret),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone, imeAction = imeAction),
                keyboardActions = keyboardActions,
                visualTransformation = visualTransformation,
                interactionSource = interactionSource,
                modifier = fieldModifier.fillMaxWidth().semantics {
                    this.contentDescription = contentDescription
                    if (error != null) error(error)
                },
                decorationBox = { inner ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 60.dp)
                            .fieldFrame(t.radii.field, focused, errorFrame)
                            // The pill 10 dp in, plus the 2 dp focus border it sits inside.
                            .padding(start = if (focused && !errorFrame) 12.dp else 10.dp, end = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier
                                .minimumInteractiveComponentSize()
                                .heightIn(min = 48.dp)
                                .clip(pill)
                                .clickable(role = Role.Button, onClick = onCountryClick)
                                .semantics { this.contentDescription = countryLabel },
                            contentAlignment = Alignment.Center,
                        ) {
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.height(44.dp).background(t.colors.surface2, pill).padding(start = 12.dp, end = 10.dp),
                            ) {
                                flag()
                                Text(dialCode, style = t.type.labelSm, color = t.colors.text)
                                Icon(AppIcons.ChevronDown, contentDescription = null, tint = t.colors.text3, modifier = Modifier.size(16.dp))
                            }
                        }
                        Box(Modifier.weight(1f).padding(start = 12.dp, end = 4.dp)) {
                            if (value.isEmpty() && placeholder != null) {
                                Text(placeholder, style = t.type.fieldPlaceholder, color = t.colors.text3, maxLines = 1)
                            }
                            inner()
                        }
                        if (value.isNotEmpty()) ClearButton { onValueChange("") }
                    }
                },
            )
        }
        when {
            error != null -> HelperLine(error, error = true)
            helper != null -> HelperLine(helper)
        }
    }
}

/** A flag of three horizontal bands (22 × 15, `--r-flag`), for the country pill. */
@Composable
fun BandFlag(top: Color, middle: Color, bottom: Color, modifier: Modifier = Modifier) {
    Column(modifier.size(22.dp, 15.dp).clip(RoundedCornerShape(AppTheme.template.radii.flag))) {
        Box(Modifier.fillMaxWidth().weight(1f).background(top))
        Box(Modifier.fillMaxWidth().weight(1f).background(middle))
        Box(Modifier.fillMaxWidth().weight(1f).background(bottom))
    }
}

/** How the code cells look. */
enum class OtpState { Normal, Error }

/**
 * The code's cells (50 × 62, `--r-md`, left to right in every language):
 * empty (`--field-line`), filled (`--otp-filled` added), the next one
 * active (a 2 dp `--primary-ring` border and the caret, no halo), or all in
 * `--error`. The digits are in [language]'s numerals.
 */
@Composable
fun OtpCells(
    code: String,
    length: Int,
    modifier: Modifier = Modifier,
    focused: Boolean = true,
    state: OtpState = OtpState.Normal,
    language: AppLanguage = screenLanguage(),
) {
    val t = AppTheme.template
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        BoxWithConstraints(modifier) {
            // 50 × 62 each, narrower (same proportions) when six do not fit.
            val gap = 10.dp
            val width = if (maxWidth == Dp.Infinity) 50.dp else minOf(50.dp, (maxWidth - gap * (length - 1)) / length)
            val shape = RoundedCornerShape(t.radii.md)
            // Centred in the row.
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap, Alignment.CenterHorizontally)) {
                for (i in 0 until length) {
                    val char = code.getOrNull(i)
                    val active = focused && state == OtpState.Normal && i == code.length
                    val error = state == OtpState.Error
                    val filled = char != null && !error
                    Box(
                        modifier = Modifier
                            .size(width, width * 1.24f)
                            .then(
                                if (filled) {
                                    // `--field-line` over `--otp-filled`: the hairline is drawn on top of the band.
                                    Modifier.background(t.colors.surfaceField, shape).insetShadow(shape, t.shadows.fieldLine + t.shadows.otpFilled)
                                } else {
                                    Modifier.fieldFrame(t.radii.md, active, error)
                                },
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        when {
                            char != null -> Text(
                                Numerals.digits(char.toString(), language),
                                style = t.type.number,
                                color = if (error) t.colors.error else t.colors.text,
                                textAlign = TextAlign.Center,
                            )
                            active -> Box(Modifier.width(2.dp).height(26.dp).background(t.colors.caret, CircleShape))
                        }
                    }
                }
            }
        }
    }
}

