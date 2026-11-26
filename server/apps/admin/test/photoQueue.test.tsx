import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs } from './panel';
import { moderator, page, queuePhoto, reader } from './moderationFixtures';

/** The position as the live region says it (the page header shows the same words for the eye). */
const LIVE = { selector: 'p[aria-live]' };

beforeEach(() => {
  resetPanel();
  signInAs(moderator);
});

const key = (code: string, k: string) => act(() => void fireEvent.keyDown(window, { code, key: k }));

function queueApi(extra: Record<string, () => unknown> = {}) {
  return fakeApi({
    'GET /v1/admin/moderation/photos': () => page([queuePhoto('11', 1, { modFlags: ['nudity'] }), queuePhoto('12', 2), queuePhoto('13', 3)]),
    'POST /v1/admin/moderation/photos/11/approve': () => ({ photo: { id: '11', status: 'approved' }, sideEffects: 'done' }),
    'POST /v1/admin/moderation/photos/11/reject': () => ({ photo: { id: '11', status: 'rejected', rejectReason: 'nudity' }, sideEffects: 'done' }),
    'POST /v1/admin/moderation/photos/12/approve': () => ({ photo: { id: '12', status: 'approved' }, sideEffects: 'failed' }),
    ...extra,
  });
}

const focused = () => screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'true');

