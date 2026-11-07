package app.core.feature.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import app.core.R
import app.core.feature.card.currentLocale
import app.core.feature.card.isolate
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.JalaliDates
import app.core.i18n.brandString
import app.core.model.CallKind
import app.core.model.CallLine
import app.core.model.CallOutcome
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

/** A list row's time: the time today, "Yesterday", a weekday within the week, else a short date. */
@Composable
fun listTime(clock: ChatClockText, at: Instant, today: LocalDate): String {
    val date = clock.date(at)
    return when {
        date == today -> clock.time(at)
        date == today.minusDays(1) -> brandString(R.string.chat_day_yesterday)
        date.isAfter(today.minusDays(7)) && date.isBefore(today) -> clock.weekday(date)
        else -> clock.shortDay(date)
    }
}

/** A call's length: "0:42", "12:05", "1:02:09", in the reader's digits. */
fun callLength(clock: ChatClockText, seconds: Long): String {
    val s = seconds.coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    val r = s % 60
    val text = if (h > 0) "%d:%02d:%02d".format(Locale.ROOT, h, m, r) else "%d:%02d".format(Locale.ROOT, m, r)
    return clock.digits(text)
}

/** What a call line says, from the side of whoever reads it. */
@Composable
fun callLineText(call: CallLine, mine: Boolean, clock: ChatClockText): String {
    val video = call.kind == CallKind.Video
    return when (call.outcome) {
        CallOutcome.Completed -> brandString(
            if (video) R.string.chat_call_video_length else R.string.chat_call_audio_length,
            callLength(clock, call.durationSeconds),
        )
        CallOutcome.Missed, CallOutcome.Declined, CallOutcome.Cancelled ->
            if (mine) {
                brandString(if (video) R.string.chat_call_video_unanswered else R.string.chat_call_audio_unanswered)
            } else {
                brandString(if (video) R.string.chat_call_video_missed else R.string.chat_call_audio_missed)
            }
        else -> brandString(if (video) R.string.chat_call_video_failed else R.string.chat_call_audio_failed)
    }
}

/**
 * A conversation's preview line: the last message as text, from the reader's
 * side ("You: …"), with unsent messages, calls and media named rather than
 * shown.
 */
@Composable
fun previewText(message: Message?, me: String?, clock: ChatClockText): String? {
    message ?: return null
    val mine = message.senderId == me
    val core = when (message.kind) {
        MessageKind.Text, MessageKind.Gif -> message.body?.takeIf { it.isNotBlank() }?.let { isolate(it.lineSequence().first()) }
            ?: brandString(R.string.chat_preview_message)
        MessageKind.LikeNote -> message.body?.takeIf { it.isNotBlank() }?.let { brandString(R.string.chat_preview_like_note, isolate(it)) }
            ?: brandString(R.string.chat_preview_liked)
        MessageKind.Image -> brandString(R.string.chat_preview_photo)
        MessageKind.Voice -> brandString(R.string.chat_preview_voice)
        MessageKind.Call -> message.call?.let { callLineText(it, mine = it.caller == me, clock = clock) } ?: brandString(R.string.chat_preview_call)
        MessageKind.Unsend -> return brandString(if (mine) R.string.chat_preview_you_unsent else R.string.chat_preview_unsent)
        MessageKind.Reaction -> brandString(R.string.chat_preview_reaction, message.body.orEmpty())
        MessageKind.Unknown -> brandString(R.string.chat_preview_message)
    }
    return if (mine && message.kind != MessageKind.Call) brandString(R.string.chat_preview_you, core) else core
}
