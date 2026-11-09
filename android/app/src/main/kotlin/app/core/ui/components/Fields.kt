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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.offset
import app.core.R
import app.core.i18n.Numerals
import app.core.i18n.screenLanguage
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Radius

/**
 * A field's frame: the fill, a 1 dp hairline at rest; focused, a 2 dp
 * gradient ring with a soft violet halo; in error, a 2 dp error ring.
 */
fun Modifier.fieldFrame(
    radius: Dp,
    fill: Color,
    rest: Color,
    focused: Boolean,
    error: Boolean,
    errorColor: Color,
    ring: androidx.compose.ui.graphics.Brush,
    halo: Color,
): Modifier = drawBehind {
    val r = radius.toPx()
    if (focused && !error) {
        val h = 5.dp.toPx()
        drawRoundRect(halo, topLeft = Offset(-h, -h), size = Size(size.width + 2 * h, size.height + 2 * h), cornerRadius = CornerRadius(r + h))
    }
    drawRoundRect(fill, cornerRadius = CornerRadius(r))
    val stroke = (if (focused || error) 2.dp else 1.dp).toPx()
    val inset = stroke / 2
    val strokeSize = Size(size.width - stroke, size.height - stroke)
    val corner = CornerRadius(r - inset)
    when {
        error -> drawRoundRect(errorColor, Offset(inset, inset), strokeSize, corner, Stroke(stroke))
        focused -> drawRoundRect(ring, Offset(inset, inset), strokeSize, corner, style = Stroke(stroke))
        else -> drawRoundRect(rest, Offset(inset, inset), strokeSize, corner, Stroke(stroke))
    }
}

@Composable
private fun Modifier.themedFieldFrame(radius: Dp, focused: Boolean, error: Boolean): Modifier {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    return fieldFrame(
        radius = radius,
        fill = scheme.surfaceContainerLow,
        rest = colors.hairlineStrong,
        focused = focused,
        error = error,
        errorColor = scheme.error,
        ring = colors.gradient,
        halo = colors.gradientStops.start.copy(alpha = 0.14f),
    )
}

/** A small icon and a line of text: helpers, trust lines, the resend timer. */
@Composable
fun IconLine(
    icon: ImageVector,
    text: String,
    modifier: Modifier = Modifier,
    color: Color = AppTheme.colors.textTertiary,
) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = color)
    }
}

/**
 * A text field: 60 dp, the label above, the counter («۴ / ۲۰») or a clear ✕
 * at the end, a helper (or the error, with a shield) below. The caret is
 * the gradient's pink.
 */
@Composable
fun AppTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String? = null,
    helper: String? = null,
    helperIcon: ImageVector? = null,
    error: String? = null,
    maxLength: Int? = null,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    interactionSource: MutableInteractionSource = remember { MutableInteractionSource() },
) {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    val language = screenLanguage()
    val focused by interactionSource.collectIsFocusedAsState()
    val isError = error != null
    val textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 18.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium, color = scheme.onSurface)
    val clear = stringResource(R.string.ui_clear)
    val description = label ?: placeholder
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (label != null) {
            Text(label, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium), color = scheme.onSurfaceVariant)
        }
        BasicTextField(
            value = value,
            onValueChange = { next -> onValueChange(if (maxLength != null) next.take(maxLength) else next) },
            enabled = enabled,
            singleLine = singleLine,
            textStyle = textStyle,
            cursorBrush = SolidColor(colors.gradientStops.end),
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
                        .themedFieldFrame(Radius.field, focused, isError)
                        .padding(start = 18.dp, end = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.weight(1f).padding(vertical = 14.dp)) {
                        if (value.isEmpty() && placeholder != null) {
                            Text(placeholder, style = textStyle.copy(fontWeight = FontWeight.Normal), color = colors.textTertiary, maxLines = 1)
                        }
                        inner()
                    }
                    if (maxLength != null) {
                        Text(
                            Numerals.digits("${value.length} / $maxLength", language),
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.textTertiary,
                            modifier = Modifier.padding(horizontal = 10.dp),
                        )
                    } else if (value.isNotEmpty() && enabled) {
                        AppIconButton(AppIcons.Close, clear, onClick = { onValueChange("") }, iconSize = 20.dp, tint = colors.textTertiary)
                    }
                }
            },
        )
        when {
            error != null -> IconLine(AppIcons.ShieldAlert, error, color = scheme.error)
            helper != null -> IconLine(helperIcon ?: AppIcons.Eye, helper)
        }
    }
}

