package app.core.ui.components

import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.ui.theme.AppTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The onboarding bar draws no counter, so a screen reader hears the step from it. */
@RunWith(AndroidJUnit4::class)
class StepProgressTest {

    @get:Rule val compose = createComposeRule()

    private fun spoken(step: Int, total: Int): Pair<String?, ProgressBarRangeInfo?> {
        compose.setContent { AppTheme { StepProgress(step, total, Modifier.testTag("steps")) } }
        val config = compose.onNodeWithTag("steps").fetchSemanticsNode().config
        return config.getOrNull(SemanticsProperties.StateDescription) to config.getOrNull(SemanticsProperties.ProgressBarRangeInfo)
    }

    @Test
    fun theStepIsSpokenInEnglish() {
        val (state, range) = spoken(3, 8)
        assertEquals("3 of 8", state)
        assertEquals(3f / 8f, range!!.current, 0.001f)
        assertEquals(0f..1f, range.range)
    }

    @Test
    @Config(qualifiers = "fa")
    fun theStepIsSpokenInPersianFigures() {
        assertEquals("۳ از ۸", spoken(3, 8).first)
    }

    @Test
    fun noStepsIsAnEmptyBar() {
        assertEquals(0f, spoken(0, 0).second!!.current, 0f)
    }
}
