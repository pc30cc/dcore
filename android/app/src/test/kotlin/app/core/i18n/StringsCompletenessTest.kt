package app.core.i18n

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Every string ships in English, Persian and Turkish, with the same
 * placeholders. Lint's MissingTranslation covers presence when lint runs;
 * this also runs with the unit tests and checks what lint does not: that
 * `{appName}` and every `%1$s` survive translation, and that `{appName}` is
 * spelled the one way [brandText] replaces.
 *
 * Reads the resource files themselves (the test's working directory is the
 * module's).
 */
class StringsCompletenessTest {

    private val res = File("src/main/res")
    private val locales = listOf("values", "values-fa", "values-tr")

    private fun strings(folder: String): Map<String, String> {
        val file = File(res, "$folder/strings.xml")
        assertTrue("missing ${file.path}", file.isFile)
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val nodes = document.getElementsByTagName("string")
        return (0 until nodes.length)
            .map { nodes.item(it) as Element }
            .filter { it.getAttribute("translatable") != "false" }
            .associate { it.getAttribute("name") to it.textContent }
    }

    private val placeholder = Regex("""\{[A-Za-z]+}|%\d+\$[sd]""")

    @Test
    fun `every locale has exactly the same keys`() {
        val english = strings("values").keys
        assertTrue("no strings found", english.isNotEmpty())
        for (folder in locales.drop(1)) {
            val keys = strings(folder).keys
            assertEquals("keys missing from $folder", emptySet<String>(), english - keys)
            assertEquals("keys only in $folder", emptySet<String>(), keys - english)
        }
    }

    @Test
    fun `placeholders survive translation`() {
        val english = strings("values")
        for (folder in locales.drop(1)) {
            val translated = strings(folder)
            for ((key, text) in english) {
                val expected = placeholder.findAll(text).map { it.value }.toSortedSet()
                val actual = placeholder.findAll(translated.getValue(key)).map { it.value }.toSortedSet()
                assertEquals("placeholders of '$key' in $folder", expected, actual)
            }
        }
    }

    @Test
    fun `the only brace placeholder is the app name`() {
        for (folder in locales) {
            for ((key, text) in strings(folder)) {
                val braces = Regex("""\{[^}]*}""").findAll(text).map { it.value }.toSet()
                assertTrue("'$key' in $folder uses $braces", braces.all { it == APP_NAME_PLACEHOLDER })
            }
        }
    }
}
