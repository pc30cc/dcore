package app.core.feature.onboarding

import androidx.annotation.StringRes
import app.core.R
import app.core.model.Config
import app.core.model.ConsentKind
import app.core.model.Gender
import app.core.model.Intention
import app.core.model.Me
import app.core.model.OnboardingCodes
import app.core.model.PhotoStatus

/**
 * The sign-up steps, in order, with the number each writes to the server
 * when it is passed ([OnboardingCodes]). Required steps must hold their
 * answer on the server to count as done, whatever the stored number says;
 * optional ones count as done once passed.
 */
enum class OnboardingStep(val code: Int, val required: Boolean, @StringRes val title: Int) {
    /** The privacy notice, when this install has not shown it (a sign-up carried on from another phone). */
    Privacy(OnboardingCodes.START, true, R.string.privacy_title),
    Name(OnboardingCodes.NAME, true, R.string.onboarding_step_name),
    BirthDate(OnboardingCodes.BIRTH_DATE, true, R.string.onboarding_step_birthday),
    Gender(OnboardingCodes.GENDER, true, R.string.onboarding_step_gender),
    InterestedIn(OnboardingCodes.INTERESTED_IN, true, R.string.onboarding_step_interested_in),
    Intention(OnboardingCodes.INTENTION, true, R.string.onboarding_step_goal),
    Photos(OnboardingCodes.PHOTOS, true, R.string.onboarding_step_photos),
    Prompts(OnboardingCodes.PROMPTS, false, R.string.onboarding_step_prompts),
    Fields(OnboardingCodes.FIELDS, false, R.string.onboarding_step_fields),
    Location(OnboardingCodes.LOCATION, true, R.string.onboarding_step_location),
    Notifications(OnboardingCodes.NOTIFICATIONS, false, R.string.onboarding_step_notifications),
    Guidelines(OnboardingCodes.GUIDELINES, true, R.string.onboarding_step_rules),
    ;

    /** What the server stores once this step is passed: the next step's number, or [OnboardingCodes.DONE]. */
    val passedCode: Int get() = entries.getOrNull(ordinal + 1)?.code ?: OnboardingCodes.DONE
}

/** What the plan reads: the server's account, the catalogue, and two things only this phone knows. */
data class OnboardingFacts(
    val storedStep: Int,
    val name: String,
    val hasBirthDate: Boolean,
    val gender: Gender,
    val interestedIn: List<Gender>,
    val intention: Intention?,
    val usablePhotos: Int,
    val photosMin: Int,
    val hasCity: Boolean,
    val hasCountry: Boolean,
    val guidelinesDue: Boolean,
    /** The privacy notice was accepted: on this install before the basics, on the server's record after them. */
    val privacyAccepted: Boolean,
    /** The phone asks for the notification permission (Android 13+, not granted yet). */
    val notificationsAskable: Boolean,
    val hasPrompts: Boolean,
    val hasFields: Boolean,
) {
    companion object {
        fun from(me: Me, config: Config?, privacyAccepted: Boolean, notificationsAskable: Boolean): OnboardingFacts {
            val profile = me.profile
            val limits = config?.limits
            return OnboardingFacts(
                storedStep = me.onboardingStep,
                name = profile?.name.orEmpty(),
                hasBirthDate = profile?.birthDate != null,
                gender = profile?.gender ?: Gender.Unknown,
                interestedIn = me.preferences?.interestedIn.orEmpty().filter { it != Gender.Unknown },
                intention = profile?.intention,
                usablePhotos = profile?.photos.orEmpty().count { it.status != PhotoStatus.Rejected && it.status != PhotoStatus.Unknown },
                photosMin = limits?.photosMin ?: 2,
                hasCity = me.location?.city != null,
                hasCountry = me.location?.country != null,
                guidelinesDue = ConsentKind.Guidelines in me.consentsDue,
                // Before the basics the notice is this install's to remember; after them, the server's
                // record decides (a raised terms or privacy version asks again).
                privacyAccepted = if (profile?.birthDate == null) privacyAccepted else LEGAL.none { it in me.consentsDue },
                notificationsAskable = notificationsAskable,
                hasPrompts = config?.catalog?.prompts.orEmpty().any { it.category != VOICE },
                hasFields = config?.catalog?.fields.orEmpty().any { it.offeredInOnboarding() },
            )
        }

        private const val VOICE = "voice"
        private val LEGAL = setOf(ConsentKind.Terms, ConsentKind.Privacy)
    }
}