/**
 * The phone number field: left to right inside a Persian page, the country
 * pill first (a 48 dp target that opens the country list), the digits in
 * the reader's numerals («۹۱۲ ۳۴۵ ۶۷۸۹» through [visualTransformation]), a
 * clear ✕ at the far right, and the trust line under it.
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
    trustLine: String? = null,
    error: String? = null,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    interactionSource: MutableInteractionSource = remember { MutableInteractionSource() },
) {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    val focused by interactionSource.collectIsFocusedAsState()
    val textStyle = MaterialTheme.typography.headlineSmall.copy(fontSize = 22.sp, lineHeight = 30.sp, fontWeight = FontWeight.Medium, color = scheme.onSurface)
    val clear = stringResource(R.string.ui_clear)
    val countryLabel = stringResource(R.string.ui_country_code, dialCode)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = textStyle,
                cursorBrush = SolidColor(colors.gradientStops.end),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                keyboardActions = keyboardActions,
                visualTransformation = visualTransformation,
                interactionSource = interactionSource,
                modifier = Modifier.fillMaxWidth().semantics {
                    this.contentDescription = contentDescription
                    if (error != null) error(error)
                },
                decorationBox = { inner ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 64.dp)
                            .themedFieldFrame(Radius.field, focused, error != null)
                            .padding(start = 8.dp, end = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .minimumInteractiveComponentSize()
                                .heightIn(min = 48.dp)
                                .clip(RoundedCornerShape(14.dp))
                                .background(scheme.surfaceContainerHigh, RoundedCornerShape(14.dp))
                                .clickable(role = Role.Button, onClick = onCountryClick)
                                .semantics { this.contentDescription = countryLabel }
                                .padding(horizontal = 12.dp),
                        ) {
                            flag()
                            Text(dialCode, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Medium), color = scheme.onSurface)
                            Icon(AppIcons.ChevronDown, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                        }
                        Box(Modifier.weight(1f).padding(start = 14.dp, end = 4.dp)) {
                            if (value.isEmpty() && placeholder != null) {
                                Text(placeholder, style = textStyle.copy(fontWeight = FontWeight.Normal), color = colors.textTertiary, maxLines = 1)
                            }
                            inner()
                        }
                        if (value.isNotEmpty()) {
                            AppIconButton(AppIcons.Close, clear, onClick = { onValueChange("") }, iconSize = 22.dp, tint = colors.textTertiary)
                        }
                    }
                },
            )
        }
        when {
            error != null -> IconLine(AppIcons.ShieldAlert, error, color = scheme.error)
            trustLine != null -> IconLine(AppIcons.Lock, trustLine)
        }
    }
}

/** A flag drawn as three horizontal bands (22 × 15), for the country pill. */
@Composable
fun BandFlag(top: Color, middle: Color, bottom: Color, modifier: Modifier = Modifier) {
    Column(modifier.size(22.dp, 15.dp).clip(RoundedCornerShape(2.dp))) {
        Box(Modifier.fillMaxWidth().weight(1f).background(top))
        Box(Modifier.fillMaxWidth().weight(1f).background(middle))
        Box(Modifier.fillMaxWidth().weight(1f).background(bottom))
    }
}

/** How the code cells look. */
enum class OtpState { Normal, Error }

/**
 * The code's cells (50 × 62, left to right in every language): empty,
 * filled (a violet underline), the next one active (gradient ring, halo and
 * the pink caret), or all in error.
 */
