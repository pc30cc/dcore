package app.core.feature.auth

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.i18n.AppLanguage
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The code boxes: as many as the server says, any keyboard's digits, Persian digits drawn in Persian. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class OtpCodeFieldTest {

    @get:Rule val compose = createComposeRule()

    @Test
    fun typedDigitsFromAnyScriptReachTheFlowAsAscii() {
        val received = mutableListOf<String>()
        compose.setContent {
            AppTheme(template = Templates.of(Templates.WHITE)) {
                var code by remember { mutableStateOf("") }
                OtpCodeField(
                    code = code,
                    length = 4,
                    onCodeChange = {
                        code = it
                        received += it
                    },
                    language = AppLanguage.EN,
                    label = "4-digit code",
                )
            }
        }
        compose.onNodeWithContentDescription("4-digit code").assertIsDisplayed()
        compose.onNodeWithContentDescription("4-digit code").performTextInput("۱۲3x45")
        compose.waitForIdle()
        // Letters are dropped and the code stops at its length.
        assertEquals("1234", received.last())
        compose.onNodeWithText("4").assertIsDisplayed()
    }

    @Test
    fun persianShowsPersianDigitsInTheBoxes() {
        compose.setContent {
            AppTheme(template = Templates.of(Templates.WHITE)) {
                OtpCodeField(code = "12", length = 6, onCodeChange = {}, language = AppLanguage.FA, label = "code")
            }
        }
        compose.onNodeWithText("۱").assertIsDisplayed()
        compose.onNodeWithText("۲").assertIsDisplayed()
    }

    @Test
    fun aWrongCodeStaysInSightUntilANewDigitIsTyped() {
        val received = mutableListOf<String>()
        compose.setContent {
            AppTheme(template = Templates.of(Templates.WHITE)) {
                var code by remember { mutableStateOf("") }
                // The flow cleared the field after the wrong code; the cells still draw it.
                OtpCodeField(
                    code = code,
                    length = 6,
                    onCodeChange = {
                        code = it
                        received += it
                    },
                    language = AppLanguage.EN,
                    label = "code",
                    isError = true,
                    shown = if (code.isEmpty()) "482710" else code,
                )
            }
        }
        compose.onNodeWithText("7").assertIsDisplayed()
        // What is typed starts afresh: the field held nothing, whatever the cells drew.
        compose.onNodeWithContentDescription("code").performTextInput("5")
        compose.waitForIdle()
        assertEquals("5", received.last())
        assertEquals(0, compose.onAllNodesWithText("7").fetchSemanticsNodes().size)
    }
}
