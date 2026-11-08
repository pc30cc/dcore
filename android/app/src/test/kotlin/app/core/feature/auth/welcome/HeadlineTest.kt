package app.core.feature.auth.welcome

import org.junit.Assert.assertEquals
import org.junit.Test

class HeadlineTest {

    @Test
    fun `plain text is one plain run`() {
        assertEquals(listOf(HeadlineRun("Hello there", false)), Headline.parse("Hello there"))
    }

    @Test
    fun `words between asterisks are emphasised`() {
        assertEquals(
            listOf(HeadlineRun("Meet ", false), HeadlineRun("someone new", true), HeadlineRun(" today", false)),
            Headline.parse("Meet *someone new* today"),
        )
        assertEquals(listOf(HeadlineRun("App", true)), Headline.parse("*App*"))
    }

    @Test
    fun `several pairs alternate`() {
        assertEquals(
            listOf(HeadlineRun("a", true), HeadlineRun(" b ", false), HeadlineRun("c", true)),
            Headline.parse("*a* b *c*"),
        )
    }

    @Test
    fun `an asterisk without a partner stays as text, and an empty pair is dropped`() {
        assertEquals(listOf(HeadlineRun("5 * 3", false)), Headline.parse("5 * 3"))
        assertEquals(listOf(HeadlineRun("ab", false)), Headline.parse("a**b"))
        assertEquals(listOf(HeadlineRun("a ", false), HeadlineRun("b", true), HeadlineRun(" *", false)), Headline.parse("a *b* *"))
    }

    @Test
    fun `Persian and the app name keep their marks apart`() {
        assertEquals(
            listOf(HeadlineRun("حساب ", false), HeadlineRun("App", true), HeadlineRun(" خود را بسازید", false)),
            Headline.parse("حساب *App* خود را بسازید"),
        )
    }

    @Test
    fun `plain drops the marks`() {
        assertEquals("Welcome back to App", Headline.plain("Welcome back to *App*"))
        assertEquals("", Headline.plain(""))
    }
}
