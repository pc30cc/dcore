package app.core.feature.onboarding

import app.core.model.AccountLocation
import app.core.model.AccountStatus
import app.core.model.Catalog
import app.core.model.City
import app.core.model.Config
import app.core.model.ConsentKind
import app.core.model.DiscoveryPreferences
import app.core.model.FieldDef
import app.core.model.Gender
import app.core.model.Intention
import app.core.model.Limits
import app.core.model.Me
import app.core.model.OnboardingCodes
import app.core.model.OwnPhoto
import app.core.model.OwnProfile
import app.core.model.PhotoStatus
import app.core.model.PromptDef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class OnboardingPlanTest {

    private val config = Config(
        catalog = Catalog(
            fields = listOf(FieldDef(1, "height", "Height", "number", min = 120, max = 230), FieldDef(4, "religion", "Religion", "text", sensitive = true)),
            prompts = listOf(PromptDef(1, "A perfect day…"), PromptDef(3, "Hear my voice…", category = "voice")),
        ),
        limits = Limits(photosMin = 2),
    )

    private fun me(
        step: Int = 0,
        name: String = "",
        birth: LocalDate? = null,
        gender: Gender = Gender.Unknown,
        interested: List<Gender> = emptyList(),
        intention: Intention? = null,
        photos: List<PhotoStatus> = emptyList(),
        city: Boolean = false,
        due: List<ConsentKind> = listOf(ConsentKind.Guidelines),
    ) = Me(
        id = "nnewacct2zzzz",
        status = AccountStatus.Onboarding,
        onboardingStep = step,
        profile = OwnProfile(
            id = "nnewacct2zzzz", name = name, birthDate = birth, gender = gender, intention = intention,
            photos = photos.mapIndexed { i, s -> OwnPhoto("10$i", i, s) },
        ),
        preferences = DiscoveryPreferences(interestedIn = interested),
        location = if (city) AccountLocation(City(1, "Tehran", "IR"), "IR") else AccountLocation(),
        consentsDue = due,
    )

    private fun facts(me: Me, privacy: Boolean = true, askable: Boolean = true) = OnboardingFacts.from(me, config, privacy, askable)

    @Test
    fun `a new account starts at the name, or at the privacy notice on a phone that has not shown it`() {
        assertEquals(OnboardingStep.Name, OnboardingPlan.resume(facts(me())))
        assertEquals(OnboardingStep.Privacy, OnboardingPlan.resume(facts(me(), privacy = false)))
        // Once the basics are on the server, the notice was accepted: it is not shown again anywhere.
        val basics = me(step = OnboardingCodes.INTERESTED_IN, name = "Sara", birth = LocalDate.of(1995, 4, 2), gender = Gender.Woman)
        assertFalse(OnboardingStep.Privacy in OnboardingPlan.visible(facts(basics, privacy = false)))
    }

    @Test
    fun `terms raised during sign-up show the notice again, after the basics too`() {
        val basics = me(step = OnboardingCodes.INTERESTED_IN, name = "Sara", birth = LocalDate.of(1995, 4, 2), gender = Gender.Woman, due = listOf(ConsentKind.Terms, ConsentKind.Guidelines))
        assertEquals(OnboardingStep.Privacy, OnboardingPlan.resume(facts(basics, privacy = true)))
    }

    @Test
    fun `sign-up carries on from what the server holds`() {
        val afterBasics = me(step = OnboardingCodes.INTERESTED_IN, name = "Sara", birth = LocalDate.of(1995, 4, 2), gender = Gender.Woman)
        assertEquals(OnboardingStep.InterestedIn, OnboardingPlan.resume(facts(afterBasics)))
        val photosStarted = afterBasics.copy(
            onboardingStep = OnboardingCodes.PHOTOS,
            profile = afterBasics.profile!!.copy(intention = Intention.Serious, photos = listOf(OwnPhoto("1", 0, PhotoStatus.Approved))),
            preferences = DiscoveryPreferences(interestedIn = listOf(Gender.Man)),
        )
        assertEquals(OnboardingStep.Photos, OnboardingPlan.resume(facts(photosStarted)))
    }

    @Test
    fun `a required answer missing on the server wins over a stored step past it`() {
        // Stored far ahead, yet no birth date: back to it.
        val f = facts(me(step = OnboardingCodes.LOCATION, name = "Sara"))
        assertEquals(OnboardingStep.BirthDate, OnboardingPlan.resume(f))
        // Photos refused by moderation no longer count.
        val refused = me(
            step = OnboardingCodes.LOCATION, name = "Sara", birth = LocalDate.of(1995, 4, 2), gender = Gender.Woman,
            interested = listOf(Gender.Man), intention = Intention.Friendship, photos = listOf(PhotoStatus.Approved, PhotoStatus.Rejected),
        )
        assertEquals(OnboardingStep.Photos, OnboardingPlan.resume(facts(refused)))
    }

    @Test
    fun `a default the server filled in does not skip the choice`() {
        val defaulted = me(step = OnboardingCodes.INTERESTED_IN, name = "Sara", birth = LocalDate.of(1995, 4, 2), gender = Gender.Woman, interested = listOf(Gender.Man))
        assertEquals(OnboardingStep.InterestedIn, OnboardingPlan.resume(facts(defaulted)))
    }

    @Test
    fun `optional steps count once passed, and steps with nothing to ask are not shown`() {
        val f = facts(
            me(
                step = OnboardingCodes.FIELDS, name = "Sara", birth = LocalDate.of(1995, 4, 2), gender = Gender.Woman,
                interested = listOf(Gender.Man), intention = Intention.Marriage, photos = listOf(PhotoStatus.Processing, PhotoStatus.Review),
            ),
            askable = false,
        )
        assertTrue(OnboardingPlan.isDone(OnboardingStep.Prompts, f))
        assertEquals(OnboardingStep.Fields, OnboardingPlan.resume(f))
        assertFalse("no permission to ask for", OnboardingStep.Notifications in OnboardingPlan.visible(f))
        val noCatalog = OnboardingFacts.from(me(), Config(), privacyAccepted = true, notificationsAskable = true)
        assertFalse(OnboardingStep.Prompts in OnboardingPlan.visible(noCatalog))
        assertFalse(OnboardingStep.Fields in OnboardingPlan.visible(noCatalog))
    }

    @Test
    fun `sensitive fields and voice prompts are not part of sign-up`() {
        val onlySensitive = Config(catalog = Catalog(fields = listOf(FieldDef(4, "religion", "Religion", "text", sensitive = true)), prompts = listOf(PromptDef(3, "Voice", "voice"))))
        val f = OnboardingFacts.from(me(), onlySensitive, privacyAccepted = true, notificationsAskable = true)
        assertFalse(f.hasFields)
        assertFalse(f.hasPrompts)
    }

    @Test
    fun `everything done leaves only the finish`() {
        val done = me(
            step = OnboardingCodes.DONE, name = "Sara", birth = LocalDate.of(1995, 4, 2), gender = Gender.Woman,
            interested = listOf(Gender.Man), intention = Intention.Marriage, photos = listOf(PhotoStatus.Approved, PhotoStatus.Approved),
            city = true, due = emptyList(),
        )
        assertNull(OnboardingPlan.resume(facts(done)))
        // The guidelines raised to a new version are asked again.
        assertEquals(OnboardingStep.Guidelines, OnboardingPlan.resume(facts(done.copy(consentsDue = listOf(ConsentKind.Guidelines)))))
    }

    @Test
    fun `going on skips what is done, going back skips what is fixed`() {
        val f = facts(
            me(step = OnboardingCodes.PHOTOS, name = "Sara", birth = LocalDate.of(1995, 4, 2), gender = Gender.Woman, interested = listOf(Gender.Man), intention = Intention.Serious),
        )
        // From the name (edited again), straight on to the first step not done.
        assertEquals(OnboardingStep.Photos, OnboardingPlan.next(OnboardingStep.Name, f))
        // Back from interests passes over the birth date and gender, set once.
        assertEquals(OnboardingStep.Name, OnboardingPlan.previous(OnboardingStep.InterestedIn, f))
        assertNull(OnboardingPlan.previous(OnboardingStep.Name, f))
        assertFalse(OnboardingPlan.canRevisit(OnboardingStep.BirthDate, f))
    }

    @Test
    fun `the progress counts the steps shown`() {
        val f = facts(me(), askable = false)
        val (position, count) = OnboardingPlan.progress(OnboardingStep.Name, f)
        assertEquals(1, position)
        assertEquals(OnboardingPlan.visible(f).size, count)
        assertEquals(count, OnboardingPlan.progress(OnboardingStep.Guidelines, f).first)
    }

    @Test
    fun `each step stores the next one's number when passed, the last one DONE`() {
        assertEquals(OnboardingCodes.BIRTH_DATE, OnboardingStep.Name.passedCode)
        assertEquals(OnboardingCodes.DONE, OnboardingStep.Guidelines.passedCode)
        val codes = OnboardingStep.entries.map { it.code }
        assertEquals(codes.sorted(), codes)
        assertTrue(codes.all { it in 0..50 } && OnboardingCodes.DONE <= 50)
    }
}
