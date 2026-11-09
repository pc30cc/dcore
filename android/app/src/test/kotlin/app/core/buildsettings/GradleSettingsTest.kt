package app.core.buildsettings

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Properties

/**
 * The build's own heap settings: the Gradle daemon and the Kotlin compile
 * daemon each get at least 3 GB. At 2 GB the Kotlin daemon (which does not
 * take the Gradle daemon's settings once it has its own) spent its time in
 * full GCs while four variants compiled at once. Reads `gradle.properties`
 * (the test's working directory is the module's).
 */
class GradleSettingsTest {

    private val properties = Properties().apply { File("../gradle.properties").inputStream().use(::load) }

    private fun heapGb(key: String): Double {
        val args = properties.getProperty(key) ?: error("$key is not set in gradle.properties")
        val xmx = Regex("""-Xmx(\d+)([gGmM])""").find(args) ?: error("$key has no -Xmx: $args")
        val amount = xmx.groupValues[1].toDouble()
        return if (xmx.groupValues[2].equals("g", ignoreCase = true)) amount else amount / 1024.0
    }

    @Test
    fun theGradleDaemonHasAtLeast3Gb() = assertTrue(heapGb("org.gradle.jvmargs") >= 3.0)

    @Test
    fun theKotlinDaemonHasItsOwnHeapOfAtLeast3Gb() = assertTrue(heapGb("kotlin.daemon.jvmargs") >= 3.0)
}
