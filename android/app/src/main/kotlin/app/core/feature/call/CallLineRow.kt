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
import app.core.feature.card.rememberTimeOfDay
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
 * A call line's title, by who is looking:
 *
 * | outcome   | caller sees              | callee sees               |
 * |-----------|--------------------------|---------------------------|
 * | completed | voice/video (+ length)   | the same                  |
 * | missed    | no answer                | missed voice/video        |
 * | cancelled | cancelled                | missed voice/video        |
 * | declined  | declined                 | declined                  |
 * | failed    | call failed              | call failed               |
 */
enum class CallLineTitle(@StringRes val text: Int) {
    VOICE(R.string.call_line_audio),
    VIDEO(R.string.call_line_video),
    MISSED_VOICE(R.string.call_line_missed_audio),
    MISSED_VIDEO(R.string.call_line_missed_video),
    NO_ANSWER(R.string.call_line_no_answer),
    DECLINED(R.string.call_line_declined),
    CANCELLED(R.string.call_line_cancelled),
    FAILED(R.string.call_line_failed),
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

/** Drawn in the danger colour: a missed call, and a cancelled one for the callee. */
fun CallLine.isMissedFor(viewerIsCaller: Boolean): Boolean =
    outcome == CallOutcome.Missed || (outcome == CallOutcome.Cancelled && !viewerIsCaller)

/** A completed call's length (`m:ss`, `h:mm:ss`), or null for any other outcome or an unknown length. */
fun CallLine.length(language: AppLanguage): String? =
    if (outcome == CallOutcome.Completed && durationSeconds > 0) callDuration(durationSeconds, language) else null

/** The conversation list's preview: "Voice call · 4:05", "Missed video call". */
@Composable
fun callLinePreview(line: CallLine, me: PublicUid): String {
    val viewerIsCaller = line.caller == me
    val title = brandString(line.title(viewerIsCaller).text)
    return line.length(rememberLanguage())?.let { "$title · $it" } ?: title
}

/**
 * One call in the conversation: the phone or the camera, an arrow out (for
 * the caller) or in (for the callee), the title, the time and, for a completed
 * call, its length; missed in the danger colour. A tap calls back with the
 * same kind when [onCallBack] is given: the caller passes it only while both
 * allow calls. Nothing in it is text anyone wrote, so it cannot be replied
 * to, copied or reported on its own. TalkBack reads it as one sentence.
 */
@Composable
fun CallLineRow(line: CallLine, me: PublicUid, at: Instant, onCallBack: (() -> Unit)?, modifier: Modifier = Modifier) {
    val viewerIsCaller = line.caller == me
    val missed = line.isMissedFor(viewerIsCaller)
    val language = rememberLanguage()
    val timeOf = rememberTimeOfDay()
    val title = brandString(line.title(viewerIsCaller).text)
    val length = line.length(language)
    val direction = brandString(if (viewerIsCaller) R.string.call_line_outgoing else R.string.call_line_incoming)
    val time = app.core.i18n.Digits.localize(timeOf(at), language)
    val comma = if (language == AppLanguage.FA) "، " else ", "
    val label = listOfNotNull(title, length, direction, time).joinToString(comma)
    val callBack = brandString(R.string.call_line_call_back)
    val danger = AppTheme.colors.danger
    val tint = if (missed) danger else MaterialTheme.colorScheme.onSurface
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
            Row(Modifier.padding(horizontal = Space.md, vertical = Space.sm), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(tint.copy(alpha = 0.12f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        painterResource(if (line.kind == CallKind.Video) R.drawable.ic_call_videocam else R.drawable.ic_call_phone),
                        contentDescription = null,
                        tint = tint,
                        modifier = Modifier.size(20.dp),
                    )
                }
                Column(Modifier.padding(start = Space.md, end = Space.xs), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
                    Text(
                        title,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                        color = if (missed) danger else Color.Unspecified,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            painterResource(if (viewerIsCaller) R.drawable.ic_call_made else R.drawable.ic_call_received),
                            contentDescription = null,
                            tint = if (missed) danger else MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(16.dp),
                        )
                        Text(
                            listOfNotNull(time, length).joinToString(" · "),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = Space.xs),
                        )
                    }
                }
            }
        }
    }
}

/** The tag of a call line, for tests. */
fun callLineTag(line: CallLine): String = "call.line.${line.callId}"
