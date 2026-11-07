package app.core.feature.call

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The media room never carries who someone is: the room's identity, name and
 * metadata come from the server's token, and nothing on the phone sets any of
 * them. A source check, so a later change that reaches for one fails here.
 */
class CallPrivacyGuardTest {

    private val sources = listOf("src/main/kotlin/app/core/feature/call", "src/main/kotlin/app/core/push")
        .map(::File)
        .filter { it.isDirectory }
        .flatMap { dir -> dir.walkTopDown().filter { it.extension == "kt" }.toList() }
        // The files that touch the media SDK (a notification's `Person` has a name of its own).
        .filter { "io.livekit" in it.readText() }

    @Test
    fun nothingOnThePhoneNamesTheParticipantInTheRoom() {
        assertTrue("the call sources are where the test expects them", sources.any { it.name == "LiveKitRoom.kt" })
        val forbidden = listOf("setName(", "updateName(", "setMetadata(", "updateMetadata(", "setAttributes(", "updateAttributes(")
        val hits = sources.flatMap { file -> forbidden.filter { it in file.readText() }.map { "${file.name}: $it" } }
        assertTrue("participant identity set on the phone: $hits", hits.isEmpty())
    }
}
