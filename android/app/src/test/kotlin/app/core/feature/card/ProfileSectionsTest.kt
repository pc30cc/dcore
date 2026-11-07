package app.core.feature.card

import app.core.model.Catalog
import app.core.model.ProfilePrompt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The full profile is one continuous page: photos, prompts and fields interleaved. */
class ProfileSectionsTest {

    private fun shape(sections: List<ProfileSection>): List<String> = sections.map {
        when (it) {
            is ProfileSection.PhotoBlock -> "photo${it.index + 1}"
            ProfileSection.Header -> "header"
            is ProfileSection.About -> "about"
            is ProfileSection.PromptBlock -> "prompt${it.prompt.promptId}"
            is ProfileSection.Fields -> "fields"
        }
    }

    @Test
    fun photosPromptsAndFieldsAlternate() {
        val sections = profileSections(ScreenTestData.negar, ScreenTestData.catalog)
        assertEquals(
            listOf("photo1", "header", "about", "prompt1", "photo2", "fields", "prompt2", "photo3", "photo4"),
            shape(sections),
        )
    }

    @Test
    fun withNoPromptsTheFieldsFollowTheSecondPhoto() {
        val card = ScreenTestData.negar.copy(prompts = emptyList(), about = null)
        assertEquals(listOf("photo1", "header", "photo2", "fields", "photo3", "photo4"), shape(profileSections(card, ScreenTestData.catalog)))
    }

    @Test
    fun emptyPartsAreLeftOut() {
        val card = ScreenTestData.olivia.copy(about = "  ", prompts = listOf(ProfilePrompt(1, "")))
        assertEquals(listOf("photo1", "header"), shape(profileSections(card, ScreenTestData.catalog)))
    }

    @Test
    fun aVoiceAnswerCountsAsAnAnswer() {
        val card = ScreenTestData.olivia.copy(prompts = listOf(ProfilePrompt(3, null, audioMs = 14_200, audioUrl = "https://media.test/a/1.m4a")))
        assertEquals(listOf("photo1", "header", "prompt3"), shape(profileSections(card, ScreenTestData.catalog)))
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
