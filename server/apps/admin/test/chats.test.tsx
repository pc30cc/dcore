import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeApi, owner, problem, renderPanel, resetPanel, signInAs, wholeText, type Call } from './panel';
import { chatList, chatMessage, chatPage, chatsAdmin, chatSummary, CHATS_ADMIN, detail, fullAdmin, LEO, moderatorAdmin, readOnlyAdmin, SARA } from './userFixtures';

/**
 * The user page's Chats tab: who sees it, the list of a person's
 * conversations, one conversation's messages page by page, and that it
 * only ever reads.
 */

const LIST = `GET /v1/admin/users/${SARA}/chats`;

/** The bubble whose body is exactly `text` (a reply's quote of it is not its body). */
const bubbleOf = (pane: HTMLElement, text: string): HTMLElement => {
  const body = Array.from(pane.querySelectorAll('p[dir="auto"]')).find((p) => p.textContent === text);
  if (!body) throw new Error(`no message ${text}`);
  return body.closest('li')!;
};
const chatPath = (id: string) => `GET /v1/admin/users/${SARA}/chats/${id}`;

const open = chatSummary('9001', { messages: { count: 12, more: false } });
const held = chatSummary('9002', {
  other: { id: 'miraaaaaaaaaa', name: 'Mira Sohrabi', status: 'active' },
  state: 'blocked',
  endedAt: '2026-11-20T09:00:00.000Z',
  endedBy: 'other',
  held: true,
  source: 'request',
  messages: { count: 100, more: true },
  visibility: { subjectSeesOther: true, otherSeesSubject: false },
});
const gone = chatSummary('9003', {
  other: { id: 'goneeeeeeeeee', name: null, status: 'purged' },
  state: 'account_gone',
  endedAt: '2026-11-10T09:00:00.000Z',
  endedBy: 'system',
  lastActivityAt: null,
  messages: { count: 0, more: false },
});
const shadowed = chatSummary('9004', {
  other: { id: 'kianaaaaaaaaa', name: 'Kian', status: 'active' },
  messages: { count: 1, more: false },
  visibility: { subjectSeesOther: false, otherSeesSubject: false },
});

/** A conversation with a message of every kind the tab draws. */
const thread = [
  chatMessage('100', { from: 'other', body: 'سلام، خوبی؟', at: '2026-11-24T18:00:00.000Z' }),
  chatMessage('101', { from: 'subject', body: 'Hi! All good', refId: '100', at: '2026-11-24T18:01:00.000Z' }),
  chatMessage('102', { from: 'subject', body: 'Call me at 0912 000 0000', at: '2026-11-25T09:00:00.000Z', unsentAt: '2026-11-25T09:02:00.000Z', flags: ['risky'] }),
  chatMessage('103', { from: 'subject', kind: 'unsend', body: null, refId: '102', at: '2026-11-25T09:02:00.000Z' }),
  chatMessage('104', { from: 'other', body: null, flags: ['body_removed'], unsentAt: '2026-11-25T09:05:00.000Z', at: '2026-11-25T09:04:00.000Z' }),
  chatMessage('105', { from: 'other', kind: 'image', body: null, refId: '701', at: '2026-11-25T10:00:00.000Z' }),
  chatMessage('106', { from: 'subject', kind: 'voice', body: null, refId: '702', at: '2026-11-25T10:01:00.000Z' }),
  chatMessage('107', { from: 'other', kind: 'gif', body: 'tenor:12345', at: '2026-11-25T10:02:00.000Z' }),
  chatMessage('108', { from: 'other', kind: 'call', body: null, refId: '77', at: '2026-11-25T11:00:00.000Z', call: { kind: 'audio', outcome: 'completed', durationSeconds: 192 } }),
  chatMessage('109', { from: 'subject', kind: 'call', body: null, refId: '78', at: '2026-11-25T11:30:00.000Z', call: { kind: 'video', outcome: 'missed', durationSeconds: 0 } }),
  chatMessage('110', { from: 'subject', kind: 'reaction', body: '❤️', refId: '107', at: '2026-11-25T12:00:00.000Z' }),
  chatMessage('111', { from: 'other', kind: 'reaction', body: '', refId: '101', at: '2026-11-25T12:01:00.000Z' }),
  chatMessage('112', { from: 'other', kind: 'unsend', flags: ['hidden'], body: null, refId: '104', at: '2026-11-25T12:02:00.000Z' }),
  chatMessage('113', { from: 'subject', kind: 'like_note', body: 'Love this photo', refId: '55', at: '2026-11-25T13:00:00.000Z', shadowed: true }),
  chatMessage('114', { from: 'other', body: 'Still there?', at: '2026-11-25T14:05:00.000Z', pending: true }),
];

