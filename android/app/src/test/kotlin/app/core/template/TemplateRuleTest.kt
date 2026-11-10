package app.core.template

import app.core.model.UiConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The effective-template rule: the choice when shipped and offered, else the default when shipped, else neon. */
class TemplateRuleTest {

    private val both = listOf("neon", "white")

    private fun ui(default: String, vararg offered: String) = UiConfig(default, offered.toList())

    @Test
    fun `every combination of choice, default and offer on a build that ships both`() {
        val defaults = listOf("neon", "white")
        val offers = listOf(listOf("neon"), listOf("white"), listOf("neon", "white"))
        for (default in defaults) for (offered in offers) for (choice in listOf("default", "neon", "white")) {
            val config = UiConfig(default, (offered + default).distinct())
            val expected = if (choice != "default" && choice in config.templates) choice else default
            assertEquals("$choice / $config", expected, TemplateRule.effective(choice, config, both))
        }
    }

    @Test
    fun `a choice is drawn only when the build ships it and the admin offers it`() {
        assertEquals("white", TemplateRule.effective("white", ui("neon", "neon", "white"), both))
        // No longer offered: the default, while the choice stays stored.
        assertEquals("neon", TemplateRule.effective("white", ui("neon", "neon"), both))
        // Offered again later: back.
        assertEquals("white", TemplateRule.effective("white", ui("neon", "white", "neon"), both))
        // Not shipped by this build.
        assertEquals("neon", TemplateRule.effective("white", ui("neon", "neon", "white"), listOf("neon")))
    }

    @Test
    fun `default follows the admin's default, and every later change of it`() {
        assertEquals("neon", TemplateRule.effective("default", ui("neon", "neon", "white"), both))
        assertEquals("white", TemplateRule.effective("default", ui("white", "neon", "white"), both))
        assertEquals("white", TemplateRule.effective("default", ui("white", "white"), both))
    }

    @Test
    fun `unknown ids fall back to the default, and an unknown default to neon`() {
        assertEquals("neon", TemplateRule.effective("sepia", ui("neon", "neon", "sepia"), both))
        assertEquals("white", TemplateRule.effective("sepia", ui("white", "white", "sepia"), both))
        assertEquals("neon", TemplateRule.effective("default", ui("sepia", "sepia", "white"), both))
        assertEquals("white", TemplateRule.effective("white", ui("sepia", "sepia", "white"), both))
        assertEquals("neon", TemplateRule.effective("white", ui("sepia", "sepia"), both))
    }

    @Test
    fun `without a ui the server's own default applies`() {
        assertEquals(UiConfig("neon", listOf("neon", "white")), UiConfig.Default)
        assertEquals("neon", TemplateRule.effective("default", null, both))
        assertEquals("white", TemplateRule.effective("white", null, both))
        assertEquals("neon", TemplateRule.effective("neon", null, both))
    }

    @Test
    fun `what may be chosen and what may be stored`() {
        assertTrue(TemplateRule.isChoice("default"))
        assertTrue(TemplateRule.isChoice("white"))
        assertFalse(TemplateRule.isChoice("sepia"))
        assertFalse(TemplateRule.isChoice(""))
        assertTrue(TemplateRule.isWireChoice("sepia"))
        assertFalse(TemplateRule.isWireChoice("Sepia"))
        assertFalse(TemplateRule.isWireChoice(""))
        assertFalse(TemplateRule.isWireChoice("a".repeat(33)))
    }
}
