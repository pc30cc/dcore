package app.core.feature.auth.welcome

import androidx.compose.runtime.Immutable

/** One run of a headline: plain, or emphasised (set in the emphasis face). */
@Immutable
data class HeadlineRun(val text: String, val emphasis: Boolean)

/**
 * Headlines mark their emphasised words with asterisks: `Hello *there*`.
 * Pairs open and close; an asterisk left without a partner is kept as text,
 * and an empty pair (`**`) is dropped. Nothing nests.
 */
object Headline {

    fun parse(source: String): List<HeadlineRun> {
        val stars = source.count { it == '*' }
        // An odd count: the last asterisk has no partner and stays as text.
        val lastPaired = if (stars % 2 == 0) source.length else source.lastIndexOf('*')
        val runs = ArrayList<HeadlineRun>(4)
        val current = StringBuilder()
        var emphasis = false
        fun flush() {
            if (current.isEmpty()) return
            val last = runs.lastOrNull()
            // Runs of the same style side by side (around an empty pair) are one run.
            if (last != null && last.emphasis == emphasis) runs[runs.lastIndex] = last.copy(text = last.text + current) else runs += HeadlineRun(current.toString(), emphasis)
            current.clear()
        }
        source.forEachIndexed { index, char ->
            if (char == '*' && index != lastPaired) {
                flush()
                emphasis = !emphasis
            } else {
                current.append(char)
            }
        }
        flush()
        return runs
    }

    /** The headline as it reads, without its marks (what TalkBack and tests see). */
    fun plain(source: String): String = parse(source).joinToString("") { it.text }
}