const REQUESTS = `GET /v1/admin/users/${SARA}/chat-requests`;
const requests = [
  {
    id: '7002',
    direction: 'received',
    other: { id: 'omidaaaaaaaaa', name: 'Omid Karimi', status: 'active' },
    status: 'accepted',
    sentAt: '2026-11-20T08:00:00.000Z',
    decidedAt: '2026-11-20T09:00:00.000Z',
    body: 'Hi, I liked your photos',
    conversationId: '9001',
  },
  {
    id: '7001',
    direction: 'sent',
    other: { id: 'ninaaaaaaaaaa', name: 'Nina', status: 'active' },
    status: 'declined',
    sentAt: '2026-11-18T08:00:00.000Z',
    decidedAt: '2026-11-19T08:00:00.000Z',
    body: 'سلام، وقت داری؟',
    conversationId: null,
  },
];

function chatsApi(extra: Record<string, (call: Call) => unknown> = {}) {
  return fakeApi({
    [REQUESTS]: () => ({ items: requests, nextCursor: null }),
    [`GET /v1/admin/users/${SARA}`]: () => detail(),
    [`GET /v1/admin/users/${SARA}/photos`]: () => ({ items: [] }),
    [LIST]: (call) => (call.query.cursor ? chatList([shadowed]) : chatList([open, held, gone], 'next-chats')),
    [chatPath('9001')]: () => chatPage(open, thread),
    [chatPath('9002')]: () => chatPage(held, [chatMessage('200', { body: 'Held message' })]),
    [chatPath('9003')]: () => chatPage(gone, []),
    ...extra,
  });
}

beforeEach(() => {
  resetPanel();
  signInAs(chatsAdmin);
});

describe('the Chats tab: who sees it', () => {
  it('is a tab for the owner and for an admin holding users.chats', async () => {
    for (const me of [{ ...owner, permissions: CHATS_ADMIN }, chatsAdmin]) {
      signInAs(me);
      const { unmount } = renderPanel(`/users/${SARA}`, chatsApi());
      expect(await screen.findByRole('tab', { name: 'Chats' })).toBeTruthy();
      unmount();
    }
  });

  it('is no tab for a moderator, a support agent or an admin without users.chats, and reads nothing from the URL', async () => {
    for (const me of [moderatorAdmin, readOnlyAdmin, fullAdmin]) {
      signInAs(me);
      const api = chatsApi();
      const { unmount } = renderPanel(`/users/${SARA}?tab=chats&c=9001`, api);
      expect(await screen.findByText('I like mountains')).toBeTruthy();
      expect(screen.queryByRole('tab', { name: 'Chats' })).toBeNull();
      expect(screen.getByRole('tab', { name: 'Profile' }).getAttribute('aria-selected')).toBe('true');
      expect(api.calls.filter((call) => call.path.includes('/chats'))).toHaveLength(0);
      unmount();
    }
  });

  it('reads nothing until the tab is opened', async () => {
    const api = chatsApi();
    const user = userEvent.setup();
    const { router } = renderPanel(`/users/${SARA}`, api);
    await user.click(await screen.findByRole('tab', { name: 'Chats' }));
    expect(router.state.location.search).toBe('?tab=chats');
    expect(await screen.findByText('Leo Brandt')).toBeTruthy();
    // Every read of the list is its first page (a StrictMode remount may repeat it).
    expect(api.of(LIST).length).toBeGreaterThan(0);
    expect(api.of(LIST).every((call) => call.query.limit === '20' && call.query.cursor === undefined)).toBe(true);
    expect(api.calls.some((call) => call.path.startsWith(`/v1/admin/users/${SARA}/chats/`))).toBe(false);
  });
});

