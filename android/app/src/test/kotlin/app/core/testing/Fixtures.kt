package app.core.testing

import app.core.model.Wire
import kotlinx.serialization.KSerializer

/**
 * The JSON examples of the API's answers (`src/test/resources/fixtures/v1`),
 * read from the test classpath.
 */
object Fixtures {
    fun text(name: String): String {
        val path = "/fixtures/v1/$name.json"
        val stream = Fixtures::class.java.getResourceAsStream(path) ?: error("no fixture $path")
        return stream.use { it.readBytes().toString(Charsets.UTF_8) }
    }

    fun <T> decode(name: String, serializer: KSerializer<T>): T = Wire.json.decodeFromString(serializer, text(name))

    /** Every fixture name, without the extension. */
    fun names(): List<String> {
        val dir = Fixtures::class.java.getResource("/fixtures/v1") ?: error("no fixtures on the classpath")
        return java.io.File(dir.toURI()).listFiles().orEmpty()
            .filter { it.name.endsWith(".json") }
            .map { it.name.removeSuffix(".json") }
            .sorted()
    }
}
