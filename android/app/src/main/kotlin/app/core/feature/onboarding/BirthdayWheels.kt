package app.core.feature.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.snapping.SnapPosition
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.JalaliDate
import app.core.i18n.JalaliDates
import app.core.i18n.brandString
import app.core.ui.theme.AppTheme
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The birth date as three wheels (day, month, year), the Solar Hijri
 * calendar in Persian and the Gregorian one otherwise, under one continuous
 * selection band (50 dp, `--surface-2`, `--r-sm`) across all three. Every
 * year of the last hundred is on the wheel (none hinted at or left out).
 * Nothing is chosen until the person moves a wheel ([date] stays null), so
 * a date nobody looked at is never kept, and until then the rows in the band
 * are drawn like any other row. TalkBack reads each wheel as an adjustable
 * value («روز، ۱۴»).
 */
@Composable
fun BirthdayWheels(date: LocalDate?, today: LocalDate, language: AppLanguage, onChange: (LocalDate?) -> Unit, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    val jalali = language == AppLanguage.FA
    val locale = Locale.forLanguageTag(language.tag)
    val thisYear = if (jalali) JalaliDates.toJalali(today).year else today.year
    val firstYear = thisYear - YEARS_SHOWN
    val resting = WheelDate(jalali, thisYear - START_AGE, 1, 1)
    // Saved with its calendar: brought back in another language, the same date is shown in that one's.
    var stored by rememberSaveable(stateSaver = WheelDate.Saver) { mutableStateOf(date?.let { WheelDate.of(it, jalali) } ?: resting) }
    var touched by rememberSaveable { mutableStateOf(date != null) }
    val parts = stored.inCalendar(jalali) ?: resting
    val monthLength = parts.monthLength()
    // A day past a shorter month's end shows (and is kept as) that month's last day.
    val shownDay = parts.day.coerceAtMost(monthLength)

    fun move(next: WheelDate) {
        stored = next
        touched = true
        onChange(next.toDate()?.takeIf { !it.isAfter(today) })
    }

    val days = remember(monthLength, language) { (1..monthLength).map { Digits.localize(it.toString(), language) } }
    val months = remember(jalali, locale) { (1..12).map { monthName(it, jalali, locale) } }
    val years = remember(firstYear, thisYear, language) { (firstYear..thisYear).map { Digits.localize(it.toString(), language) } }
    val labels = listOf(
        brandString(R.string.onboarding_birthday_day),
        brandString(R.string.onboarding_birthday_month),
        brandString(R.string.onboarding_birthday_year),
    )
    val weights = listOf(DAY_WEIGHT, MONTH_WEIGHT, YEAR_WEIGHT)
    val chosen = touched && date != null

    Column(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(WheelSizes.gap)) {
            labels.forEachIndexed { i, label ->
                Text(
                    label,
                    style = t.type.section,
                    color = t.colors.text3,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    modifier = Modifier.weight(weights[i]).padding(bottom = WheelSizes.labelGap).clearAndSetSemantics { },
                )
            }
        }
        Box(Modifier.fillMaxWidth().height(WheelSizes.item * VISIBLE)) {
            // One band across the three wheels, behind the chosen row.
            Box(
                Modifier
                    .fillMaxWidth()
                    .offset(y = WheelSizes.item * (VISIBLE / 2))
                    .height(WheelSizes.item)
                    .background(t.colors.surface2, RoundedCornerShape(t.radii.sm)),
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(WheelSizes.gap)) {
                Wheel(labels[0], days, shownDay - 1, chosen, Modifier.weight(DAY_WEIGHT), cyclic = true) { move(parts.copy(day = it + 1)) }
                Wheel(labels[1], months, parts.month - 1, chosen, Modifier.weight(MONTH_WEIGHT), cyclic = true) { move(parts.copy(month = it + 1)) }
                Wheel(labels[2], years, parts.year - firstYear, chosen, Modifier.weight(YEAR_WEIGHT)) { move(parts.copy(year = firstYear + it)) }
            }
        }
    }
}

/**
 * The wheels' parts as shown, with the calendar they belong to ([jalali]):
 * the day may run past the month's end (it is shown and kept as the last
 * day), so the parts are kept rather than a date.
 */
internal data class WheelDate(val jalali: Boolean, val year: Int, val month: Int, val day: Int) {

    fun monthLength(): Int = if (jalali) JalaliDates.monthLength(year, month) else YearMonth.of(year, month).lengthOfMonth()

    /** The date the wheels show, or null when the parts make none. */
    fun toDate(): LocalDate? = runCatching {
        val d = day.coerceAtMost(monthLength())
        if (jalali) JalaliDates.toGregorian(JalaliDate(year, month, d)) else LocalDate.of(year, month, d)
    }.getOrNull()

    /** The same date in the other calendar; null when the parts make no date. */
    fun inCalendar(jalali: Boolean): WheelDate? = if (jalali == this.jalali) this else toDate()?.let { of(it, jalali) }

    companion object {
        fun of(date: LocalDate, jalali: Boolean): WheelDate =
            if (jalali) JalaliDates.toJalali(date).let { WheelDate(true, it.year, it.month, it.day) } else WheelDate(false, date.year, date.monthValue, date.dayOfMonth)

        val Saver = listSaver<WheelDate, Int>(
            save = { listOf(if (it.jalali) 1 else 0, it.year, it.month, it.day) },
            restore = { WheelDate(it[0] == 1, it[1], it[2], it[3]) },
        )
    }
}

