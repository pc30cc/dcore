package app.core.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

class FactColumnsTest {
    @Test
    fun rowsAreFullWheneverACountThatFitsAllowsIt() {
        // Four facts are two rows of two, not three and one; six are two rows of three.
        assertEquals(2, factColumns(4, listOf(3, 2)))
        assertEquals(3, factColumns(6, listOf(3, 2)))
        assertEquals(3, factColumns(3, listOf(3, 2)))
    }

    @Test
    fun aShortRowIsLeftOnlyWhenNoCountDividesTheFacts() {
        // Five facts: three, then two that share the width.
        assertEquals(3, factColumns(5, listOf(3, 2)))
        assertEquals(2, factColumns(5, listOf(2)))
    }

    @Test
    fun neverMoreColumnsThanFactsAndOneWhenNothingFits() {
        assertEquals(2, factColumns(2, listOf(3, 2)))
        assertEquals(1, factColumns(1, listOf(3, 2)))
        assertEquals(1, factColumns(4, emptyList()))
    }
}
