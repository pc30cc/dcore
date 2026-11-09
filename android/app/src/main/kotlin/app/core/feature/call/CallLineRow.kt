package app.core.feature.call

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
import app.core.ui.theme.Space
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
    return (words + listOfNotNull(length)).joinToString(if (spoken) spokenComma(language) else " · ")
}

/** The comma TalkBack's sentences are joined with: Persian's own «،». */
internal fun spokenComma(language: AppLanguage): String = if (language == AppLanguage.FA) "، " else ", "

/**
 * One call in the conversation: the phone or the camera, the title (missed in
 * the danger colour), an arrow out (for the caller) or in (for the callee)
 * with the length of a completed call ("2 min, 5 sec", never `2:05`) or the
 * direction, and the time it was made, apart and quieter, where a bubble
 * keeps its own. When [onCallBack] is given (the caller passes it only while
 * both allow calls) a round call-back button with the same kind ends the
 * line, and a tap anywhere on it calls back; without it the line is only a
 * record and shows no button. Nothing in it is text anyone wrote, so it
 * cannot be replied to, copied or reported on its own. TalkBack reads it as
 * one sentence, the kind always named: "Voice call, 2 minutes, 5 seconds,
 * Outgoing, 5:57 PM", "Video call, Declined, Outgoing, 11:10 AM".
 */
@Composable
fun CallLineRow(line: CallLine, me: PublicUid?, at: Instant, onCallBack: (() -> Unit)?, modifier: Modifier = Modifier) {
    val viewerIsCaller = line.caller == me
    val missed = line.isMissedFor(viewerIsCaller)
    val language = rememberLanguage()
    val lengths = rememberCallLengths()
    val time = rememberChatClock().time(at)
    // On the line the icon says voice or video, so the title stays short ("Declined").
    val title = brandString(line.title(viewerIsCaller).text)
    val words = line.words(viewerIsCaller).map { brandString(it) }
    val seconds = line.lengthSeconds()
    val direction = brandString(if (viewerIsCaller) R.string.call_line_outgoing else R.string.call_line_incoming)
    val label = (words + listOfNotNull(seconds?.let(lengths::spoken), direction, time)).joinToString(spokenComma(language))
    val callBack = brandString(R.string.call_line_call_back)
    val danger = AppTheme.colors.danger
    val tint = if (missed) danger else MaterialTheme.colorScheme.onSurface
    val quiet = MaterialTheme.colorScheme.onSurfaceVariant
    val kindIcon = if (line.kind == CallKind.Video) R.drawable.ic_call_videocam else R.drawable.ic_call_phone
    Box(modifier.fillMaxWidth().padding(vertical = Space.xs), contentAlignment = Alignment.Center) {
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            contentColor = MaterialTheme.colorScheme.onSurface,
            shape = RoundedCornerShape(20.dp),
            onClick = onCallBack ?: {},
            enabled = onCallBack != null,
            modifier = Modifier
                .widthIn(max = 360.dp)
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
        ) {
            Row(
                // The call-back button's touch target brings its own room at the end.
                Modifier.padding(start = Space.sm, end = if (onCallBack != null) Space.xs else Space.md, top = Space.sm, bottom = Space.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(tint.copy(alpha = 0.12f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        painterResource(kindIcon),
                        contentDescription = null,
                        tint = tint,
                        modifier = Modifier.size(20.dp),
                    )
                }
                Column(
                    Modifier.padding(start = Space.md).weight(1f, fill = false),
                    verticalArrangement = Arrangement.spacedBy(Space.xxs),
                ) {
                    Text(
                        title,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                        color = if (missed) danger else Color.Unspecified,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            painterResource(if (viewerIsCaller) R.drawable.ic_call_made else R.drawable.ic_call_received),
                            contentDescription = null,
                            tint = if (missed) danger else quiet,
                            modifier = Modifier.size(16.dp),
                        )
                        Text(
                            seconds?.let(lengths::line) ?: direction,
                            style = MaterialTheme.typography.labelMedium,
                            color = quiet,
                            modifier = Modifier.padding(start = Space.xs),
                        )
                    }
                }
                // The time it was made: apart from the length, and quieter, like a bubble's.
                Text(
                    time,
                    style = MaterialTheme.typography.labelSmall,
                    color = quiet,
                    maxLines = 1,
                    modifier = Modifier.align(Alignment.Bottom).padding(start = Space.lg),
                )
                if (onCallBack != null) {
                    // Says that a tap calls back (the whole line does), with the same kind.
                    // 40 dp, in its own 48 dp touch target; TalkBack has the line's action.
                    val accent = MaterialTheme.colorScheme.primary
                    IconButton(
                        onClick = onCallBack,
                        colors = IconButtonDefaults.iconButtonColors(containerColor = accent.copy(alpha = 0.12f), contentColor = accent),
                        modifier = Modifier.padding(start = Space.sm),
                    ) {
                        Icon(painterResource(kindIcon), contentDescription = null, modifier = Modifier.size(20.dp))
                    }
                }
            }
        }
    }
}

/** The tag of a call line, for tests. */
fun callLineTag(line: CallLine): String = "call.line.${line.callId}"