/**
 * One wheel: [items] 50 dp apart, five in sight, the one in the band
 * `--type-h3` in `--text` once [chosen] (before, `--type-body` in
 * `--text-2`, like a row nobody picked), its neighbours `--text-2` at 75 %,
 * the outer ones `--text-3` at 45 %. A fling settles on a row; a tap on a
 * row turns it into the band. A [cyclic] wheel (days, months) runs on past
 * its end into its start, as a calendar does («اسفند» above «فروردین»).
 * [onSelect] hears the row a person settled on.
 */
@Composable
private fun Wheel(label: String, items: List<String>, selected: Int, chosen: Boolean, modifier: Modifier, cyclic: Boolean = false, onSelect: (Int) -> Unit) {
    val t = AppTheme.template
    val size = items.size.coerceAtLeast(1)
    // A cyclic wheel is the list many times over, started in the middle; a row's value is its index modulo the list.
    val rows = if (cyclic) size * LOOPS else size
    val base = if (cyclic) size * (LOOPS / 2) else 0
    val state = rememberLazyListState(initialFirstVisibleItemIndex = base + selected.coerceIn(0, size - 1))
    val fling = rememberSnapFlingBehavior(state, SnapPosition.Center)
    val scope = rememberCoroutineScope()
    val itemPx = with(LocalDensity.current) { WheelSizes.item.toPx() }
    val select by rememberUpdatedState(onSelect)
    val centredRow by remember(rows) {
        derivedStateOf { (state.firstVisibleItemIndex + (state.firstVisibleItemScrollOffset / itemPx).roundToInt()).coerceIn(0, rows - 1) }
    }
    val centred = centredRow % size
    // The row showing [index] nearest to the one in the band.
    fun rowOf(index: Int): Int = if (!cyclic) index else centredRow - centred + index
    // A person's drag counts once the wheel comes to rest; the code's own moves (a shorter month) never do.
    var dragged by remember { mutableStateOf(false) }
    LaunchedEffect(state) {
        state.interactionSource.interactions.collect { if (it is DragInteraction.Start) dragged = true }
    }
    LaunchedEffect(state, size) {
        snapshotFlow { state.isScrollInProgress }.distinctUntilChanged().collectLatest { scrolling ->
            if (!scrolling && dragged) {
                // A drag hands over to its fling a moment later: the wheel is at rest only if, a frame on, it
                // has not moved on (a new scroll cancels this wait).
                withFrameNanos { }
                if (!state.isScrollInProgress) {
                    dragged = false
                    // The row in the band now, read at rest (not the one the wheel started on).
                    select(centredRow % size)
                }
            }
        }
    }
    // The value moved from outside (a day past a shorter month's end): the wheel follows.
    LaunchedEffect(selected, size) {
        if (!state.isScrollInProgress && centred != selected && selected in 0 until size) state.scrollToItem(rowOf(selected))
    }
    val value = items.getOrNull(centred).orEmpty()
    LazyColumn(
        state = state,
        flingBehavior = fling,
        contentPadding = PaddingValues(vertical = WheelSizes.item * (VISIBLE / 2)),
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier
            .height(WheelSizes.item * VISIBLE)
            .clearAndSetSemantics {
                contentDescription = label
                stateDescription = value
                progressBarRangeInfo = ProgressBarRangeInfo(centred.toFloat(), 0f..(size - 1).coerceAtLeast(1).toFloat(), steps = (size - 2).coerceAtLeast(0))
                setProgress { target ->
                    val index = target.roundToInt().coerceIn(0, size - 1)
                    scope.launch { state.scrollToItem(rowOf(index)) }
                    select(index)
                    true
                }
            },
    ) {
        items(rows) { row ->
            val index = row % size
            val distance = abs(row - centredRow)
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(WheelSizes.item)
                    .clickable {
                        scope.launch { state.animateScrollToItem(row) }
                        select(index)
                    },
                contentAlignment = Alignment.Center,
            ) {
                val inBand = distance == 0 && chosen
                Text(
                    items.getOrElse(index) { "" },
                    style = if (inBand) t.type.h3 else t.type.body,
                    color = when {
                        inBand -> t.colors.text
                        distance <= 1 -> t.colors.text2
                        else -> t.colors.text3
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.alpha(
                        when (distance) {
                            0 -> 1f
                            1 -> NEAR_ALPHA
                            else -> FAR_ALPHA
                        },
                    ),
                )
            }
        }
    }
}

private fun monthName(month: Int, jalali: Boolean, locale: Locale): String =
    if (jalali) JALALI_MONTHS[month - 1] else java.time.Month.of(month).getDisplayName(TextStyle.FULL_STANDALONE, locale)

/** The Solar Hijri month names, Farvardin to Esfand (calendar data, the same in every UI language that shows them). */
internal val JALALI_MONTHS = listOf(
    "فروردین", "اردیبهشت", "خرداد",
    "تیر", "مرداد", "شهریور",
    "مهر", "آبان", "آذر",
    "دی", "بهمن", "اسفند",
)

private const val VISIBLE = 5
/** How many times a cyclic wheel repeats its list: far more than anyone scrolls. */
private const val LOOPS = 200
private const val YEARS_SHOWN = 100
/** Where the year wheel rests before anyone moves it. */
private const val START_AGE = 25
private const val DAY_WEIGHT = 1f
private const val MONTH_WEIGHT = 1.5f
private const val YEAR_WEIGHT = 1.2f
private const val NEAR_ALPHA = 0.75f
private const val FAR_ALPHA = 0.45f

private object WheelSizes {
    val item = 50.dp
    val gap = 10.dp
    val labelGap = 6.dp
}
