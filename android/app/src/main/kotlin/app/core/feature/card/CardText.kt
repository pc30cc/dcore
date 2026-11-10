package app.core.feature.card

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import app.core.R
import app.core.i18n.brandString
import app.core.model.Catalog
import app.core.model.Distance
import app.core.model.Intention
import app.core.model.ProfileCard
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** The reader's locale, as the configuration has it (Persian digits in Persian). */
@Composable
@ReadOnlyComposable
fun currentLocale(): Locale = LocalConfiguration.current.locales.get(0) ?: Locale.ROOT

/** Writes whole numbers in the reader's digits, without grouping (ages, kilometres, counts). */
@Composable
fun rememberNumbers(): (Int) -> String {
    val locale = currentLocale()
    return remember(locale) {
        val format = NumberFormat.getIntegerInstance(locale).apply { isGroupingUsed = false }
        val write: (Int) -> String = { n -> synchronized(format) { format.format(n.toLong()) } }
        write
    }
}

/** A time of day in the reader's style ("18:40", "6:40 PM"), in the phone's zone. */
@Composable
fun rememberTimeOfDay(): (Instant) -> String {
    val locale = currentLocale()
    return remember(locale) {
        val formatter = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale)
        val write: (Instant) -> String = { instant -> formatter.format(instant.atZone(ZoneId.systemDefault())) }
        write
    }
}

/**
 * [text] as a bidi isolate (FSI … PDI), for a person's words placed inside a
 * sentence: a name, city or comment in another script than the UI's keeps
 * its place. Without it "Elif, 25" in Persian, or a Persian name or city in
 * English, takes the line's direction from the name and draws the age or
 * the distance on the wrong side.
 */
fun isolate(text: String): String = "\u2068$text\u2069"

/** "Negar, 27", or the name alone when the age is hidden. */
@Composable
fun nameAndAge(card: ProfileCard, number: (Int) -> String): String =
    card.age?.let { brandString(R.string.deck_name_age, isolate(card.name), number(it)) } ?: card.name

/** «۴ کیلومتر», «کمتر از ۲ کیلومتر», or null when the person hides their distance. */
@Composable
fun distanceText(distance: Distance?, number: (Int) -> String): String? = distance?.let {
    if (it.lessThan) brandString(R.string.deck_distance_less, number(it.km)) else brandString(R.string.deck_distance_km, number(it.km))
}

/** The card's one line, «تهران، ۴ کیلومتر», either part alone, or null. */
@Composable
fun locationLine(card: ProfileCard, number: (Int) -> String): String? {
    val distance = distanceText(card.distance, number)
    val city = card.city?.name?.takeIf { it.isNotBlank() }
    return when {
        city != null && distance != null -> brandString(R.string.deck_city_distance, isolate(city), distance)
        else -> city ?: distance
    }
}

/** What someone is looking for, in the panel's words when the config has them, else the app's. */
@Composable
fun intentionLabel(intention: Intention?, catalog: Catalog): String? {
    if (intention == null || intention == Intention.Unknown) return null
    catalog.intentions.firstOrNull { it.key == intention.wire }?.label?.takeIf { it.isNotBlank() }?.let { return it }
    return brandString(
        when (intention) {
            Intention.Serious -> R.string.profile_view_intention_serious
            Intention.Marriage -> R.string.profile_view_intention_marriage
            Intention.Friendship -> R.string.profile_view_intention_friendship
            Intention.NotSure, Intention.Unknown -> R.string.profile_view_intention_not_sure
        },
    )
}

/**
 * The whole card in one sentence, for TalkBack: what the card shows (name,
 * age, badge, online, city and distance) and whether they already like you.
 */
@Composable
fun cardDescription(card: ProfileCard, number: (Int) -> String): String = buildList {
    add(nameAndAge(card, number))
    if (card.verified) add(brandString(R.string.deck_verified))
    if (card.activeRecently) add(brandString(R.string.ui_online))
    if (card.superliked) add(brandString(R.string.deck_superliked_you)) else if (card.likesYou) add(brandString(R.string.deck_likes_you))
    locationLine(card, number)?.let(::add)
}.joinToString(". ")