@Composable
fun OtpCells(
    code: String,
    length: Int,
    modifier: Modifier = Modifier,
    focused: Boolean = true,
    state: OtpState = OtpState.Normal,
) {
    val colors = AppTheme.colors
    val scheme = MaterialTheme.colorScheme
    val language = screenLanguage()
    val digit = AppTheme.type.numeral
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        BoxWithConstraints(modifier) {
        // 50 × 62 each, narrower (same proportions) when six do not fit.
        val gap = 10.dp
        val width = if (maxWidth == Dp.Infinity) 50.dp else minOf(50.dp, (maxWidth - gap * (length - 1)) / length)
        Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
            for (i in 0 until length) {
                val char = code.getOrNull(i)
                val active = focused && state == OtpState.Normal && i == code.length
                val error = state == OtpState.Error
                Box(
                    modifier = Modifier
                        .size(width, width * 1.24f)
                        .themedFieldFrame(Radius.otpCell, active, error)
                        .then(
                            if (char != null && !error) {
                                Modifier.drawBehind {
                                    val h = 3.dp.toPx()
                                    val r = Radius.otpCell.toPx()
                                    clipBottomUnderline(h, r, scheme.primary)
                                }
                            } else {
                                Modifier
                            },
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    when {
                        char != null -> Text(
                            Numerals.digits(char.toString(), language),
                            style = digit,
                            color = if (error) scheme.error else scheme.onSurface,
                            textAlign = TextAlign.Center,
                        )
                        active -> Box(Modifier.width(2.dp).height(26.dp).background(colors.gradientStops.end, CircleShape))
                    }
                }
            }
        }
        }
    }
}

/** The filled cell's underline: the bottom [height] of the rounded cell, in [color]. */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.clipBottomUnderline(height: Float, radius: Float, color: Color) {
    val path = androidx.compose.ui.graphics.Path().apply {
        addRoundRect(androidx.compose.ui.geometry.RoundRect(0f, 0f, size.width, size.height, CornerRadius(radius)))
    }
    clipPath(path) {
        drawRect(color, topLeft = Offset(0f, size.height - height), size = Size(size.width, height))
    }
}

/**
 * The code input: a hidden text field drawn as [OtpCells], digits only. A
 * wrong code shakes the row (6 dp, three times in 240 ms; not with reduced
 * motion).
 */
@Composable
fun OtpField(
    value: String,
    onValueChange: (String) -> Unit,
    contentDescription: String,
    modifier: Modifier = Modifier,
    length: Int = 6,
    isError: Boolean = false,
    interactionSource: MutableInteractionSource = remember { MutableInteractionSource() },
) {
    val focused by interactionSource.collectIsFocusedAsState()
    val shake = remember { Animatable(0f) }
    val reduced = LocalReducedMotion.current
    LaunchedEffect(isError) {
        if (isError && !reduced) {
            shake.animateTo(
                0f,
                keyframes {
                    durationMillis = 240
                    6f at 40
                    -6f at 80
                    6f at 120
                    -6f at 160
                    6f at 200
                },
            )
        }
    }
    BasicTextField(
        value = value,
        onValueChange = { next -> onValueChange(next.filter { it.isDigit() }.take(length)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        interactionSource = interactionSource,
        textStyle = TextStyle(color = Color.Transparent),
        cursorBrush = SolidColor(Color.Transparent),
        modifier = modifier
            .offset { IntOffset(shake.value.dp.roundToPx(), 0) }
            .semantics { this.contentDescription = contentDescription },
        decorationBox = { _ ->
            OtpCells(value, length, focused = focused, state = if (isError) OtpState.Error else OtpState.Normal)
        },
    )
}

/** The code read from the SMS, offered above the keyboard: «از پیامک: ۴۸۲۷۱۵» (a 40 dp pill in a 48 dp target). */
@Composable
fun SmsCodeChip(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    Box(
        modifier
            .heightIn(min = 48.dp)
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .heightIn(min = 40.dp)
                .border(1.dp, AppTheme.colors.hairlineStrong, CircleShape)
                .padding(start = 4.dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
        ) {
            Box(Modifier.size(32.dp).background(scheme.secondaryContainer, CircleShape), contentAlignment = Alignment.Center) {
                Icon(AppIcons.Mail, contentDescription = null, tint = scheme.primary, modifier = Modifier.size(18.dp))
            }
            Text(text, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Bold), color = scheme.onSurface)
        }
    }
}

/** A plain safety line in a card: «کد رو به هیچ‌کس نده». */
@Composable
fun SafetyCard(title: String, body: String, modifier: Modifier = Modifier, icon: ImageVector = AppIcons.ShieldAlert) {
    val scheme = MaterialTheme.colorScheme
    Row(
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        modifier = modifier
            .fillMaxWidth()
            .background(scheme.surfaceContainerHigh, RoundedCornerShape(18.dp))
            .padding(16.dp),
    ) {
        Box(Modifier.size(40.dp).background(scheme.errorContainer, RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = scheme.onErrorContainer, modifier = Modifier.size(22.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold), color = scheme.onSurface)
            Text(body, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
        }
    }
}
