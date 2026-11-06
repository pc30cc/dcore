package app.core.model

/**
 * The numbers the app writes to `onboardingStep` (`PATCH /v1/me/profile`) as
 * the person moves through sign-up: the step they reached, so another phone
 * can carry on from there. Spaced by two so a step can be put between two
 * others without renumbering what accounts already store (the column is a
 * smallint, 0-50).
 *
 * [DONE] finishes sign-up: the server checks that everything required is
 * there and moves the account out of `onboarding` (to `active`, or to
 * `pending_review` when new profiles are reviewed first).
 */
object OnboardingCodes {
    const val START = 0
    const val NAME = 2
    const val BIRTH_DATE = 4
    const val GENDER = 6
    const val INTERESTED_IN = 8
    const val INTENTION = 10
    const val PHOTOS = 12
    const val PROMPTS = 14
    const val FIELDS = 16
    const val LOCATION = 18
    const val NOTIFICATIONS = 20
    const val GUIDELINES = 22
    const val DONE = 30
}
