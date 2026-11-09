import { z } from 'zod';
import { type callLineSchema, wireTime, type Message } from '../../api/common.js';
import { callKind, callOutcome, type CallKind, type CallOutcome } from '../../codes.js';
import type { CallSide } from './model.js';

type CallLine = z.infer<typeof callLineSchema>;

/**
 * The call in the chat: every finished call leaves one line in its
 * conversation, a `messages` row of kind 5 (`ref_id` = the call, the sender
 * = the caller), written in the same transaction as the `calls` row. Its id
 * is minted right before that transaction, so it sorts after every cursor
 * handed out before it is durable, and its time (the id's) is the line's
 * time everywhere it is shown. Its body is a small summary (below) from which `call`
 * is built on every read; nothing else of the calls row is needed to show it.
 *
 * Titles, by who is looking:
 *
 *   | outcome   | caller sees         | callee sees             |
 *   |-----------|---------------------|-------------------------|
 *   | completed | voice/video + time  | the same                |
 *   | missed    | no answer           | missed voice/video call |
 *   | cancelled | cancelled           | missed voice/video call |
 *   | declined  | declined            | declined                |
 *   | failed    | failed              | failed                  |
 *
 * A missed or cancelled line counts as unread for the callee; the caller's
 * own line never counts for the caller.
 */

const bodySchema = z.strictObject({
  v: z.literal(1),
  /** calls.kind */
  k: z.number().int(),
  /** calls.outcome */
  o: z.number().int(),
  /** Talk time, seconds (completed calls only). */
  d: z.number().int().nonnegative(),
  /** When the call was placed, epoch ms. */
  p: z.number().int().nonnegative(),
});

export interface CallLineSummary {
  kind: CallKind;
  outcome: CallOutcome;
  durationSeconds: number;
  placedMs: number;
}

export function encodeCallLineBody(summary: CallLineSummary): string {
  return JSON.stringify({
    v: 1,
    k: callKind.code(summary.kind),
    o: callOutcome.code(summary.outcome),
    d: summary.outcome === 'completed' ? Math.max(0, Math.round(summary.durationSeconds)) : 0,
    p: summary.placedMs,
  });
}

/** The summary of a stored line, or null for a body that is not one. */
export function decodeCallLineBody(body: string | null | undefined): CallLineSummary | null {
  if (!body) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return null;
  const kind = callKind.nameOrUndefined(parsed.data.k);
  const outcome = callOutcome.nameOrUndefined(parsed.data.o);
  if (!kind || !outcome) return null;
  return { kind, outcome, durationSeconds: parsed.data.d, placedMs: parsed.data.p };
}

/** `call` of a line, as both people see it (`caller` is the caller's public id). */
export function callLineOf(callId: string, summary: CallLineSummary, callerPublicUid: string): CallLine {
  return {
    callId,
    kind: summary.kind,
    outcome: summary.outcome,
    placedAt: wireTime(summary.placedMs),
    durationSeconds: summary.outcome === 'completed' ? summary.durationSeconds : 0,
    caller: callerPublicUid,
  };
}

/** The line as a message (realtime `message`, history reads). */
export function callLineMessage(input: {
  lineId: string;
  conversationId: string;
  callId: string;
  callerPublicUid: string;
  summary: CallLineSummary;
  atMs: number;
}): Message {
  return {
    id: input.lineId,
    conversationId: input.conversationId,
    senderId: input.callerPublicUid,
    kind: 'call',
    refId: input.callId,
    call: callLineOf(input.callId, input.summary, input.callerPublicUid),
    at: wireTime(input.atMs),
  };
}

export type CallLineTitle =
  | 'voice'
  | 'video'
  | 'no_answer'
  | 'cancelled'
  | 'declined'
  | 'failed'
  | 'missed_voice'
  | 'missed_video';

/** The title of a line for the person looking at it. */
export function callLineTitle(summary: Pick<CallLineSummary, 'kind' | 'outcome'>, viewer: CallSide): CallLineTitle {
  switch (summary.outcome) {
    case 'completed':
      return summary.kind === 'video' ? 'video' : 'voice';
    case 'missed':
      return viewer === 'caller' ? 'no_answer' : summary.kind === 'video' ? 'missed_video' : 'missed_voice';
    case 'cancelled':
      return viewer === 'caller' ? 'cancelled' : summary.kind === 'video' ? 'missed_video' : 'missed_voice';
    case 'declined':
      return 'declined';
    case 'failed':
      return 'failed';
  }
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatCallDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Whether a line counts as unread for this person. */
export function callLineUnreadFor(summary: Pick<CallLineSummary, 'outcome'>, viewer: CallSide): boolean {
  return viewer === 'callee' && (summary.outcome === 'missed' || summary.outcome === 'cancelled');
}

type TitleTexts = Record<CallLineTitle, string>;

const TITLES: Record<'en' | 'fa' | 'tr', TitleTexts> = {
  en: {
    voice: 'Voice call',
    video: 'Video call',
    no_answer: 'No answer',
    cancelled: 'Cancelled call',
    declined: 'Declined call',
    failed: 'Call failed',
    missed_voice: 'Missed voice call',
    missed_video: 'Missed video call',
  },
  fa: {
    voice: 'تماس صوتی',
    video: 'تماس تصویری',
    no_answer: 'بی‌پاسخ',
    cancelled: 'تماس لغوشده',
    declined: 'تماس ردشده',
    failed: 'تماس ناموفق',
    missed_voice: 'تماس صوتی بی‌پاسخ',
    missed_video: 'تماس تصویری بی‌پاسخ',
  },
  tr: {
    voice: 'Sesli arama',
    video: 'Görüntülü arama',
    no_answer: 'Yanıt yok',
    cancelled: 'İptal edilen arama',
    declined: 'Reddedilen arama',
    failed: 'Arama başarısız',
    missed_voice: 'Cevapsız sesli arama',
    missed_video: 'Cevapsız görüntülü arama',
  },
};

/** The line's text for a list preview, in a language (`m:ss` after a completed call's title). */
export function callLinePreview(summary: CallLineSummary, viewer: CallSide, locale: string): string {
  const base = locale.slice(0, 2).toLowerCase();
  const texts = TITLES[base === 'fa' || base === 'tr' ? base : 'en'];
  const title = texts[callLineTitle(summary, viewer)];
  return summary.outcome === 'completed' ? `${title} · ${formatCallDuration(summary.durationSeconds)}` : title;
}
