import { expandGrants } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { decisionsFrom } from '../src/lib/profileReviews';
import { review } from './appFixtures';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs, type Call } from './panel';

/**
 * `/moderation/profiles`: new profiles waiting for a review (oldest first),
 * sent back for changes, or refused; approve, ask for changes or refuse,
 * with the message the person reads in their own language.
 */

const MODERATOR = adminWith(expandGrants(['users.read', 'moderation.*', 'reports.*', 'appeals.*']), ['moderator']);
const SARA = '1A2B3C4D5E6F7G8H';
const KIAN = '9Z8Y7X6W5V4U3T2S';

beforeEach(() => {
  resetPanel();
  signInAs(MODERATOR);
});

const decided = (review: string) => (call: Call) => ({
  user: {
    id: call.path.split('/')[4],
    name: 'Sara Ahmadi',
    status: review === 'approved' ? 'active' : 'pending_review',
  },
  review,
  sideEffects: 'done',
});

function api(handlers: Record<string, (call: Call) => unknown> = {}) {
  return fakeApi({
    'GET /v1/admin/moderation/profiles': (call) =>
      call.query['state'] === 'needs_changes'
        ? {
            items: [
              review(KIAN, {
                user: { ...review(KIAN).user, name: 'Kian Salehi' },
                state: 'needs_changes',
                rounds: 1,
                decision: {
                  kind: 'needs_changes',
                  reasonText: 'Add a clear photo of your face.',
                  decidedAt: '2026-11-27T09:00:00.000Z',
                  decidedBy: { id: '2', displayName: 'Mina Karimi' },
                },
              }),
            ],
            nextCursor: null,
          }
        : call.query['state'] === 'rejected'
          ? { items: [], nextCursor: null }
          : {
              items: [
                review(SARA),
                review(KIAN, {
                  user: { ...review(KIAN).user, name: 'Kian Salehi' },
                  locale: 'en',
                }),
              ],
              nextCursor: null,
            },
    ...handlers,
  });
}

describe('the review decisions', () => {
  it('offers every move away from the state shown', () => {
    expect(decisionsFrom('waiting')).toEqual(['approve', 'needs-changes', 'reject']);
    expect(decisionsFrom('needs_changes')).toEqual(['approve', 'reject']);
    expect(decisionsFrom('rejected')).toEqual(['approve', 'needs-changes']);
  });
});

