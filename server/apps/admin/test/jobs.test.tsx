import { expandGrants, type AdminSystemHealth } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { messages } from '../src/i18n/messages';
import { formatDateTime, formatTime, unbreakable } from '../src/lib/format';
import { localMinuteOf } from '../src/lib/system';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs, wholeText, type Call } from './panel';
import { deadLetter, health, partitions, queues, run, streams, task } from './systemFixtures';

/**
 * `/system/jobs` (`system.read`): health, saving queues and their failed
 * entries, job queues and their failed groups, scheduled tasks and Run now,
 * partitions; each card read on its own; actions with `system.write` only;
 * nothing that names a person.
 */

const OWNER = adminWith(expandGrants(['*']), ['superadmin']);

beforeEach(() => {
  resetPanel();
  signInAs(OWNER);
});

function api(handlers: Record<string, (call: Call) => unknown> = {}) {
  return fakeApi({
    'GET /v1/admin/system/health': () => health(),
    'GET /v1/admin/system/queues': () => queues(),
    'GET /v1/admin/system/streams': () => streams(),
    'GET /v1/admin/system/partitions': () => partitions(),
    'GET /v1/admin/system/streams/like/dead-letters': (call) =>
      call.query['cursor']
        ? { items: [deadLetter('1764320000000-0', { reason: 'malformed', kind: null })], nextCursor: null }
        : { items: [deadLetter('1764323000000-0'), deadLetter('1764322000000-1', { kind: 'superlike', deliveries: 3, reason: 'deliveries' })], nextCursor: 'next' },
    ...handlers,
  });
}

/** A row's cell under the column named `column` (the phone's copies of the figures sit in the first cell). */
function cellOf(row: HTMLElement, column: string): HTMLElement {
  const table = row.closest('table')!;
  const index = [...table.querySelectorAll('thead th')].findIndex((th) => th.textContent === column);
  expect(index, column).toBeGreaterThanOrEqual(0);
  return row.querySelectorAll('td')[index] as HTMLElement;
}

/** A card of the page by its title, once its read has answered (or failed). */
async function card(title: string, { loaded = true } = {}) {
  const heading = await screen.findByRole('heading', { level: 2, name: title });
  const section = heading.closest('section')!;
  if (loaded) await waitFor(() => expect(section.querySelector('[aria-busy="true"]')).toBeNull());
  return within(section);
}

