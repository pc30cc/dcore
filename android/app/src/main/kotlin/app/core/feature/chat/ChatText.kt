package app.core.feature.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import kotlinx.coroutines.delay
import app.core.R
import app.core.feature.call.callLinePreview
import app.core.feature.card.currentLocale
import app.core.feature.card.isolate
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.JalaliDates
import app.core.i18n.brandString
import app.core.model.Message
import app.core.model.MessageKind
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Locale

/**
 * How the chat writes times and days for the reader: Persian digits and the
 * Solar Hijri calendar in Persian, the locale's own style elsewhere. Pure
 * functions over a locale and "today", so the rules are tested without a
 * screen.
 */
class ChatClockText(private val locale: Locale, private val zone: ZoneId = ZoneId.systemDefault()) {

    private val language = AppLanguage.fromTag(locale.toLanguageTag()) ?: AppLanguage.EN
    private val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale)
    private val gregorianDay = DateTimeFormatter.ofPattern("d MMMM", locale)
    private val gregorianDayYear = DateTimeFormatter.ofPattern("d MMMM yyyy", locale)
    private val gregorianShort = DateTimeFormatter.ofPattern("d MMM", locale)

    val persian: Boolean get() = language == AppLanguage.FA

    fun digits(text: String): String = Digits.localize(Digits.ascii(text), language)

    /** "18:40", in the reader's digits. */
    fun time(at: Instant): String = digits(time.format(at.atZone(zone)))

    fun date(at: Instant): LocalDate = at.atZone(zone).toLocalDate()

    /** A day's name in a calendar the reader uses: "15 Aban 1405" in Persian, "6 November 2026" elsewhere; the year only when it is not this one. */
    fun day(date: LocalDate, today: LocalDate): String {
        if (persian) {
            val j = JalaliDates.toJalali(date)
            val thisYear = JalaliDates.toJalali(today).year
            val text = if (j.year == thisYear) "${j.day} ${JALALI_MONTHS[j.month - 1]}" else "${j.day} ${JALALI_MONTHS[j.month - 1]} ${j.year}"
            return digits(text)
        }
        return digits((if (date.year == today.year) gregorianDay else gregorianDayYear).format(date))
    }

    /** A short date for a list row: "15 Aban" / "6 Nov". */
    fun shortDay(date: LocalDate): String {
        if (persian) {
            val j = JalaliDates.toJalali(date)
            return digits("${j.day} ${JALALI_MONTHS[j.month - 1]}")
        }
        return digits(gregorianShort.format(date))
    }

    fun weekday(date: LocalDate): String = date.dayOfWeek.getDisplayName(TextStyle.FULL, locale)

    companion object {
        /** The Solar Hijri months, Farvardin to Esfand (calendar data). */
        val JALALI_MONTHS = listOf(
            "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
            "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
        )
    }
}

/**
 * The time now, read again as each minute turns: one value for a whole
 * list, so its rows skip recomposing in between, and «الان» or «۲ ساعت پیش»
 * move on by themselves.
 */
@Composable
fun rememberMinuteNow(): Instant {
    val now by produceState(Instant.now()) {
        while (true) {
            delay(MINUTE_MS - System.currentTimeMillis() % MINUTE_MS)
            value = Instant.now()
        }
    }
    return now
}

/** Today in the phone's zone, the same object for as long as [now] is. */
@Composable
fun rememberToday(now: Instant): LocalDate = remember(now) { now.atZone(ZoneId.systemDefault()).toLocalDate() }

private const val MINUTE_MS = 60_000L

@Composable
fun rememberChatClock(): ChatClockText {
    val locale = currentLocale()
    return remember(locale) { ChatClockText(locale) }
}

/** The day separator: "Today", "Yesterday", a weekday within the week, else the date. */
@Composable
fun dayHeader(clock: ChatClockText, date: LocalDate, today: LocalDate): String = when {
    date == today -> brandString(R.string.chat_day_today)
    date == today.minusDays(1) -> brandString(R.string.chat_day_yesterday)
    date.isAfter(today.minusDays(7)) && date.isBefore(today) -> clock.weekday(date)
    else -> clock.day(date, today)
}

/**
 * A list row's time (`time.now`, `time.yesterday`, `time.daysAgo`): «الان»
 * within the minute before [now], the time today (or, with [hoursToday],
 * «۲ ساعت پیش» from the first hour on, as a request's line says it),
 * «دیروز», «۳ روز پیش» within the week, else a short date.
 */
@Composable
fun listTime(clock: ChatClockText, at: Instant, today: LocalDate, now: Instant? = null, hoursToday: Boolean = false): String {
    val date = clock.date(at)
    val days = java.time.temporal.ChronoUnit.DAYS.between(date, today)
    val resources = androidx.compose.ui.platform.LocalResources.current
    val ago = now?.let { java.time.Duration.between(at, it) }
    return when {
        ago != null && !ago.isNegative && ago < JUST_NOW -> brandString(R.string.chat_time_now)
        days == 0L && hoursToday && ago != null && ago.toHours() >= 1 ->
            resources.getQuantityString(R.plurals.chat_time_hours_ago, ago.toHours().toInt(), clock.digits(ago.toHours().toString()))
        days == 0L -> clock.time(at)
        days == 1L -> brandString(R.string.chat_day_yesterday)
        days in 2..6 -> resources.getQuantityString(R.plurals.chat_time_days_ago, days.toInt(), clock.digits(days.toString()))
        else -> clock.shortDay(date)
    }
}

private val JUST_NOW: java.time.Duration = java.time.Duration.ofMinutes(1)

/**
 * A conversation's preview line: the last message as text, from the reader's
 * side ("You: …"), with unsent messages, calls and media named rather than
 * shown. [spoken] for TalkBack: a call's length with its units spelt out
 * ("Video call, 12 minutes, 34 seconds"); the rest reads as it is shown.
 */
@Composable
fun previewText(message: Message?, me: String?, spoken: Boolean = false): String? {
    message ?: return null
    val mine = message.senderId == me
    val core = when (message.kind) {
        MessageKind.Text, MessageKind.Gif -> message.body?.takeIf { it.isNotBlank() }?.let { isolate(it.lineSequence().first()) }
            ?: brandString(R.string.chat_preview_message)
        MessageKind.LikeNote -> message.body?.takeIf { it.isNotBlank() }?.let { brandString(R.string.chat_preview_like_note, isolate(it)) }
            ?: brandString(R.string.chat_preview_liked)
        MessageKind.Image -> brandString(R.string.chat_preview_photo)
        MessageKind.Voice -> message.media?.durationMs?.takeIf { it > 0 }
            ?.let { brandString(R.string.chat_preview_voice_length, app.core.feature.call.callDuration((it + 999) / 1000, app.core.feature.call.rememberLanguage())) }
            ?: brandString(R.string.chat_preview_voice)
        MessageKind.Call -> message.call?.let { callLinePreview(it, me, spoken) } ?: brandString(R.string.chat_preview_call)
        MessageKind.Unsend -> return brandString(if (mine) R.string.chat_preview_you_unsent else R.string.chat_preview_unsent)
        MessageKind.Reaction -> brandString(R.string.chat_preview_reaction, message.body.orEmpty())
        MessageKind.Unknown -> brandString(R.string.chat_preview_message)
    }
    return if (mine && message.kind != MessageKind.Call) brandString(R.string.chat_preview_you, core) else core
}