describe('the Chats tab: the list', () => {
  it('shows each conversation with whom, since when, the last activity, the count and its state, most recently started first', async () => {
    renderPanel(`/users/${SARA}?tab=chats`, chatsApi());
    const list = await screen.findByRole('list', { name: 'Chats' });
    const rows = within(list).getAllByRole('link');
    expect(rows).toHaveLength(3);
    const first = rows[0]!;
    expect(within(first).getByText('Leo Brandt')).toBeTruthy();
    expect(within(first).getByText(LEO)).toBeTruthy();
    expect(within(first).getByText('Open')).toBeTruthy();
    expect(first.textContent).toContain('Started Nov 3, 2026');
    expect(first.textContent).toContain('Last activity Nov 25, 2026');
    expect(screen.getByText('Most recently started first')).toBeTruthy();
    expect(screen.queryByText('Messages not saved yet could not all be counted.')).toBeNull();
    expect(first.textContent).toContain('12 messages');
    // A blocked one with a hold, from a request, over a hundred messages; hidden-from badges only while open.
    const second = rows[1]!;
    expect(within(second).getByText('Blocked')).toBeTruthy();
    expect(within(second).getByText('Legal hold')).toBeTruthy();
    expect(within(second).getByText('From a message request')).toBeTruthy();
    expect(second.textContent).toContain('100+ messages');
    expect(within(second).queryByText('Not shown to the other person')).toBeNull();
    // The other person's account is gone: no name, no messages.
    const third = rows[2]!;
    expect(within(third).getByText('Deleted account')).toBeTruthy();
    expect(within(third).getByText('Ended: account banned or deleted')).toBeTruthy();
    expect(third.textContent).toContain('No messages');
    // Nothing is open yet.
    expect(screen.getByText('No conversation selected.')).toBeTruthy();
    expect(rows.every((row) => row.getAttribute('aria-current') === null)).toBe(true);
  });

  it('loads the next page with the cursor and marks a conversation hidden either way while it is open', async () => {
    const api = chatsApi();
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}?tab=chats`, api);
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Kian')).toBeTruthy();
    expect(api.of(LIST).filter((call) => call.query.cursor).map((call) => call.query)).toEqual([{ limit: '20', cursor: 'next-chats' }]);
    const row = screen.getByText('Kian').closest('a')!;
    expect(within(row).getByText('Not shown to the other person')).toBeTruthy();
    expect(within(row).getByText('Not shown to this person')).toBeTruthy();
    expect(row.textContent).toContain('1 message');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says when there is no conversation, and shows no empty conversation pane beside it', async () => {
    renderPanel(`/users/${SARA}?tab=chats`, chatsApi({ [LIST]: () => chatList([]) }));
    expect(await screen.findByText('No conversations.')).toBeTruthy();
    expect(screen.queryByText('No conversation selected.')).toBeNull();
  });

  it('says when messages not saved yet could not all be counted, and gives such a count as a lower bound', async () => {
    const short = chatSummary('9005', { messages: { count: 3, more: false }, countComplete: false });
    renderPanel(`/users/${SARA}?tab=chats`, chatsApi({ [LIST]: () => chatList([open, short], null, { streamComplete: false }) }));
    expect(await screen.findByText('Messages not saved yet could not all be counted.')).toBeTruthy();
    expect(screen.getByText('At least 3 messages')).toBeTruthy();
    expect(screen.getByText('12 messages')).toBeTruthy();
  });

  it('shows the empty list for a person without conversations whatever the URL names, and reads no conversation', async () => {
    const api = chatsApi({ [LIST]: () => chatList([]) });
    renderPanel(`/users/${SARA}?tab=chats&c=9001`, api);
    const empty = await screen.findByText('No conversations.');
    // Not hidden below `lg` (where the conversation would replace the list), and no pane beside it.
    expect(empty.closest('.hidden')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Messages' })).toBeNull();
    expect(screen.queryByText('No conversation selected.')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.calls.some((call) => call.path.startsWith(`/v1/admin/users/${SARA}/chats/`))).toBe(false);
  });

  it('reads an open conversation only once the list has answered', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const held = new Promise((resolve) => {
      answer = resolve;
    });
    const api = chatsApi({ [LIST]: () => held });
    renderPanel(`/users/${SARA}?tab=chats&c=9001`, api);
    await waitFor(() => expect(api.of(LIST).length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.of(chatPath('9001'))).toHaveLength(0);
    answer(chatList([open]));
    expect(await screen.findByText('Still there?')).toBeTruthy();
    expect(api.of(chatPath('9001')).length).toBeGreaterThan(0);
  });

  it('offers a retry when the list cannot be read', async () => {
    let fail = true;
    const api = chatsApi({ [LIST]: () => (fail ? problem(429, 'rate_limited') : chatList([open])) });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}?tab=chats`, api);
    expect(await screen.findByText('Too many requests. Wait a minute and try again.')).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Leo Brandt')).toBeTruthy();
  });
});