describe('the jobs page', () => {
  it('shows the database, both Valkeys with their memory, the job runner and the processes with their settings versions', async () => {
    renderPanel('/system/jobs', api());
    expect(await screen.findByRole('heading', { level: 1, name: 'Jobs and health' })).toBeTruthy();
    const h = await card('Health');
    expect(await h.findByText('Database')).toBeTruthy();
    expect(h.getAllByText('Up').length).toBeGreaterThanOrEqual(3);
    // kv-core at 75 %: amber; the cache at 25 %.
    expect(h.getByText('75%').className).toContain('text-amber');
    expect(h.getByText('25%').className).toContain('text-muted-foreground');
    expect(h.getByText('3 GB of 4 GB')).toBeTruthy();
    expect(h.getByText(/^Last beat /)).toBeTruthy();
    // Workers and servers, by name, the maintenance one marked; the one on an older settings version marked behind.
    expect(h.getByText('worker-a')).toBeTruthy();
    expect(h.getAllByText('Maintenance')[0]!.closest('[data-slot="badge"]')?.className).toContain('bg-secondary');
    expect(h.getAllByText('Settings 41', { exact: false })).toHaveLength(2);
    expect(h.getAllByText('Behind on settings')).toHaveLength(2);
    expect(h.getByText('This one')).toBeTruthy();
    expect(h.getByText('Roles not loaded')).toBeTruthy();
  });

  it('says so in red when nothing runs: no worker, no beat, Valkey down, memory near full', async () => {
    const down: AdminSystemHealth = health({
      heartbeat: null,
      workers: [],
      apis: [],
      valkey: [
        { name: 'core', status: 'up', latencyMs: 1, sharedWithCore: false, usedBytes: 95, maxBytes: 100, policy: 'noeviction' },
        { name: 'cache', status: 'down', latencyMs: 3, sharedWithCore: false, usedBytes: null, maxBytes: null, policy: null },
      ],
    });
    renderPanel('/system/jobs', api({ 'GET /v1/admin/system/health': () => down }));
    const h = await card('Health');
    expect((await h.findByText('No beat')).className).toContain('text-destructive');
    expect(h.getByText('None running').className).toContain('text-destructive');
    expect(h.getByText('None reporting')).toBeTruthy();
    expect(h.getByText('Down').className).toContain('text-destructive');
    expect(h.getByText('95%').className).toContain('text-destructive');
  });

  it('names a cache that is the core itself, and a Valkey without a memory limit', async () => {
    const shared = health({
      valkey: [
        { name: 'core', status: 'up', latencyMs: 1, sharedWithCore: false, usedBytes: 2048, maxBytes: null, policy: 'noeviction' },
        { name: 'cache', status: 'up', latencyMs: 1, sharedWithCore: true, usedBytes: 2048, maxBytes: null, policy: 'noeviction' },
      ],
    });
    renderPanel('/system/jobs', api({ 'GET /v1/admin/system/health': () => shared }));
    const h = await card('Health');
    expect(await h.findByText('Same server as the core')).toBeTruthy();
    expect(h.getByText(wholeText('2 kB · No memory limit'))).toBeTruthy();
  });

  it('shows the saving queues with their delay, amber past a minute, and failed entries in red', async () => {
    renderPanel('/system/jobs', api({ 'GET /v1/admin/system/streams': () => streams({ match: { group: false } }) }));
    const s = await card('Saving queues');
    const msg = s.getByRole('row', { name: /Messages/ });
    // The larger of the oldest pending entry and the watermark: 90 s.
    expect(within(msg).getAllByText('2 min').some((cell) => cell.className.includes('text-amber'))).toBe(true);
    const likes = s.getByRole('row', { name: /Likes/ });
    expect(within(likes).getByText('2').className).toContain('text-destructive');
    expect(within(likes).getByRole<HTMLButtonElement>('button', { name: 'View failed entries of Likes' }).disabled).toBe(false);
    expect(within(msg).getByRole<HTMLButtonElement>('button', { name: 'View failed entries of Messages' }).disabled).toBe(true);
    expect(within(s.getByRole('row', { name: /Matches/ })).getByText('No reader yet')).toBeTruthy();
  });

  it('shows under In queue what waits to be saved, and the entries a stream keeps after saving them apart', async () => {
    renderPanel(
      '/system/jobs',
      api({
        'GET /v1/admin/system/streams': () =>
          streams({
            // The live case: ten matches saved and kept until a trim, nothing waiting.
            match: { length: 10, pending: 0, undelivered: 0 },
            // Two being saved and five not delivered yet.
            like: { length: 120, pending: 2, undelivered: 5 },
            // No reader group: what waits is unknown.
            msg: { length: 900, pending: 0, undelivered: null, group: false },
          }),
      }),
    );
    const s = await card('Saving queues');
    const matches = s.getByRole('row', { name: /Matches/ });
    expect(cellOf(matches, 'In queue').textContent).toBe('0');
    expect(cellOf(matches, 'Kept entries').textContent).toBe('10');
    const likes = s.getByRole('row', { name: /Likes/ });
    expect(cellOf(likes, 'In queue').textContent).toBe('7');
    expect(cellOf(likes, 'Being saved').textContent).toBe('2');
    expect(cellOf(likes, 'Kept entries').textContent).toBe('120');
    const msg = s.getByRole('row', { name: /Messages/ });
    expect(cellOf(msg, 'In queue').textContent).toBe('—');
    expect(cellOf(msg, 'Kept entries').textContent).toBe('900');
    // On a phone, under the stream's name: what waits, never the kept entries.
    expect(within(cellOf(matches, 'Queue')).getByText(wholeText('In queue 0'))).toBeTruthy();
    expect(within(cellOf(matches, 'Queue')).queryByText(/Kept entries/)).toBeNull();
    // A secondary figure, shown only where the table fits it (from xl); a table wider than its card scrolls inside it.
    const kept = s.getByRole('columnheader', { name: 'Kept entries' });
    expect(kept.className).toContain('xl:table-cell');
    expect(kept.className).not.toContain('md:table-cell');
    expect(cellOf(matches, 'Kept entries').className).toContain('xl:table-cell');
    const wrappers = [...document.querySelectorAll('[data-slot="table-container"]')].map((container) => container.parentElement!).filter((w) => w.className.includes('-mx-4'));
    expect(wrappers.length).toBeGreaterThanOrEqual(3);
    for (const wrapper of wrappers) expect(wrapper.className.split(' ')).toContain('min-w-0');
  });

  it('lists failed entries without people or conversations, pages them, and deletes the ticked ones', async () => {
    const fake = api({ 'POST /v1/admin/system/dead-letters/delete': () => ({ deleted: 1, sideEffects: 'done' }) });
    const user = userEvent.setup();
    renderPanel('/system/jobs', fake);
    const s = await card('Saving queues');
    await user.click(s.getByRole('button', { name: 'View failed entries of Likes' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Failed entries: Likes' }));
    expect(await dialog.findByText('Refused by the database')).toBeTruthy();
    expect(dialog.getByText('Super like')).toBeTruthy();
    expect(dialog.getByText('Too many tries')).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Load more' }));
    expect(await dialog.findByText('Malformed')).toBeTruthy();
    expect(fake.of('GET /v1/admin/system/streams/like/dead-letters').at(-1)?.query['cursor']).toBe('next');
    // Delete is off until something is ticked.
    expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Delete selected (0)' }).disabled).toBe(true);
    const boxes = dialog.getAllByRole('checkbox', { name: /^Select the entry of / });
    await user.click(boxes[1]!);
    await user.click(dialog.getByRole('button', { name: 'Delete selected (1)' }));
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(confirm.getByText('Delete 1 failed entries?')).toBeTruthy();
    await user.click(confirm.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fake.of('POST /v1/admin/system/dead-letters/delete')).toHaveLength(1));
    expect(fake.of('POST /v1/admin/system/dead-letters/delete')[0]!.body).toEqual({ stream: 'like', ids: ['1764322000000-1'] });
    expect(await screen.findByText('1 deleted.')).toBeTruthy();
    // The list and the streams are read again.
    await waitFor(() => expect(fake.of('GET /v1/admin/system/streams').length).toBeGreaterThanOrEqual(2));
  });

  it('deletes all failed entries, up to the newest one shown, naming how many', async () => {
    const fake = api({ 'POST /v1/admin/system/dead-letters/delete': () => ({ deleted: 2, sideEffects: 'done' }) });
    const user = userEvent.setup();
    renderPanel('/system/jobs', fake);
    const s = await card('Saving queues');
    await user.click(s.getByRole('button', { name: 'View failed entries of Likes' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(await dialog.findByRole('button', { name: 'Delete all' }));
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(confirm.getByText('Delete all 2 failed entries of Likes?')).toBeTruthy();
    await user.click(confirm.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fake.of('POST /v1/admin/system/dead-letters/delete')[0]?.body).toEqual({ stream: 'like', upTo: '1764323000000-0' }));
    expect(await screen.findByText('2 deleted.')).toBeTruthy();
  });

  it('ticks at most 500 entries, the most one delete takes', async () => {
    const many = Array.from({ length: 520 }, (_, i) => deadLetter(`${1764323000000 - i * 1000}-0`));
    const fake = api({
      'GET /v1/admin/system/streams': () => streams({ like: { dead: 520 } }),
      'GET /v1/admin/system/streams/like/dead-letters': () => ({ items: many, nextCursor: null }),
      'POST /v1/admin/system/dead-letters/delete': () => ({ deleted: 500, sideEffects: 'done' }),
    });
    const user = userEvent.setup();
    renderPanel('/system/jobs', fake);
    await user.click((await card('Saving queues')).getByRole('button', { name: 'View failed entries of Likes' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(await dialog.findByRole('checkbox', { name: 'Select all shown' }));
    expect(dialog.getByRole('button', { name: 'Delete selected (500)' })).toBeTruthy();
    const boxes = dialog.getAllByRole<HTMLInputElement>('checkbox', { name: /^Select the entry of / });
    expect(boxes.filter((box) => box.checked)).toHaveLength(500);
    expect(boxes.slice(500).every((box) => box.disabled && !box.checked)).toBe(true);
    await user.click(dialog.getByRole('button', { name: 'Delete selected (500)' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect((fake.of('POST /v1/admin/system/dead-letters/delete')[0]?.body as { ids: string[] }).ids).toHaveLength(500));
  });

  it('says nothing was deleted when the delete failed after its record, and a page that failed to load under the list', async () => {
    const fake = api({
      'GET /v1/admin/system/streams/like/dead-letters': (call) =>
        call.query['cursor'] ? problem(503, 'service_unavailable', { detail: 'The job queues cannot be read right now.' }) : { items: [deadLetter('1764323000000-0')], nextCursor: 'next' },
      'POST /v1/admin/system/dead-letters/delete': () => ({ deleted: 0, sideEffects: 'failed' }),
    });
    const user = userEvent.setup();
    renderPanel('/system/jobs', fake);
    await user.click((await card('Saving queues')).getByRole('button', { name: 'View failed entries of Likes' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(await dialog.findByRole('button', { name: 'Load more' }));
    expect(await dialog.findByText('It could not be loaded')).toBeTruthy();
    expect(dialog.getByRole('button', { name: 'Try again' })).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Delete all' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Nothing was deleted. Try again.')).toBeTruthy();
  });

  it('opens a queue to its failed groups: retry where a late run is harmless, remove anywhere, with the result worded', async () => {
    const fake = api({
      'POST /v1/admin/system/jobs/retry': () => ({ matched: 7, done: 6, more: false, sideEffects: 'done' }),
      'POST /v1/admin/system/jobs/remove': () => ({ matched: 200, done: 200, more: true, sideEffects: 'done' }),
    });
    const user = userEvent.setup();
    renderPanel('/system/jobs', fake);
    const q = await card('Job queues');
    // Maintenance is paused; a queue without failures has nothing to open.
    expect(within(q.getByRole('row', { name: /Maintenance/ })).getByText('Paused')).toBeTruthy();
    expect(q.queryByRole('button', { name: 'Failed jobs of System' })).toBeNull();
    await user.click(q.getByRole('button', { name: 'Failed jobs of Photos' }));
    expect(q.getByRole('button', { name: 'Failed jobs of Photos' }).getAttribute('aria-expanded')).toBe('true');
    await user.click(q.getByRole('button', { name: 'Retry Photo processing' }));
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(confirm.getByText('Retry 7 failed “Photo processing” jobs?')).toBeTruthy();
    await user.click(confirm.getByRole('button', { name: 'Retry' }));
    // Bounded to the count named (every failed photo job was counted).
    await waitFor(() => expect(fake.of('POST /v1/admin/system/jobs/retry')[0]?.body).toEqual({ queue: 'photo', name: 'process', max: 7 }));
    expect(await screen.findByText('6 of 7 done.')).toBeTruthy();

    await user.click(q.getByRole('button', { name: 'Failed jobs of Push notifications' }));
    // Notifications are never run late: no Retry, a Remove.
    expect(q.queryByRole('button', { name: 'Retry Notification send' })).toBeNull();
    expect(q.getByText('Not retried')).toBeTruthy();
    expect(q.getByText('Counted among the newest 200')).toBeTruthy();
    await user.click(q.getByRole('button', { name: 'Remove Notification send' }));
    // Only the newest 200 were counted: the confirm names no count it cannot keep, but what one remove takes at most.
    const removeConfirm = within(await screen.findByRole('alertdialog'));
    expect(removeConfirm.getByText('Remove up to 500 failed “Notification send” jobs?')).toBeTruthy();
    expect(removeConfirm.queryByText(/200/)).toBeNull();
    await user.click(removeConfirm.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(fake.of('POST /v1/admin/system/jobs/remove')[0]?.body).toEqual({ queue: 'push', name: 'send' }));
    expect(await screen.findByText('200 done; more remain.')).toBeTruthy();
  });

  it('shows each task’s schedule, next run and last run, and starts a runnable one by hand', async () => {
    const fake = api({ 'POST /v1/admin/system/tasks/run': () => ({ queued: true, jobId: 'partitions.run.29404800', sideEffects: 'done' }) });
    const user = userEvent.setup();
    renderPanel('/system/jobs', fake);
    const tasks = await card('Scheduled tasks');
    const beat = tasks.getByRole('row', { name: /Job runner beat/ });
    expect(within(beat).getAllByText('Every 30 sec').length).toBeGreaterThan(0);
    expect(within(beat).getAllByText('Done').length).toBeGreaterThan(0);
    const partitionsRow = tasks.getByRole('row', { name: /Partitions/ });
    // In the browser's time of day, written as the next run beside it; the cron's UTC on hover.
    const daily = within(partitionsRow).getAllByTitle('3:17 AM UTC');
    expect(daily.length).toBeGreaterThan(0);
    expect(daily[0]!.textContent).toBe(`Daily, ${unbreakable(formatTime('2026-11-29T03:17:00.000Z', 'en'))}`);
    expect(cellOf(partitionsRow, 'Next').textContent).toBe(formatDateTime('2026-11-29T03:17:00.000Z', 'en'));
    expect(within(partitionsRow).getAllByText('Failed, will retry').length).toBeGreaterThan(0);
    expect(within(partitionsRow).getAllByText('DatabaseError:57014').length).toBeGreaterThan(0);
    const likes = tasks.getByRole('row', { name: /Like lists/ });
    expect(within(likes).getAllByText('Every 15 min').length).toBeGreaterThan(0);
    expect(within(likes).getAllByText('Skipped').length).toBeGreaterThan(0);
    const sessions = tasks.getByRole('row', { name: /Old sessions/ });
    expect(within(sessions).getAllByTitle('Sunday 4:41 AM UTC')[0]!.textContent).toMatch(new RegExp(`^Weekly, \\w+ ${unbreakable(formatTime('2026-11-29T04:41:00.000Z', 'en'))}$`));
    // A runnable task whose scheduler is not registered yet says so (it is no task "by hand only").
    expect(within(tasks.getByRole('row', { name: /Publish the host list/ })).getAllByText('Not scheduled').length).toBeGreaterThan(0);
    expect(within(likes).getAllByText('By hand').length).toBeGreaterThan(0);
    // An hourly cron's minute in the browser's zone too (a half-hour zone moves it), the cron's on hover.
    const checks = within(tasks.getByRole('row', { name: /Purchase checks/ }));
    expect(checks.getAllByText(`Hourly, minute ${localMinuteOf(17)}`).length).toBeGreaterThan(0);
    expect(checks.getAllByTitle('Hourly, minute 17 UTC').length).toBeGreaterThan(0);
    // The schedule may wrap between words, never inside its time (a no-break space before AM).
    expect(cellOf(partitionsRow, 'When').className).not.toContain('whitespace-nowrap');
    expect(daily[0]!.textContent).toMatch(/\d\u00a0[AP]M$/);
    // Not runnable: no button.
    expect(tasks.queryByRole('button', { name: 'Run now: Purchase checks' })).toBeNull();
    await user.click(tasks.getByRole('button', { name: 'Run now: Daily figures' }));
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(confirm.getByText('Run “Daily figures” now?')).toBeTruthy();
    await user.click(confirm.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(fake.of('POST /v1/admin/system/tasks/run')[0]?.body).toEqual({ queue: 'stats', name: 'rollup' }));
    expect(await screen.findByText('Queued.')).toBeTruthy();
  });

  it('says when this minute’s run was started already', async () => {
    const fake = api({ 'POST /v1/admin/system/tasks/run': () => ({ queued: false, already: true, jobId: 'rollup.run.29404800', sideEffects: 'done' }) });
    const user = userEvent.setup();
    renderPanel('/system/jobs', fake);
    const tasks = await card('Scheduled tasks');
    await user.click(tasks.getByRole('button', { name: 'Run now: Daily figures' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText('Already started this minute.')).toBeTruthy();
  });

  it('shows what a run did, and on a phone the last success and the next run under the task', async () => {
    const figures = queues();
    figures.tasks = figures.tasks.map((item) =>
      item.name === 'partitions' ? { ...item, last: { ...item.last!, ok: true, willRetry: false, error: null, manual: true, summary: { leased: true, ensured: 2, dropped: 1, held: 0 } } } : item,
    );
    renderPanel('/system/jobs', api({ 'GET /v1/admin/system/queues': () => figures }));
    const tasks = await card('Scheduled tasks');
    const row = within(tasks.getByRole('row', { name: /Partitions/ }));
    for (const [key, value] of [['ensured', '2'], ['dropped', '1'], ['held', '0']] as const) {
      const label = row.getAllByText(key)[0]!;
      expect(label.nextElementSibling?.textContent).toBe(value);
    }
    // The lease is not repeated as a figure (the state says it).
    expect(row.queryByText('leased')).toBeNull();
    // The task cell carries the last success and the next run (their columns are hidden below lg).
    const taskCell = within(row.getAllByRole('cell')[0]!);
    expect(taskCell.getByText('Last success')).toBeTruthy();
    expect(taskCell.getByText('Next')).toBeTruthy();
    // The last success has its own column from xl only, so from 1024 px the table fits its card with Run now inside it.
    expect(tasks.getByRole('columnheader', { name: 'Last success' }).className).toContain('xl:table-cell');
    expect(taskCell.getByText('Last success').closest('.xl\\:hidden')).not.toBeNull();
    expect(taskCell.getByText('Next').closest('.lg\\:hidden')).not.toBeNull();
  });

  it('writes a run under a second in milliseconds, 0 ms included', async () => {
    const figures = queues({
      tasks: [
        task('system', 'heartbeat', { every: 30_000, last: run({ durationMs: 0 }) }),
        task('chat', 'read-flush', { every: 60_000, last: run({ durationMs: 999 }) }),
        task('stats', 'live', { every: 60_000, last: run({ durationMs: 1_500 }) }),
      ],
    });
    const view = renderPanel('/system/jobs', api({ 'GET /v1/admin/system/queues': () => figures }));
    let tasks = await card('Scheduled tasks');
    expect(within(tasks.getByRole('row', { name: /Job runner beat/ })).getAllByText(/ · took 0 ms$/).length).toBeGreaterThan(0);
    expect(within(tasks.getByRole('row', { name: /Read receipts/ })).getAllByText(/ · took 999 ms$/).length).toBeGreaterThan(0);
    expect(within(tasks.getByRole('row', { name: /Live figures/ })).getAllByText(/ · took 2 sec$/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/took 0 sec/)).toBeNull();
    view.unmount();

    renderPanel('/system/jobs', api({ 'GET /v1/admin/system/queues': () => figures }), { locale: 'fa' });
    tasks = await card('کارهای زمان‌بندی‌شده');
    // Persian's own comma before the run's length: a "·" beside «۰» would read as a second zero.
    const beat = within(tasks.getByRole('row', { name: /ضربان اجرای کارها/ })).getAllByText(/، در ۰ میلی‌ثانیه$/);
    expect(beat.length).toBeGreaterThan(0);
    for (const line of beat) expect(line.textContent).not.toContain('·');
    expect(screen.queryByText(/در ۰ ثانیه/)).toBeNull();
  });

  it('writes “not run yet” under a task’s name on a phone at the size of the facts beside it', async () => {
    renderPanel('/system/jobs', api());
    const tasks = await card('Scheduled tasks');
    const checks = tasks.getByRole('row', { name: /Purchase checks/ });
    const nameCell = cellOf(checks, 'Task');
    const under = within(nameCell).getAllByText('Not run yet');
    // Under the name, once: the last run at the facts' size (no "Last success: not run yet" after it).
    expect(under).toHaveLength(1);
    expect(within(nameCell).queryByText('Last success')).toBeNull();
    for (const text of under) {
      expect(text.closest('.text-xs, [class*="text-xs"]'), text.outerHTML).not.toBeNull();
      expect(text.className).not.toContain('text-sm');
    }
    // In its own column (wider screens) it keeps the column's size.
    expect(within(cellOf(checks, 'Last run')).getByText('Not run yet').className).toContain('text-sm');
  });

  it('says under 1 ms and under 1 % for a round trip or a share too small to round, never 0', async () => {
    const quick = health({
      database: { status: 'up', latencyMs: 0 },
      valkey: [
        { name: 'core', status: 'up', latencyMs: 0, sharedWithCore: false, usedBytes: 3 * 1024 ** 2, maxBytes: 1024 ** 3, policy: 'noeviction' },
        { name: 'cache', status: 'up', latencyMs: 2, sharedWithCore: false, usedBytes: 512 * 1024 ** 2, maxBytes: 1024 ** 3, policy: 'allkeys-lru' },
      ],
    });
    const view = renderPanel('/system/jobs', api({ 'GET /v1/admin/system/health': () => quick }));
    let h = await card('Health');
    expect((await h.findAllByText('<1 ms')).length).toBe(2);
    expect(h.getByText('2 ms')).toBeTruthy();
    expect(h.getByText('<1%')).toBeTruthy();
    expect(h.getByText('50%')).toBeTruthy();
    expect(h.queryByText('0 ms')).toBeNull();
    expect(h.queryByText('0%')).toBeNull();
    view.unmount();

    renderPanel('/system/jobs', api({ 'GET /v1/admin/system/health': () => quick }), { locale: 'fa' });
    h = await card('سلامت');
    expect((await h.findAllByText('کمتر از ۱ میلی‌ثانیه')).length).toBe(2);
    expect(h.getByText('کمتر از ۱٪')).toBeTruthy();
    expect(h.queryByText('۰ میلی‌ثانیه')).toBeNull();
    expect(h.queryByText('۰٪')).toBeNull();
  });

  it('keeps Run now off for maintenance while no worker runs it', async () => {
    const noMaint = health({ workers: health().workers.map((worker) => ({ ...worker, maint: false })) });
    renderPanel('/system/jobs', api({ 'GET /v1/admin/system/health': () => noMaint }));
    const tasks = await card('Scheduled tasks');
    await waitFor(() => expect(tasks.getByRole<HTMLButtonElement>('button', { name: 'Run now: Partitions' }).disabled).toBe(true));
    // Two maintenance tasks are runnable; each says it under its name (phones) and under its button.
    expect(tasks.getAllByText('No worker runs maintenance').length).toBe(4);
    expect(tasks.getByRole<HTMLButtonElement>('button', { name: 'Run now: Daily figures' }).disabled).toBe(false);
  });

  it('words a refusal of a write (the second factor the deployment requires)', async () => {
    const fake = api({ 'POST /v1/admin/system/tasks/run': () => problem(403, 'forbidden', { reason: 'mfa_required', detail: 'Sign in with your code.' }) });
    const user = userEvent.setup();
    renderPanel('/system/jobs', fake);
    const tasks = await card('Scheduled tasks');
    await user.click(tasks.getByRole('button', { name: 'Run now: Daily figures' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText(messages.en['access.mfaRequired'])).toBeTruthy();
  });

  it('shows the partitions: ahead, kept, next removal, estimates; amber below plan or with an old transaction age, red with none for now', async () => {
    renderPanel('/system/jobs', api());
    const p = await card('Partitions');
    const messagesBlock = within(p.getByRole('heading', { level: 3, name: 'Messages' }).closest('section')!);
    expect(messagesBlock.getByText('12 months')).toBeTruthy();
    expect(messagesBlock.getAllByText('1,250,000')).toHaveLength(2);
    expect(messagesBlock.getAllByText('512 MB')).toHaveLength(2);
    expect(messagesBlock.getByText('Partitions (2)')).toBeTruthy();
    // Each partition by its period (from, to), its rows and its size; its name on hover.
    const partition = within(messagesBlock.getByTitle('messages_p20261101'));
    expect(partition.getByText('Nov 1, 2026')).toBeTruthy();
    expect(partition.getByText('Dec 1, 2026')).toBeTruthy();
    expect(partition.getByText('1,250,000')).toBeTruthy();
    expect(within(messagesBlock.getByTitle('messages_p20261201')).getByText('0')).toBeTruthy();
    // Three blocks side by side are narrower than their tables from 1024 to 1279 px: each table scrolls inside its block.
    for (const block of p.getAllByRole('heading', { level: 3 }).map((h) => h.closest('section')!)) {
      expect(block.className.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'grid-cols-1']));
      expect(block.querySelector('table')!.parentElement!.className.split(' ')).toContain('overflow-x-auto');
    }
    const likes = within(p.getByRole('heading', { level: 3, name: 'Likes' }).closest('section')!);
    expect(likes.getByText('37 days')).toBeTruthy();
    expect(likes.getByText('Fewer than 4').className).toContain('text-amber');
    expect(likes.getByText('High: check autovacuum')).toBeTruthy();
    const audit = within(p.getByRole('heading', { level: 3, name: 'Audit log' }).closest('section')!);
    expect(audit.getByText('For good')).toBeTruthy();
    expect(audit.getByText('None for the current period').className).toContain('text-destructive');
  });

  it('reads each card on its own: a queue outage leaves health, streams and partitions shown', async () => {
    renderPanel('/system/jobs', api({ 'GET /v1/admin/system/queues': () => problem(503, 'service_unavailable', { detail: 'The job queues cannot be read right now.' }) }));
    const q = await card('Job queues');
    expect(await q.findByText('It could not be loaded')).toBeTruthy();
    expect((await card('Scheduled tasks')).getByText('It could not be loaded')).toBeTruthy();
    expect(await (await card('Partitions')).findByText('Messages')).toBeTruthy();
    expect(await (await card('Health')).findByText('Database')).toBeTruthy();
  });

  it('shows grey rows while a card loads', async () => {
    renderPanel('/system/jobs', api({ 'GET /v1/admin/system/partitions': () => new Promise(() => undefined) }));
    const p = await card('Partitions', { loaded: false });
    expect(p.getByText('Loading…')).toBeTruthy();
  });

  it('offers no action to an admin who may only read it', async () => {
    signInAs(adminWith(['system.read']));
    const user = userEvent.setup();
    renderPanel('/system/jobs', api());
    const q = await card('Job queues');
    await user.click(q.getByRole('button', { name: 'Failed jobs of Photos' }));
    expect(q.queryByRole('button', { name: 'Retry Photo processing' })).toBeNull();
    expect(q.queryByRole('button', { name: 'Remove Photo processing' })).toBeNull();
    expect((await card('Scheduled tasks')).queryByRole('button', { name: /^Run now/ })).toBeNull();
    await user.click((await card('Saving queues')).getByRole('button', { name: 'View failed entries of Likes' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(await dialog.findByText('Refused by the database')).toBeTruthy();
    expect(dialog.queryByRole('checkbox')).toBeNull();
    expect(dialog.queryByRole('button', { name: /^Delete/ })).toBeNull();
  });

  it('reads in Persian with Persian digits and in Turkish, no English left', async () => {
    const view = renderPanel('/system/jobs', api(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { level: 1, name: 'کارها و سلامت سیستم' })).toBeTruthy();
    const h = await card('سلامت');
    expect(await h.findByText('پایگاه داده')).toBeTruthy();
    expect(h.getByText('۷۵٪')).toBeTruthy();
    const tasks = await card('کارهای زمان‌بندی‌شده');
    // One time format: the schedule's hour as the next run writes it (never «۰۳:۱۷» beside «۳:۱۷»).
    const partitionsRow = tasks.getByRole('row', { name: /ساخت و حذف پارتیشن‌ها/ });
    expect(tasks.getAllByTitle('۳:۱۷ UTC')[0]!.textContent).toBe(`هر روز، ساعت ${formatTime('2026-11-29T03:17:00.000Z', 'fa')}`);
    expect(cellOf(partitionsRow, 'بعدی').textContent).toBe(formatDateTime('2026-11-29T03:17:00.000Z', 'fa'));
    expect(formatTime('2026-11-29T03:17:00.000Z', 'fa')).not.toMatch(/^۰/);
    const p = await card('پارتیشن‌ها');
    expect(p.getByText('۱۲ ماه')).toBeTruthy();
    for (const english of ['Health', 'Saving queues', 'Job queues', 'Scheduled tasks', 'Partitions', 'Retry', 'Run now']) expect(screen.queryByText(english)).toBeNull();
    view.unmount();

    renderPanel('/system/jobs', api(), { locale: 'tr' });
    expect(await screen.findByRole('heading', { level: 1, name: 'İşler ve sistem durumu' })).toBeTruthy();
    expect(await card('Kayıt kuyrukları')).toBeTruthy();
    expect(await card('Zamanlanmış görevler')).toBeTruthy();
  });

  it('reads every card again on Refresh', async () => {
    const fake = api();
    const user = userEvent.setup();
    renderPanel('/system/jobs', fake);
    await card('Partitions');
    await card('Job queues');
    await card('Health');
    await card('Saving queues');
    const before = Object.fromEntries(['health', 'queues', 'streams', 'partitions'].map((path) => [path, fake.of(`GET /v1/admin/system/${path}`).length]));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      for (const [path, count] of Object.entries(before)) expect(fake.of(`GET /v1/admin/system/${path}`).length, path).toBeGreaterThan(count);
    });
  });
});
