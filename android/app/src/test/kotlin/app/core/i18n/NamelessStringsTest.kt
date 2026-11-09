package app.core.i18n

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The product has no name yet: the redesigned screens say nothing that
 * needs one (the logo mark stands alone). The strings that still say
 * `{appName}` are listed here and go as their screens are rewritten; a new
 * string must be written without it, and a rewritten one must leave this
 * list. Reads the string resources of main and both stores, every language.
 */
class NamelessStringsTest {

    /** Strings written before the redesign that still carry the placeholder. Shrinks, never grows. */
    private val notYetRewritten = setOf(
        "auth_closed_body", "auth_error_banned", "auth_sheet_signin_title", "auth_sheet_signup_title",
        "call_end_no_microphone_body", "call_notify_incoming_public", "call_notify_missed_public", "call_notify_ongoing_public",
        "chat_push_missing_body", "chat_unknown", "deck_location_title", "discover_empty_body", "maintenance_body",
        "onboarding_error_text_refused", "onboarding_interest_consent", "onboarding_location_body", "onboarding_name_body",
        "onboarding_rule_adults", "onboarding_rules_body", "paywall_current_grant", "paywall_title", "privacy_adults",
        "privacy_intro", "push_call_missed_body", "push_channel_offers_about", "push_like_body", "push_message_body",
        "push_offer_body", "push_support_body", "rating_prompt", "restricted_body", "review_body", "settings_rate",
        "splash_loading", "update_available", "update_required_body", "update_required_title",
    )

    private val entry = Regex("""<(string|item)\s+name="([a-z0-9_]+)"[^>]*>([^<]*)<""")
    private val plural = Regex("""<plurals\s+name="([a-z0-9_]+)"[^>]*>(.*?)</plurals>""", RegexOption.DOT_MATCHES_ALL)

    @Test
    fun `no new string needs the app's name`() {
        val roots = listOf("src/main/res", "src/bazaar/res", "src/play/res").map(::File).filter { it.isDirectory }
        val offenders = sortedSetOf<String>()
        for (root in roots) {
            root.walkTopDown().filter { it.isFile && it.parentFile.name.startsWith("values") && it.extension == "xml" }.forEach { file ->
                val text = file.readText()
                entry.findAll(text).filter { "{appName}" in it.groupValues[3] }.forEach { offenders += it.groupValues[2] }
                plural.findAll(text).filter { "{appName}" in it.groupValues[2] }.forEach { offenders += it.groupValues[1] }
            }
        }
        val added = offenders - notYetRewritten
        assertTrue("these strings need the app's name; write them without it (\"ما\", \"این‌جا\"): $added", added.isEmpty())
        val rewritten = notYetRewritten - offenders
        assertTrue("rewritten without the name, now remove them from the list: $rewritten", rewritten.isEmpty())
    }
}