describe('the Chats tab: a conversation', () => {
  it('opens from the list into the URL and draws every kind of message on its sender’s side', async () => {
    const api = chatsApi();
    const user = userEvent.setup();
    const { router } = renderPanel(`/users/${SARA}?tab=chats`, api);
    await user.click(await screen.findByRole('link', { name: /Leo Brandt/ }));
    expect(router.state.location.search).toBe('?tab=chats&c=9001');
    const pane = await screen.findByRole('region', { name: 'Messages' });
    expect(api.of(chatPath('9001')).every((call) => call.query.limit === '50' && call.query.cursor === undefined)).toBe(true);
    expect(screen.getByRole('link', { name: /Leo Brandt/, current: true })).toBeTruthy();

    // The person whose page it is at the end, the other at the start; mixed-direction bodies keep their own direction.
    const theirs = bubbleOf(pane, 'سلام، خوبی؟');
    const mine = bubbleOf(pane, 'Hi! All good');
    expect(theirs.className).toContain('justify-start');
    expect(mine.className).toContain('justify-end');
    expect(within(mine).getByText('Sara Ahmadi')).toBeTruthy();
    expect(within(theirs).getByText('Leo Brandt')).toBeTruthy();
    // A reply quotes the message it answers, in the quote's own direction.
    expect(within(mine).getByText('Reply')).toBeTruthy();
    expect(within(mine).getByText('سلام، خوبی؟').getAttribute('dir')).toBe('auto');

    // An unsent message keeps its text while it exists, marked with when; once removed, a placeholder.
    const unsent = within(pane).getByText('Call me at 0912 000 0000').closest('li')!;
    expect(within(unsent).getByText(/^Unsent /)).toBeTruthy();
    expect(within(unsent).getByText('Flagged')).toBeTruthy();
    expect(within(pane).getByText('Unsent; the text was deleted')).toBeTruthy();
    expect(within(pane).queryByText('Text removed')).toBeNull();
    expect(within(pane).getByText(wholeText('Sara Ahmadi took back a message'))).toBeTruthy();
    expect(within(pane).getByText('A message was hidden by moderation')).toBeTruthy();

    // Media is never fetched; a GIF is its id.
    expect(within(pane).getByText('Photo (not shown)')).toBeTruthy();
    expect(within(pane).getByText('Voice message (not shown)')).toBeTruthy();
    expect(pane.querySelector('img, audio, video')).toBeNull();
    // A photo's or a voice message's reference is its upload, not a message it answers.
    expect(within(within(pane).getByText('Photo (not shown)').closest('li')!).queryByText('Reply')).toBeNull();
    expect(within(within(pane).getByText('Voice message (not shown)').closest('li')!).queryByText('Reply')).toBeNull();
    expect(within(pane).getByText('tenor:12345').getAttribute('dir')).toBe('ltr');

    // Calls and reactions are lines between the bubbles.
    expect(within(pane).getByText(wholeText('Voice call from Leo Brandt (3:12)'))).toBeTruthy();
    expect(within(pane).getByText(wholeText('Video call from Sara Ahmadi (missed)'))).toBeTruthy();
    expect(within(pane).getByText(wholeText('Sara Ahmadi reacted ❤️'))).toBeTruthy();
    expect(within(pane).getByText(wholeText('Leo Brandt removed a reaction'))).toBeTruthy();

    // A like note, a message sent while shadowbanned, one not stored yet.
    const note = within(pane).getByText('Love this photo').closest('li')!;
    expect(within(note).getByText('Like note')).toBeTruthy();
    expect(within(note).getByText('Sent while shadowbanned')).toBeTruthy();
    expect(within(within(pane).getByText('Still there?').closest('li')!).getByText(/Not saved yet/)).toBeTruthy();

    // A day heading for each day; the oldest page says so.
    expect(within(pane).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Nov 24, 2026', 'Nov 25, 2026']);
    expect(within(pane).getByText('No older messages.')).toBeTruthy();
  });

  it('shows the header: the other person linked to their page on the same conversation, its state and dates', async () => {
    renderPanel(`/users/${SARA}?tab=chats&c=9002`, chatsApi());
    const section = await screen.findByRole('region', { name: 'Conversation with Mira Sohrabi' });
    const name = within(section).getByRole('heading', { level: 2 });
    expect(within(name).getByRole('link').getAttribute('href')).toBe('/users/miraaaaaaaaaa?tab=chats&c=9002');
    expect(within(section).getByText('Legal hold')).toBeTruthy();
    expect(within(section).getByText('Blocked')).toBeTruthy();
    expect(within(section).getByText(/The other person ended it on Nov 20, 2026/)).toBeTruthy();
    expect(await within(section).findByText('Held message')).toBeTruthy();
  });

  it('does not link a purged person, and names the retention rule without saying that anything was deleted', async () => {
    renderPanel(`/users/${SARA}?tab=chats&c=9003`, chatsApi({ [chatPath('9003')]: () => chatPage({ ...gone, state: 'unmatched', retentionDays: 7 }, []) }));
    const section = await screen.findByRole('region', { name: 'Conversation with Deleted account' });
    expect(await within(section).findByText('No messages are kept. The messages of an ended conversation are deleted 7 days after it ends.')).toBeTruthy();
    expect(within(section).queryByText(/were deleted/)).toBeNull();
    expect(within(within(section).getByRole('heading', { level: 2 })).queryByRole('link')).toBeNull();
  });

  it('pages older messages on top with the cursor, and reads the newest page again on refresh', async () => {
    const newest = [chatMessage('500', { body: 'Newest page', at: '2026-11-25T10:00:00.000Z' })];
    const older = [chatMessage('400', { body: 'Older page', at: '2026-11-25T09:00:00.000Z' })];
    const api = chatsApi({ [chatPath('9001')]: (call) => (call.query.cursor ? chatPage(open, older) : chatPage(open, newest, { nextCursor: 'older-1' })) });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}?tab=chats&c=9001`, api);
    expect(await screen.findByText('Newest page')).toBeTruthy();
    expect(screen.queryByText('No older messages.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(await screen.findByText('Older page')).toBeTruthy();
    expect(api.of(chatPath('9001')).filter((call) => call.query.cursor).map((call) => call.query)).toEqual([{ limit: '50', cursor: 'older-1' }]);
    const bodies = Array.from(screen.getByRole('region', { name: 'Messages' }).querySelectorAll('p[dir="auto"]'), (p) => p.textContent);
    expect(bodies).toEqual(['Older page', 'Newest page']);
    expect(screen.getByText('No older messages.')).toBeTruthy();

    const reads = api.of(chatPath('9001')).length;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.of(chatPath('9001')).length).toBe(reads + 1));
    expect(api.of(chatPath('9001')).at(-1)!.query).toEqual({ limit: '50' });
    expect(await screen.findByText('Newest page')).toBeTruthy();
    expect(screen.queryByText('Older page')).toBeNull();
  });

  it('says when messages not saved yet could not all be read, on whichever page it happened', async () => {
    const api = chatsApi({
      [chatPath('9001')]: (call) =>
        call.query.cursor ? chatPage(open, [chatMessage('50', { body: 'Older page' })], { conversation: null, stream: 'partial' }) : chatPage(open, thread.slice(0, 2), { nextCursor: 'older-1' }),
    });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}?tab=chats&c=9001`, api);
    expect(await screen.findByText('Hi! All good')).toBeTruthy();
    expect(screen.queryByText('Some messages not saved yet could not be read.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(await screen.findByText('Older page')).toBeTruthy();
    expect(screen.getByText('Some messages not saved yet could not be read.')).toBeTruthy();
    // The header stays the newest page's (an older page carries none).
    expect(screen.getByRole('region', { name: 'Conversation with Leo Brandt' })).toBeTruthy();
  });

  it('goes on through pages that stopped early while messages wait to be saved, never saying there are none', async () => {
    const api = chatsApi({
      [chatPath('9001')]: (call) =>
        call.query.cursor === 'cut-2'
          ? chatPage(open, [chatMessage('40', { body: 'Waiting since this morning', pending: true })], { conversation: null })
          : call.query.cursor === 'cut-1'
            ? chatPage(open, [], { conversation: null, stream: 'backlog', nextCursor: 'cut-2' })
            : chatPage(open, [], { stream: 'backlog', nextCursor: 'cut-1' }),
    });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}?tab=chats&c=9001`, api);
    const notice = 'Many messages are waiting to be saved, so this conversation loads in parts. Load older messages for the rest.';
    expect(await screen.findByText(notice)).toBeTruthy();
    expect(screen.queryByText('No messages in this conversation.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load older messages' }));
    await waitFor(() => expect(api.of(chatPath('9001')).some((call) => call.query.cursor === 'cut-1')).toBe(true));
    expect(screen.queryByText('No messages in this conversation.')).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Load older messages' }));
    expect(await screen.findByText('Waiting since this morning')).toBeTruthy();
    expect(screen.queryByText(notice)).toBeNull();
    expect(screen.getByText('No older messages.')).toBeTruthy();
  });

  it('names a conversation that is not this person’s, with the way back', async () => {
    renderPanel(`/users/${SARA}?tab=chats&c=9999`, chatsApi({ [chatPath('9999')]: () => problem(404, 'not_found', { detail: 'No such conversation.' }) }));
    expect(await screen.findByText('This person has no such conversation.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All conversations' }).getAttribute('href')).toBe(`/users/${SARA}?tab=chats`);
  });

  it('ignores a conversation id in the URL that is not one', async () => {
    const api = chatsApi();
    renderPanel(`/users/${SARA}?tab=chats&c=abc`, api);
    expect(await screen.findByText('No conversation selected.')).toBeTruthy();
    expect(api.calls.some((call) => call.path.startsWith(`/v1/admin/users/${SARA}/chats/`))).toBe(false);
  });
});

describe('the Chats tab: a pure read', () => {
  it('lists the message requests the person sent and received, with their state and text, and opens an accepted one’s conversation', async () => {
    const api = chatsApi();
    const user = userEvent.setup();
    const { router } = renderPanel(`/users/${SARA}?tab=chats`, api);
    const list = await screen.findByRole('list', { name: 'Message requests' });
    const [accepted, declined] = within(list).getAllByRole('listitem');
    expect(within(accepted!).getByText('Received')).toBeTruthy();
    expect(within(accepted!).getByText('Accepted')).toBeTruthy();
    expect(within(accepted!).getByText('Hi, I liked your photos')).toBeTruthy();
    expect(within(declined!).getByText('Sent')).toBeTruthy();
    expect(within(declined!).getByText('Declined')).toBeTruthy();
    expect(within(declined!).getByRole('link', { name: 'Nina' }).getAttribute('href')).toBe('/users/ninaaaaaaaaaa?tab=chats');
    expect(within(declined!).queryByRole('link', { name: 'Open the conversation' })).toBeNull();
    await user.click(within(accepted!).getByRole('link', { name: 'Open the conversation' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=chats&c=9001'));
    expect(api.of(REQUESTS).every((call) => call.method === 'GET')).toBe(true);
  });

  it('says when the person has no message requests', async () => {
    renderPanel(`/users/${SARA}?tab=chats`, chatsApi({ [REQUESTS]: () => ({ items: [], nextCursor: null }) }));
    expect(await screen.findByText('No message requests.')).toBeTruthy();
  });

  it('sends only GETs, and nothing on hover or focus', async () => {
    const api = chatsApi();
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}?tab=chats`, api);
    const rows = within(await screen.findByRole('list', { name: 'Chats' })).getAllByRole('link');
    const before = api.calls.length;
    for (const row of rows) {
      await user.hover(row);
      fireEvent.focus(row);
    }
    expect(api.calls.length).toBe(before);
    await user.click(rows[0]!);
    await screen.findByText('Still there?');
    await user.click(screen.getByRole('link', { name: /Mira Sohrabi/ }));
    await screen.findByText('Held message');
    expect(api.calls.length).toBeGreaterThan(before);
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });
});

