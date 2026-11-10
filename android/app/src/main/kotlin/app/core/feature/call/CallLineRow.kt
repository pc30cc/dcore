package app.core.feature.call

import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.feature.chat.rememberChatClock
import app.core.i18n.AppLanguage
import app.core.i18n.brandString
import app.core.model.CallKind
import app.core.model.CallLine
import app.core.model.CallOutcome
import app.core.model.PublicUid
import app.core.ui.theme.AppTheme
import app.core.ui.components.overhangingTarget
import java.time.Instant

/*
 * The call in the chat: every call between the two leaves one line in their
 * conversation (a `call` message the server writes once, when the call ends).
 * These are the rules the line and the conversation list's preview draw it by.
 */

/**
 * A call line's title, by who is looking (missed: drawn in the danger colour):
 *
 * | outcome   | caller sees              | callee sees                  |
 * |-----------|--------------------------|------------------------------|
 * | completed | voice/video (+ length)   | the same                     |
 * | missed    | no answer                | missed voice/video (missed)  |
 * | cancelled | cancelled                | missed voice/video (missed)  |
 * | declined  | declined                 | declined                     |
 * | failed    | call failed              | call failed                  |
 *
 * A call the caller placed that never connected is not drawn as missed: the
 * red is for the person a call did not reach.
 *
 * [afterKind]: for a title that does not name the call's kind, the words
 * said after the kind wherever the line's icon is not there to say it (the
 * conversation list, TalkBack): "Voice call · Declined". Null when the title
 * names it already.
 */
enum class CallLineTitle(@StringRes val text: Int, @StringRes val afterKind: Int? = null) {
    VOICE(R.string.call_line_audio),
    VIDEO(R.string.call_line_video),
    MISSED_VOICE(R.string.call_line_missed_audio),
    MISSED_VIDEO(R.string.call_line_missed_video),
    NO_ANSWER(R.string.call_line_no_answer, afterKind = R.string.call_line_no_answer),
    DECLINED(R.string.call_line_declined, afterKind = R.string.call_line_declined),
    CANCELLED(R.string.call_line_cancelled, afterKind = R.string.call_line_cancelled),
    FAILED(R.string.call_line_failed, afterKind = R.string.call_line_failed_after_kind),
}

/** The line's title for the person looking at it: [viewerIsCaller] when they placed the call. */
fun CallLine.title(viewerIsCaller: Boolean): CallLineTitle {
    val video = kind == CallKind.Video
    val missed = if (video) CallLineTitle.MISSED_VIDEO else CallLineTitle.MISSED_VOICE
    return when (outcome) {
        CallOutcome.Completed -> if (video) CallLineTitle.VIDEO else CallLineTitle.VOICE
        CallOutcome.Missed -> if (viewerIsCaller) CallLineTitle.NO_ANSWER else missed
        CallOutcome.Cancelled -> if (viewerIsCaller) CallLineTitle.CANCELLED else missed
        CallOutcome.Declined -> CallLineTitle.DECLINED
        CallOutcome.Failed -> CallLineTitle.FAILED
        // A newer outcome this build does not know reads as the call it was.
        CallOutcome.Unknown -> if (video) CallLineTitle.VIDEO else CallLineTitle.VOICE
    }
}

/** Drawn in the danger colour: a call that rang the viewer and was not answered (missed, or cancelled while ringing). */
fun CallLine.isMissedFor(viewerIsCaller: Boolean): Boolean =
    !viewerIsCaller && (outcome == CallOutcome.Missed || outcome == CallOutcome.Cancelled)

/** The call's kind as a title: "Voice call", "Video call" (an unknown kind reads as voice, as [title] does). */
@StringRes
fun CallLine.kindText(): Int = if (kind == CallKind.Video) R.string.call_line_video else R.string.call_line_audio

/**
 * What says this call where its icon does not (the conversation list,
 * TalkBack): the title, after the kind when the title does not name it
 * ("Video call", "Declined": "Video call · Declined").
 */
fun CallLine.words(viewerIsCaller: Boolean): List<Int> {
    val title = title(viewerIsCaller)
    val after = title.afterKind ?: return listOf(title.text)
    return listOf(kindText(), after)
}

/** A completed call's length in seconds, or null for any other outcome or an unknown length. */
fun CallLine.lengthSeconds(): Long? =
    durationSeconds.takeIf { outcome == CallOutcome.Completed && it > 0 }

