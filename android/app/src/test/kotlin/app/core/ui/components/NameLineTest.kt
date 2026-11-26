package app.core.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.roundToInt

/**
 * A name line's size is chosen from the width it is given and its texts
 * alone, so it settles: the rule it replaced (the name's room depended on
 * the age drawn at the size before) could swap between two sizes on every
 * frame for good.
 */
@RunWith(AndroidJUnit4::class)
class NameLineTest {

    @get:Rule val compose = createComposeRule()

    private val name = { s: Float -> (18.5f * s).roundToInt() }
    private val age = { s: Float -> (4.3f * s).roundToInt() }

    /** The rule it replaced: the name alone in what the age left at the size drawn before. */
    private fun oldRule(previous: Float, room: Int): Float {
        val left = room - age(previous)
        var s = 40f
        while (s > 28f && name(s) > left) s -= 0.25f
        return s
    }

    @Test
    fun theSizeDependsOnTheWidthAloneSoItIsAFixedPoint() {
        val first = nameLineSize(28f, 40f, 0.25f, 900, name, age)
        assertEquals(39.25f, first, 0f)
        assertEquals(first, nameLineSize(28f, 40f, 0.25f, 900, name, age), 0f)
        assertTrue(name(first) + age(first) <= 900)
        assertTrue(name(first + 0.25f) + age(first + 0.25f) > 900)
    }

    @Test
    fun theOldRuleSwappedBetweenTwoSizesForGood() {
        val sizes = generateSequence(40f) { oldRule(it, 900) }.take(12).toList().drop(2)
        assertEquals(setOf(39.25f, 39.5f), sizes.toSet())
        sizes.zipWithNext().forEach { (a, b) -> assertTrue("$a then $b", a != b) }
    }

    @Test
    fun theLargestStepThatFitsIsFoundLikeAScanWouldFindIt() {
        for (room in 400..1000 step 7) {
            val scan = generateSequence(40f) { it - 0.25f }.takeWhile { it >= 28f }.firstOrNull { name(it) + age(it) <= room } ?: 28f
            assertEquals("room $room", scan, nameLineSize(28f, 40f, 0.25f, room, name, age), 0f)
        }
    }

    @Test
    fun theEndsOfTheRange() {
        assertEquals(40f, nameLineSize(28f, 40f, 0.25f, 10_000, name, age), 0f)
        assertEquals(28f, nameLineSize(28f, 40f, 0.25f, 10, name, age), 0f)
        assertEquals(26f, nameLineSize(28f, 26f, 0.25f, 10, name, age), 0f)
    }

    private fun layout(text: String): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode()
            .config[SemanticsActions.GetTextLayoutResult].action?.invoke(results)
        return results.single()
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(qualifiers = "w400dp-h800dp-xhdpi")
    fun onAPhotoAMidLengthNameSettlesWithTheAgeInTheSameSize() {
        compose.setContent {
            AppTheme(template = Templates.Neon) {
                Box(Modifier.width(300.dp)) { NameLine("Alessandra", "27", verified = true, online = true, onPhoto = true) }
            }
        }
        compose.waitForIdle()
        val applied = mutableListOf<Set<Any>>()
        val observer = Snapshot.registerApplyObserver { changed, _ -> if (changed.isNotEmpty()) applied += changed }
        try {
            compose.mainClock.autoAdvance = false
            repeat(10) { compose.mainClock.advanceTimeByFrame() }
        } finally {
            observer.dispose()
            compose.mainClock.autoAdvance = true
        }
        assertEquals("no state changes once settled", emptyList<Set<Any>>(), applied)
        val nameLayout = layout("⁨Alessandra⁩, ")
        val ageLayout = layout("27")
        assertEquals(nameLayout.layoutInput.style.fontSize, ageLayout.layoutInput.style.fontSize)
        val size = nameLayout.layoutInput.style.fontSize.value
        assertTrue("size $size", size in 28f..34f)
        // Above the smallest size the name is whole; only at the smallest may it end in an ellipsis.
        assertTrue("the name is whole at $size", size == 28f || !nameLayout.isLineEllipsized(0))
    }
}