describe('the Chats tab: Persian, phones', () => {
  it('speaks Persian right to left, in Persian digits, with the back arrow mirrored', async () => {
    renderPanel(`/users/${SARA}?tab=chats&c=9001`, chatsApi(), { locale: 'fa' });
    expect(await screen.findByRole('tab', { name: 'گفتگوها' })).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    // The messages are read once the list has answered.
    expect(await screen.findByText(wholeText('تماس صوتی از طرف Leo Brandt (۳:۱۲)'))).toBeTruthy();
    const pane = screen.getByRole('region', { name: 'پیام‌ها' });
    expect(within(pane).getByText('عکس (نمایش داده نمی‌شود)')).toBeTruthy();
    expect(within(pane).getByText('پیام قدیمی‌تری نیست.')).toBeTruthy();
    // A Latin name in a Persian sentence is isolated.
    const line = within(pane).getByText(wholeText('Sara Ahmadi پیامی را پس گرفت'));
    expect(Array.from(line.querySelectorAll('bdi'), (bdi) => bdi.textContent)).toEqual(['Sara Ahmadi']);
    const list = screen.getByRole('list', { name: 'گفتگوها' });
    expect(list.textContent).toContain('۱۲ پیام');
    expect(list.textContent).toContain('بیش از ۱۰۰ پیام');
    const back = screen.getByRole('link', { name: 'همه‌ی گفتگوها' });
    expect(back.querySelector('svg')?.getAttribute('class')).toContain('lucide-arrow-right');
  });

  it('shows the conversation alone below the wide layout, with the way back, and the list alone without one', async () => {
    const { router } = renderPanel(`/users/${SARA}?tab=chats&c=9001`, chatsApi());
    await screen.findByRole('region', { name: 'Messages' });
    const list = await screen.findByRole('list', { name: 'Chats' });
    expect(list.closest('.hidden')?.className).toContain('lg:block');
    const back = screen.getByRole('link', { name: 'All conversations' });
    expect(back.className).toContain('lg:hidden');
    await userEvent.setup().click(back);
    expect(router.state.location.search).toBe('?tab=chats');
    expect(screen.getByRole('list', { name: 'Chats' }).closest('.hidden')).toBeNull();
    // Back on the list, the focus is on the row that was open.
    await waitFor(() => expect(document.activeElement?.getAttribute('data-chat')).toBe('9001'));
  });
});
