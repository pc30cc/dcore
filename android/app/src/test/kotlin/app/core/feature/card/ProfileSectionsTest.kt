package app.core.feature.card

import app.core.model.Catalog
import app.core.model.ProfilePrompt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The full profile after its first screen (the photos, the name and the
 * line) is one continuous page: about, the voice answers, the fact grid,
 * then each answer with one more photo after it.
 */
class ProfileSectionsTest {

    private fun shape(sections: List<ProfileSection>): List<String> = sections.map {
        when (it) {
            is ProfileSection.PhotoBlock -> "photo${it.index + 1}"
            is ProfileSection.About -> "about"
            is ProfileSection.PromptBlock -> if (it.voice) "voice${it.prompt.promptId}" else "prompt${it.prompt.promptId}"
            is ProfileSection.Fields -> "fields"
        }
    }

    @Test
    fun aboutAndTheFactsLeadThenEachAnswerBringsOneMorePhoto() {
        val sections = profileSections(ScreenTestData.negar, ScreenTestData.catalog)
        assertEquals(
            listOf("about", "fields", "prompt1", "photo2", "prompt2", "photo3", "photo4"),
            shape(sections),
        )
    }

    @Test
    fun theFirstPhotoIsTheFirstScreensAndNeverRepeated() {
        val sections = profileSections(ScreenTestData.negar, ScreenTestData.catalog)
        assertTrue(sections.filterIsInstance<ProfileSection.PhotoBlock>().none { it.index == 0 })
    }

    @Test
    fun withNoPromptsThePhotosFollowTheFacts() {
        val card = ScreenTestData.negar.copy(prompts = emptyList(), about = null)
        assertEquals(listOf("fields", "photo2", "photo3", "photo4"), shape(profileSections(card, ScreenTestData.catalog)))
    }

    @Test
    fun emptyPartsAreLeftOut() {
        val card = ScreenTestData.olivia.copy(about = "  ", prompts = listOf(ProfilePrompt(1, "")))
        assertEquals(emptyList<String>(), shape(profileSections(card, ScreenTestData.catalog)))
    }

    @Test
    fun whatTheyLookForAloneStillMakesTheFactGrid() {
        val card = ScreenTestData.olivia.copy(intention = app.core.model.Intention.Friendship)
        val fields = profileSections(card, ScreenTestData.catalog).single() as ProfileSection.Fields
        assertEquals(app.core.model.Intention.Friendship, fields.intention)
        assertTrue(fields.lines.isEmpty())
    }

    @Test
    fun aVoiceAnswerCountsAsAnAnswerAndComesBeforeTheFacts() {
        val card = ScreenTestData.negar.copy(prompts = listOf(ProfilePrompt(3, null, audioMs = 14_200, audioUrl = "https://media.test/a/1.m4a"), ProfilePrompt(1, "A trip north")))
        assertEquals(listOf("about", "voice3", "fields", "prompt1", "photo2", "photo3", "photo4"), shape(profileSections(card, ScreenTestData.catalog)))
    }

    @Test
    fun promptsCarryTheirQuestionFromTheCatalogue() {
        val prompt = profileSections(ScreenTestData.negar, ScreenTestData.catalog).filterIsInstance<ProfileSection.PromptBlock>().first()
        assertEquals("The best trip I took…", prompt.question)
    }

    @Test
    fun fieldsAreWordedFromTheCatalogueAndPrivateOnesNeverShow() {
        val lines = fieldLines(ScreenTestData.negar, ScreenTestData.catalog)
        assertEquals(listOf(FieldLine(1, "Height", "168 cm"), FieldLine(2, "Smoking", "No")), lines)
        assertTrue(lines.none { it.label == "Religion" })
    }

    @Test
    fun numbersAreWrittenInTheReadersDigits() {
        val persian = { n: Int -> n.toString().map { c -> '۰' + (c - '0') }.joinToString("") }
        assertEquals("۱۶۸ cm", fieldLines(ScreenTestData.negar, ScreenTestData.catalog, persian).first().value)
    }

    @Test
    fun aFieldTheCatalogueNoLongerHasIsSkipped() {
        assertTrue(fieldLines(ScreenTestData.negar, Catalog()).isEmpty())
    }

    @Test
    fun keysAreUnique() {
        val keys = profileSections(ScreenTestData.negar, ScreenTestData.catalog).map { it.key }
        assertEquals(keys.size, keys.toSet().size)
    }
}
