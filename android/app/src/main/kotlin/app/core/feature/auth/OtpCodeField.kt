package app.core.feature.auth

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
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
import androidx.compose.ui.unit.LayoutDirection
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.ui.components.OtpCells
import app.core.ui.components.OtpState as CellState
import app.core.ui.theme.LocalReducedMotion

/**
 * The code, as [length] cells (the length the server sent). One text field
 * underneath takes the keyboard, a paste, and the keyboard's or the
 * platform's suggestion of the code from the message (autofill content type
 * `SmsOtpCode`); the cells only draw it ([OtpCells]). Always left to right,
 * also in Persian, as digits are.
 *
 * [shown] is what the cells draw when it differs from what the field holds
 * (a wrong code stays in sight, in the error colour, until a new digit is
 * typed). [errorKey] changing shakes the cells once (a wrong code).
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
    shown: String = code,
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
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    // The selection always sits at the end: the cells have no caret of their own.
    val value = TextFieldValue(code, selection = TextRange(code.length))
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        BasicTextField(
            value = value,
            onValueChange = { onCodeChange(Digits.ascii(it.text).filter(Char::isDigit).take(length)) },
            enabled = enabled,
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onDone() }),
            cursorBrush = SolidColor(Color.Transparent),
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
                    // autofill, drawn invisibly behind the cells.
                    Box(Modifier.graphicsLayer { alpha = 0f }) { inner() }
                    OtpCells(
                        code = shown,
                        length = length,
                        modifier = Modifier.fillMaxWidth().graphicsLayer { translationX = shake.value * density },
                        focused = focused && enabled,
                        state = if (isError) CellState.Error else CellState.Normal,
                        language = language,
                    )
                }
            },
        )
    }
}
