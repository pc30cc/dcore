package app.core.ui.components

import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** An error under a field is announced as it appears; a hint is not. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "fa-w411dp-h891dp-xhdpi")
class HelperLineTest {

    @get:Rule val compose = createComposeRule()

    private fun live(text: String): LiveRegionMode? =
        compose.onNodeWithText(text).fetchSemanticsNode().config.getOrNull(SemanticsProperties.LiveRegion)

    @Test
    fun anErrorLineIsALiveRegionAndAHintIsNot() {
        compose.setContent {
            AppTheme {
                androidx.compose.foundation.layout.Column {
                    HelperLine("این شماره درست نیست.", error = true)
                    HelperLine("یه راهنما")
                }
            }
        }
        assertEquals(LiveRegionMode.Polite, live("این شماره درست نیست."))
        assertNull(live("یه راهنما"))
    }

    @Test
    fun thePhoneFieldsErrorIsAnnounced() {
        compose.setContent {
            AppTheme {
                PhoneField(
                    value = "۰۹۱۲",
                    onValueChange = {},
                    dialCode = "+۹۸",
                    onCountryClick = {},
                    contentDescription = "شماره",
                    error = "اینترنت قطعه.",
                )
            }
        }
        assertEquals(LiveRegionMode.Polite, live("اینترنت قطعه."))
    }
}
