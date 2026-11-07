package app.core.feature.auth

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Radius
import app.core.ui.theme.Space

/**
 * The code, as [length] boxes (the length the server sent). One text field
 * underneath takes the keyboard, a paste, and the keyboard's or the
 * platform's suggestion of the code from the message (autofill content type
 * `SmsOtpCode`); the boxes only draw it. Always left to right, also in
 * Persian, as digits are.
 *
 * [errorKey] changing shakes the boxes once (a wrong code); [success] fills
 * them with the success colour.
 */
@Composable
fun OtpCodeField(
    code: String,
    length: Int,
    onCodeChange: (String) -> Unit,
    language: AppLanguage,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isError: Boolean = false,
    errorKey: Any? = null,
    success: Boolean = false,
    onDone: () -> Unit = {},
) {
    val focus = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    val shake = remember { Animatable(0f) }
    val reduced = LocalReducedMotion.current
    LaunchedEffect(errorKey) {
        if (errorKey != null && !reduced) {
            for (x in listOf(14f, -12f, 9f, -6f, 3f, 0f)) shake.animateTo(x, tween(40))
        }
    }
    LaunchedEffect(Unit) { focus.requestFocus() }

    // The selection always sits at the end: boxes have no caret of their own.
    val value = TextFieldValue(code, selection = TextRange(code.length))
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        BasicTextField(
            value = value,
            onValueChange = { onCodeChange(Digits.ascii(it.text).filter(Char::isDigit).take(length)) },
            enabled = enabled,
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onDone() }),
            cursorBrush = SolidColor(androidx.compose.ui.graphics.Color.Transparent),
            modifier = modifier
                .fillMaxWidth()
                .focusRequester(focus)
                .onFocusChanged { focused = it.isFocused }
                .semantics {
                    contentType = ContentType.SmsOtpCode
                    contentDescription = label
                    stateDescription = Digits.localize(code, language)
                },
            decorationBox = { inner ->
                Box {
                    // The real field stays in the tree for the keyboard and
                    // autofill, drawn invisibly behind the boxes.
                    Box(Modifier.graphicsLayer { alpha = 0f }) { inner() }
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .graphicsLayer { translationX = shake.value * density },
                        horizontalArrangement = Arrangement.spacedBy(Space.sm, Alignment.CenterHorizontally),
                    ) {
                        repeat(length) { index ->
                            CodeBox(
                                digit = code.getOrNull(index)?.let { Digits.localize(it.toString(), language) },
                                active = focused && enabled && (index == code.length || (index == length - 1 && code.length == length)),
                                isError = isError,
                                success = success,
                                modifier = Modifier.weight(1f, fill = false).widthIn(min = 36.dp, max = 56.dp),
                            )
                        }
                    }
                }
            },
        )
    }
}

@Composable
private fun CodeBox(digit: String?, active: Boolean, isError: Boolean, success: Boolean, modifier: Modifier) {
    val colors = MaterialTheme.colorScheme
    val border by animateColorAsState(
        when {
            success -> AppTheme.colors.success
            isError -> AppTheme.colors.danger
            active -> colors.primary
            digit != null -> colors.outline
            else -> colors.outlineVariant
        },
        label = "boxBorder",
    )
    val scale = remember { Animatable(1f) }
    val reduced = LocalReducedMotion.current
    LaunchedEffect(digit) {
        if (digit != null && !reduced) {
            scale.snapTo(0.86f)
            scale.animateTo(1f, spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium))
        }
    }
    Surface(
        modifier = modifier
            .aspectRatio(0.82f)
            .heightIn(min = 48.dp)
            .graphicsLayer {
                scaleX = scale.value
                scaleY = scale.value
            }
            .border(if (active || isError || success) 2.dp else 1.dp, border, RoundedCornerShape(Radius.md)),
        shape = RoundedCornerShape(Radius.md),
        color = if (success) AppTheme.colors.success.copy(alpha = 0.10f) else colors.surfaceContainerLow,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = digit ?: "",
                style = MaterialTheme.typography.headlineSmall,
                color = colors.onSurface,
                textAlign = TextAlign.Center,
            )
        }
    }
}