/**
 * The conversation list's preview: "Voice call · 2 min, 5 sec", "Missed video
 * call", "Voice call · Declined". [spoken] for what TalkBack reads: the units
 * spelt out and the parts joined as a sentence ("Voice call, 2 minutes,
 * 5 seconds"), not a middle dot read out.
 */
@Composable
fun callLinePreview(line: CallLine, me: PublicUid?, spoken: Boolean = false): String {
    val lengths = rememberCallLengths()
    val language = rememberLanguage()
    val words = line.words(viewerIsCaller = line.caller == me).map { brandString(it) }
    val length = line.lengthSeconds()?.let { if (spoken) lengths.spoken(it) else lengths.line(it) }
    return (words + listOfNotNull(length)).joinToString(spokenComma(language))
}

/** The comma TalkBack's sentences (and a call's words on screen) are joined with: Persian's own «،». */
internal fun spokenComma(language: AppLanguage): String = if (language == AppLanguage.FA) "، " else ", "

/**
 * One call in the conversation, as a system line (m10): centred, in
 * `--type-caption` `--text-3`, its words and the length of a completed call
 * («تماس صوتی، ۱۲ دقیقه»; missed, for the person it rang, in `--error`).
 * When [onCallBack] is given (the caller passes it only while both allow
 * calls) «زنگ بزن» follows in `--type-caption-strong` and the accent, a
 * 48 dp target over its 28 dp line, with the same kind; without it the line
 * is only a record. No icon, no direction arrow, no time of its own: the
 * day separators place it. Nothing in it is text anyone wrote, so it cannot
 * be replied to, copied or reported on its own. TalkBack reads it as one
 * sentence, the kind always named and the time it was made: "Voice call,
 * 2 minutes, 5 seconds, Outgoing, 5:57 PM", "Video call, Declined, Outgoing,
 * 11:10 AM".
 */
@Composable
fun CallLineRow(line: CallLine, me: PublicUid?, at: Instant, onCallBack: (() -> Unit)?, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    val viewerIsCaller = line.caller == me
    val missed = line.isMissedFor(viewerIsCaller)
    val language = rememberLanguage()
    val lengths = rememberCallLengths()
    val time = rememberChatClock().time(at)
    val words = line.words(viewerIsCaller).map { brandString(it) }
    val seconds = line.lengthSeconds()
    val shown = (words + listOfNotNull(seconds?.let(lengths::line))).joinToString(spokenComma(language))
    val direction = brandString(if (viewerIsCaller) R.string.call_line_outgoing else R.string.call_line_incoming)
    val label = (words + listOfNotNull(seconds?.let(lengths::spoken), direction, time)).joinToString(spokenComma(language))
    val callBack = brandString(R.string.call_line_call_back)
    // The line is centred in the thread's width; only what is drawn takes a tap, never the empty room beside it.
    Box(modifier.fillMaxWidth().padding(vertical = CallLineLayout.margin), contentAlignment = Alignment.Center) {
        Row(
            Modifier
                // A tap anywhere on the line's words calls back too; only the link shows it is pressed.
                .then(if (onCallBack != null) Modifier.clickable(interactionSource = null, indication = null, onClick = onCallBack) else Modifier)
                .clearAndSetSemantics {
                    testTag = callLineTag(line)
                    contentDescription = label
                    if (onCallBack != null) {
                        role = Role.Button
                        onClick(label = callBack) {
                            onCallBack()
                            true
                        }
                    }
                },
            horizontalArrangement = Arrangement.spacedBy(CallLineLayout.gap, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                shown,
                style = t.type.caption,
                color = if (missed) t.colors.error else t.colors.text3,
                textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (onCallBack != null) {
                // The accent (`--primary`): a link-like action, never the ink of controls.
                Text(
                    callBack,
                    style = t.type.captionStrong,
                    color = t.colors.primary,
                    maxLines = 1,
                    modifier = Modifier
                        .overhangingTarget(onCallBack)
                        .heightIn(min = CallLineLayout.linkHeight)
                        .wrapContentHeight(Alignment.CenterVertically)
                        .padding(horizontal = CallLineLayout.linkPad),
                )
            }
        }
    }
}

private object CallLineLayout {
    /** `.callline{margin:8px 0}`. */
    val margin = 8.dp
    val gap = 4.dp

    /** «زنگ بزن» as `.btn-txt` on the line: 28 dp tall, 6 dp each side. */
    val linkHeight = 28.dp
    val linkPad = 6.dp
}

/** The tag of a call line, for tests. */
fun callLineTag(line: CallLine): String = "call.line.${line.callId}"
