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

    /** Every string of [folder], from `strings.xml` and the per-feature `strings_*.xml` files; plurals by `name#quantity`. */
    private fun strings(folder: String): Map<String, String> {
        val main = File(res, "$folder/strings.xml")
        assertTrue("missing ${main.path}", main.isFile)
        val files = File(res, folder).listFiles { f -> f.name.startsWith("strings") && f.name.endsWith(".xml") }.orEmpty().sortedBy { it.name }
        return files.flatMap { file ->
            val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
            val nodes = document.getElementsByTagName("string")
            val singles = (0 until nodes.length)
                .map { nodes.item(it) as Element }
                .filter { it.getAttribute("translatable") != "false" }
                .map { it.getAttribute("name") to it.textContent }
            val plurals = document.getElementsByTagName("plurals")
            // Quantities differ by language (Persian and Turkish need only "other"); "other" is the one all share.
            val others = (0 until plurals.length).map { plurals.item(it) as Element }.mapNotNull { plural ->
                val items = plural.getElementsByTagName("item")
                (0 until items.length).map { items.item(it) as Element }.firstOrNull { it.getAttribute("quantity") == "other" }
                    ?.let { "${plural.getAttribute("name")}#other" to it.textContent }
            }
            singles + others
        }.toMap()
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