/**
 * Which steps a person sees, which are done, and where sign-up carries on:
 * the same answer on every phone, because it is read from the server's
 * account (plus the two local facts in [OnboardingFacts]).
 */
object OnboardingPlan {

    fun visible(facts: OnboardingFacts): List<OnboardingStep> = OnboardingStep.entries.filter { step ->
        when (step) {
            OnboardingStep.Privacy -> !facts.privacyAccepted
            OnboardingStep.Prompts -> facts.hasPrompts
            OnboardingStep.Fields -> facts.hasFields
            OnboardingStep.Notifications -> facts.notificationsAskable
            else -> true
        }
    }

    fun isDone(step: OnboardingStep, facts: OnboardingFacts): Boolean {
        val passed = facts.storedStep > step.code
        return when (step) {
            OnboardingStep.Privacy -> facts.privacyAccepted
            OnboardingStep.Name -> facts.name.isNotBlank()
            OnboardingStep.BirthDate -> facts.hasBirthDate
            OnboardingStep.Gender -> facts.gender != Gender.Unknown
            // The server may fill a default; only a pass by the person counts.
            OnboardingStep.InterestedIn -> facts.interestedIn.isNotEmpty() && passed
            OnboardingStep.Intention -> facts.intention != null && facts.intention != Intention.Unknown
            OnboardingStep.Photos -> facts.usablePhotos >= facts.photosMin && passed
            OnboardingStep.Prompts, OnboardingStep.Fields, OnboardingStep.Notifications -> passed
            OnboardingStep.Location -> facts.hasCity || (facts.hasCountry && passed)
            OnboardingStep.Guidelines -> !facts.guidelinesDue && passed
        }
    }

    /** Where sign-up carries on; null when every step is done (only the finish is left). */
    fun resume(facts: OnboardingFacts): OnboardingStep? = visible(facts).firstOrNull { !isDone(it, facts) }

    /** After [from] is passed: the next step not done yet, after it, else anywhere before; null to finish. */
    fun next(from: OnboardingStep, facts: OnboardingFacts): OnboardingStep? {
        val steps = visible(facts)
        return steps.firstOrNull { it.ordinal > from.ordinal && !isDone(it, facts) }
            ?: steps.firstOrNull { !isDone(it, facts) && it != from }
    }

    /** Birth date and gender are set once; after that going back skips them. */
    fun canRevisit(step: OnboardingStep, facts: OnboardingFacts): Boolean = when (step) {
        OnboardingStep.Privacy -> false
        OnboardingStep.BirthDate -> !facts.hasBirthDate
        OnboardingStep.Gender -> facts.gender == Gender.Unknown
        else -> true
    }

    /** The step before [from] a person may go back to, or null. */
    fun previous(from: OnboardingStep, facts: OnboardingFacts): OnboardingStep? =
        visible(facts).lastOrNull { it.ordinal < from.ordinal && canRevisit(it, facts) }

    /** 1-based position of [step] among the visible steps, and their count, for the progress bar. */
    fun progress(step: OnboardingStep, facts: OnboardingFacts): Pair<Int, Int> {
        val steps = visible(facts)
        val index = steps.indexOf(step).takeIf { it >= 0 } ?: steps.count { it.ordinal < step.ordinal }
        return (index + 1) to steps.size
    }
}

/** The catalogue fields sign-up offers: the kinds it can draw, never a special category (asked later, with its consent). */
fun app.core.model.FieldDef.offeredInOnboarding(): Boolean = !sensitive && kind in FIELD_KINDS && label.isNotBlank()

internal val FIELD_KINDS = setOf("single", "multi", "number", "text")