describe('/moderation/profiles', () => {
  it('lists the waiting profiles oldest first with their photos and texts, and approves one with the state seen', async () => {
    const posts: Call[] = [];
    const fake = api({
      [`POST /v1/admin/users/${SARA}/approve`]: (call) => {
        posts.push(call);
        return decided('approved')(call);
      },
    });
    const user = userEvent.setup();
    renderPanel('/moderation/profiles', fake);
    expect(await screen.findByRole('heading', { level: 1, name: 'New profiles' })).toBeTruthy();
    expect(fake.of('GET /v1/admin/moderation/profiles')[0]!.query).toMatchObject({ state: 'waiting', limit: '20' });
    await screen.findByText('Sara Ahmadi');
    const cards = screen.getAllByRole('article');
    expect(within(cards[0]!).getByText('Sara Ahmadi')).toBeTruthy();
    expect(within(cards[0]!).getByText('Hiking and tea.')).toBeTruthy();
    // The photo still waiting for its own review says so.
    expect(within(cards[0]!).getAllByText('Waiting').length).toBeGreaterThan(0);
    expect(within(cards[0]!).getByText('Persian')).toBeTruthy();
    await user.click(within(cards[0]!).getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ from: 'waiting' });
    await waitFor(() => expect(screen.queryByText('Sara Ahmadi')).toBeNull());
    expect(screen.getByText('Approved.', { exact: false })).toBeTruthy();
  });

  it('asks for changes with a message in the person’s language and a note for the team', async () => {
    const posts: Call[] = [];
    const user = userEvent.setup();
    renderPanel(
      '/moderation/profiles',
      api({
        [`POST /v1/admin/users/${KIAN}/needs-changes`]: (call) => {
          posts.push(call);
          return decided('needs_changes')(call);
        },
      }),
    );
    const card = within((await screen.findByText('Kian Salehi')).closest('article')!);
    await user.click(card.getByRole('button', { name: 'Ask for changes' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Ask Kian Salehi for changes')).toBeTruthy();
    // The effect sentence is the dialog's description, read with its title.
    const effect = dialog.getByText('The person reads this message and can edit and send the profile again.');
    expect(screen.getByRole('dialog').getAttribute('aria-describedby')).toBe(effect.id);
    expect(dialog.getByText('English')).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Send' }));
    expect(dialog.getByText('Required.')).toBeTruthy();
    await user.type(dialog.getByRole('textbox', { name: /Message to Kian Salehi/ }), 'Please add a photo of your face.');
    await user.type(dialog.getByRole('textbox', { name: /Note for the team/ }), 'Only a landscape photo.');
    await user.click(dialog.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({
      from: 'waiting',
      reasonText: 'Please add a photo of your face.',
      note: 'Only a landscape photo.',
    });
    await waitFor(() => expect(screen.queryByText('Kian Salehi')).toBeNull());
  });

  it('rejects with R and its message, in the person’s direction', async () => {
    const posts: Call[] = [];
    const user = userEvent.setup();
    renderPanel(
      '/moderation/profiles',
      api({
        [`POST /v1/admin/users/${SARA}/reject`]: (call) => {
          posts.push(call);
          return decided('rejected')(call);
        },
      }),
    );
    await screen.findByText('Sara Ahmadi');
    await user.keyboard('r');
    const dialog = within(await screen.findByRole('dialog'));
    const text = dialog.getByRole('textbox', {
      name: /Message to Sara Ahmadi/,
    });
    expect(text.getAttribute('dir')).toBe('rtl');
    expect(text.getAttribute('lang')).toBe('fa');
    await user.type(text, 'پروفایل با قوانین سازگار نیست.');
    await user.click(dialog.getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(posts[0]?.body).toEqual({
        from: 'waiting',
        reasonText: 'پروفایل با قوانین سازگار نیست.',
      }),
    );
  });

  it('shows the profiles sent back with their last message, named as such, and offers approve and reject only', async () => {
    const user = userEvent.setup();
    const { router } = renderPanel('/moderation/profiles', api());
    await screen.findByText('Sara Ahmadi');
    await user.click(screen.getByRole('radio', { name: 'Needs changes' }));
    expect(router.state.location.search).toBe('?state=needs_changes');
    const card = within((await screen.findByText('Kian Salehi')).closest('article')!);
    expect(card.getByText('Add a clear photo of your face.')).toBeTruthy();
    expect(card.getByText(/^Changes asked · Mina Karimi, /)).toBeTruthy();
    expect(card.getByText('Reviews: 1')).toBeTruthy();
    expect(card.getByRole('button', { name: /Approve/ })).toBeTruthy();
    expect(card.getByRole('button', { name: /Reject/ })).toBeTruthy();
    expect(card.queryByRole('button', { name: 'Ask for changes' })).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Rejected' }));
    expect(await screen.findByText('No rejected profile.')).toBeTruthy();
  });

  it('names the earlier request of a profile sent again, and a rejection as one', async () => {
    const decision = (kind: 'needs_changes' | 'rejected') => ({ kind, reasonText: 'Remove the handle.', decidedAt: '2026-11-27T09:00:00.000Z', decidedBy: { id: '2', displayName: 'Mina Karimi' } });
    renderPanel(
      '/moderation/profiles',
      fakeApi({
        'GET /v1/admin/moderation/profiles': (call) => ({
          items:
            call.query['state'] === 'rejected'
              ? [review(KIAN, { user: { ...review(KIAN).user, name: 'Kian Salehi' }, state: 'rejected', rounds: 2, decision: decision('rejected') })]
              : [review(SARA, { rounds: 1, decision: decision('needs_changes') })],
          nextCursor: null,
        }),
      }),
    );
    const card = within((await screen.findByText('Sara Ahmadi')).closest('article')!);
    expect(card.getByText(/^Changes asked · Mina Karimi, /)).toBeTruthy();
    expect(card.getByText('Remove the handle.')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Rejected' }));
    const rejected = within((await screen.findByText('Kian Salehi')).closest('article')!);
    expect(rejected.getByText(/^Rejected · Mina Karimi, /)).toBeTruthy();
    expect(rejected.getByText('Reviews: 2')).toBeTruthy();
  });

  it('reloads the queue when the profile changed meanwhile, and drops one already decided', async () => {
    let answer: unknown = problem(409, 'conflict', { reason: 'stale' });
    const fake = api({
      [`POST /v1/admin/users/${SARA}/approve`]: () => answer,
    });
    const user = userEvent.setup();
    renderPanel('/moderation/profiles', fake);
    const card = within((await screen.findByText('Sara Ahmadi')).closest('article')!);
    const reads = fake.of('GET /v1/admin/moderation/profiles').length;
    await user.click(card.getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(fake.of('GET /v1/admin/moderation/profiles').length).toBeGreaterThan(reads));
    answer = problem(409, 'conflict', { reason: 'already_decided' });
    await user.click(within((await screen.findByText('Sara Ahmadi')).closest('article')!).getByRole('button', { name: /Approve/ }));
    expect(await screen.findByText('Already decided.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Sara Ahmadi')).toBeNull());
  });

  it('shows the queue without decisions to a role that only reads moderation', async () => {
    signInAs(adminWith(['moderation.read'], ['analyst']));
    renderPanel('/moderation/profiles', api());
    expect(await screen.findByText('Sara Ahmadi')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask for changes' })).toBeNull();
  });

  it('says when nothing waits', async () => {
    renderPanel(
      '/moderation/profiles',
      fakeApi({
        'GET /v1/admin/moderation/profiles': () => ({
          items: [],
          nextCursor: null,
        }),
      }),
    );
    expect(await screen.findByText('Nothing waiting.')).toBeTruthy();
  });

  it('reads in Persian', async () => {
    renderPanel('/moderation/profiles', api(), { locale: 'fa' });
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'پروفایل‌های تازه',
      }),
    ).toBeTruthy();
    expect(screen.getAllByText('در انتظار بررسی').length).toBeGreaterThan(0);
    expect((await screen.findAllByText('۲۷ ساله')).length).toBeGreaterThan(0);
  });
});