describe('the photo queue', () => {
  it('shows the waiting photos, the first focused with the person, and announces the position', async () => {
    renderPanel('/moderation/photos', queueApi());
    expect(await screen.findByRole('heading', { name: 'Photos' })).toBeTruthy();
    expect(await screen.findByText('Photo 1 of 3', LIVE)).toBeTruthy();
    const region = screen.getByRole('region', { name: 'Photo under review' });
    expect(within(region).getByText('Person 1')).toBeTruthy();
    expect(within(region).getByText('Nudity')).toBeTruthy();
    expect(screen.getByText('Photo 1 of 3', LIVE)).toBeTruthy();
    expect(focused()).toHaveLength(1);
  });

  it('approves the focused photo with A (the exact request), and the next one is focused', async () => {
    const api = queueApi();
    renderPanel('/moderation/photos', api);
    await screen.findByText('Photo 1 of 3', LIVE);
    // The first photo is veiled (nudity): A shows it, and only the next A approves it.
    expect(screen.getByRole('button', { name: /Approve/ })).toHaveProperty('disabled', true);
    key('KeyA', 'a');
    expect(await screen.findByRole('button', { name: /Approve/ })).toHaveProperty('disabled', false);
    expect(api.of('POST /v1/admin/moderation/photos/11/approve')).toHaveLength(0);
    key('KeyA', 'a');
    await waitFor(() => expect(api.of('POST /v1/admin/moderation/photos/11/approve')).toHaveLength(1));
    // The status the queue saw: a photo decided elsewhere since is a 409.
    expect(api.of('POST /v1/admin/moderation/photos/11/approve')[0]?.body).toEqual({ from: 'review' });
    // Said in the live region, without a toast over the pane's buttons.
    expect(await screen.findByText('Approved. Photo 1 of 2')).toBeTruthy();
    expect(screen.queryByText('Approved.')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Photo under review' })).getByText('Person 2')).toBeTruthy();
    // A Persian layout presses the same key.
    act(() => void fireEvent.keyDown(window, { code: 'KeyA', key: 'ش' }));
    await waitFor(() => expect(api.of('POST /v1/admin/moderation/photos/12/approve')).toHaveLength(1));
    expect(await screen.findByText('Saved. Some updates in the app will be late.')).toBeTruthy();
  });

  it('rejects with R: the reason picker, 2 then Enter sends the second reason', async () => {
    const api = queueApi();
    renderPanel('/moderation/photos', api);
    await screen.findByText('Photo 1 of 3', LIVE);
    key('KeyR', 'r');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Reject a photo of Person 1')).toBeTruthy();
    // The worker's own reason is not offered.
    expect(within(dialog).queryByText('Unreadable file')).toBeNull();
    expect(api.of('POST /v1/admin/moderation/photos/11/reject')).toHaveLength(0);
    key('Digit2', '2');
    key('Enter', 'Enter');
    await waitFor(() => expect(api.of('POST /v1/admin/moderation/photos/11/reject')).toHaveLength(1));
    expect(api.of('POST /v1/admin/moderation/photos/11/reject')[0]?.body).toEqual({ reason: 'nudity', from: 'review' });
    expect(await screen.findByText('Rejected. Photo 1 of 2')).toBeTruthy();
    expect(screen.queryByText('Rejected.')).toBeNull();
  });

  it('moves with J and K, and the keys do nothing while the picker is open', async () => {
    const api = queueApi();
    renderPanel('/moderation/photos', api);
    await screen.findByText('Photo 1 of 3', LIVE);
    key('KeyJ', 'j');
    expect(await screen.findByText('Photo 2 of 3', LIVE)).toBeTruthy();
    key('KeyJ', 'j');
    key('KeyJ', 'j');
    expect(await screen.findByText('Photo 3 of 3', LIVE)).toBeTruthy();
    key('KeyK', 'k');
    expect(await screen.findByText('Photo 2 of 3', LIVE)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: /Reject/ }));
    await screen.findByRole('alertdialog');
    key('KeyA', 'a');
    key('KeyJ', 'j');
    expect(screen.getByText('Photo 2 of 3', LIVE)).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('is one tab stop: the arrow keys move the focus and the selection together, and A decides the photo with the focus', async () => {
    const api = queueApi({ 'POST /v1/admin/moderation/photos/12/approve': () => ({ photo: { id: '12', status: 'approved' }, sideEffects: 'done' }) });
    const user = userEvent.setup();
    renderPanel('/moderation/photos', api);
    await screen.findByText('Photo 1 of 3', LIVE);
    const thumbs = within(screen.getByRole('list', { name: 'Photos' })).getAllByRole('button');
    expect(thumbs.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    thumbs[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(thumbs[1]);
    expect(thumbs[1]!.getAttribute('aria-current')).toBe('true');
    expect(thumbs.map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
    expect(await screen.findByText('Photo 2 of 3', LIVE)).toBeTruthy();
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(thumbs[2]);
    await user.keyboard('{Home}{ArrowRight}');
    key('KeyA', 'a');
    await waitFor(() => expect(api.of('POST /v1/admin/moderation/photos/12/approve')).toHaveLength(1));
    expect(api.of('POST /v1/admin/moderation/photos/11/approve')).toHaveLength(0);
    // The focus goes on to the photo now selected, not to the page.
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-current')).toBe('true'));
  });

  it('follows the right-to-left order with the arrows in Persian', async () => {
    const user = userEvent.setup();
    renderPanel('/moderation/photos', queueApi(), { locale: 'fa' });
    await screen.findByText('عکس ۱ از ۳', LIVE);
    const thumbs = within(screen.getByRole('list', { name: 'عکس‌ها' })).getAllByRole('button');
    thumbs[0]!.focus();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(thumbs[1]);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(thumbs[0]);
  });

  it('brings the decision pane into view when a thumbnail is tapped on a narrow screen', async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const media = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    try {
      renderPanel('/moderation/photos', queueApi());
      await screen.findByText('Photo 1 of 3', LIVE);
      await userEvent.setup().click(within(screen.getByRole('list', { name: 'Photos' })).getAllByRole('button')[2]!);
      expect(await screen.findByText('Photo 3 of 3', LIVE)).toBeTruthy();
      expect(scrolled).toContain(screen.getByRole('region', { name: 'Photo under review' }));
    } finally {
      Element.prototype.scrollIntoView = original;
      window.matchMedia = media;
    }
  });

  it('veils a photo labelled nudity or a possible minor until the admin chooses to look, and names the labels', async () => {
    const user = userEvent.setup();
    renderPanel('/moderation/photos', queueApi({ 'GET /v1/admin/moderation/photos': () => page([queuePhoto('11', 1, { modFlags: ['nudity'], url: 'https://cdn.test/11-640.jpg', thumbUrl: 'https://cdn.test/11-320.jpg' }), queuePhoto('12', 2, { url: 'https://cdn.test/12-640.jpg', thumbUrl: 'https://cdn.test/12-320.jpg' })]) }));
    await screen.findByText('Photo 1 of 2', LIVE);
    const thumbs = within(screen.getByRole('list', { name: 'Photos' })).getAllByRole('button');
    expect(thumbs[0]!.getAttribute('aria-label')).toBe('Person 1 · Photo 1 of 2 · Nudity');
    expect(thumbs[1]!.getAttribute('aria-label')).toBe('Person 2 · Photo 2 of 2');
    const region = screen.getByRole('region', { name: 'Photo under review' });
    const large = () => region.querySelector('img')!;
    expect(large().className).toContain('blur');
    expect(thumbs[0]!.querySelector('img')!.className).toContain('blur');
    expect(thumbs[1]!.querySelector('img')!.className).not.toContain('blur');
    await user.click(within(region).getByRole('button', { name: 'Show photo' }));
    expect(large().className).not.toContain('blur');
    expect(thumbs[0]!.querySelector('img')!.className).not.toContain('blur');
  });

  it('says the position in the panel’s digits, with a plus while more can be read', async () => {
    const api = fakeApi({ 'GET /v1/admin/moderation/photos': (call) => (call.query['cursor'] ? page([]) : page(Array.from({ length: 8 }, (_, i) => queuePhoto(String(20 + i), i)), 'more')) });
    renderPanel('/moderation/photos', api, { locale: 'fa' });
    expect(await screen.findByText(/^عکس ۱ از ۸\+$/, LIVE)).toBeTruthy();
  });

  it('drops a photo decided elsewhere, with the words for it', async () => {
    const api = queueApi({ 'POST /v1/admin/moderation/photos/11/approve': () => problem(409, 'conflict', { detail: 'The photo is still being processed.' }) });
    renderPanel('/moderation/photos', api);
    await screen.findByText('Photo 1 of 3', LIVE);
    // Veiled: A shows it first (this fixture has no image link, so no Show button).
    key('KeyA', 'a');
    await userEvent.setup().click(await screen.findByRole('button', { name: /Approve/ }));
    expect(await screen.findByText('The photo is still being processed.')).toBeTruthy();
    expect(await screen.findByText('Photo 1 of 2', LIVE)).toBeTruthy();
  });

  it('reads the next page when few are left, with its cursor', async () => {
    const api = fakeApi({
      'GET /v1/admin/moderation/photos': (call) => (call.query['cursor'] === 'next' ? page([queuePhoto('14', 4)]) : page([queuePhoto('11'), queuePhoto('12', 2)], 'next')),
    });
    renderPanel('/moderation/photos', api);
    await waitFor(() => expect(api.of('GET /v1/admin/moderation/photos').some((c) => c.query['cursor'] === 'next')).toBe(true));
    expect(api.of('GET /v1/admin/moderation/photos')[0]?.query['limit']).toBe('24');
    expect(await screen.findByText('Photo 1 of 3', LIVE)).toBeTruthy();
  });

  it('says nothing waits when the queue is empty', async () => {
    renderPanel('/moderation/photos', fakeApi({ 'GET /v1/admin/moderation/photos': () => page([]) }));
    expect(await screen.findByText('Nothing waiting.')).toBeTruthy();
  });

  it('offers no decision to a role without moderation.decide, and the keys only move', async () => {
    signInAs(reader);
    const api = queueApi();
    renderPanel('/moderation/photos', api);
    await screen.findByText('Photo 1 of 3', LIVE);
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    key('KeyA', 'a');
    key('KeyJ', 'j');
    expect(await screen.findByText('Photo 2 of 3', LIVE)).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('is closed to a role without moderation.read, with no request', async () => {
    signInAs(adminWith(['users.read'], ['support']));
    const api = queueApi();
    renderPanel('/moderation/photos', api);
    expect(await screen.findByText('No access')).toBeTruthy();
    expect(api.of('GET /v1/admin/moderation/photos')).toHaveLength(0);
  });

  it('is right to left in Persian, with its words and digits', async () => {
    renderPanel('/moderation/photos', queueApi(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { name: 'عکس‌ها' })).toBeTruthy();
    expect(await screen.findByText('عکس ۱ از ۳', LIVE)).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    const region = screen.getByRole('region', { name: 'عکس در حال بررسی' });
    expect(within(region).getByRole('button', { name: /^تأیید/ })).toBeTruthy();
    expect(within(region).getByRole('button', { name: /^رد/ })).toBeTruthy();
    // The reason picker's key caps in Persian digits.
    key('KeyR', 'ب');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('۱')).toBeTruthy();
    expect(within(dialog).queryByText('1')).toBeNull();
  });
});
